import { Address, BigDecimal, BigInt, ethereum, store, log, Bytes } from '@graphprotocol/graph-ts';

import { Transfer } from '../../generated/templates/Pair/Pair';
import { Pair as PairContract, Mint, Burn, Swap, Sync } from '../../generated/templates/Pair/Pair';
import {
  Bundle,
  LiquidityPosition,
  LiquidityPositionSnapshot,
  Pair,
  SolidlyFactory,
  Token,
  Transaction,
  User,
  Mint as MintEvent,
  Burn as BurnEvent,
  Swap as SwapEvent,
} from '../../generated/schema';
import { ADDRESS_ZERO, BI_18, convertTokenToDecimal, FACTORY_ADDRESS, getDerivedFTM, ONE_BI, ZERO_BD } from './helpers';
import { findFtmPerToken, getFtmPriceInUSD, getTrackedLiquidityUSD, getTrackedVolumeUSD } from './pricing';

export function handleTransfer(event: Transfer): void {
  // ignore initial transfers for first adds
  // TODO: confirm that this is the behavior we want
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.amount.equals(BigInt.fromI32(1000))) {
    return;
  }

  let transactionHash = event.transaction.hash.toHexString();

  // user stats
  const from = event.params.from;
  getOrCreateUser(from);
  const to = event.params.to;
  getOrCreateUser(to);

  // get pair and load contract
  let pair = Pair.load(event.address.toHexString());
  if (pair == null) {
    log.debug('debug pair not found', []);
    return;
  }
  let pairContract = PairContract.bind(event.address);

  // liquidity token amount being transferred
  let value = convertTokenToDecimal(event.params.amount, BI_18);

  // get or create transaction
  let transaction = Transaction.load(transactionHash);
  if (transaction === null) {
    transaction = new Transaction(transactionHash);
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
  }

  // mints
  const mints = transaction.mints;
  if (from.toHexString() == ADDRESS_ZERO) {
    // update total supply
    pair.totalSupply = pair.totalSupply.plus(value);
    pair.save();

    // create new mint if no mints so far or if last one is done already
    if (mints.length === 0 || isCompleteMint(mints[mints.length - 1])) {
      let mint = new MintEvent(
        event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(mints.length).toString())
      );
      mint.transaction = transaction.id;
      mint.pair = pair.id;
      mint.to = to;
      mint.liquidity = value;
      mint.timestamp = transaction.timestamp;
      mint.transaction = transaction.id;
      mint.save();

      // update mints in transaction
      transaction.mints = mints.concat([mint.id]);

      // save entities
      transaction.save();
    }
  }

  // case where direct send first on FTM withdrawls
  if (event.params.to.toHexString() == pair.id) {
    let burns = transaction.burns;
    let burn = new BurnEvent(
      event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(burns.length).toString())
    );
    burn.transaction = transaction.id;
    burn.pair = pair.id;
    burn.liquidity = value;
    burn.timestamp = transaction.timestamp;
    burn.to = event.params.to;
    burn.sender = event.params.from;
    burn.needsComplete = true;
    burn.transaction = transaction.id;
    burn.save();

    // TODO: Consider using .concat() for handling array updates to protect
    // against unintended side effects for other code paths.
    burns.push(burn.id);
    transaction.burns = burns;
    transaction.save();
  }

  // burn
  if (event.params.to.toHexString() == ADDRESS_ZERO && event.params.from.toHexString() == pair.id) {
    pair.totalSupply = pair.totalSupply.minus(value);
    pair.save();

    // this is a new instance of a logical burn
    let burns = transaction.burns;
    let burn: BurnEvent;
    if (burns.length > 0) {
      const currentBurn = BurnEvent.load(burns[burns.length - 1]);
      if (currentBurn === null) {
        log.debug('debug currentBurn is null', []);
        return;
      }
      if (currentBurn.needsComplete) {
        burn = currentBurn as BurnEvent;
      } else {
        burn = new BurnEvent(
          event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(burns.length).toString())
        );
        burn.transaction = transaction.id;
        burn.needsComplete = false;
        burn.pair = pair.id;
        burn.liquidity = value;
        burn.transaction = transaction.id;
        burn.timestamp = transaction.timestamp;
      }
    } else {
      burn = new BurnEvent(
        event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(burns.length).toString())
      );
      burn.transaction = transaction.id;
      burn.needsComplete = false;
      burn.pair = pair.id;
      burn.liquidity = value;
      burn.transaction = transaction.id;
      burn.timestamp = transaction.timestamp;
    }

    // if this logical burn included a fee mint, account for this
    if (mints.length !== 0 && !isCompleteMint(mints[mints.length - 1])) {
      let mint = MintEvent.load(mints[mints.length - 1]);
      if (mint == null) {
        log.debug('debug mint not found', []);
        return;
      }
      burn.feeTo = mint.to;
      burn.feeLiquidity = mint.liquidity;
      // remove the logical mint
      store.remove('Mint', mints[mints.length - 1]);
      // update the transaction

      // TODO: Consider using .slice().pop() to protect against unintended
      // side effects for other code paths.
      mints.pop();
      transaction.mints = mints;
      transaction.save();
    }
    burn.save();
    // if accessing last one, replace it
    if (burn.needsComplete) {
      // TODO: Consider using .slice(0, -1).concat() to protect against
      // unintended side effects for other code paths.
      burns[burns.length - 1] = burn.id;
    }
    // else add new one
    else {
      // TODO: Consider using .concat() for handling array updates to protect
      // against unintended side effects for other code paths.
      burns.push(burn.id);
    }
    transaction.burns = burns;
    transaction.save();
  }

  if (from.toHexString() != ADDRESS_ZERO && from.toHexString() != pair.id) {
    let fromUserLiquidityPosition = createLiquidityPosition(event.address, from);
    if (fromUserLiquidityPosition !== null) {
      fromUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(from), BI_18);
      fromUserLiquidityPosition.save();
      createLiquiditySnapshot(fromUserLiquidityPosition, event);
    }
  }

  if (event.params.to.toHexString() != ADDRESS_ZERO && to.toHexString() != pair.id) {
    let toUserLiquidityPosition = createLiquidityPosition(event.address, to);
    if (toUserLiquidityPosition !== null) {
      toUserLiquidityPosition.liquidityTokenBalance = convertTokenToDecimal(pairContract.balanceOf(to), BI_18);
      toUserLiquidityPosition.save();
      createLiquiditySnapshot(toUserLiquidityPosition, event);
    }
  }
}

