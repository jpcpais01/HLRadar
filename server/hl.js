// Hyperliquid public API client.
// - Weight-based rate limiter (HL allows 1200 weight / minute / IP; we stay under a configurable budget).
// - Small on-disk cache so restarts don't re-download everything.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const INFO_URL = process.env.HL_INFO_URL || 'https://api.hyperliquid.xyz/info';
const STATS_URL = process.env.HL_STATS_URL || 'https://stats-data.hyperliquid.xyz/Mainnet';

// Request weights, per HL docs. Endpoints returning lists add ~1 weight per 20 items returned.
const LIGHT = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus', 'spotClearinghouseState', 'exchangeStatus']);
function baseWeight(type) {
  if (LIGHT.has(type)) return 2;
  if (type === 'userRole') return 60;
  return 20;
}

export class RateLimiter {
  constructor(weightPerMinute = 900) {
    this.capacity = weightPerMinute;
    this.tokens = weightPerMinute;
    this.refillPerMs = weightPerMinute / 60000;
    this.last = Date.now();
    this.queue = Promise.resolve();
  }
  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;
  }
  // Serialises callers so weight is spent in order.
  take(weight) {
    const run = async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= weight) { this.tokens -= weight; return; }
        const waitMs = Math.ceil((weight - this.tokens) / this.refillPerMs);
        await sleep(Math.min(waitMs, 5000));
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => {});
    return p;
  }
  // Charge extra weight after the fact (list endpoints).
  charge(weight) { this.refill(); this.tokens -= weight; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HLClient {
  constructor({ cacheDir = 'data/cache', weightPerMinute = 900 } = {}) {
    this.cacheDir = cacheDir;
    fs.mkdirSync(cacheDir, { recursive: true });
    this.limiter = new RateLimiter(weightPerMinute);
    this.stats = { requests: 0, cacheHits: 0, errors: 0 };
  }

  cachePath(key) {
    return path.join(this.cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  }
  readCache(key, ttlMs) {
    if (!ttlMs) return undefined;
    const p = this.cachePath(key);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > ttlMs) return undefined;
      this.stats.cacheHits++;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return undefined; }
  }
  writeCache(key, data) {
    try { fs.writeFileSync(this.cachePath(key), JSON.stringify(data)); } catch { /* cache is best effort */ }
  }

  async info(body, { ttlMs = 0 } = {}) {
    const key = 'info:' + JSON.stringify(body);
    const cached = this.readCache(key, ttlMs);
    if (cached !== undefined) return cached;
    let attempt = 0;
    for (;;) {
      await this.limiter.take(baseWeight(body.type));
      this.stats.requests++;
      try {
        const res = await fetch(INFO_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        if (res.status === 429) throw Object.assign(new Error('rate limited'), { retry: true, backoff: 10000 });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} for ${body.type}`), { retry: res.status >= 500 });
        const data = await res.json();
        if (Array.isArray(data)) this.limiter.charge(Math.floor(data.length / 20));
        if (ttlMs) this.writeCache(key, data);
        return data;
      } catch (e) {
        this.stats.errors++;
        attempt++;
        const retryable = e.retry || e.name === 'TimeoutError' || e.name === 'TypeError';
        if (!retryable || attempt > 4) throw e;
        await sleep((e.backoff || 1000) * attempt);
      }
    }
  }

  async stats_(pathname, { ttlMs = 0 } = {}) {
    const key = 'stats:' + pathname;
    const cached = this.readCache(key, ttlMs);
    if (cached !== undefined) return cached;
    const res = await fetch(`${STATS_URL}/${pathname}`, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
    const data = await res.json();
    if (ttlMs) this.writeCache(key, data);
    return data;
  }

  leaderboard(ttlMs = 6 * 3600e3) { return this.stats_('leaderboard', { ttlMs }); }
  vaults(ttlMs = 6 * 3600e3) { return this.stats_('vaults', { ttlMs }); }

  perpDexs(ttlMs = 3600e3) { return this.info({ type: 'perpDexs' }, { ttlMs }); }
  metaAndAssetCtxs(dex = '', ttlMs = 0) {
    return this.info(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, { ttlMs });
  }
  clearinghouseState(user, dex = '', ttlMs = 0) {
    return this.info(dex ? { type: 'clearinghouseState', user, dex } : { type: 'clearinghouseState', user }, { ttlMs });
  }
  spotClearinghouseState(user, ttlMs = 0) { return this.info({ type: 'spotClearinghouseState', user }, { ttlMs }); }
  portfolio(user, ttlMs = 0) { return this.info({ type: 'portfolio', user }, { ttlMs }); }
  historicalOrders(user, ttlMs = 0) { return this.info({ type: 'historicalOrders', user }, { ttlMs }); }
  ledger(user, startTime = 0, ttlMs = 0) { return this.info({ type: 'userNonFundingLedgerUpdates', user, startTime }, { ttlMs }); }
  subAccounts(user, ttlMs = 0) { return this.info({ type: 'subAccounts', user }, { ttlMs }); }
  extraAgents(user, ttlMs = 0) { return this.info({ type: 'extraAgents', user }, { ttlMs }); }

  // Fills between startTime and now, walking forward in pages of up to 2000 (HL keeps the 10k most recent).
  // userFillsByTime pages ascend from startTime, so for very active wallets we first look at the latest
  // 2000 fills to estimate the fill rate and move the start forward so the pages end at "now".
  async fillsSince(user, startTime, { maxPages = 5, ttlMs = 0, latest: known = null } = {}) {
    const latest = known || await this.info({ type: 'userFills', user, aggregateByTime: true }, { ttlMs });
    if (!Array.isArray(latest) || latest.length === 0) return [];
    // Fewer than 2000 fills ever: that's the whole history (kept even if older than the lookback).
    if (latest.length < 2000 || maxPages === 0) return [...latest].sort((a, b) => a.time - b.time);
    const times = latest.map((f) => f.time);
    const span = Math.max(...times) - Math.min(...times);
    const all = [];
    let cursor = Math.max(startTime, Date.now() - span * (maxPages - 0.5));
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.info({ type: 'userFillsByTime', user, startTime: cursor, aggregateByTime: true }, { ttlMs });
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 2000) break;
      cursor = batch[batch.length - 1].time + 1;
    }
    all.push(...latest);
    // De-dupe by tid (pages can overlap on equal timestamps).
    const seen = new Set();
    return all.filter((f) => (seen.has(f.tid) ? false : (seen.add(f.tid), true))).sort((a, b) => a.time - b.time);
  }
}
