/**
 * Urban VPN free-tier client.
 * Reverse-engineered auth chain (verified live):
 *   1. POST /registrations/clientApps/<app>/users/anonymous  -> auth token (anon)
 *   2. POST /security/tokens/accs   (Bearer auth)            -> security JWT
 *   3. GET  /entrypoints/countries  (Bearer security)        -> free proxy servers
 *   4. POST /security/tokens/accs-proxy { signature }        -> per-server proxy token
 *      Proxy credentials are: username = token.value, password = "1"
 */

import { CLIENT_APP, EP, UA } from './constants.mjs';

export class UrbanError extends Error {
  constructor(message, status, url, body) {
    super(message);
    this.name = 'UrbanError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const RETRY = { attempts: 4, baseDelayMs: 900 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** parse "try again in 37s" style hints, or Retry-After headers */
function retryAfterMs(err) {
  const text = String(err?.body?.detail || err?.body?.message || err?.message || '');
  const m = text.match(/(\d+)\s*(second|sec|s\b|minute|min|m\b)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    return unit.startsWith('m') ? n * 60_000 : n * 1000;
  }
  return null;
}

async function withRetry(fn, label) {
  let lastErr;
  for (let i = 0; i < RETRY.attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 4xx (except rate limiting) will not succeed on retry
      if (err instanceof UrbanError && err.status >= 400 && err.status < 500 && err.status !== 429) throw err;

      if (i < RETRY.attempts - 1) {
        if (err instanceof UrbanError && err.status === 429) {
          const hinted = retryAfterMs(err);
          const wait = hinted ?? Math.min(30_000, 3000 * Math.pow(2, i));
          await sleep(wait);
        } else {
          await sleep(RETRY.baseDelayMs * (i + 1));
        }
      }
    }
  }
  if (lastErr instanceof UrbanError && lastErr.status === 429) {
    const e = new UrbanError(
      `The free server service is temporarily rate-limiting this machine. ` +
        `Wait about a minute and press Retry — no need to restart the app.`,
      429
    );
    throw e;
  }
  throw new UrbanError(`${label} failed after ${RETRY.attempts} attempts: ${lastErr?.message}`, lastErr?.status);
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function assertOk(res, json, label) {
  if (res.status < 200 || res.status >= 400) {
    const detail =
      json && typeof json === 'object'
        ? json.detail || json.message || json.title || JSON.stringify(json).slice(0, 300)
        : String(json).slice(0, 300);
    throw new UrbanError(`${label}: HTTP ${res.status} ${detail}`, res.status, res.url, json);
  }
}

export class UrbanClient {
  #authToken = null;
  #authOwnerId = null;
  #securityToken = null;
  #securityTokenAt = 0;
  #securityTokenTtlMs = 30 * 60 * 1000;
  /** optional persistence so restarts reuse the same anonymous identity */
  #store = null;

  constructor({ store = null } = {}) {
    this.#store = store;
    this.#restore();
  }

  #restore() {
    if (!this.#store) return;
    try {
      const saved = this.#store.getSecret('urbanSession');
      if (!saved) return;
      const now = Date.now();
      if (saved.authToken && (!saved.authExpiresAt || saved.authExpiresAt > now + 60_000)) {
        this.#authToken = saved.authToken;
        this.#authOwnerId = saved.ownerId ?? null;
      }
      if (saved.securityToken && saved.securityExpiresAt > now + 60_000) {
        this.#securityToken = saved.securityToken;
        this.#securityTokenAt = saved.securityAt ?? now;
        this.#securityTokenTtlMs = saved.securityExpiresAt - (saved.securityAt ?? now);
      }
    } catch {
      /* start fresh if the vault cannot be read */
    }
  }

  #persist() {
    if (!this.#store) return;
    try {
      this.#store.setSecret('urbanSession', {
        authToken: this.#authToken,
        ownerId: this.#authOwnerId,
        securityToken: this.#securityToken,
        securityAt: this.#securityTokenAt,
        securityExpiresAt: this.#securityTokenAt + this.#securityTokenTtlMs,
        savedAt: Date.now(),
      });
    } catch {
      /* persistence is best-effort */
    }
  }

