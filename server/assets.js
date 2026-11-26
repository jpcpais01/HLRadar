// Asset-class classification for Hyperliquid perps.
// Main-dex coins are plain names ("BTC", "kPEPE"); builder-deployed (HIP-3) markets are "dex:NAME" ("xyz:NVDA").

export const CLASSES = {
  index: { label: 'Indices / ETFs', quality: 1.0 },
  equity: { label: 'Equities', quality: 1.0 },
  commodity: { label: 'Commodities', quality: 1.0 },
  fx: { label: 'FX / Rates', quality: 1.0 },
  major: { label: 'BTC / ETH', quality: 0.9 },
  largecap: { label: 'Large-cap crypto', quality: 0.65 },
  alt: { label: 'Alts', quality: 0.4 },
  smallcap: { label: 'Small-cap alts', quality: 0.25 },
  meme: { label: 'Memecoins', quality: 0.1 },
};

const INDEX = new Set([
  'XYZ100', 'SP500', 'USA100', 'USA500', 'US500', 'USTECH', 'SMALL2000', 'JP225', 'KR200', 'NIFTY', 'IBOV', 'VIX', 'VOL',
  'EWJ', 'EWT', 'EWY', 'EWZ', 'SMH', 'SOXL', 'XBI', 'XLE', 'TLT', 'MAGS', 'MAG7', 'SEMIS', 'SEMI', 'KWEB', 'GDX', 'IGV',
  'BIOTECH', 'DEFENSE', 'ENERGY', 'INFOTECH', 'NUCLEAR', 'ROBOT', 'USENERGY', 'KORU', 'URNM', 'BVIV', 'TOTAL2', 'OTHERS', 'BTCD',
]);
const COMMODITY = new Set([
  'GOLD', 'SILVER', 'CL', 'BRENTOIL', 'OIL', 'WTI', 'USOIL', 'NATGAS', 'GAS', 'COPPER', 'ALUMINIUM', 'PLATINUM', 'PALLADIUM',
  'CORN', 'WHEAT', 'SOY', 'URANIUM', 'HO', 'TTF', 'GOLDJM', 'SILVERJM', 'GLDMINE', 'PAXG', 'DRAM', 'H100',
]);
const FX = new Set(['EUR', 'GBP', 'JPY', 'KRW', 'DXY', 'USBOND', '10Y', '2Y', '30Y']);
const MAJOR = new Set(['BTC', 'ETH']);
const LARGECAP = new Set([
  'SOL', 'XRP', 'BNB', 'HYPE', 'ADA', 'AVAX', 'LINK', 'LTC', 'BCH', 'DOT', 'TRX', 'SUI', 'TON', 'NEAR', 'APT', 'XLM', 'HBAR',
  'UNI', 'AAVE', 'ATOM', 'ETC', 'XMR', 'ZEC', 'ARB', 'OP', 'TAO', 'ICP', 'FIL', 'INJ', 'TIA', 'SEI', 'ENA', 'ONDO', 'LDO',
  'MKR', 'SKY', 'RENDER', 'FET', 'STX', 'DASH', 'POL', 'CRV', 'JUP', 'PENDLE', 'WLD', 'ALGO', 'MNT', 'KAS',
]);
const MEME = new Set([
  'DOGE', 'kPEPE', 'kBONK', 'kSHIB', 'kFLOKI', 'kLUNC', 'kNEIRO', 'WIF', 'POPCAT', 'FARTCOIN', 'PUMP', 'TRUMP', 'MELANIA',
  'MOODENG', 'GOAT', 'PNUT', 'MEW', 'BRETT', 'SPX', 'CHILLGUY', 'TURBO', 'PENGU', 'VINE', 'BOME', 'MYRO', 'NEIROETH', 'MEME',
  'PEOPLE', 'USELESS', 'CASHCAT', 'GRIFFAIN', 'AIXBT', 'HMSTR', 'DOGS', 'NOT', 'ANIME', 'BANANA', 'PURR', 'MOG', 'SLERF',
  'WLFI', 'BASED', 'ANSEM', 'TST', 'JELLY', 'FWOG', 'GIGA', 'BABY', 'ZEREBRO', 'VVV', 'PONS', 'XTEN', 'CHIP',
]);

// maxLeverage by main-dex coin, filled from meta at runtime; low max leverage => thin/small market.
const maxLevByCoin = new Map();
export function setMeta(universe) {
  for (const a of universe || []) maxLevByCoin.set(a.name, a.maxLeverage);
}

export function classify(coin) {
  if (!coin) return 'alt';
  if (coin.startsWith('@')) return 'alt'; // spot pair ids, shouldn't appear in perp fills
  const [dex, raw] = coin.includes(':') ? coin.split(':') : ['', coin];
  const name = raw.toUpperCase();
  if (INDEX.has(name)) return 'index';
  if (COMMODITY.has(name)) return 'commodity';
  if (FX.has(name)) return 'fx';
  if (dex) {
    // HIP-3 dexes: anything not crypto-named is a stock/pre-IPO style market.
    if (MAJOR.has(name)) return 'major';
    if (MEME.has(raw) || MEME.has(name)) return 'meme';
    if (LARGECAP.has(name)) return 'largecap';
    return 'equity';
  }
  if (MAJOR.has(name)) return 'major';
  if (MEME.has(raw) || MEME.has(name)) return 'meme';
  if (LARGECAP.has(name)) return 'largecap';
  const lev = maxLevByCoin.get(raw);
  if (lev !== undefined && lev <= 3) return 'smallcap';
  return 'alt';
}

export const isTradFi = (cls) => cls === 'index' || cls === 'equity' || cls === 'commodity' || cls === 'fx';