export function handleSync(event: Sync): void {
  const pair = Pair.load(event.address.toHex());

  if (pair == null) {
    log.debug('debug pair not found', []);
    return;
  }
  const token0 = Token.load(pair.token0);
  const token1 = Token.load(pair.token1);
  const solidly = SolidlyFactory.load(FACTORY_ADDRESS);

  if (solidly == null) {
    log.debug('debug SolidlyFactory not found', []);
    return;
  }

  if (token0 == null || token1 == null) {
    log.debug('debug token not found', []);
    return;
  }

  // reset factory liquidity by subtracting only tracked liquidity
  solidly.totalLiquidityFTM = solidly.totalLiquidityFTM.minus(pair.trackedReserveFTM as BigDecimal);

  // reset token total liquidity amounts
  token0.totalLiquidity = token0.totalLiquidity.minus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.minus(pair.reserve1);

  pair.reserve0 = convertTokenToDecimal(event.params.reserve0, token0.decimals);
  pair.reserve1 = convertTokenToDecimal(event.params.reserve1, token1.decimals);

  if (pair.reserve1.notEqual(ZERO_BD)) {
    pair.token0Price = pair.reserve0.div(pair.reserve1);
  } else {
    pair.token0Price = ZERO_BD;
  }
  if (pair.reserve0.notEqual(ZERO_BD)) {
    pair.token1Price = pair.reserve1.div(pair.reserve0);
  } else {
    pair.token1Price = ZERO_BD;
  }

  pair.save();

  // update FTM price now that reserves could have changed
  let bundle = Bundle.load('1');
  if (bundle == null) {
    log.debug('debug bundle not found', []);
    return;
  }
  bundle.ftmPrice = getFtmPriceInUSD();
  bundle.save();

  token0.derivedFTM = findFtmPerToken(token0 as Token);
  token1.derivedFTM = findFtmPerToken(token1 as Token);
  token0.save();
  token1.save();

  // get tracked liquidity - will be 0 if neither is in whitelist
  let trackedLiquidityFTM: BigDecimal;
  if (bundle.ftmPrice.notEqual(ZERO_BD)) {
    trackedLiquidityFTM = getTrackedLiquidityUSD(pair.reserve0, token0 as Token, pair.reserve1, token1 as Token).div(
      bundle.ftmPrice
    );
  } else {
    trackedLiquidityFTM = ZERO_BD;
  }

  // use derived amounts within pair
  pair.trackedReserveFTM = trackedLiquidityFTM;
  pair.reserveFTM = pair.reserve0
    .times(token0.derivedFTM as BigDecimal)
    .plus(pair.reserve1.times(token1.derivedFTM as BigDecimal));
  pair.reserveUSD = pair.reserveFTM.times(bundle.ftmPrice);

  // use tracked amounts globally
  solidly.totalLiquidityFTM = solidly.totalLiquidityFTM.plus(trackedLiquidityFTM);
  solidly.totalLiquidityUSD = solidly.totalLiquidityFTM.times(bundle.ftmPrice);

  // now correctly set liquidity amounts for each token
  token0.totalLiquidity = token0.totalLiquidity.plus(pair.reserve0);
  token1.totalLiquidity = token1.totalLiquidity.plus(pair.reserve1);

  log.debug('SYNC ALMOST COMPLETE', []);

  // save entities
  pair.save();
  solidly.save();
  token0.save();
  token1.save();

  log.debug('SYNC COMPLETE', []);
}

