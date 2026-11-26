// Hourly price history per coin, cached on disk and shared by every wallet that traded the coin.
// Used to mark open positions to market between fills (see mtm.js). Candles for finished hours never change,
// so the cache only ever grows; HL serves at most 5000 candles per request, which is ~208 days of 1h candles,
// so older history comes from 4h candles.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { mergeCandles, neededPriceRanges } from './mtm.js';

const HOUR = 3600e3;
const SPAN = { '1h': HOUR, '4h': 4 * HOUR };
const MAX_CANDLES = 4900;

export class PriceStore {
  constructor({ hl, dir }) {
    this.hl = hl;
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.mem = new Map();
    this.failed = new Set(); // coins without candle data (delisted etc.), skipped for this run
  }

  file(coin, interval) {
    return path.join(this.dir, `${coin.replace(/[^a-zA-Z0-9]/g, '_')}-${crypto.createHash('sha1').update(coin).digest('hex').slice(0, 6)}-${interval}.json`);
  }

  load(coin, interval) {
    const key = `${coin}|${interval}`;
    if (!this.mem.has(key)) {
      let v = { candles: [] };
      try { v = JSON.parse(fs.readFileSync(this.file(coin, interval), 'utf8')); } catch { /* not cached yet */ }
      this.mem.set(key, v);
    }
    return this.mem.get(key);
  }

  save(coin, interval, v) {
    this.mem.set(`${coin}|${interval}`, v);
    try { fs.writeFileSync(this.file(coin, interval), JSON.stringify(v)); } catch { /* best effort */ }
  }

  // Make sure candles cover [start, end] (fetching what is missing unless offline), return the cached series.
  async ensure(coin, interval, start, end, offline) {
    const span = SPAN[interval];
    const v = this.load(coin, interval);
    const c = v.candles;
    const have = c.length ? [c[0].t, c[c.length - 1].T] : null;
    // Covered if we have data from the start (or the coin didn't exist earlier) up to the last finished candle.
    const lastClosed = Math.floor(Math.min(end, Date.now()) / span) * span - 1;
    const headOk = have && (have[0] <= start + span || v.earliest !== undefined && v.earliest >= have[0]);
    const tailOk = have && have[1] >= lastClosed - span;
    if ((headOk && tailOk) || offline || this.failed.has(coin)) return c;
    const from = headOk ? have[1] + 1 : start;
    try {
      const got = await this.hl.candles(coin, interval, from, end);
      const fresh = (Array.isArray(got) ? got : []).map((x) => ({ t: x.t, T: x.T, h: +x.h, l: +x.l, c: +x.c }));
      const byT = new Map(c.map((x) => [x.t, x]));
      for (const x of fresh) if (x.T < Date.now()) byT.set(x.t, x); // keep only finished candles
      const merged = [...byT.values()].sort((a, b) => a.t - b.t);
      // If the API returned nothing before some point although we asked, the coin has no older data.
      const earliest = !headOk ? (fresh.length && fresh.length < MAX_CANDLES ? fresh[0].t : v.earliest) : v.earliest;
      this.save(coin, interval, { candles: merged, earliest });
      return merged;
    } catch {
      this.failed.add(coin);
      return c;
    }
  }

  // Map coin -> merged candles for everything this wallet held for an hour or more.
  async forFills(fills, { now = Date.now(), offline = false } = {}) {
    const out = new Map();
    const cut = Date.now() - MAX_CANDLES * HOUR; // 1h candles are only served this far back
    for (const [coin, [a, b]] of neededPriceRanges(fills, now)) {
      const sets = [];
      if (b > cut) sets.push(await this.ensure(coin, '1h', Math.max(a, cut), b, offline));
      if (a < cut) sets.push(await this.ensure(coin, '4h', a, Math.min(b, cut + 8 * HOUR), offline));
      const series = mergeCandles(...sets).filter((x) => x.T >= a - 4 * HOUR && x.t <= b);
      if (series.length) out.set(coin, series);
    }
    return out;
  }
}
