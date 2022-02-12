import { PairCreated } from '../../generated/templates/Pair/BaseV1Factory';
import { Pair as PairTemplate } from '../../generated/templates';
import { Bundle, Pair, SolidlyFactory, Token } from '../../generated/schema';
import {
  fetchTokenDecimals,
  fetchTokenSymbol,
  fetchTokenName,
  fetchTokenTotalSupply,
  FACTORY_ADDRESS,
  ZERO_BD,
  ZERO_BI,
} from './helpers';
import { Address, log } from '@graphprotocol/graph-ts';

export function handlePairCreated(event: PairCreated): void {
  let factory = SolidlyFactory.load(FACTORY_ADDRESS);

  if (factory == null) {
    factory = new SolidlyFactory(FACTORY_ADDRESS);
    factory.pairCount = 0;
    factory.totalVolumeFTM = ZERO_BD;
    factory.totalLiquidityFTM = ZERO_BD;
    factory.totalVolumeUSD = ZERO_BD;
    factory.untrackedVolumeUSD = ZERO_BD;
    factory.totalLiquidityUSD = ZERO_BD;
    factory.txCount = ZERO_BI;

    // create new bundle
    let bundle = new Bundle('1');
    bundle.ftmPrice = ZERO_BD;
    bundle.save();
  }

  factory.pairCount += 1;
  factory.save();

  //create a token pair
  const token0 = getOrCreateToken(event.params.token0);
  const token1 = getOrCreateToken(event.params.token1);

  if (token0 === null || token1 === null) {
    log.debug('debug could not successfully get one of the tokens', []);
    return;
  }

  let pair = new Pair(event.params.pair.toHexString());
  pair.token0 = token0.id;
  pair.token1 = token1.id;
  pair.liquidityProviderCount = ZERO_BI;
  pair.createdAtTimestamp = event.block.timestamp;
  pair.createdAtBlockNumber = event.block.number;
  pair.txCount = ZERO_BI;
  pair.reserve0 = ZERO_BD;
  pair.reserve1 = ZERO_BD;
  pair.trackedReserveFTM = ZERO_BD;
  pair.reserveFTM = ZERO_BD;
  pair.reserveUSD = ZERO_BD;
  pair.totalSupply = ZERO_BD;
  pair.volumeToken0 = ZERO_BD;
  pair.volumeToken1 = ZERO_BD;
  pair.volumeUSD = ZERO_BD;
  pair.untrackedVolumeUSD = ZERO_BD;
  pair.token0Price = ZERO_BD;
  pair.token1Price = ZERO_BD;

  // create the tracked contract based on the template
  PairTemplate.create(event.params.pair)

  // save updated values
  token0.save();
  token1.save();
  pair.save();
  factory.save();
}

function getOrCreateToken(tokenAddress: Address): Token | null {
  let token = Token.load(tokenAddress.toHexString());
  const tokenAddressHex = tokenAddress.toHexString();

  // Token does not exist, so we'll create a new one
  if (token == null) {
    token = new Token(tokenAddressHex);
    token.symbol = fetchTokenSymbol(tokenAddress);
    token.name = fetchTokenName(tokenAddress);
    token.totalSupply = fetchTokenTotalSupply(tokenAddress);
    let decimals = fetchTokenDecimals(tokenAddress);

    // bail if we couldn't figure out the decimals
    if (decimals === null) {
      log.debug('debug the decimal on token 0 was null', []);
      return null;
    }

    token.decimals = decimals;
    token.derivedFTM = ZERO_BD;
    token.tradeVolume = ZERO_BD;
    token.tradeVolumeUSD = ZERO_BD;
    token.untrackedVolumeUSD = ZERO_BD;
    token.totalLiquidity = ZERO_BD;
    token.txCount = ZERO_BI;
  }

  return token;
}
