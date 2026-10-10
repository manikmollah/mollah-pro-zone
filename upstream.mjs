/**
 * Upstream tunnel: authenticated HTTP CONNECT through a free pool proxy.
 * Verified live: CONNECT returns "200 Connection established" and TLS works through it.
 */

import net from 'node:net';
import tls from 'node:tls';
import { UrbanError } from './urban.mjs';
import { PROBE_URL, PROBE_URL_ALT } from './constants.mjs';

const CONNECT_TIMEOUT_MS = 12_000;

/**
 * Open a raw TCP tunnel to targetHost:targetPort through an authenticated upstream HTTP proxy.
 * @returns {Promise<net.Socket>} connected socket already tunnelled
 */
export function openTunnel(proxy, targetHost, targetPort, { timeoutMs = CONNECT_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const started = Date.now();

    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    sock.setTimeout(timeoutMs, () => fail(new UrbanError(`Tunnel timeout after ${timeoutMs}ms`, 'TIMEOUT')));
    sock.on('error', (e) => fail(new UrbanError(`Tunnel error: ${e.code || e.message}`, e.code)));

    sock.on('connect', () => {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      const hostHeader = targetPort === 80 ? targetHost : `${targetHost}:${targetPort}`;
      const req =
        `CONNECT ${hostHeader} HTTP/1.1\r\n` +
        `Host: ${hostHeader}\r\n` +
        `Proxy-Authorization: Basic ${auth}\r\n` +
        `Proxy-Connection: keep-alive\r\n` +
        `User-Agent: MollahProZone/1.0.0\r\n\r\n`;
      sock.write(req);
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 16 * 1024) fail(new UrbanError('Upstream sent oversized header', 'BAD_RESPONSE'));
        return;
      }
      const head = buf.subarray(0, idx).toString('latin1');
      const statusLine = head.split('\r\n')[0] || '';
      const m = statusLine.match(/^HTTP\/1\.[01]\s+(\d{3})/);
      const code = m ? Number(m[1]) : 0;

      sock.off('data', onData);
      sock.setTimeout(0);

      if (code !== 200) {
        const detail = code === 407 ? 'Proxy authentication rejected' : statusLine;
        return fail(new UrbanError(`Upstream refused tunnel: ${detail}`, code));
      }
      settled = true;
      sock.rttMs = Date.now() - started;
      const rest = buf.subarray(idx + 4);
      if (rest.length) sock.unshift(rest);
      resolve(sock);
    };
    sock.on('data', onData);
  });
}

/**
 * Full round-trip HTTP request through an upstream tunnel (used for probing + IP checks).
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export async function tunnelRequest(proxy, { method = 'GET', url, headers = {}, body = null, timeoutMs = 15_000, maxBytes = 512 * 1024 }) {
  const u = new URL(url);
  const isTls = u.protocol === 'https:';
  const port = u.port ? Number(u.port) : isTls ? 443 : 80;
  const started = Date.now();
  const rawSock = await openTunnel(proxy, u.hostname, port, { timeoutMs });

  let sock = rawSock;
  if (isTls) {
    sock = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket: rawSock, servername: u.hostname, rejectUnauthorized: false }, () => resolve(t));
      t.once('error', (e) => reject(new UrbanError(`TLS handshake failed: ${e.code || e.message}`, e.code)));
      t.setTimeout(timeoutMs, () => reject(new UrbanError('TLS timeout', 'TIMEOUT')));
    });
  }

  try {
    const chunks = [];
    const done = new Promise((resolve, reject) => {
      let total = 0;
      const onData = (d) => {
        chunks.push(d);
        total += d.length;
        if (total > maxBytes) {
          sock.destroy();
          reject(new Error('response too large'));
        }
      };
      sock.on('data', onData);
      sock.on('error', reject);
      sock.on('close', () => resolve());
      sock.setTimeout(timeoutMs, () => {
        sock.destroy();
        reject(new Error('request timeout'));
      });
    });

    const reqHeaders = {
      Host: u.host,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
      Accept: '*/*',
      Connection: 'close',
      ...headers,
    };
    if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body);

    const raw = `${method} ${u.pathname}${u.search} HTTP/1.1\r\n` + Object.entries(reqHeaders).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
    sock.write(raw);
    if (body) sock.write(body);

    await done;
    const all = Buffer.concat(chunks);
    const sep = all.indexOf('\r\n\r\n');
    const head = sep === -1 ? all.toString('latin1') : all.subarray(0, sep).toString('latin1');
    const rest = sep === -1 ? Buffer.alloc(0) : all.subarray(sep + 4);
    const lines = head.split('\r\n');
    const status = Number((lines[0]?.match(/\s(\d{3})\s?/) || [])[1] || 0);
    const resHeaders = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) resHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    let payload = rest;
    if ((resHeaders['transfer-encoding'] || '').includes('chunked')) payload = dechunk(payload);
    return { status, headers: resHeaders, body: payload, ms: Date.now() - started };
  } finally {
    sock.destroy();
  }
}

