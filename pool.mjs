/**
 * ServerPool: catalogue + latency scoring + credential cache + failover selection.
 */

import { EventEmitter } from 'node:events';
import { UrbanClient } from './urban.mjs';
import { probeProxy, tunnelRequest } from './upstream.mjs';
import { IP_ECHO, POOL_TTL_MS, PROBE_CONCURRENCY, PROBE_URL, TOKEN_REFRESH_MARGIN_MS } from './constants.mjs';

export class ServerPool extends EventEmitter {
  /** @type {UrbanClient} */
  client;
  /** @type {Map<string, {username:string,password:string,expiresAt:number}>} */
  #tokenCache = new Map();
  #servers = [];
  #countries = [];
  #fetchedAt = 0;
  #fetching = null;
  #probeAbort = null;
  #lastProbeAt = 0;

  constructor({ store = null } = {}) {
    super();
    this.client = new UrbanClient({ store });
  }

  get servers() {
    return this.#servers;
  }
  get countries() {
    return this.#countries;
  }
  get fetchedAt() {
    return this.#fetchedAt;
  }
  get stale() {
    return Date.now() - this.#fetchedAt > POOL_TTL_MS;
  }

  /** fetch catalogue (dedupes concurrent calls) */
  async refresh({ force = false } = {}) {
    if (!force && this.#servers.length && !this.stale) {
      return { servers: this.#servers, countries: this.#countries, fetchedAt: this.#fetchedAt, cached: true };
    }
    if (this.#fetching) return this.#fetching;
    this.#fetching = (async () => {
      try {
        const { servers, countries, fetchedAt } = await this.client.fetchServers();
        // keep previously measured latency for identical endpoints
        const prev = new Map(this.#servers.map((s) => [s.id, s]));
        for (const s of servers) {
          const old = prev.get(s.id);
          if (old?.latencyMs) {
            s.latencyMs = old.latencyMs;
            s.lastCheck = old.lastCheck;
            s.successCount = old.successCount;
            s.failCount = old.failCount;
          }
        }
        this.#servers = servers;
        this.#countries = countries;
        this.#fetchedAt = fetchedAt;
        this.emit('refreshed', { count: servers.length, countries: countries.length });
        return { servers, countries, fetchedAt, cached: false };
      } finally {
        this.#fetching = null;
      }
    })();
    return this.#fetching;
  }

  /** cached proxy credential for a signature, refreshed before expiry */
  async credentialsFor(signature) {
    const hit = this.#tokenCache.get(signature);
    if (hit && hit.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) return hit;
    const tok = await this.client.getProxyToken(signature);
    const value = { username: tok.username, password: tok.password, expiresAt: tok.expiresAt, features: tok.features };
    this.#tokenCache.set(signature, value);
    return value;
  }

  /** resolve a server record into a ready-to-use proxy descriptor */
  async resolve(server) {
    const cred = await this.credentialsFor(server.signature);
    return {
      id: server.id,
      cc: server.cc,
      country: server.country,
      host: server.host,
      port: server.port,
      username: cred.username,
      password: cred.password,
    };
  }

  clearCredentials() {
    this.#tokenCache.clear();
  }

  /**
   * Probe servers with the given candidates (or all, capped) and update scores.
   * @param {{limit?:number, cc?:string, onlyUntested?:boolean, onProgress?:Function}} opts
   */
  async probe({ limit = 0, cc = null, onlyUntested = false, onProgress } = {}) {
    if (!this.#servers.length) await this.refresh();
    // group by signature so one credential covers many endpoints
    const candidates = this.#servers
      .filter((s) => (cc ? s.cc === cc : true))
      .filter((s) => (onlyUntested ? !s.latencyMs : true))
      .slice(0, limit > 0 ? limit : undefined);

    const groups = new Map();
    for (const s of candidates) {
      if (!groups.has(s.signature)) groups.set(s.signature, []);
      groups.get(s.signature).push(s);
    }

    const abort = new AbortController();
    this.#probeAbort = abort;
    let done = 0;
    const results = [];
    const total = candidates.length;

    // one credential per signature covers all of its endpoints, so probe sibling
    // endpoints of the same signature concurrently in the same work unit.
    const queue = [...groups.entries()];
    const work = async ([, list]) => {
      if (abort.signal.aborted) return;
      let proxy;
      try {
        proxy = await this.resolve(list[0]);
      } catch (e) {
        for (const s of list) {
          s.failCount++;
          s.lastCheck = Date.now();
          s.error = `credential: ${e.message}`;
        }
        done += list.length;
        onProgress?.({ done, total, cc: list[0].cc });
        return;
      }
      await Promise.all(
        list.map(async (s) => {
          if (abort.signal.aborted) return;
          const r = await probeProxy({ ...proxy, host: s.host, port: s.port }, { url: PROBE_URL });
          s.latencyMs = r.ok ? r.ms : null;
          s.lastCheck = Date.now();
          if (r.ok) s.successCount++;
          else s.failCount++;
          s.error = r.ok ? null : r.error;
          results.push({ id: s.id, cc: s.cc, ok: r.ok, ms: r.ms, error: r.error });
          done++;
          onProgress?.({ done, total, cc: s.cc });
        })
      );
    };

    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length || 1) }, async () => {
      while (queue.length && !abort.signal.aborted) {
        const item = queue.shift();
        if (!item) break;
        await work(item);
      }
    });
    await Promise.all(workers);
    this.#lastProbeAt = Date.now();
    this.#recomputeScores();
    return { tested: done, results, at: this.#lastProbeAt, aborted: abort.signal.aborted };
  }

