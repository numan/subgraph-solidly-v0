import { BigDecimal, Address, BigInt } from '@graphprotocol/graph-ts';
import { Token, Pair, Bundle } from '../../generated/schema';
import { ADDRESS_ZERO, factoryContract, ONE_BD, UNTRACKED_PAIRS, ZERO_BD } from './helpers';

const WFTM_ADDRESS = '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83';
// TODO: Need to fill these our when pairs are created. Currently using from spookyswap
const DAI_WFTM_PAIR = '0x21be370d5312f44cb42ce377bc9b8a0ce00000000'; //TODO: this pair doesn't exist
const USDC_WFTM_PAIR = '0x2b4c76d0dc16be1c31d4c1dc53bf9b45987fc75c';
const USDT_WFTM_PAIR = '0x5965e53aa80a0bcf1cd6dbdd72e6a9b2aa047410';

// token where amounts should contribute to tracked volume and liquidity
const WHITELIST: string[] = [
  '0x21be370d5312f44cb42ce377bc9b8a0cef1a4c83', // WFTM
  '0x8d11ec38a3eb5e956b052f67da8bdc9bef8abf3e', // DAI
  '0x04068da6c83afcfa0e13ba15a6696662335d5b75', // USDC
  '0x9879aBDea01a879644185341F7aF7d8343556B7a', // TUSD
  '0xe1146b9ac456fcbb60644c36fd3f868a9072fc6e', // fBTC
  '0x658b0c7613e890ee50b8c4bc6a3f41ef411208ad', // fETH
  '0x321162Cd933E2Be498Cd2267a90534A804051b11', // BTC
  '0xb3654dc3d10ea7645f8319668e8f54d2574fbdc8', // LINK
  '0x69c744d3444202d35a2783929a0f930f2fbb05ad', // SFTM
  '0x82f0b8b456c1a451378467398982d4834b6829c1', // MIM
  '0xdc301622e621166bd8e82f2ca0a26c13ad0be355', // FRAX
  '0x6a07A792ab2965C72a5B8088d3a069A7aC3a993B', // AAVE
  '0x1E4F97b9f9F913c46F1632781732927B9019C68b', // CRV
  '0x56ee926bD8c72B2d5fa1aF4d9E4Cbb515a1E3Adc', // SYX
  '0x29b0Da86e484E1C0029B56e817912d778aC0EC69', //YFI
  '0xae75A438b2E0cB8Bb01Ec1E1e376De11D44477CC', // SUSHI
  '0x7d016eec9c25232b01f23ef992d98ca97fc2af5a', // FXS
  '0x468003b688943977e6130f4f68f23aad939a1040', // SPELL
  '0x2a5062d22adcfaafbd5c541d4da82e4b450d4212', // K3PR
  '0x841fad6eae12c286d1fd18d1d525dffa75c7effe', // BOO
];

// minimum liquidity for price to get tracked
const MINIMUM_LIQUIDITY_THRESHOLD_FTM = BigDecimal.fromString('2');

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
const MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString('400000')

export function getFtmPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  const daiPair = Pair.load(DAI_WFTM_PAIR); // dai is token0
  const usdcPair = Pair.load(USDC_WFTM_PAIR); // usdc is token0
  const usdtPair = Pair.load(USDT_WFTM_PAIR); // usdt is token1

  // all 3 have been created
  if (daiPair !== null && usdcPair !== null && usdtPair !== null) {
    const totalLiquidityETH = daiPair.reserve1.plus(usdcPair.reserve1).plus(usdtPair.reserve0);
    const daiWeight = daiPair.reserve1.div(totalLiquidityETH);
    const usdcWeight = usdcPair.reserve1.div(totalLiquidityETH);
    const usdtWeight = usdtPair.reserve0.div(totalLiquidityETH);
    return daiPair.token0Price
      .times(daiWeight)
      .plus(usdcPair.token0Price.times(usdcWeight))
      .plus(usdtPair.token1Price.times(usdtWeight));
    // dai and USDC have been created
  } else if (daiPair !== null && usdcPair !== null) {
    const totalLiquidityETH = daiPair.reserve1.plus(usdcPair.reserve1);
    const daiWeight = daiPair.reserve1.div(totalLiquidityETH);
    const usdcWeight = usdcPair.reserve1.div(totalLiquidityETH);
    return daiPair.token0Price.times(daiWeight).plus(usdcPair.token0Price.times(usdcWeight));
    // USDC is the only pair so far
  } else if (usdcPair !== null) {
    return usdcPair.token0Price;
  } else {
    return ZERO_BD;
  }
}

/**
 * Search through graph to find derived FTM per token.
 * @todo update to be derived FTM (add stablecoin estimates)
 **/
export function findFtmPerToken(token: Token): BigDecimal {
  if (token.id == WFTM_ADDRESS) {
    return ONE_BD;
  }
  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    let pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]), true);
    if (pairAddress.toHexString() != ADDRESS_ZERO) {
      let pair = Pair.load(pairAddress.toHexString());
      if (pair == null) {
        return ZERO_BD;
      }
      if (pair.token0 == token.id && pair.reserveFTM.gt(MINIMUM_LIQUIDITY_THRESHOLD_FTM)) {
        let token1 = Token.load(pair.token1);
        if (token1 == null) {
          return ZERO_BD;
        }
        return pair.token1Price.times(token1.derivedFTM as BigDecimal); // return token1 per our token * FTM per token 1
      }
      if (pair.token1 == token.id && pair.reserveFTM.gt(MINIMUM_LIQUIDITY_THRESHOLD_FTM)) {
        let token0 = Token.load(pair.token0);
        if (token0 == null) {
          return ZERO_BD;
        }
        return pair.token0Price.times(token0.derivedFTM as BigDecimal); // return token0 per our token * FTM per token 0
      }
    }
  }
  return ZERO_BD; // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: Pair
): BigDecimal {
  const bundle = Bundle.load('1');

  // get new amounts of USD and FTM for tracking
  const token0DerivedFTM = token0.derivedFTM || ZERO_BD;
  const token1DerivedFTM = token1.derivedFTM || ZERO_BD;

  const price0 = token0DerivedFTM.times(bundle!.ftmPrice);
  const price1 = token1DerivedFTM.times(bundle!.ftmPrice);

  // dont count tracked volume on these pairs - usually rebass tokens
  if (UNTRACKED_PAIRS.includes(pair.id)) {
    return ZERO_BD;
  }

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    let reserve0USD = pair.reserve0.times(price0);
    let reserve1USD = pair.reserve1.times(price1);
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD;
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD;
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD;
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1)).div(BigDecimal.fromString('2'));
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0);
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1);
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  let bundle = Bundle.load('1');
  if (bundle == null) {
    return ZERO_BD;
  }

  let price0 = token0.derivedFTM?.times(bundle.ftmPrice);
  let price1 = token1.derivedFTM?.times(bundle.ftmPrice);

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id) && price0 && price1) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1));
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id) && price0) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'));
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id) && price1) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'));
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD;
}