function dechunk(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf('\r\n', pos);
    if (nl === -1) break;
    const size = parseInt(buf.subarray(pos, nl).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.subarray(nl + 2, nl + 2 + size));
    pos = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * Forward a plain-HTTP request through an upstream proxy using the absolute-URI form.
 * (Verified upstream behaviour: CONNECT is only honoured for TLS/443; port-80 traffic
 * must be sent as `GET http://host/path` straight to the proxy.)
 * @returns {Promise<net.Socket>} socket connected to the proxy, request already written
 */
export function openForward(proxy, { method, url, headers, body, timeoutMs = CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    sock.setTimeout(timeoutMs, () => fail(new UrbanError(`Forward timeout after ${timeoutMs}ms`, 'TIMEOUT')));
    sock.on('error', (e) => fail(new UrbanError(`Forward error: ${e.code || e.message}`, e.code)));
    sock.on('connect', () => {
      sock.setTimeout(0);
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      const out = { ...(headers || {}) };
      delete out['proxy-authorization'];
      delete out['proxy-connection'];
      out.Host = out.Host || u.host;
      const raw =
        `${method} ${u.href} HTTP/1.1\r\n` +
        Object.entries(out)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n') +
        `\r\nProxy-Authorization: Basic ${auth}\r\nProxy-Connection: keep-alive\r\n\r\n`;
      settled = true;
      sock.write(raw);
      if (body?.length) sock.write(body);
      resolve(sock);
    });
  });
}

/**
 * Measure raw tunnel RTT (TCP connect to upstream + authenticated CONNECT),
 * then confirm end-to-end liveness with a lightweight HTTPS 204 through it.
 * Reporting the connect RTT keeps the number comparable to a normal ping.
 */
export async function probeProxy(proxy, { url = PROBE_URL, altUrl = PROBE_URL_ALT, timeoutMs = 8000, verify = true } = {}) {
  const t0 = Date.now();
  try {
    const sock = await openTunnel(proxy, 'www.gstatic.com', 443, { timeoutMs });
    const rtt = sock.rttMs ?? Date.now() - t0;
    sock.destroy();
    if (!verify) return { ok: true, ms: rtt, rtt, target: 'connect' };

    // confirm the tunnel actually carries traffic
    for (const target of [url, altUrl].filter(Boolean)) {
      const t1 = Date.now();
      try {
        const res = await tunnelRequest(proxy, { url: target, timeoutMs, maxBytes: 8192 });
        if (res.status >= 200 && res.status < 400) {
          return { ok: true, ms: rtt, rtt, verifiedMs: Date.now() - t1, target };
        }
      } catch {
        /* try next target */
      }
    }
    // TCP+CONNECT worked but no liveness confirmation; treat as alive with a penalty
    return { ok: true, ms: rtt, rtt, verified: false, degraded: true, target: 'connect-only' };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message };
  }
}
