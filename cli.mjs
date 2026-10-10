#!/usr/bin/env node
/**
 * Mollah Pro Zone - command line client.
 * Talks to a running engine, or starts one in-process with `serve`.
 *
 *   mollah status
 *   mollah connect --cc DE
 *   mollah connect --best
 *   mollah countries
 *   mollah servers --cc JP --tested
 *   mollah test                 (latency-test the pool)
 *   mollah ip                   (prove the tunnel changed your IP)
 *   mollah leak                 (run leak/integrity checks)
 *   mollah disconnect
 *   mollah serve --port 8787    (run the engine in the foreground)
 */

const args = process.argv.slice(2);
const cmd = (args[0] || 'status').toLowerCase();

function getArg(name, def = null) {
  const i = args.indexOf(`--${name}`);
  if (i > -1) {
    const next = args[i + 1];
    return next && !next.startsWith('--') ? next : true;
  }
  return def;
}
const has = (name) => args.includes(`--${name}`);

const PORT = Number(getArg('port', process.env.MOLLAH_PORT || 8898));
const BASE = `http://127.0.0.1:${PORT}`;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  b: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  violet: '\x1b[35m',
};

const out = (...a) => console.log(...a);

async function api(path, opts = {}) {
  const clean = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  const res = await fetch(BASE + clean, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return await res.json().catch(() => ({}));
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

async function ensureEngine() {
  try {
    const r = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return true;
  } catch {
    /* not running */
  }
  out(`${C.yellow}No engine on port ${PORT}.${C.reset}`);
  out(`${C.dim}Start it with :  node src/server.mjs --port ${PORT}${C.reset}`);
  out(`${C.dim}or from here  :  node src/cli.mjs serve --port ${PORT}${C.reset}`);
  return false;
}

function heading(text) {
  out(`\n${C.b}${C.violet}${text}${C.reset}`);
  out(`${C.dim}${'-'.repeat(Math.max(20, text.length + 4))}${C.reset}`);
}

const dash = '-';
const star = '*';
const okMark = '+';
const noMark = 'x';
const upArrow = '^';
const downArrow = 'v';

// ------------------------------------------------------------------ commands

async function cmdStatus() {
  if (!(await ensureEngine())) return 1;
  const s = await api('/status');
  const snap = s.snapshot;
  if (!snap) {
    out(`${C.red}Engine returned no status.${C.reset}`);
    return 1;
  }
  heading('Mollah Pro Zone - status');
  const stateColor = snap.state === 'connected' ? C.green : snap.state === 'error' ? C.red : C.yellow;
  out(`  State        ${stateColor}${snap.state}${C.reset}`);
  if (snap.activeServer) {
    out(`  Location     ${snap.activeServer.country} (${snap.activeServer.cc})`);
    out(`  Exit node    ${snap.activeServer.host}:${snap.activeServer.port}`);
  }
  out(`  Direct IP    ${snap.ip?.direct ?? dash}`);
  out(`  VPN IP       ${C.cyan}${snap.ip?.egress ?? dash}${C.reset}${snap.ip?.hiding ? ` ${C.green}(hiding)${C.reset}` : ''}`);
  out(`  Routing      ${snap.protocol}`);
  out(`  Kill switch  ${snap.killSwitch ? 'armed' : 'off'}`);
  out(`  Throughput   ${downArrow} ${fmtBytes(snap.session.bytesIn)}  ${upArrow} ${fmtBytes(snap.session.bytesOut)}  (${snap.session.connections} conns)`);
  out(
    `  Pool         ${snap.pool.total} servers / ${snap.pool.countries} countries` +
      (snap.pool.tested ? `  (${snap.pool.tested} tested, median ${snap.pool.medianLatency}ms)` : '')
  );
  out(`  Favorites    ${(s.favorites || []).join(', ') || dash}`);
  return 0;
}

async function cmdCountries() {
  if (!(await ensureEngine())) return 1;
  const d = await api('/countries');
  heading(`Countries (${(d.countries || []).length})`);
  const sorted = (d.countries || []).slice().sort((a, b) => (a.bestLatency ?? 1e9) - (b.bestLatency ?? 1e9));
  for (const c of sorted) {
    const lat = c.bestLatency ? `${String(c.bestLatency).padStart(5)}ms` : '    -  ';
    const latColor = !c.bestLatency ? C.dim : c.bestLatency < 400 ? C.green : c.bestLatency < 1200 ? C.yellow : C.red;
    const fav = (d.favorites || []).includes(c.cc) ? `${C.yellow}${star}${C.reset}` : ' ';
    out(`  ${fav} ${c.cc}  ${latColor}${lat}${C.reset}  ${String(c.name).padEnd(30)} ${C.dim}${c.aliveCount}/${c.serverCount} alive${C.reset}`);
  }
  return 0;
}

async function cmdServers() {
  if (!(await ensureEngine())) return 1;
  const cc = getArg('cc');
  const q = getArg('q');
  const params = new URLSearchParams();
  if (cc) params.set('cc', String(cc).toUpperCase());
  if (q) params.set('q', String(q));
  if (has('tested')) params.set('tested', '1');
  const d = await api(`/servers?${params.toString()}`);
  heading(`Servers (${d.shown} of ${d.total})`);
  for (const s of (d.servers || []).slice(0, Number(getArg('limit', 40)))) {
    const lat = s.latencyMs ? `${String(s.latencyMs).padStart(5)}ms` : '    -  ';
    const latColor = !s.latencyMs ? C.dim : s.latencyMs < 400 ? C.green : s.latencyMs < 1200 ? C.yellow : C.red;
    out(`  ${s.cc}  ${latColor}${lat}${C.reset}  ${String(s.host).padEnd(16)}:${s.port}  ${C.dim}${s.country}${C.reset}`);
  }
  return 0;
}

async function cmdTest() {
  if (!(await ensureEngine())) return 1;
  const cc = getArg('cc');
  heading(`Latency test${cc ? ` - ${cc}` : ' - all servers'}`);
  await api('/probe', {
    method: 'POST',
    body: { cc: cc ? String(cc).toUpperCase() : null, limit: Number(getArg('limit', 0)) },
  });
  let last = -1;
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const st = (await api('/status')).snapshot?.pool;
    if (!st) break;
    process.stdout.write(`\r  tested ${st.tested}/${st.total}   alive ${st.alive}   median ${st.medianLatency ?? '-'}ms`.padEnd(72));
    if (st.tested === last) break;
    last = st.tested;
    if (st.tested > 0 && st.tested >= st.total) break;
  }
  out('');
  const d = await api('/countries');
  const best = (d.countries || [])
    .filter((c) => c.bestLatency)
    .sort((a, b) => a.bestLatency - b.bestLatency)
    .slice(0, 12);
  heading('Fastest countries');
  for (const c of best) out(`  ${c.cc}  ${C.green}${String(c.bestLatency).padStart(5)}ms${C.reset}  ${c.name}`);
  return 0;
}

async function cmdConnect() {
  if (!(await ensureEngine())) return 1;
  const cc = getArg('cc');
  const id = getArg('server');
  heading('Connecting');
  const r = await api('/connect', {
    method: 'POST',
    body: { cc: cc ? String(cc).toUpperCase() : null, serverId: id || null, mode: has('best') ? 'fastest' : 'smart' },
  });
  if (!r.ok) {
    out(`  ${C.red}Failed:${C.reset} ${r.error}`);
    return 1;
  }
  const s = r.snapshot;
  out(`  ${C.green}Connected${C.reset} - ${s.activeServer.country} (${s.activeServer.cc}) via ${s.activeServer.host}:${s.activeServer.port}`);
  if (s.ip?.direct && s.ip?.egress) {
    const verdict = s.ip.hiding ? `${C.green}(your real IP is hidden)${C.reset}` : `${C.yellow}(IP unchanged - check the log)${C.reset}`;
    out(`  ${s.ip.direct} ${C.dim}->${C.reset} ${C.cyan}${s.ip.egress}${C.reset} ${verdict}`);
  }
  const meta = await api('/meta');
  out(`\n  ${C.dim}HTTP proxy :${C.reset}  http://127.0.0.1:${meta.gatewayPort}`);
  out(`  ${C.dim}SOCKS5     :${C.reset}  socks5h://127.0.0.1:${meta.gatewayPort}`);
  out(`  ${C.dim}PAC file   :${C.reset}  http://127.0.0.1:${PORT}/api/pac`);
  out(`  ${C.dim}Try it     :${C.reset}  curl -x http://127.0.0.1:${meta.gatewayPort} https://api.ipify.org`);
  return 0;
}

async function cmdDisconnect() {
  if (!(await ensureEngine())) return 1;
  await api('/disconnect', { method: 'POST' });
  out(`  ${C.green}Disconnected${C.reset} - Windows proxy settings restored.`);
  return 0;
}

async function cmdIp() {
  if (!(await ensureEngine())) return 1;
  heading('IP check');
  out(`  ${C.dim}querying...${C.reset}`);
  const r = await api('/ip');
  out(`  Direct IP   ${r.direct ?? dash}`);
  out(`  VPN IP      ${C.cyan}${r.egress ?? dash}${C.reset}`);
  if (r.hiding) out(`  ${C.green}${okMark} Your real IP (${r.direct}) is hidden behind ${r.egress}${C.reset}`);
  else if (r.egress) out(`  ${C.yellow}${noMark} VPN IP equals the direct IP - tunnel not effective${C.reset}`);
  else out(`  ${C.yellow}not connected - no VPN exit measured${C.reset}`);
  return 0;
}

async function cmdLeak() {
  if (!(await ensureEngine())) return 1;
  const r = await api('/leaktests');
  heading('Security checks');
  for (const c of r.checks || []) {
    const mark = c.pass ? `${C.green}${okMark}${C.reset}` : `${C.red}${noMark}${C.reset}`;
    out(`  ${mark} ${String(c.name).padEnd(24)} ${C.dim}${c.detail ?? ''}${C.reset}`);
  }
  return 0;
}

async function cmdServe() {
  const { createServer } = await import('./server.mjs');
  const app = await createServer({ controlPort: PORT, dataDir: getArg('data', undefined) });
  out(`\n  ${C.violet}Mollah Pro Zone${C.reset} engine running`);
  out(`  UI      http://127.0.0.1:${app.port}/`);
  out(`  Proxy   127.0.0.1:${app.controller.engine.port}  (HTTP + SOCKS5 + PAC)`);
  out(`  ${C.dim}Ctrl+C to stop (restores Windows proxy settings)${C.reset}\n`);
  const bye = async () => {
    out('\n  shutting down...');
    await app.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  return new Promise(() => {});
}

function usage() {
  out(`
${C.violet}${C.b}Mollah Pro Zone${C.reset} - real VPN/proxy client ${C.dim}(free server pool)${C.reset}

${C.b}Usage${C.reset}
  mollah <command> [options]

${C.b}Commands${C.reset}
  status                    show connection state and IP
  countries                 list all countries with best latency
  servers [--cc DE] [--q text] [--tested] [--limit N]
  test [--cc DE] [--limit N]   measure latency across the pool
  connect [--cc DE | --best | --server <id>]
  disconnect                stop and restore Windows proxy
  ip                        prove the tunnel changed your IP
  leak                      run leak/integrity checks
  serve [--port 8787]       run the engine in the foreground

${C.b}Global options${C.reset}
  --port <n>                control port (default 8787)

${C.b}Examples${C.reset}
  mollah connect --best
  mollah connect --cc JP
  mollah test --cc SG
  curl -x http://127.0.0.1:8899 https://api.ipify.org
`);
  return 0;
}

const TABLE = {
  status: cmdStatus,
  countries: cmdCountries,
  servers: cmdServers,
  test: cmdTest,
  connect: cmdConnect,
  disconnect: cmdDisconnect,
  ip: cmdIp,
  leak: cmdLeak,
  leaks: cmdLeak,
  serve: cmdServe,
  help: usage,
  '--help': usage,
  '-h': usage,
};

const fn = TABLE[cmd];
if (!fn) {
  out(`${C.red}Unknown command: ${cmd}${C.reset}`);
  usage();
  process.exit(2);
}
const code = await fn();
if (typeof code === 'number') process.exit(code);
