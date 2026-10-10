/**
 * Local proxy engine (Mollah Pro Zone).
 *
 * Listens on 127.0.0.1:<port> and speaks BOTH:
 *   - SOCKS5  (no-auth locally; CONNECT command)  -> used by apps/browsers
 *   - HTTP    (CONNECT tunneling + absolute-URI forwarding + PAC serving)
 *
 * Every accepted connection is tunnelled through the active upstream free proxy
 * with real Proxy-Authorization, so the egress IP genuinely changes.
 *
 * Also serves:
 *   GET /proxy.pac   -> split-tunnel PAC for system-wide split routing
 */

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { openTunnel, openForward } from './upstream.mjs';
import { NEVER_TUNNEL } from './constants.mjs';

const SOCKS_VERSION = 5;

export class ProxyEngine extends EventEmitter {
  #server = null;
  #port;
  #host;
  #connections = new Set();
  #activeUpstream = null;
  #exclusions = [];
  #blockedLog = [];
  #stats = { bytesIn: 0, bytesOut: 0, totalConnections: 0, activeConnections: 0, errors: 0, startedAt: 0 };
  #logLimit = 300;

  constructor({ host = '127.0.0.1', port = 8899 } = {}) {
    super();
    this.#host = host;
    this.#port = port;
  }