export function handleMint(event: Mint): void {
  const pair = Pair.load(event.address.toHex());
  const solidly = SolidlyFactory.load(FACTORY_ADDRESS);

  const transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction == null) {
    log.debug('debug transaction not found', []);
    return;
  }

  const mints = transaction.mints;
  const mint = MintEvent.load(mints[mints.length - 1]);

  if (mint == null) {
    log.debug('debug mint not found', []);
    return;
  }

  if (solidly == null) {
    log.debug('debug SolidlyFactory not found', []);
    return;
  }

  if (pair == null) {
    log.debug('debug pair not found', []);
    return;
  }

  let token0 = Token.load(pair.token0);
  let token1 = Token.load(pair.token1);

  if (token0 == null || token1 == null) {
    log.debug('debug token not found', []);
    return;
  }

  // update exchange info (except balances, sync will cover that)
  const token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // update txn counts
  pair.txCount = pair.txCount.plus(ONE_BI);
  solidly.txCount = solidly.txCount.plus(ONE_BI);

  const bundle = Bundle.load('1');

  const amountTotalUSD = getDerivedFTM(token1)
    .times(token1Amount)
    .plus(getDerivedFTM(token0).times(token0Amount))
    .times(bundle!.ftmPrice);

  // save entities
  token0.save();
  token1.save();
  pair.save();
  solidly.save();

  mint.sender = event.params.sender;
  mint.amount0 = token0Amount as BigDecimal;
  mint.amount1 = token1Amount as BigDecimal;
  mint.logIndex = event.logIndex;
  mint.amountUSD = amountTotalUSD as BigDecimal;
  mint.save();

  // update the LP position
  let liquidityPosition = createLiquidityPosition(event.address, Address.fromString(mint.to.toHexString()));

  if (liquidityPosition !== null) {
    createLiquiditySnapshot(liquidityPosition, event);
  }
}

export function handleBurn(event: Burn): void {
  const transaction = Transaction.load(event.transaction.hash.toHexString());

  // safety check
  if (transaction === null) {
    return;
  }

  const burns = transaction.burns;
  if (burns.length === 0) {
    log.debug('debug SolidlyFactory not found', []);
    return;
  }

  const burn = BurnEvent.load(burns[burns.length - 1]);
  if (burn === null) {
    log.debug('debug BurnEvent not found', []);
    return;
  }

  const pair = Pair.load(event.address.toHex());
  if (pair === null) {
    log.debug('debug pair not found', []);
    return;
  }
  const solidly = SolidlyFactory.load(FACTORY_ADDRESS);

  if (solidly === null) {
    log.debug('debug SolidlyFactory not found', []);
    return;
  }

  //update token info
  const token0 = Token.load(pair.token0);
  const token1 = Token.load(pair.token1);

  if (token0 === null || token1 === null) {
    log.debug('debug token not found', []);
    return;
  }

  const token0Amount = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const token1Amount = convertTokenToDecimal(event.params.amount1, token1.decimals);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // get new amounts of USD and ETH for tracking
  const bundle = Bundle.load('1');

  let amountTotalUSD = getDerivedFTM(token1)
    .times(token1Amount)
    .plus(getDerivedFTM(token0).times(token0Amount))
    .times(bundle!.ftmPrice);

  // update txn counts
  solidly.txCount = solidly.txCount.plus(ONE_BI);
  pair.txCount = pair.txCount.plus(ONE_BI);

  // update global counter and save
  token0.save();
  token1.save();
  pair.save();
  solidly.save();

  // update burn
  // burn.sender = event.params.sender
  burn.amount0 = token0Amount as BigDecimal;
  burn.amount1 = token1Amount as BigDecimal;
  // burn.to = event.params.to
  burn.logIndex = event.logIndex;
  burn.amountUSD = amountTotalUSD as BigDecimal;
  burn.save();

  // update the LP position
  if (burn.sender !== null) {
    // Need to do explicit conversion to satisfy complier
    const sender = burn.sender as Bytes;
    const liquidityPosition = createLiquidityPosition(event.address, Address.fromString(sender.toHexString()));
    if (liquidityPosition !== null) {
      createLiquiditySnapshot(liquidityPosition, event);
    }
  }
}

