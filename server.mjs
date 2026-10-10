/**
 * Mollah Pro Zone - local control server + UI host.
 * Binds to 127.0.0.1 only. Serves the desktop UI, a REST API,
 * a live WebSocket feed, the PAC endpoint and a CLI-friendly surface.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { VpnController } from './core/controller.mjs';
import { Store, resolveDataDir } from './core/store.mjs';
import { EventHub } from './server/ws.mjs';
import { APP, DEFAULT_CONTROL_PORT } from './core/constants.mjs';
import { tunnelRequest } from './core/upstream.mjs';
import * as win from './platform/windows.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, 'ui');
const ASSET_DIR = path.resolve(__dirname, '..', 'assets');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

export async function createServer({ dataDir, controlPort = DEFAULT_CONTROL_PORT, autoInit = true } = {}) {
  const store = new Store(resolveDataDir(dataDir));
  const controller = new VpnController(store);
  const hub = new EventHub();
  const startedAt = Date.now();
  const bootLog = [];

  const push = (event) => hub.broadcast({ type: 'event', event });
  controller.on('state', (e) => push({ kind: 'state', ...e, snapshot: controller.snapshot() }));
  controller.on('log', (e) => {
    bootLog.push({ at: Date.now(), ...e });
    if (bootLog.length > 400) bootLog.shift();
    push({ kind: 'log', ...e });
  });
  controller.on('probe', (e) => push({ kind: 'probe', ...e }));
  controller.on('health', (e) => push({ kind: 'health', ...e }));
  controller.on('pool', (e) => push({ kind: 'pool', ...e }));

  // periodic metrics tick
  const tick = setInterval(() => {
    if (hub.clientCount) push({ kind: 'tick', snapshot: controller.snapshot() });
  }, 1000);
  tick.unref?.();

  const json = (res, code, body) => {
    const payload = JSON.stringify(body);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(payload);
  };

  const readBody = (req, limit = 512 * 1024) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (d) => {
        size += d.length;
        if (size > limit) {
          reject(new Error('payload too large'));
          req.destroy();
          return;
        }
        chunks.push(d);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('invalid JSON body'));
        }
      });
      req.on('error', reject);
    });

  async function api(req, res, url) {
    const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    const [head, ...rest] = seg;
    const method = req.method || 'GET';

    // ---- meta ----------------------------------------------------------
    if (head === 'meta') {
      return json(res, 200, {
        app: APP,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        hostname: os.hostname(),
        dataDir: store.dataDir,
        controlPort,
        gatewayPort: controller.engine.port,
        startedAt,
        uptimeMs: Date.now() - startedAt,
        elevated: await win.isElevated().catch(() => false),
        engineListening: controller.engine.listening,
        wsClients: hub.clientCount,
      });
    }

    // ---- status --------------------------------------------------------
    if (head === 'status') {
      return json(res, 200, {
        snapshot: controller.snapshot(),
        settings: store.settings,
        favorites: store.favorites,
        recent: store.recent,
        lifetime: store.stats,
        log: bootLog.slice(-80),
      });
    }

    if (head === 'servers' && method === 'GET') {
      await controller.pool.refresh();
      const cc = url.searchParams.get('cc');
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const testedOnly = url.searchParams.get('tested') === '1';
      let list = controller.pool.servers;
      if (cc && cc !== 'ALL') list = list.filter((s) => s.cc === cc);
      if (q) list = list.filter((s) => s.country.toLowerCase().includes(q) || s.cc.toLowerCase() === q || s.host.includes(q));
      if (testedOnly) list = list.filter((s) => s.latencyMs);
      const limit = Math.min(Number(url.searchParams.get('limit') || 5000), 5000);
      return json(res, 200, {
        total: controller.pool.servers.length,
        shown: Math.min(list.length, limit),
        countries: controller.pool.countries,
        servers: list.slice(0, limit),
        pool: controller.pool.stats(),
      });
    }

    if (head === 'countries') {
      await controller.pool.refresh();
      const enriched = controller.pool.countries.map((c) => {
        const list = controller.pool.servers.filter((s) => s.cc === c.cc);
        const lat = list.map((s) => s.latencyMs).filter(Boolean);
        return {
          ...c,
          bestLatency: lat.length ? Math.min(...lat) : null,
          testedCount: lat.length,
          aliveCount: list.filter((s) => s.latencyMs && !s.error).length,
        };
      });
      const latAll = controller.pool.servers.map((s) => s.latencyMs).filter(Boolean);
      return json(res, 200, {
        countries: enriched,
        best: latAll.length ? Math.min(...latAll) : null,
        favorites: store.favorites,
        recent: store.recent,
        pool: controller.pool.stats(),
      });
    }

    if (head === 'probe') {
      const body = method === 'POST' ? await readBody(req).catch(() => ({})) : {};
      const cc = body.cc || url.searchParams.get('cc') || null;
      const limit = Number(body.limit ?? url.searchParams.get('limit') ?? 0);
      const onlyUntested = (body.onlyUntested ?? url.searchParams.get('untested') === '1') === true;
      if (body.cancel) {
        controller.pool.cancelProbe();
        return json(res, 200, { cancelled: true });
      }
      controller.probeAll({ cc, limit, onlyUntested }).catch((e) => controller.emit('log', { level: 'error', msg: `probe: ${e.message}` }));
      return json(res, 202, { started: true, cc, limit });
    }

    // ---- connection ----------------------------------------------------
    if (head === 'connect' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const snap = await controller.connect({ cc: body.cc || null, serverId: body.serverId || null, mode: body.mode || null });
        return json(res, 200, { ok: true, snapshot: snap });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message, snapshot: controller.snapshot() });
      }
    }

    if (head === 'disconnect' && method === 'POST') {
      const snap = await controller.disconnect({ forgetBackup: true });
      return json(res, 200, { ok: true, snapshot: snap });
    }

    if (head === 'switch' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      try {
        const snap = await controller.switchTo({ cc: body.cc || null, serverId: body.serverId || null });
        return json(res, 200, { ok: true, snapshot: snap });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    if (head === 'best') {
      await controller.pool.refresh();
      const cc = url.searchParams.get('cc');
      const best = controller.pool.pick({ cc: cc && cc !== 'AUTO' ? cc : null });
      return json(res, 200, { server: best, pool: controller.pool.stats() });
    }

    // ---- settings ------------------------------------------------------
    if (head === 'settings') {
      if (method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const settings = await controller.applySettings(body);
        push({ kind: 'settings', settings });
        return json(res, 200, { ok: true, settings });
      }
      return json(res, 200, store.settings);
    }

    if (head === 'favorites' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      return json(res, 200, { favorites: store.toggleFavorite(body.cc) });
    }

    // ---- system integration -------------------------------------------
    if (head === 'system') {
      const what = rest[0];
      if (what === 'proxy' && method === 'GET') return json(res, 200, await win.getSystemProxy());
      if (what === 'proxy' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        if (body.action === 'off') return json(res, 200, await win.disableSystemProxy());
        if (body.action === 'pac')
          return json(res, 200, await win.enableSystemProxy({ pacUrl: `http://127.0.0.1:${controlPort}/api/pac` }));
        return json(
          res,
          200,
          await win.enableSystemProxy({
            http: body.http || `127.0.0.1:${controller.engine.port}`,
            https: body.https || `127.0.0.1:${controller.engine.port}`,
            socks: body.socks,
          })
        );
      }
      if (what === 'killswitch' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        if (body.enabled) {
          const elevated = await win.isElevated().catch(() => false);
          if (!elevated) {
            return json(res, 403, {
              ok: false,
              error: 'Kill switch needs administrator rights. Close the app, right-click “Mollah Pro Zone.exe”, choose “Run as administrator”, then enable it again.',
            });
          }
          const ip = controller.activeServer?.host;
          return json(res, 200, await win.enableKillSwitch([ip]));
        }
        return json(res, 200, await win.disableKillSwitch());
      }
      if (what === 'killswitch') return json(res, 200, { active: await win.killSwitchActive() });
      if (what === 'flushdns' && method === 'POST') return json(res, 200, { ok: await win.flushDns() });
      if (what === 'startup' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const exe = process.env.MOLLAH_EXE || process.execPath;
        return json(res, 200, { ok: await win.setLaunchOnStartup(!!body.enabled, exe) });
      }
      if (what === 'network') return json(res, 200, await win.networkInfo());
      if (what === 'elevate' && method === 'POST') {
        return json(res, 501, { ok: false, error: 'Run the launcher with "Run as administrator" to use this.' });
      }
    }

    // ---- diagnostics ---------------------------------------------------
    if (head === 'ip') {
      const [direct, verify] = await Promise.all([
        controller.pool.directIp().catch(() => ({ ok: false, ip: null })),
        controller.activeServer ? controller.pool.verifyEgress(controller.activeServer).catch(() => ({ ok: false })) : Promise.resolve(null),
      ]);
      return json(res, 200, {
        direct: direct.ip,
        egress: verify?.ok ? verify.egressIp : null,
        matchesProxyIp: verify?.ok ? verify.matchesProxyIp : null,
        hiding: !!(direct.ip && verify?.ok && verify.egressIp && direct.ip !== verify.egressIp),
        verify,
        at: Date.now(),
      });
    }

    if (head === 'ipinfo' && method === 'GET') {
      const target = url.searchParams.get('target') || 'egress';
      const proxy = target === 'egress' && controller.activeResolved ? controller.activeResolved : null;
      const fetchJson = async (u) => {
        if (proxy) {
          const r = await tunnelRequest(proxy, { url: u, timeoutMs: 12000 });
          return JSON.parse(r.body.toString('utf8'));
        }
        const r = await fetch(u, { signal: AbortSignal.timeout(12000) });
        return await r.json();
      };
      const out = {};
      for (const [key, u] of [
        ['ipinfo', 'https://ipinfo.io/json'],
      ]) {
        try {
          out[key] = await fetchJson(u);
        } catch (e) {
          out[key] = { error: e.message };
        }
      }
      return json(res, 200, out);
    }

    if (head === 'leaktests') {
      const direct = await controller.pool.directIp().catch(() => ({ ip: null }));
      let egress = null;
      if (controller.activeServer) {
        const v = await controller.pool.verifyEgress(controller.activeServer).catch(() => null);
        egress = v?.ok ? v.egressIp : null;
      }
      const sysProxy = await win.getSystemProxy().catch(() => null);
      const net = await win.networkInfo().catch(() => ({ dns: [] }));
      const checks = [
        {
          id: 'tunnel',
          name: 'Tunnel active',
          pass: !!(direct.ip && egress && direct.ip !== egress),
          detail: direct.ip && egress ? `${direct.ip} -> ${egress}` : 'no egress measured',
        },
        {
          id: 'sysproxy',
          name: 'System proxy routed',
          pass: !!(sysProxy?.enabled && (sysProxy.server?.includes('127.0.0.1') || sysProxy.pac?.includes('127.0.0.1'))),
          detail: sysProxy ? `enabled=${sysProxy.enabled} server=${sysProxy.server ?? '-'} pac=${sysProxy.pac ?? '-'}` : 'n/a',
        },
        {
          id: 'dns',
          name: 'DNS servers',
          pass: true,
          detail: (net.dns || []).join(' | ') || 'unknown',
        },
        {
          id: 'webrtc',
          name: 'WebRTC guard',
          pass: !!store.settings.webRtcGuard,
          optional: true,
          detail: store.settings.webRtcGuard ? 'enabled (extension-level for browsers)' : 'not enabled',
        },
        {
          id: 'killswitch',
          name: 'Kill switch',
          pass: !!store.settings.killSwitch,
          optional: true,
          detail: store.settings.killSwitch ? 'armed' : 'optional — off',
        },
      ];
      return json(res, 200, {
        directIp: direct.ip,
        egressIp: egress,
        checks,
        failed: checks.filter((c) => !c.pass && !c.optional).length,
        at: Date.now(),
      });
    }

    // ---- PAC -----------------------------------------------------------
    if (head === 'pac') {
      const body = controller.engine.buildPac();
      res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-cache' });
      return res.end(body);
    }

    // ---- history / log -------------------------------------------------
    if (head === 'history') {
      return json(res, 200, { recent: store.recent, switchHistory: controller.switchHistory, lifetime: store.stats });
    }
    if (head === 'log') {
      return json(res, 200, { entries: bootLog.slice(-200), connections: controller.engine.recentLog });
    }

    // ---- graceful shutdown (used by the launcher and the UI) -------------
    if (head === 'shutdown' && method === 'POST') {
      json(res, 200, { ok: true, stopping: true });
      setTimeout(async () => {
        try {
          await shutdown();
        } catch {
          /* ignore */
        }
        process.exit(0);
      }, 150);
      return;
    }

    if (head === 'retry-proxy' && method === 'POST') {
      try {
        await controller.reapplyRouting();
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    // ---- reload the server catalogue (used after a rate-limit or offline start)
    if (head === 'retry-pool' && method === 'POST') {
      try {
        const r = await controller.pool.refresh({ force: true });
        controller.emit('log', { level: 'success', msg: `server list reloaded: ${r.servers.length} servers` });
        controller.emit('state', { state: controller.state, at: Date.now() });
        return json(res, 200, { ok: true, total: r.servers.length, countries: r.countries.length });
      } catch (e) {
        controller.emit('log', { level: 'error', msg: `reload failed: ${e.message}` });
        return json(res, 502, { ok: false, error: e.message });
      }
    }

    return json(res, 404, { error: 'unknown endpoint', path: url.pathname });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const isAsset = rel.startsWith('/assets/');
    const root = isAsset ? ASSET_DIR : UI_DIR;
    const filePath = path.join(root, rel.replace(/^\/?assets\//, '').replace(/^\/+/, ''));
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${controlPort}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e) => {
        bootLog.push({ at: Date.now(), level: 'error', msg: `${req.method} ${url.pathname} failed: ${e.message}` });
        json(res, 500, { error: e.message });
      });
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }
    serveStatic(req, res, url);
  });

  // never let an unexpected error take the whole app down
  server.on('clientError', (err, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {
      /* ignore */
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${controlPort}`);
    if (url.pathname === '/ws') {
      hub.handleUpgrade(req, socket);
      return;
    }
    socket.destroy();
  });

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(controlPort, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });

  const port = await listen();

  if (autoInit) {
    controller.init({ probe: false }).catch((e) => {
      bootLog.push({ at: Date.now(), level: 'error', msg: `init failed: ${e.message}` });
    });
  }

  const shutdown = async () => {
    clearInterval(tick);
    await controller.shutdown().catch(() => {});
    await new Promise((r) => server.close(r));
  };

  return { server, store, controller, hub, port, shutdown, uiDir: UI_DIR };
}

// ------------------------------------------------------------------ direct run

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]).endsWith('server.mjs');

if (isDirectRun) {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i > -1 && args[i + 1] ? args[i + 1] : def;
  };
  const port = Number(getArg('port', process.env.MOLLAH_PORT || DEFAULT_CONTROL_PORT));
  const dataDir = getArg('data', undefined);

  const app = await createServer({ controlPort: port, dataDir });
  const url = `http://127.0.0.1:${app.port}`;
  console.log(`\n  ${APP.name} v${APP.version}`);
  console.log(`  ${APP.tagline}`);
  console.log(`  --------------------------------------------------`);
  console.log(`  UI / API   : ${url}`);
  console.log(`  Proxy port : 127.0.0.1:${app.controller.engine.port}  (HTTP + SOCKS5 + PAC)`);
  console.log(`  PAC        : ${url}/api/pac`);
  console.log(`  Data dir   : ${app.store.dataDir}`);
  console.log(`  --------------------------------------------------\n`);

  const bye = async () => {
    console.log('\n  shutting down: restoring proxy settings...');
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGHUP', bye);
}
