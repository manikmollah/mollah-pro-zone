/**
 * VpnController - the brain. Owns connect/disconnect, protocol modes,
 * health monitoring, automatic failover and session accounting.
 *
 * States: idle | preparing | connecting | connected | switching | disconnecting | error
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { ServerPool } from './pool.mjs';
import { ProxyEngine } from './proxy-engine.mjs';
import { HEALTH_INTERVAL_MS } from './constants.mjs';
import { geoFor, regionFor } from './geo.mjs';
import * as win from '../platform/windows.mjs';

export class VpnController extends EventEmitter {
  /** @type {ServerPool} */
  pool;
  /** @type {ProxyEngine} */
  engine;
  /** @type {import('./store.mjs').Store} */
  store;

  state = 'idle';
  #activeServer = null;
  #activeResolved = null;
  #failoverChain = [];
  #failedIds = new Set();
  #healthTimer = null;
  #connectStartedAt = 0;
  #proxyBackup = null;
  #lastError = null;
  #routingError = null;
  #engineError = null;
  #tzBackup = null;
  #tzApplied = null;
  #tzError = null;
  #lastVerify = null;
  #directIp = null;
  #connecting = null;
  #sessionBytes = { bytesIn: 0, bytesOut: 0 };
  #switchHistory = [];

  constructor(store) {
    super();
    this.store = store;
    this.pool = new ServerPool({ store });
    this.engine = new ProxyEngine({ port: store.settings.gatewayPort });

    this.pool.on('refreshed', (info) => this.emit('pool', info));
    this.engine.on('upstream-error', (e) => this.emit('log', { level: 'warn', msg: `upstream failed: ${e.upstream?.cc} ${e.error}` }));
    this.engine.on('failover', (e) => this.emit('log', { level: 'info', msg: `failover -> ${e.to?.cc} ${e.to?.host}` }));
    this.engine.on('error', (e) => this.emit('log', { level: 'error', msg: `engine: ${e.message}` }));
  }

  get activeServer() {
    return this.#activeServer;
  }
  get activeResolved() {
    return this.#activeResolved;
  }
  get isConnected() {
    return this.state === 'connected';
  }
  get lastError() {
    return this.#lastError;
  }
  get lastVerify() {
    return this.#lastVerify;
  }
  get switchHistory() {
    return this.#switchHistory.slice(-20);
  }

  snapshot() {
    const eng = this.engine.stats;
    const direct = this.#directIp;
    const egress = this.#lastVerify?.egressIp ?? null;
    return {
      state: this.state,
      activeServer: this.#activeServer
        ? {
            id: this.#activeServer.id,
            cc: this.#activeServer.cc,
            country: this.#activeServer.country,
            host: this.#activeServer.host,
            port: this.#activeServer.port,
            latencyMs: this.#activeServer.latencyMs,
          }
        : null,
      connectStartedAt: this.#connectStartedAt || null,
      uptimeMs: this.#connectStartedAt && this.isConnected ? Date.now() - this.#connectStartedAt : 0,
      session: {
        bytesIn: this.#sessionBytes.bytesIn + eng.bytesIn,
        bytesOut: this.#sessionBytes.bytesOut + eng.bytesOut,
        connections: eng.totalConnections,
        activeConnections: eng.activeConnections,
        errors: eng.errors,
      },
      ip: {
        direct,
        egress,
        hiding: !!(direct && egress && direct !== egress),
        country: this.#lastVerify?.country ?? null,
      },
      protocol: this.store.settings.protocol,
      killSwitch: this.store.settings.killSwitch,
      routingError: this.#routingError,
      engineError: this.#engineError,
      gatewayPort: this.engine.port,
      /** presentation: what the machine claims to be while connected */
      geo: this.#activeServer
        ? {
            cc: this.#activeServer.cc,
            region: regionFor(this.#activeServer.cc),
            timezone: geoFor(this.#activeServer.cc).tz,
            locale: geoFor(this.#activeServer.cc).locale,
            appliedTimezone: this.#tzApplied,
            timezoneError: this.#tzError,
          }
        : null,
      lastError: this.#lastError,
      lastVerify: this.#lastVerify,
      failoverChain: this.#failoverChain.map((f) => ({ cc: f.cc, host: f.host })),
      pool: this.pool.stats(),
    };
  }

  /**
   * Match the machine's presentation to the exit country:
   * Windows timezone now, browser locale/timezone when the launcher opens the window.
   */
  async #applyTimezone(cc, { restore = false } = {}) {
    if (!this.store.settings.syncTimezone) {
      this.#tzApplied = null;
      this.#tzError = null;
      return;
    }

    if (restore) {
      if (!this.#tzBackup) return;
      try {
        await win.setTimezone(this.#tzBackup);
        this.emit('log', { level: 'info', msg: `timezone restored to ${this.#tzBackup}` });
      } catch (e) {
        this.emit('log', { level: 'warn', msg: `could not restore the timezone: ${e.message}` });
      }
      this.#tzApplied = null;
      this.#tzError = null;
      return;
    }

    const target = geoFor(cc).tz;
    if (!target) return;

    try {
      if (!this.#tzBackup) this.#tzBackup = await win.getTimezone();
      const r = await win.setTimezone(target);
      this.#tzApplied = r.applied || r.zone;
      this.#tzError = null;
      this.emit('log', { level: 'success', msg: `desktop timezone matched to ${this.#tzApplied} (${cc})` });
    } catch (e) {
      this.#tzError = e.message;
      this.emit('log', { level: 'warn', msg: `timezone sync unavailable: ${e.message}` });
    }
  }

  #setState(state, extra = {}) {
    this.state = state;
    this.emit('state', { state, ...extra, at: Date.now() });
  }

  /** start engine + pool; optionally probe */
  async init({ probe = false } = {}) {
    this.#setState('preparing');

    // Crash recovery: a previous run may have died while the Windows proxy was
    // still pointed at our local gateway, which breaks every app on the machine.
    await this.#recoverOrphanedProxy().catch(() => {});

    // The proxy engine is essential, but a failure here must not make the whole
    // app unusable: the API surface (and a retry from the UI) stays available.
    try {
      await this.engine.start();
      this.engine.setExclusions(this.store.settings.splitTunnel);
      this.#engineError = null;
      this.emit('log', { level: 'info', msg: `proxy engine listening on 127.0.0.1:${this.engine.port}` });
    } catch (err) {
      this.#engineError = err.message;
      this.emit('log', { level: 'error', msg: `proxy engine failed to start: ${err.message}` });
    }

    // The catalogue fetch is what makes servers usable; failures are reported but
    // do not throw, so the UI can still show a helpful state.
    try {
      await this.pool.refresh();
      this.emit('log', { level: 'info', msg: `pool ready: ${this.pool.servers.length} servers / ${this.pool.countries.length} countries` });
    } catch (err) {
      this.#lastError = `could not load the server list: ${err.message}`;
      this.emit('log', { level: 'error', msg: this.#lastError });
    }

    this.#setState(this.#engineError ? 'error' : 'idle', { error: this.#engineError || this.#lastError || undefined });

    if (probe && this.pool.servers.length) {
      this.probeAll({ limit: 90 }).catch(() => {});
    }
    return this.snapshot();
  }

  /**
   * If the registry still routes through our gateway port but nothing is
   * listening there (previous process was killed), reset to direct so the
   * machine is not left without working networking.
   */
  async #recoverOrphanedProxy() {
    try {
      const current = await win.getSystemProxy();
      const pointsAtUs =
        (current.server && current.server.includes('127.0.0.1')) ||
        (current.pac && current.pac.includes('127.0.0.1'));
      if (!current.enabled || !pointsAtUs) return;

      const port = Number((current.server || current.pac || '').match(/127\.0\.0\.1:(\d+)/)?.[1] || 0);
      if (!port) return;

      const alive = await new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        s.setTimeout(700, () => {
          s.destroy();
          resolve(false);
        });
        s.on('error', () => resolve(false));
        s.on('connect', () => {
          s.destroy();
          resolve(true);
        });
      });
      if (alive) return; // belongs to a live instance (or another tool) - leave it

      await win.restoreProxy({ enabled: false, server: null, pac: null, bypass: null });
      this.emit('log', { level: 'warn', msg: `recovered orphaned proxy settings (127.0.0.1:${port} was not listening) - restored to direct` });
    } catch {
      /* recovery is best-effort */
    }
  }

  async probeAll({ cc = null, limit = 0, onlyUntested = false } = {}) {
    this.emit('probe', { phase: 'start', cc, limit });
    const res = await this.pool.probe({
      cc,
      limit,
      onlyUntested,
      onProgress: (p) => this.emit('probe', { phase: 'progress', ...p }),
    });
    this.emit('probe', { phase: 'done', ...res, stats: this.pool.stats() });
    return res;
  }

  /**
   * Connect.
   * @param {{cc?:string, serverId?:string, mode?:string, remember?:boolean}} opts
   */
  async connect({ cc = null, serverId = null, mode = null } = {}) {
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#doConnect({ cc, serverId, mode }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #doConnect({ cc, serverId, mode }) {
    const settings = this.store.settings;
    this.#lastError = null;
    this.#failedIds.clear();
    this.#setState('connecting', { cc, serverId });

    try {
      // 1. engine + catalogue
      if (!this.engine.listening) {
        await this.engine.start();
        this.#engineError = null;
      }
      await this.pool.refresh();

      // 2. choose target
      let target = null;
      if (serverId) target = this.pool.findById(serverId);
      if (!target) {
        const effectiveMode = mode || settings.mode;
        if (effectiveMode === 'fastest' || effectiveMode === 'smart') {
          const needProbe = this.pool.servers.filter((s) => s.latencyMs).length < 8;
          if (needProbe) {
            this.emit('log', { level: 'info', msg: 'measuring server latency...' });
            await this.probeAll({ cc, limit: cc ? 40 : 90 });
          }
        }
        target = this.pool.pick({ cc, maxLatencyMs: settings.maxLatencyMs });
      }
      if (!target) throw new Error('No server available for this location');

      // 3. resolve credentials + failover chain
      const resolved = await this.pool.resolve(target);
      const chain = [];
      for (const cand of [target, ...this.pool.failoverList({ cc: cc ?? target.cc, count: 7 })]) {
        if (chain.find((c) => c.id === cand.id)) continue;
        try {
          const r = await this.pool.resolve(cand);
          chain.push({ ...r, signature: cand.signature, server: cand });
        } catch {
          /* skip unusable */
        }
        if (chain.length >= 4) break;
      }
      this.#failoverChain = chain.map((c) => c.server);

      this.#activeServer = target;
      this.#activeResolved = resolved;
      this.engine.setUpstreams(chain.map((c) => ({ id: c.id, cc: c.cc, host: c.host, port: c.port, username: c.username, password: c.password, country: c.country })));

      // 4. verify the tunnel actually changes the IP
      if (settings.hideIpOnLaunch) {
        const [direct, verify] = await Promise.all([
          this.pool.directIp().catch(() => ({ ok: false, ip: null })),
          this.pool.verifyEgress(target),
        ]);
        this.#directIp = direct.ip;
        this.#lastVerify = verify.ok ? { ...verify, at: Date.now() } : { ok: false, errors: verify.errors, at: Date.now() };
        if (!verify.ok) {
          this.emit('log', { level: 'warn', msg: `tunnel verify inconclusive: ${(verify.errors || []).slice(0, 2).join('; ')}` });
        } else if (direct.ip && direct.ip === verify.egressIp) {
          this.emit('log', { level: 'warn', msg: 'egress IP equals direct IP - tunnel may not be active' });
        }
      }

      // 5. apply system routing per protocol
      //    A failure here must NOT kill the connection: the tunnel and the local
      //    gateway still work, and the user gets an actionable warning instead.
      let routingError = null;
      try {
        await this.#applyProtocol();
        this.#routingError = null;
      } catch (routeErr) {
        routingError = routeErr.message;
        this.#routingError = routingError;
        this.emit('log', { level: 'error', msg: `could not apply system proxy: ${routingError}` });
      }

      // 6. start health monitor
      this.#startHealth();

      // 7. match the machine's clock/locale to the exit country
      await this.#applyTimezone(target.cc);

      this.#connectStartedAt = Date.now();
      this.#sessionBytes = { bytesIn: 0, bytesOut: 0 };
      this.store.pushRecent({ cc: target.cc, country: target.country, id: target.id });
      this.#setState('connected', { server: this.#activeServer, routingError });
      this.emit('log', {
        level: 'success',
        msg: `connected via ${target.cc} ${target.host}:${target.port}${this.#lastVerify?.egressIp ? ` (egress ${this.#lastVerify.egressIp})` : ''}`,
      });
      return this.snapshot();
    } catch (err) {
      this.#lastError = err.message;
      this.#setState('error', { error: err.message });
      this.emit('log', { level: 'error', msg: `connect failed: ${err.message}` });
      await this.#teardownRouting().catch(() => {});
      throw err;
    }
  }

  async #applyProtocol() {
    const settings = this.store.settings;
    const port = this.engine.port;
    this.#proxyBackup = this.#proxyBackup || (await win.backupProxy().catch(() => null));

    if (settings.protocol === 'gateway') {
      // engine only; user/apps point at 127.0.0.1:port manually
      return;
    }
    if (settings.protocol === 'pac') {
      await win.enableSystemProxy({ pacUrl: `http://127.0.0.1:${settings.controlPort}/api/pac` });
      return;
    }
    if (settings.protocol === 'manual') {
      await win.enableSystemProxy({
        http: `127.0.0.1:${port}`,
        https: `127.0.0.1:${port}`,
        bypass: ['localhost', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.2*', '172.30.*', '172.31.*', '192.168.*', '<local>'].join(';'),
      });
      return;
    }
    // default: system-wide via local engine
    await win.enableSystemProxy({
      http: `127.0.0.1:${port}`,
      https: `127.0.0.1:${port}`,
    });
  }

  async #teardownRouting() {
    if (this.store.settings.protocol === 'gateway') return;
    try {
      await win.restoreProxy(this.#proxyBackup);
    } catch {
      await win.disableSystemProxy().catch(() => {});
    }
  }

  async disconnect({ forgetBackup = false } = {}) {
    this.#setState('disconnecting');
    this.#stopHealth();
    const eng = this.engine.stats;
    if (this.#connectStartedAt) {
      this.store.addStats({
        bytesIn: this.#sessionBytes.bytesIn + eng.bytesIn,
        bytesOut: this.#sessionBytes.bytesOut + eng.bytesOut,
        ms: Date.now() - this.#connectStartedAt,
      });
    }
    await this.#teardownRouting();
    await this.#applyTimezone(null, { restore: true });
    if (this.store.settings.killSwitch) await win.disableKillSwitch().catch(() => {});
    this.engine.setUpstreams([]);
    this.#activeServer = null;
    this.#activeResolved = null;
    this.#failoverChain = [];
    this.#connectStartedAt = 0;
    this.#lastVerify = null;
    if (forgetBackup) this.#proxyBackup = null;
    this.#setState('idle');
    this.emit('log', { level: 'info', msg: 'disconnected' });
    return this.snapshot();
  }

  /** switch to a different location while staying connected */
  async switchTo({ cc = null, serverId = null } = {}) {
    if (!this.isConnected) return await this.connect({ cc, serverId });
    this.#setState('switching', { cc, serverId });
    const wasKill = this.store.settings.killSwitch;
    if (wasKill) await win.disableKillSwitch().catch(() => {});
    try {
      await this.pool.refresh();
      const previousCc = this.#activeServer?.cc ?? null;
      let target = serverId ? this.pool.findById(serverId) : this.pool.pick({ cc });
      if (!target) throw new Error('no server for that location');
      const resolved = await this.pool.resolve(target);
      const chain = [{ ...resolved, server: target }];
      for (const cand of this.pool.failoverList({ cc: cc ?? target.cc, count: 6 })) {
        if (cand.id === target.id) continue;
        try {
          const r = await this.pool.resolve(cand);
          chain.push({ ...r, server: cand });
        } catch {
          /* skip */
        }
        if (chain.length >= 4) break;
      }
      this.#activeServer = target;
      this.#activeResolved = resolved;
      this.#failoverChain = chain.map((c) => c.server);
      this.engine.setUpstreams(
        chain.map((c) => ({ id: c.id, cc: c.cc, host: c.host, port: c.port, username: c.username, password: c.password, country: c.country }))
      );
      this.#switchHistory.push({ from: previousCc, to: target.cc, at: Date.now() });
      const verify = await this.pool.verifyEgress(target).catch(() => ({ ok: false }));
      if (verify.ok) this.#lastVerify = { ...verify, at: Date.now() };
      this.store.pushRecent({ cc: target.cc, country: target.country, id: target.id });
      if (wasKill) await win.enableKillSwitch([target.host]).catch(() => {});
      await this.#applyTimezone(target.cc);
      this.#setState('connected', { server: target, switched: true });
      this.emit('log', { level: 'success', msg: `switched -> ${target.cc} ${target.host}` });
      return this.snapshot();
    } catch (err) {
      this.#lastError = err.message;
      this.#setState('connected', { error: err.message });
      throw err;
    }
  }

  // ------------------------------------------------------------- health

  #startHealth() {
    this.#stopHealth();
    this.#healthTimer = setInterval(() => this.#healthCheck().catch(() => {}), HEALTH_INTERVAL_MS);
    this.#healthTimer.unref?.();
  }

  #stopHealth() {
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = null;
  }

  async #healthCheck() {
    if (!this.isConnected || !this.#activeServer) return;
    const { probeProxy } = await import('./upstream.mjs');
    const proxy = { ...this.#activeResolved };
    const result = await probeProxy(proxy);
    if (result.ok) {
      this.#activeServer.latencyMs = result.ms;
      this.emit('health', { ok: true, ms: result.ms });
      return;
    }
    this.emit('health', { ok: false, error: result.error });
    if (!this.store.settings.autoFailover) return;
    await this.#failover(result.error);
  }

  async #failover(reason) {
    if (!this.#activeServer) return;
    this.#failedIds.add(this.#activeServer.id);
    const cc = this.#activeServer.cc;
    const next = this.pool.pick({ cc, excludeIds: this.#failedIds });
    if (!next) {
      this.#lastError = `all servers failed: ${reason}`;
      this.#setState('error', { error: this.#lastError });
      this.emit('log', { level: 'error', msg: this.#lastError });
      return;
    }
    this.emit('log', { level: 'warn', msg: `server unhealthy (${reason}) -> failing over to ${next.cc}` });
    try {
      const resolved = await this.pool.resolve(next);
      this.#activeServer = next;
      this.#activeResolved = resolved;
      const chain = [];
      for (const cand of this.pool.failoverList({ cc, count: 6, excludeIds: this.#failedIds })) {
        try {
          chain.push({ ...(await this.pool.resolve(cand)), server: cand });
        } catch {
          /* skip */
        }
        if (chain.length >= 4) break;
      }
      this.#failoverChain = chain.map((c) => c.server);
      this.engine.setUpstreams(
        chain.map((c) => ({ id: c.id, cc: c.cc, host: c.host, port: c.port, username: c.username, password: c.password, country: c.country }))
      );
      this.#switchHistory.push({ from: cc, to: next.cc, at: Date.now(), reason });
      const verify = await this.pool.verifyEgress(next).catch(() => ({ ok: false }));
      if (verify.ok) this.#lastVerify = { ...verify, at: Date.now() };
      this.emit('state', { state: 'connected', server: next, failover: true, at: Date.now() });
      this.emit('log', { level: 'success', msg: `failover complete -> ${next.cc} ${next.host}` });
    } catch (e) {
      this.#lastError = e.message;
      this.emit('log', { level: 'error', msg: `failover failed: ${e.message}` });
    }
  }

  /** re-apply the current routing mode (used by the "Retry" button after a failure) */
  async reapplyRouting() {
    if (!this.isConnected) throw new Error('not connected');
    await this.#applyProtocol();
    this.#lastError = null;
    this.emit('log', { level: 'success', msg: 'system proxy re-applied' });
    this.#setState('connected', { server: this.#activeServer });
    return this.snapshot();
  }

  /** apply settings that need live effect */
  async applySettings(patch) {
    const before = { ...this.store.settings };
    const settings = this.store.update(patch);
    this.engine.setExclusions(settings.splitTunnel);

    if (before.protocol !== settings.protocol && this.isConnected) await this.#applyProtocol();

    if (before.killSwitch !== settings.killSwitch) {
      if (settings.killSwitch && this.isConnected && this.#activeServer) {
        await win.enableKillSwitch([this.#activeServer.host]);
      } else if (!settings.killSwitch) {
        await win.disableKillSwitch();
      }
    }

    if (before.gatewayPort !== settings.gatewayPort && this.engine.listening) {
      await this.engine.stop();
      this.engine = new ProxyEngine({ port: settings.gatewayPort });
      await this.engine.start();
    }
    return settings;
  }

  async shutdown() {
    this.#stopHealth();
    try {
      await this.#teardownRouting();
    } catch {
      /* ignore */
    }
    if (this.store.settings.killSwitch) await win.disableKillSwitch().catch(() => {});
    await this.engine.stop().catch(() => {});
  }
}