export function handleSwap(event: Swap): void {
  const pair = Pair.load(event.address.toHexString());

  if (pair == null) {
    log.debug('debug pair not found', []);
    return;
  }

  const token0 = Token.load(pair.token0);
  const token1 = Token.load(pair.token1);

  if (token0 == null || token1 == null) {
    log.debug('debug token not found', []);
    return;
  }

  const amount0In = convertTokenToDecimal(event.params.amount0In, token0.decimals);
  const amount1In = convertTokenToDecimal(event.params.amount1In, token1.decimals);
  const amount0Out = convertTokenToDecimal(event.params.amount0Out, token0.decimals);
  const amount1Out = convertTokenToDecimal(event.params.amount1Out, token1.decimals);

  // totals for volume updates
  const amount0Total = amount0Out.plus(amount0In);
  const amount1Total = amount1Out.plus(amount1In);

  // FTM/USD prices
  const bundle = Bundle.load('1');

  // get total amounts of derived USD and ETH for tracking
  const derivedAmountFTM = getDerivedFTM(token1)
    .times(amount1Total)
    .plus(getDerivedFTM(token0).times(amount0Total))
    .div(BigDecimal.fromString('2'));
  const derivedAmountUSD = derivedAmountFTM.times(bundle!.ftmPrice);

  // only accounts for volume through white listed tokens
  const trackedAmountUSD = getTrackedVolumeUSD(
    amount0Total,
    token0 as Token,
    amount1Total,
    token1 as Token,
    pair as Pair
  );

  let trackedAmountFTM: BigDecimal;
  if (bundle!.ftmPrice.equals(ZERO_BD)) {
    trackedAmountFTM = ZERO_BD;
  } else {
    trackedAmountFTM = trackedAmountUSD.div(bundle!.ftmPrice);
  }

  // update token0 global volume and token liquidity stats
  token0.tradeVolume = token0.tradeVolume.plus(amount0In.plus(amount0Out));
  token0.tradeVolumeUSD = token0.tradeVolumeUSD.plus(trackedAmountUSD);
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update token1 global volume and token liquidity stats
  token1.tradeVolume = token1.tradeVolume.plus(amount1In.plus(amount1Out));
  token1.tradeVolumeUSD = token1.tradeVolumeUSD.plus(trackedAmountUSD);
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(derivedAmountUSD);

  // update txn counts
  token0.txCount = token0.txCount.plus(ONE_BI);
  token1.txCount = token1.txCount.plus(ONE_BI);

  // update pair volume data, use tracked amount if we have it as its probably more accurate
  pair.volumeUSD = pair.volumeUSD.plus(trackedAmountUSD);
  pair.volumeToken0 = pair.volumeToken0.plus(amount0Total);
  pair.volumeToken1 = pair.volumeToken1.plus(amount1Total);
  pair.untrackedVolumeUSD = pair.untrackedVolumeUSD.plus(derivedAmountUSD);
  pair.txCount = pair.txCount.plus(ONE_BI);
  pair.save();

  // update global values, only used tracked amounts for volume
  const solidly = SolidlyFactory.load(FACTORY_ADDRESS);
  if (solidly == null) {
    log.debug('debug SolidlyFactory not found', []);
    return;
  }
  solidly.totalVolumeUSD = solidly.totalVolumeUSD.plus(trackedAmountUSD);
  solidly.totalVolumeFTM = solidly.totalVolumeFTM.plus(trackedAmountFTM);
  solidly.untrackedVolumeUSD = solidly.untrackedVolumeUSD.plus(derivedAmountUSD);
  solidly.txCount = solidly.txCount.plus(ONE_BI);

  // save entities
  pair.save();
  token0.save();
  token1.save();
  solidly.save();

  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction === null) {
    transaction = new Transaction(event.transaction.hash.toHexString());
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp;
    transaction.mints = [];
    transaction.swaps = [];
    transaction.burns = [];
  }
  let swaps = transaction.swaps;
  let swap = new SwapEvent(
    event.transaction.hash.toHexString().concat('-').concat(BigInt.fromI32(swaps.length).toString())
  );

  // update swap event
  swap.transaction = transaction.id;
  swap.pair = pair.id;
  swap.timestamp = transaction.timestamp;
  swap.transaction = transaction.id;
  swap.sender = event.params.sender;
  swap.amount0In = amount0In;
  swap.amount1In = amount1In;
  swap.amount0Out = amount0Out;
  swap.amount1Out = amount1Out;
  swap.to = event.params.to;
  swap.from = event.transaction.from;
  swap.logIndex = event.logIndex;
  // use the tracked amount if we have it
  swap.amountUSD = trackedAmountUSD === ZERO_BD ? derivedAmountUSD : trackedAmountUSD;
  swap.save();

  // update the transaction

  // TODO: Consider using .concat() for handling array updates to protect
  // against unintended side effects for other code paths.
  swaps.push(swap.id);
  transaction.swaps = swaps;
  transaction.save();
}