  cancelProbe() {
    this.#probeAbort?.abort();
    this.#probeAbort = null;
  }

  #recomputeScores() {
    for (const s of this.#servers) {
      const lat = s.latencyMs ?? 9999;
      const attempts = s.successCount + s.failCount;
      const reliability = attempts === 0 ? 0.7 : s.successCount / attempts;
      const weightBonus = Math.min((s.weight || 0) / 1000, 0.3);
      // lower is better
      s.score = lat / 1000 - reliability * 3 - weightBonus;
    }
  }

  /**
   * Pick the best server.
   * @param {{cc?:string, preferLowLatency?:boolean, excludeIds?:Set<string>, maxLatencyMs?:number}} opts
   */
  pick({ cc = null, excludeIds = new Set(), maxLatencyMs = 3000 } = {}) {
    let pool = this.#servers.filter((s) => !excludeIds.has(s.id));
    if (cc && cc !== 'AUTO') pool = pool.filter((s) => s.cc === cc);
    if (!pool.length) {
      if (cc && cc !== 'AUTO') return this.pick({ cc: null, excludeIds, maxLatencyMs });
      return null;
    }
    const tested = pool.filter((s) => s.latencyMs && s.latencyMs <= maxLatencyMs && (s.error == null));
    const ranked = (tested.length ? tested : pool).slice().sort((a, b) => {
      const sa = a.latencyMs ?? 9999;
      const sb = b.latencyMs ?? 9999;
      if (sa !== sb) return sa - sb;
      return (b.weight || 0) - (a.weight || 0);
    });
    // rotate among the best few to spread load and enable failover
    const top = ranked.slice(0, Math.min(3, ranked.length));
    return top[Math.floor(Math.random() * top.length)];
  }

  /** ordered failover list for a location */
  failoverList({ cc = null, count = 6, excludeIds = new Set() } = {}) {
    let pool = this.#servers.filter((s) => !excludeIds.has(s.id));
    if (cc && cc !== 'AUTO') pool = pool.filter((s) => s.cc === cc);
    if (!pool.length) pool = this.#servers.filter((s) => !excludeIds.has(s.id));
    return pool
      .slice()
      .sort((a, b) => (a.latencyMs ?? 9999) - (b.latencyMs ?? 9999) || (b.weight || 0) - (a.weight || 0))
      .slice(0, count);
  }

  /** Verify the tunnel really changes the egress IP, and gather geo info. */
  async verifyEgress(server, { timeoutMs = 15000 } = {}) {
    const proxy = await this.resolve(server);
    const errors = [];
    for (const echo of IP_ECHO) {
      try {
        const res = await tunnelRequest(proxy, { url: echo.url, timeoutMs });
        if (res.status < 200 || res.status >= 400) {
          errors.push(`${echo.url}: HTTP ${res.status}`);
          continue;
        }
        const text = res.body.toString('utf8');
        let ip;
        if (echo.type === 'json') {
          const j = JSON.parse(text);
          ip = echo.pick(j);
        } else {
          ip = echo.pick(text);
        }
        if (ip && /^[0-9a-fA-F:.]{3,45}$/.test(String(ip).trim())) {
          const clean = String(ip).trim();
          return {
            ok: true,
            egressIp: clean,
            matchesProxyIp: clean === server.ip || clean === server.host,
            ms: res.ms,
            source: echo.url,
          };
        }
        errors.push(`${echo.url}: unparsable`);
      } catch (e) {
        errors.push(`${echo.url}: ${e.message}`);
      }
    }
    return { ok: false, errors };
  }

  /** direct (untunnelled) public IP for comparison */
  async directIp({ timeoutMs = 10000 } = {}) {
    for (const echo of IP_ECHO) {
      try {
        const ctl = AbortSignal.timeout(timeoutMs);
        const res = await fetch(echo.url, { signal: ctl, headers: { Accept: '*/*' } });
        const text = await res.text();
        let ip;
        if (echo.type === 'json') ip = echo.pick(JSON.parse(text));
        else ip = echo.pick(text);
        if (ip) return { ok: true, ip: String(ip).trim(), source: echo.url };
      } catch {
        /* try next */
      }
    }
    return { ok: false, ip: null };
  }

  findById(id) {
    return this.#servers.find((s) => s.id === id) ?? null;
  }

  stats() {
    const tested = this.#servers.filter((s) => s.latencyMs);
    const alive = tested.filter((s) => !s.error);
    return {
      total: this.#servers.length,
      tested: tested.length,
      alive: alive.length,
      countries: this.#countries.length,
      fetchedAt: this.#fetchedAt,
      lastProbeAt: this.#lastProbeAt,
      medianLatency: alive.length
        ? alive.map((s) => s.latencyMs).sort((a, b) => a - b)[Math.floor(alive.length / 2)]
        : null,
      credentialsCached: this.#tokenCache.size,
    };
  }
}