  get port() {
    return this.#port;
  }
  get host() {
    return this.#host;
  }
  get listening() {
    return !!this.#server?.listening;
  }
  get stats() {
    return { ...this.#stats, upstream: this.#activeUpstream?.id ?? null };
  }
  get recentLog() {
    return this.#blockedLog.slice(-60).reverse();
  }

  /** Upstream proxy descriptor: {id, cc, country, host, port, username, password} or null for DIRECT */
  setUpstream(upstream) {
    const changed = this.#activeUpstream?.id !== upstream?.id;
    this.#activeUpstream = upstream;
    if (changed) this.emit('upstream', upstream);
    return changed;
  }

  setUpstreams(list) {
    // failover chain
    this.#chain = Array.isArray(list) ? list.filter(Boolean) : [];
    this.#activeUpstream = this.#chain[0] ?? null;
  }

  #chain = [];

  setExclusions(patterns) {
    this.#exclusions = (patterns || [])
      .map((p) => String(p).trim().toLowerCase())
      .filter(Boolean);
  }

  get exclusions() {
    return [...NEVER_TUNNEL, ...this.#exclusions];
  }

  shouldBypass(hostname) {
    const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return true;
    if (/^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
    for (const raw of this.#exclusions) {
      const p = raw.replace(/^\*\.?/, '');
      if (h === p || h.endsWith('.' + p)) return true;
      if (raw.startsWith('*') && h.endsWith(p)) return true;
    }
    return false;
  }

  async start() {
    if (this.#server) return this.#port;
    this.#server = net.createServer((socket) => this.#onConnection(socket));
    this.#server.on('error', (err) => this.emit('error', err));

    // A leftover process can hold the gateway port. Try the preferred port, then
    // nearby alternatives, so a stale instance never blocks startup.
    const candidates = [this.#port, this.#port + 1, this.#port + 2, this.#port + 10, 0];
    let lastErr = null;

    for (const port of candidates) {
      try {
        await new Promise((resolve, reject) => {
          const onError = (err) => {
            this.#server.off('listening', onListening);
            reject(err);
          };
          const onListening = () => {
            this.#server.off('error', onError);
            resolve();
          };
          this.#server.once('error', onError);
          this.#server.once('listening', onListening);
          this.#server.listen(port, this.#host);
        });

        this.#port = this.#server.address().port;
        this.#stats.startedAt = Date.now();
        this.emit('listening', { host: this.#host, port: this.#port });
        return this.#port;
      } catch (err) {
        lastErr = err;
        if (err.code !== 'EADDRINUSE') break;
      }
    }

    // every candidate failed: drop the server so a later retry can rebuild it
    try {
      this.#server.close();
    } catch {
      /* ignore */
    }
    this.#server = null;
    throw new Error(
      `Could not start the local proxy engine on port ${this.#port}: ${lastErr?.code || lastErr?.message || 'unknown error'}`
    );
  }

  async stop() {
    for (const s of this.#connections) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    this.#connections.clear();
    if (this.#server) {
      await new Promise((r) => this.#server.close(r));
      this.#server = null;
    }
    this.#stats.activeConnections = 0;
  }

  /** open a tunnel to an arbitrary target using the current upstream (with failover) */
  async openUpstream(targetHost, targetPort) {
    const chain = this.#chain.length ? this.#chain : this.#activeUpstream ? [this.#activeUpstream] : [];
    if (!chain.length) {
      // DIRECT fallback
      return await new Promise((resolve, reject) => {
        const s = net.connect({ host: targetHost, port: targetPort });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
    }
    let lastErr;
    for (let i = 0; i < chain.length; i++) {
      const up = chain[i];
      try {
        const sock = await openTunnel(up, targetHost, targetPort);
        if (i > 0) {
          // promote the working node
          this.#chain = [up, ...chain.filter((c) => c.id !== up.id)];
          this.#activeUpstream = up;
          this.emit('failover', { to: up });
        }
        return sock;
      } catch (err) {
        lastErr = err;
        this.emit('upstream-error', { upstream: up, error: err.message });
      }
    }
    this.#stats.errors++;
    throw lastErr ?? new Error('no upstream available');
  }

  /** forward a plain-HTTP request through the active upstream (absolute-URI form) */
  async forwardUpstream({ method, url, headers, body }) {
    const chain = this.#chain.length ? this.#chain : this.#activeUpstream ? [this.#activeUpstream] : [];
    if (!chain.length) throw new Error('no upstream available');
    let lastErr;
    for (let i = 0; i < chain.length; i++) {
      const up = chain[i];
      try {
        const sock = await openForward(up, { method, url, headers, body });
        if (i > 0) {
          this.#chain = [up, ...chain.filter((c) => c.id !== up.id)];
          this.#activeUpstream = up;
          this.emit('failover', { to: up });
        }
        return sock;
      } catch (err) {
        lastErr = err;
        this.emit('upstream-error', { upstream: up, error: err.message });
      }
    }
    this.#stats.errors++;
    throw lastErr ?? new Error('no upstream available');
  }

  #push(entry) {
    this.#blockedLog.push({ at: Date.now(), ...entry });
    if (this.#blockedLog.length > this.#logLimit) this.#blockedLog.shift();
  }

  #onConnection(socket) {
    socket.setNoDelay(true);
    this.#connections.add(socket);
    this.#stats.totalConnections++;
    this.#stats.activeConnections = this.#connections.size;
    socket.once('close', () => {
      this.#connections.delete(socket);
      this.#stats.activeConnections = this.#connections.size;
    });
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    });
    socket.once('data', (chunk) => {
      socket.pause();
      const first = chunk[0];
      if (first === SOCKS_VERSION) {
        this.#handleSocks(socket, chunk).catch((e) => this.#fail(socket, e));
      } else {
        this.#handleHttp(socket, chunk).catch((e) => this.#fail(socket, e));
      }
    });
  }

  #fail(socket, err) {
    this.#stats.errors++;
    this.#push({ type: 'error', message: err?.message ?? String(err) });
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------- SOCKS5

  async #handleSocks(socket, firstChunk) {
    socket.pause();
    let buf = firstChunk;

    // greeting: VER, NMETHODS, METHODS...
    if (buf.length < 2) buf = await readMore(socket, buf, 2);
    const nMethods = buf[1];
    const need = 2 + nMethods;
    if (buf.length < need) buf = await readMore(socket, buf, need);
    const methods = [...buf.subarray(2, need)];
    if (!methods.includes(0x00)) {
      socket.write(Buffer.from([0x05, 0xff]));
      socket.destroy();
      return;
    }
    socket.write(Buffer.from([0x05, 0x00]));
    buf = buf.subarray(need);

    // request: VER, CMD, RSV, ATYP, ADDR, PORT
    if (buf.length < 4) buf = await readMore(socket, buf, 4);
    const cmd = buf[1];
    const atyp = buf[3];
    let offset = 4;
    let targetHost = null;

    if (atyp === 0x01) {
      if (buf.length < offset + 4) buf = await readMore(socket, buf, offset + 4);
      targetHost = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`;
      offset += 4;
    } else if (atyp === 0x03) {
      if (buf.length < offset + 1) buf = await readMore(socket, buf, offset + 1);
      const len = buf[offset];
      if (buf.length < offset + 1 + len) buf = await readMore(socket, buf, offset + 1 + len);
      targetHost = buf.subarray(offset + 1, offset + 1 + len).toString('utf8');
      offset += 1 + len;
    } else if (atyp === 0x04) {
      if (buf.length < offset + 16) buf = await readMore(socket, buf, offset + 16);
      const segs = [];
      for (let i = 0; i < 16; i += 2) segs.push(buf.readUInt16BE(offset + i).toString(16));
      targetHost = segs.join(':');
      offset += 16;
    } else {
      socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      socket.destroy();
      return;
    }
    if (buf.length < offset + 2) buf = await readMore(socket, buf, offset + 2);
    const targetPort = buf.readUInt16BE(offset);
    offset += 2;
    const leftover = buf.subarray(offset);

    if (cmd !== 0x01) {
      // only CONNECT supported
      socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      socket.destroy();
      return;
    }

    const bypass = this.shouldBypass(targetHost);
    let upstreamSock;
    try {
      upstreamSock = bypass
        ? await new Promise((res, rej) => {
            const s = net.connect({ host: targetHost, port: targetPort });
            s.once('connect', () => res(s));
            s.once('error', rej);
          })
        : await this.openUpstream(targetHost, targetPort);
    } catch (err) {
      socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
      this.#push({ type: 'denied', via: 'socks5', target: `${targetHost}:${targetPort}`, reason: err.message });
      socket.destroy();
      return;
    }

    socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    this.#push({ type: 'allow', via: 'socks5', target: `${targetHost}:${targetPort}`, bypass });
    this.#pipe(socket, upstreamSock, leftover);
  }

  // ------------------------------------------------------------------ HTTP

  async #handleHttp(socket, firstChunk) {
    socket.pause();
    let buf = firstChunk;
    let headerEnd = buf.indexOf('\r\n\r\n');
    while (headerEnd === -1) {
      if (buf.length > 64 * 1024) throw new Error('header too large');
      buf = await readMore(socket, buf, buf.length + 1);
      headerEnd = buf.indexOf('\r\n\r\n');
    }
    const head = buf.subarray(0, headerEnd).toString('latin1');
    const rest = buf.subarray(headerEnd + 4);
    const lines = head.split('\r\n');
    const [method, target, version] = lines[0].split(' ');
    const headers = {};
    for (const line of lines.slice(1)) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }

    // local PAC endpoint
    if (method === 'GET' && (target === '/proxy.pac' || target === '/wpad.dat')) {
      const body = this.buildPac();
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n` +
          body
      );
      socket.end();
      return;
    }
    if (method === 'GET' && target === '/') {
      const body = 'Mollah Pro Zone proxy engine OK\n';
      socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      socket.end();
      return;
    }

    if (method === 'CONNECT') {
      const [hostPart, portPart] = splitHostPort(target, 443);
      const bypass = this.shouldBypass(hostPart);
      let upstreamSock;
      try {
        upstreamSock = bypass ? await directConnect(hostPart, portPart) : await this.openUpstream(hostPart, portPart);
      } catch (err) {
        socket.write(`HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        this.#push({ type: 'denied', via: 'connect', target, reason: err.message });
        socket.destroy();
        return;
      }
      socket.write(`HTTP/1.1 200 Connection established\r\nProxy-Agent: MollahProZone/1.0\r\n\r\n`);
      this.#push({ type: 'allow', via: 'connect', target, bypass });
      this.#pipe(socket, upstreamSock, rest);
      return;
    }

    // absolute-URI plain HTTP forwarding (upstream expects the absolute-URI form)
    let url;
    try {
      url = new URL(target);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const bypass = this.shouldBypass(url.hostname);
    const isHttps = url.protocol === 'https:';
    const port = url.port ? Number(url.port) : isHttps ? 443 : 80;

    const outHeaders = { ...headers };
    delete outHeaders['proxy-authorization'];
    delete outHeaders['proxy-connection'];
    outHeaders.host = outHeaders.host || url.host;

    let upstreamSock;
    try {
      if (bypass || isHttps) {
        // direct CONNECT for bypassed hosts; TLS tunnels need CONNECT too
        upstreamSock = bypass ? await directConnect(url.hostname, port) : await this.openUpstream(url.hostname, port);
        const rebuilt =
          `${method} ${url.pathname}${url.search} ${version || 'HTTP/1.1'}\r\n` +
          Object.entries(outHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n';
        upstreamSock.write(rebuilt);
      } else {
        // plain HTTP through the proxy: absolute-URI forwarded straight to the proxy
        upstreamSock = await this.forwardUpstream({
          method,
          url: url.href,
          headers: outHeaders,
          body: rest?.length ? rest : null,
        });
      }
    } catch (err) {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      this.#push({ type: 'denied', via: 'http', target, reason: err.message });
      socket.destroy();
      return;
    }
    this.#push({ type: 'allow', via: 'http', target, bypass });
    const alreadySent = !bypass && !isHttps;
    this.#pipe(socket, upstreamSock, alreadySent ? null : rest);
  }

  // ------------------------------------------------------------------ pipe

  #pipe(clientSock, upstreamSock, leftover) {
    upstreamSock.setNoDelay?.(true);
    const onClientData = (d) => {
      this.#stats.bytesOut += d.length;
      if (!upstreamSock.write(d)) clientSock.pause();
    };
    const onUpstreamData = (d) => {
      this.#stats.bytesIn += d.length;
      if (!clientSock.write(d)) upstreamSock.pause();
    };
    upstreamSock.on('drain', () => clientSock.resume());
    clientSock.on('drain', () => upstreamSock.resume());

    clientSock.on('data', onClientData);
    upstreamSock.on('data', onUpstreamData);

    const teardown = () => {
      clientSock.off('data', onClientData);
      upstreamSock.off('data', onUpstreamData);
      clientSock.destroy();
      upstreamSock.destroy();
    };
    clientSock.once('close', teardown);
    clientSock.once('error', teardown);
    upstreamSock.once('close', teardown);
    upstreamSock.once('error', teardown);

    clientSock.resume();
    upstreamSock.resume();
    if (leftover?.length) {
      this.#stats.bytesOut += leftover.length;
      upstreamSock.write(leftover);
    }
  }

  // ------------------------------------------------------------------- PAC

  buildPac() {
    const list = [...NEVER_TUNNEL, ...this.#exclusions];
    const patterns = list.map((h) => `"${h.replace(/"/g, '')}"`).join(',');
    return `// Mollah Pro Zone - split tunnel PAC
function FindProxyForURL(url, host) {
  host = host.toLowerCase();
  if (isPlainHostName(host) || host === "localhost" || host === "127.0.0.1") return "DIRECT";
  if (shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") ||
      shExpMatch(host, "172.16.*") || shExpMatch(host, "172.17.*") ||
      shExpMatch(host, "172.18.*") || shExpMatch(host, "172.19.*") ||
      shExpMatch(host, "172.2?.*") || shExpMatch(host, "172.30.*") ||
      shExpMatch(host, "172.31.*") || shExpMatch(host, "169.254.*")) return "DIRECT";
  var bypass = [${patterns}];
  for (var i = 0; i < bypass.length; i++) {
    var p = bypass[i];
    if (host === p || dnsDomainIs(host, "." + p) || shExpMatch(host, "*." + p)) return "DIRECT";
  }
  return "SOCKS5 127.0.0.1:${this.#port}; SOCKS 127.0.0.1:${this.#port}; PROXY 127.0.0.1:${this.#port}";
}
`;
  }
}

// ------------------------------------------------------------------ helpers

function splitHostPort(target, defaultPort) {
  const m = String(target).match(/^\[(.+)\]:(\d+)$/);
  if (m) return [m[1], Number(m[2])];
  const i = target.lastIndexOf(':');
  if (i > -1 && !target.slice(i + 1).includes(']')) {
    const p = Number(target.slice(i + 1));
    if (Number.isFinite(p)) return [target.slice(0, i), p];
  }
  return [target, defaultPort];
}

function directConnect(host, port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

/** read until buffer length >= needed */
function readMore(socket, buf, needed, timeoutMs = 15000) {
  socket.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('read timeout'));
    }, timeoutMs);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= needed) {
        cleanup();
        socket.pause();
        resolve(buf);
      }
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('socket closed early'));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
      socket.off('end', onEnd);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
    socket.on('end', onEnd);
  });
}