function getOrCreateUser(address: Address): User {
  let user = User.load(address.toHexString());
  if (user === null) {
    user = new User(address.toHexString());
    user.usdSwapped = ZERO_BD;
    user.save();
  }
  return user;
}

function createLiquidityPosition(exchange: Address, user: Address): LiquidityPosition | null {
  let id = exchange.toHexString().concat('-').concat(user.toHexString());
  let liquidityTokenBalance = LiquidityPosition.load(id);

  if (liquidityTokenBalance === null) {
    let pair = Pair.load(exchange.toHexString());
    if (pair !== null) {
      pair.liquidityProviderCount = pair.liquidityProviderCount.plus(ONE_BI);
      liquidityTokenBalance = new LiquidityPosition(id);
      liquidityTokenBalance.liquidityTokenBalance = ZERO_BD;
      liquidityTokenBalance.pair = exchange.toHexString();
      liquidityTokenBalance.user = user.toHexString();
      liquidityTokenBalance.save();
      pair.save();
    }
  }
  if (liquidityTokenBalance === null) log.error('LiquidityTokenBalance is null', [id]);
  return liquidityTokenBalance;
}

function createLiquiditySnapshot(position: LiquidityPosition, event: ethereum.Event): void {
  const timestamp = event.block.timestamp.toI32();
  const bundle = Bundle.load('1');
  const pair = Pair.load(position.pair);

  if (bundle === null) {
    log.error('Bundle is null', []);
    return;
  }

  if (pair == null) {
    log.debug('debug pair not found', []);
    return;
  }

  const token0 = Token.load(pair.token0);
  const token1 = Token.load(pair.token1);

  if (token0 === null || token1 === null) {
    log.error('token0 or token1 is null', [pair.token0, pair.token1]);
    return;
  }

  // create new snapshot
  let snapshot = new LiquidityPositionSnapshot(position.id.concat(timestamp.toString()));
  snapshot.liquidityPosition = position.id;
  snapshot.timestamp = timestamp;
  snapshot.block = event.block.number.toI32();
  snapshot.user = position.user;
  snapshot.pair = position.pair;

  if (token0.derivedFTM !== null) {
    snapshot.token0PriceUSD = getDerivedFTM(token0).times(bundle.ftmPrice);
  }

  if (token1.derivedFTM !== null) {
    snapshot.token1PriceUSD = getDerivedFTM(token1).times(bundle.ftmPrice);
  }

  snapshot.reserve0 = pair.reserve0;
  snapshot.reserve1 = pair.reserve1;
  snapshot.reserveUSD = pair.reserveUSD;
  snapshot.liquidityTokenTotalSupply = pair.totalSupply;
  snapshot.liquidityTokenBalance = position.liquidityTokenBalance;
  snapshot.liquidityPosition = position.id;
  snapshot.save();
  position.save();
}

function isCompleteMint(mintId: string): boolean {
  return MintEvent.load(mintId)!.sender !== null; // sufficient checks
}