  /** anonymous registration (or reuse of supplied token) */
  async registerAnonymous() {
    return withRetry(async () => {
      const url = `${EP.accountApi}/registrations/clientApps/${CLIENT_APP}/users/anonymous`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ clientApp: { name: CLIENT_APP, browser: 'CHROME' } }),
      });
      const json = await readBody(res);
      assertOk(res, json, 'registerAnonymous');
      const token = json?.value || json?.token;
      if (!token) throw new UrbanError('registerAnonymous: no token in response', res.status, url, json);
      this.#authToken = token;
      this.#authOwnerId = json?.owner?.id ?? null;
      this.#securityToken = null;
      this.#securityTokenAt = 0;
      this.#persist();
      return { token, ownerId: this.#authOwnerId, expiresAt: json?.expirationTime ?? null };
    }, 'registerAnonymous');
  }

  /** exchange the anon auth token for the security token used by all stats APIs */
  async getSecurityToken() {
    if (!this.#authToken) await this.registerAnonymous();
    return withRetry(async () => {
      const url = `${EP.securityApi}/security/tokens/accs`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': UA,
          authorization: `Bearer ${this.#authToken}`,
        },
        body: JSON.stringify({ type: 'accs', clientApp: { name: CLIENT_APP } }),
      });
      const json = await readBody(res);
      assertOk(res, json, 'getSecurityToken');
      const token = json?.value || json?.token;
      if (!token) throw new UrbanError('getSecurityToken: no token in response', res.status, url, json);
      this.#securityToken = token;
      this.#securityTokenAt = Date.now();
      // JWT-ish token: try to read exp
      this.#securityTokenTtlMs = decodeJwtTtl(token) ?? this.#securityTokenTtlMs;
      this.#persist();
      return token;
    }, 'getSecurityToken');
  }

  async #ensureSecurityToken() {
    const age = Date.now() - this.#securityTokenAt;
    if (!this.#securityToken || age > this.#securityTokenTtlMs - 60_000) {
      await this.getSecurityToken();
    }
    return this.#securityToken;
  }

  /**
   * Fetch the free server catalogue.
   * @returns {Promise<{servers: Array, countries: Array, fetchedAt: number}>}
   */
  async fetchServers({ includePremium = false } = {}) {
    const token = await this.#ensureSecurityToken();
    return withRetry(async () => {
      const url = `${EP.statsApi}/entrypoints/countries`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          pragma: 'no-cache',
          'cache-control': 'no-cache',
          'User-Agent': UA,
          'X-Client-App': CLIENT_APP,
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await readBody(res);
      assertOk(res, json, 'fetchServers');

      const elements = json?.countries?.elements ?? [];
      const servers = [];
      const countries = [];

      for (const c of elements) {
        const cc = c?.code?.iso2 ?? 'XX';
        const title = c?.title ?? cc;
        const accessType = c?.accessType ?? 'UNKNOWN';
        const srvList = c?.servers?.elements ?? [];
        let usable = 0;

        for (const s of srvList) {
          const premium = !!s.premium;
          if (premium && !includePremium) continue;
          const primary = s?.address?.primary;
          if (!primary?.host) continue;
          const secondary = Array.isArray(s?.address?.secondary) ? s.address.secondary : [];
          const entries = [primary, ...secondary];
          entries.forEach((addr, idx) => {
            if (!addr?.host) return;
            servers.push({
              id: `${cc}-${addr.host}-${addr.port || 8081}-${idx}`,
              cc,
              country: title,
              city: s?.city ?? null,
              host: addr.host,
              ip: addr.ip ?? null,
              port: addr.port || 8081,
              signature: s.signature,
              premium,
              accessType,
              pool: s?.pool ?? null,
              weight: typeof s.weight === 'number' ? s.weight : 0,
              primary: idx === 0,
              latencyMs: null,
              lastCheck: 0,
              successCount: 0,
              failCount: 0,
              score: 0,
            });
            usable++;
          });
        }

        countries.push({
          cc,
          name: title,
          accessType,
          serverCount: usable,
          premium: srvList.length > 0 && srvList.every((s) => !!s.premium),
          flag: cc.toLowerCase(),
        });
      }

      countries.sort((a, b) => a.name.localeCompare(b.name));
      servers.sort((a, b) => a.country.localeCompare(b.country) || (b.weight || 0) - (a.weight || 0));
      return { servers, countries, fetchedAt: Date.now(), raw: json };
    }, 'fetchServers');
  }

  /**
   * Get proxy credentials for a server signature.
   * @returns {Promise<{username: string, password: string, expiresAt: number, raw: object}>}
   */
  async getProxyToken(signature) {
    if (!signature) throw new UrbanError('getProxyToken: signature required');
    const token = await this.#ensureSecurityToken();
    return withRetry(async () => {
      const url = `${EP.securityApi}/security/tokens/accs-proxy`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': UA,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          type: 'accs-proxy',
          clientApp: { name: CLIENT_APP },
          signature,
        }),
      });
      const json = await readBody(res);
      assertOk(res, json, 'getProxyToken');
      const value = json?.value || json?.token;
      if (!value) throw new UrbanError('getProxyToken: no token value', res.status, url, json);
      const expiresAt = json?.expirationTime ?? Date.now() + 25 * 60 * 1000;
      return {
        username: value,
        password: '1',
        expiresAt,
        features: json?.features ?? [],
        locations: json?.locations ?? [],
        raw: json,
      };
    }, 'getProxyToken');
  }

  /** auto/random server entrypoint */
  async fetchAutoServer() {
    const token = await this.#ensureSecurityToken();
    return withRetry(async () => {
      const url = `${EP.statsApi}/entrypoints/autoserver`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': UA,
          'X-Client-App': CLIENT_APP,
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await readBody(res);
      assertOk(res, json, 'fetchAutoServer');
      return json;
    }, 'fetchAutoServer');
  }

  /** streaming-optimised servers (Netflix pools etc.) */
  async fetchStreamingServers() {
    const token = await this.#ensureSecurityToken();
    return withRetry(async () => {
      const url = `${EP.statsApi}/entrypoints/streamingservers`;
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': UA,
          'X-Client-App': CLIENT_APP,
          Authorization: `Bearer ${token}`,
        },
      });
      const json = await readBody(res);
      assertOk(res, json, 'fetchStreamingServers');
      return json;
    }, 'fetchStreamingServers');
  }

  get hasSession() {
    return !!this.#authToken;
  }

  get ownerId() {
    return this.#authOwnerId;
  }
}

function decodeJwtTtl(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (json?.exp) return json.exp * 1000 - Date.now();
  } catch {
    /* not a JWT we can read */
  }
  return null;
}
