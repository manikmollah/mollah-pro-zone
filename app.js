/* ============================================================
   Mollah Pro Zone — renderer
   ============================================================ */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  snapshot: null,
  settings: {},
  favorites: [],
  recent: [],
  countries: [],
  servers: [],
  activeCc: 'ALL',
  query: '',
  testedOnly: false,
  favOnly: false,
  probe: null,
  samples: [],
  lastBytes: { in: 0, out: 0, at: 0 },
  rate: { down: 0, up: 0 },
  autoBestOnConnect: false,
  log: [],
  connLog: [],
};

const CC_EMOJI = (cc) =>
  String(cc || '')
    .toUpperCase()
    .replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));

const flagUrl = (cc) => `https://flagcdn.com/w40/${String(cc || '').toLowerCase()}.png`;

/** build a flag <img> that gracefully degrades to an emoji */
function flagImg(cc, cls = '') {
  const img = document.createElement('img');
  img.src = flagUrl(cc);
  img.alt = cc || '';
  img.loading = 'lazy';
  if (cls) img.className = cls;
  img.onerror = () => {
    const span = document.createElement('span');
    span.className = cls;
    span.style.fontSize = '15px';
    span.textContent = CC_EMOJI(cc);
    img.replaceWith(span);
  };
  return img;
}

const fmtBytes = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};

/** rate formatting: more decimals when small, none when large */
const fmtRate = (bps) => {
  const n = Number(bps) || 0;
  if (n < 10) return `${n.toFixed(1)} B/s`;
  if (n < 1024) return `${Math.round(n)} B/s`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB/s`;
  return `${(n / 1048576).toFixed(2)} MB/s`;
};

const fmtDuration = (ms) => {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
};

const latClass = (ms) => (ms == null ? 'unknown' : ms < 400 ? 'good' : ms < 1200 ? 'mid' : 'bad');

/* ------------------------------------------------------------ toasts */
function toast(message, kind = 'info', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(24px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

/* ------------------------------------------------------------ api */
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.snapshot && !json.error) throw new Error(`HTTP ${res.status}`);
  return json;
}

/* ------------------------------------------------------------ navigation */
const VIEW_META = {
  home: ['Home', 'Free high-speed servers, hard-tunnelled through a local engine.'],
  servers: ['Servers', 'Live endpoints across 84 countries — test latency and pick your exit.'],
  stats: ['Statistics', 'Session throughput, latency ranking and connection history.'],
  security: ['Security', 'Leak tests, kill switch and split-tunnel control.'],
  stealth: ['Stealth', 'How well your device blends into the exit country — and what cannot be hidden.'],
  settings: ['Settings', 'Routing mode, selection strategy and application behaviour.'],
  logs: ['Live Log', 'Everything the engine is doing, in real time.'],
  about: ['About', 'Developer credits and the technology behind Mollah Pro Zone.'],
};

function go(view) {
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === view));
  const [title, sub] = VIEW_META[view] || ['', ''];
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  if (view === 'servers' && !state.servers.length) loadServers();
  if (view === 'stats') renderStats();
  if (view === 'security') renderSystem();
  if (view === 'stealth') renderStealth();
  if (view === 'settings') renderEngineKv();
  if (view === 'about') wireAbout();
}

/* ------------------------------------------------------------ rendering: state */
function render() {
  const s = state.snapshot;
  if (!s) return;
  const connected = s.state === 'connected';
  const connecting = ['connecting', 'switching', 'preparing', 'disconnecting'].includes(s.state);

  const chip = $('#stateChip');
  chip.classList.toggle('is-connected', connected);
  chip.classList.toggle('is-connecting', connecting);
  chip.classList.toggle('is-error', s.state === 'error');
  $('#stateText').textContent =
    { idle: 'Idle', connected: 'Protected', connecting: 'Connecting…', switching: 'Switching…', preparing: 'Starting…', disconnecting: 'Stopping…', error: 'Error' }[s.state] || s.state;

  const hero = $('.hero');
  hero.classList.toggle('is-connected', connected);
  hero.classList.toggle('is-connecting', connecting);

  $('#heroState').textContent = connected
    ? `Protected — ${s.activeServer?.country ?? ''}`
    : connecting
    ? 'Connecting…'
    : s.state === 'error'
    ? 'Connection failed'
    : 'Not connected';
  $('#heroSub').textContent = connected
    ? `Your traffic exits through ${s.activeServer?.host}:${s.activeServer?.port}`
    : s.lastError
    ? s.lastError
    : 'তোমার আসল IP লুকিয়ে রাখো — এক ক্লিকে';

  $('#btnConnect').textContent = connected ? 'Disconnect' : connecting ? 'Please wait…' : 'Connect';
  $('#btnConnect').disabled = connecting;
  $('#btnAuto').textContent = connected ? 'Change to fastest' : 'Auto (Fastest)';

  $('#ipDirect').textContent = s.ip?.direct ?? '—';
  $('#ipEgress').textContent = s.ip?.egress ?? (connected ? 'checking…' : '—');
  $('#sideIp').textContent = connected ? s.ip?.egress ?? '…' : s.ip?.direct ?? '—';
  $('#sideIpSub').textContent = connected
    ? `${s.activeServer?.cc ?? ''} exit · hiding ${s.ip?.hiding ? 'active' : 'unverified'}`
    : 'direct (not hidden)';

  // device identity summary in the sidebar
  const geo = s.geo;
  $('#sideGeo').textContent = connected && geo ? geo.appliedTimezone ?? geo.timezone ?? geo.cc : '—';
  $('#sideGeoSub').textContent = connected && geo
    ? `${geo.region}${geo.timezoneError ? ' · timezone blocked' : ''}`
    : 'not connected';

  $('#curCountry').textContent = s.activeServer?.country ?? '—';
  $('#curHost').textContent = s.activeServer ? `${s.activeServer.host}:${s.activeServer.port}` : 'no server selected';
  $('#curLatency').textContent = s.activeServer?.latencyMs ? `${s.activeServer.latencyMs} ms` : '—';
  $('#curUptime').textContent = connected ? fmtDuration(s.uptimeMs) : '—';

  const flagHost = $('#flagBig');
  if (s.activeServer?.cc) {
    if (flagHost.dataset.cc !== s.activeServer.cc) {
      flagHost.dataset.cc = s.activeServer.cc;
      flagHost.src = flagUrl(s.activeServer.cc);
      flagHost.onerror = () => (flagHost.style.visibility = 'hidden');
      flagHost.style.visibility = 'visible';
    }
  } else {
    flagHost.removeAttribute('src');
    flagHost.dataset.cc = '';
  }

  $('#sessTotal').textContent = fmtBytes((s.session?.bytesIn || 0) + (s.session?.bytesOut || 0));
  $('#sessConns').textContent = s.session?.connections ?? 0;

  // rates
  const now = Date.now();
  const totalIn = s.session?.bytesIn || 0;
  const totalOut = s.session?.bytesOut || 0;
  if (state.lastBytes.at) {
    const dt = (now - state.lastBytes.at) / 1000;
    if (dt > 0.2) {
      state.rate.down = Math.max(0, (totalIn - state.lastBytes.in) / dt);
      state.rate.up = Math.max(0, (totalOut - state.lastBytes.out) / dt);
    }
  }
  state.lastBytes = { in: totalIn, out: totalOut, at: now };
  $('#rateDown').textContent = fmtRate(state.rate.down);
  $('#rateUp').textContent = fmtRate(state.rate.up);

  // highlight active server row
  $$('#srvBody tr').forEach((tr) => tr.classList.toggle('is-active', tr.dataset.id === s.activeServer?.id));

  renderRoutingWarning(s);
  renderHomeChecks();
}

let routingWarnShown = null;
function renderRoutingWarning(s) {
  const banner = $('#routingWarn');
  if (!s.routingError) {
    if (banner) banner.remove();
    routingWarnShown = null;
    return;
  }
  if (routingWarnShown === s.routingError && banner) return;
  routingWarnShown = s.routingError;
  if (banner) banner.remove();
  const el = document.createElement('div');
  el.id = 'routingWarn';
  el.className = 'warn-banner';
  el.innerHTML =
    `<div class="wb-ic">!</div>
     <div class="wb-body">
       <b>Tunnel is up, but Windows did not accept the system proxy.</b>
       <small>${s.routingError}</small>
       <div class="wb-actions">
         <button class="btn btn-sm btn-primary" id="wbRetry">Try again</button>
         <button class="btn btn-sm btn-ghost" id="wbAdmin">How to fix</button>
         <button class="btn btn-sm btn-ghost" id="wbCopy">Copy proxy address</button>
       </div>
     </div>`;
  $('.views').prepend(el);
  $('#wbRetry').onclick = async () => {
    const r = await api('/retry-proxy', { method: 'POST' });
    toast(r.ok ? 'System proxy applied' : r.error || 'Still blocked', r.ok ? 'ok' : 'err', 7000);
    if (r.ok) el.remove();
  };
  $('#wbAdmin').onclick = () =>
    showModal(
      'Windows blocked the proxy change',
      'Close the app, then right-click "Mollah Pro Zone.exe" and choose "Run as administrator". ' +
        'Some security suites and corporate lockdowns block this by design.\n\n' +
        'Meanwhile the tunnel itself is working — you can use it directly with the proxy address below.'
    );
  $('#wbCopy').onclick = () => {
    navigator.clipboard?.writeText(`127.0.0.1:${s.gatewayPort ?? 8899}`);
    toast('Proxy address copied', 'ok');
  };
}

function showModal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modal').hidden = false;
}

function renderHomeChecks() {
  const s = state.snapshot;
  const connected = s?.state === 'connected';
  const items = [
    ['Tunnel active', connected && !!s.ip?.egress, connected ? (s.ip?.hiding ? 'IP changed' : 'unverified') : 'not connected'],
    ['IPv4 leak blocked', connected && s.ip?.hiding, s.ip?.direct && s.ip?.egress ? `${s.ip.direct} ≠ ${s.ip.egress}` : ''],
    ['Kill switch', !!state.settings.killSwitch, state.settings.killSwitch ? 'armed' : 'optional'],
    ['Auto failover', !!state.settings.autoFailover, `${s?.failoverChain?.length ?? 0} backup nodes`],
  ];
  $('#homeChecks').innerHTML = items
    .map(([label, pass, detail]) => {
      const cls = connected || label === 'Kill switch' || label === 'Auto failover' ? (pass ? 'ok' : '') : '';
      return `<li class="${cls}">${label}${detail ? ` <small>${detail}</small>` : ''}</li>`;
    })
    .join('');
}

/* ------------------------------------------------------------ servers */
async function loadServers() {
  const t0 = Date.now();
  const data = await api(`/servers?limit=5000`);
  state.servers = data.servers || [];
  state.countries = data.countries || [];
  $('#navServerCount').textContent = data.total ?? state.servers.length;
  $('#ccCount').textContent = state.countries.length;
  renderCountries();
  renderServerTable();
  renderQuickLocations();
  renderPoolWarning();
  console.log(`servers loaded in ${Date.now() - t0}ms`);
}

/** When the catalogue could not be fetched (offline / rate limited) offer a retry. */
let poolWarnShown = null;
function renderPoolWarning() {
  const snap = state.snapshot;
  const hasServers = state.servers.length > 0;
  const err = !hasServers ? snap?.lastError || snap?.engineError : null;
  const existing = $('#poolWarn');
  if (!err) {
    if (existing) existing.remove();
    poolWarnShown = null;
    return;
  }
  if (poolWarnShown === err && existing) return;
  poolWarnShown = err;
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'poolWarn';
  el.className = 'warn-banner';
  el.innerHTML =
    `<div class="wb-ic">!</div>
     <div class="wb-body">
       <b>Could not load the server list.</b>
       <small>${err}</small>
       <div class="wb-actions">
         <button class="btn btn-sm btn-primary" id="pwRetry">Retry now</button>
       </div>
     </div>`;
  $('.views').prepend(el);
  $('#pwRetry').onclick = async () => {
    const btn = $('#pwRetry');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    const r = await api('/retry-pool', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = 'Retry now';
    if (r.ok) {
      toast(`Loaded ${r.total} servers across ${r.countries} countries`, 'ok');
      el.remove();
      poolWarnShown = null;
      await loadServers();
    } else {
      toast(r.error || 'Still unavailable', 'warn', 7000);
    }
  };
}

function countryLatency(cc) {
  const list = state.servers.filter((s) => s.cc === cc && s.latencyMs);
  return list.length ? Math.min(...list.map((s) => s.latencyMs)) : null;
}

function renderCountries() {
  const list = state.countries
    .map((c) => ({ ...c, lat: countryLatency(c.cc) }))
    .sort((a, b) => {
      if (a.lat && b.lat) return a.lat - b.lat;
      if (a.lat) return -1;
      if (b.lat) return 1;
      return a.name.localeCompare(b.name);
    });

  const wrap = $('#ccList');
  wrap.innerHTML = '';
  const all = document.createElement('div');
  all.className = `cc ${state.activeCc === 'ALL' ? 'is-active' : ''}`;
  all.innerHTML = `<span class="nm">🌍 All countries</span><span class="lat">${state.servers.length}</span>`;
  all.onclick = () => {
    state.activeCc = 'ALL';
    renderCountries();
    renderServerTable();
  };
  wrap.appendChild(all);

  for (const c of list) {
    const el = document.createElement('div');
    el.className = `cc ${state.activeCc === c.cc ? 'is-active' : ''}`;
    el.appendChild(flagImg(c.cc));
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = c.name;
    el.appendChild(nm);
    const lat = document.createElement('span');
    lat.className = `lat ${c.lat ? latClass(c.lat) : ''}`;
    lat.textContent = c.lat ? `${c.lat}ms` : `${c.serverCount}`;
    el.appendChild(lat);
    el.onclick = () => {
      state.activeCc = c.cc;
      renderCountries();
      renderServerTable();
    };
    wrap.appendChild(el);
  }
}

function visibleServers() {
  let list = state.servers;
  if (state.activeCc !== 'ALL') list = list.filter((s) => s.cc === state.activeCc);
  if (state.testedOnly) list = list.filter((s) => s.latencyMs);
  if (state.favOnly) list = list.filter((s) => state.favorites.includes(s.cc));
  const q = state.query.trim().toLowerCase();
  if (q) list = list.filter((s) => s.country.toLowerCase().includes(q) || s.cc.toLowerCase() === q || s.host.includes(q));
  return list
    .slice()
    .sort((a, b) => (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999) || a.country.localeCompare(b.country));
}

function renderServerTable() {
  const list = visibleServers();
  const shown = list.slice(0, 400);
  $('#srvCount').textContent = `${list.length} shown`;
  const body = $('#srvBody');
  body.innerHTML = '';
  if (!shown.length) {
    body.innerHTML = `<tr><td colspan="5" class="muted" style="padding:26px;text-align:center">No servers match. Try “Test all latency” or a different filter.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of shown) {
    const tr = document.createElement('tr');
    tr.dataset.id = s.id;

    const favTd = document.createElement('td');
    const fav = document.createElement('button');
    fav.className = `fav-btn ${state.favorites.includes(s.cc) ? 'is-fav' : ''}`;
    fav.textContent = state.favorites.includes(s.cc) ? '★' : '☆';
    fav.title = 'Favourite country';
    fav.onclick = async (e) => {
      e.stopPropagation();
      const r = await api('/favorites', { method: 'POST', body: { cc: s.cc } });
      state.favorites = r.favorites;
      renderServerTable();
      renderQuickLocations();
    };
    favTd.appendChild(fav);
    tr.appendChild(favTd);

    const ccTd = document.createElement('td');
    const wrap = document.createElement('div');
    wrap.className = 'cell-cc';
    wrap.appendChild(flagImg(s.cc));
    const nm = document.createElement('div');
    nm.innerHTML = `<div>${s.country}</div><small>${s.cc}${s.premium ? ' · premium' : ''}</small>`;
    wrap.appendChild(nm);
    ccTd.appendChild(wrap);
    tr.appendChild(ccTd);

    const hostTd = document.createElement('td');
    hostTd.innerHTML = `<span class="mono">${s.host}:${s.port}</span>`;
    tr.appendChild(hostTd);

    const latTd = document.createElement('td');
    const lc = latClass(s.latencyMs);
    latTd.innerHTML = `<span class="lat-badge ${lc}"><i></i>${s.latencyMs ? `${s.latencyMs} ms` : 'untested'}</span>`;
    tr.appendChild(latTd);

    const actTd = document.createElement('td');
    actTd.className = 'col-act';
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-ghost';
    btn.textContent = 'Connect';
    btn.onclick = () => connect({ serverId: s.id, cc: s.cc });
    actTd.appendChild(btn);
    tr.appendChild(actTd);

    frag.appendChild(tr);
  }
  body.appendChild(frag);
  render();
}

function renderQuickLocations() {
  const wrap = $('#quickLocations');
  wrap.innerHTML = '';
  const picks = [];
  for (const cc of state.favorites.slice(0, 3)) picks.push({ cc, name: cc });
  for (const r of state.recent.slice(0, 5)) if (!picks.find((p) => p.cc === r.cc)) picks.push({ cc: r.cc, name: r.country || r.cc });
  const lows = state.countries
    .map((c) => ({ ...c, lat: countryLatency(c.cc) }))
    .filter((c) => c.lat)
    .sort((a, b) => a.lat - b.lat)
    .slice(0, 4);
  for (const c of lows) if (!picks.find((p) => p.cc === c.cc)) picks.push({ cc: c.cc, name: c.name, lat: c.lat });

  if (!picks.length) {
    wrap.innerHTML = `<span class="muted small">No history yet — hit “Test all latency” to rank servers.</span>`;
    return;
  }
  for (const p of picks.slice(0, 7)) {
    const chip = document.createElement('button');
    chip.className = `loc-chip ${state.snapshot?.activeServer?.cc === p.cc ? 'is-active' : ''}`;
    chip.appendChild(flagImg(p.cc));
    const label = document.createElement('span');
    label.textContent = p.name || p.cc;
    chip.appendChild(label);
    const lat = p.lat ?? countryLatency(p.cc);
    if (lat) {
      const b = document.createElement('b');
      b.textContent = `${lat}ms`;
      chip.appendChild(b);
    }
    chip.onclick = () => connect({ cc: p.cc });
    wrap.appendChild(chip);
  }
}

/* ------------------------------------------------------------ probe */
async function probeAll() {
  $('#probeBar').hidden = false;
  $('#probeText').textContent = 'Testing latency…';
  await api('/probe', { method: 'POST', body: { limit: 0 } });
}

function onProbeEvent(e) {
  if (e.phase === 'start') {
    $('#probeBar').hidden = false;
    $('#probeFill').style.width = '0%';
    $('#probePct').textContent = '0%';
    $('#probeText').textContent = `Probing ${e.cc || 'all'} servers…`;
  } else if (e.phase === 'progress') {
    const pct = e.total ? Math.round((e.done / e.total) * 100) : 0;
    $('#probeFill').style.width = `${pct}%`;
    $('#probePct').textContent = `${pct}%`;
    $('#probeText').textContent = `Probing… ${e.done}/${e.total} (${e.cc || ''})`;
  } else if (e.phase === 'done') {
    $('#probeFill').style.width = '100%';
    $('#probeText').textContent = `Done — ${e.tested} tested, best ${e.stats?.medianLatency ?? '?'}ms median`;
    setTimeout(() => ($('#probeBar').hidden = true), 2200);
    loadServers();
    toast(`Latency test complete (${e.tested} servers)`, 'ok');
  }
}

/* ------------------------------------------------------------ connect */
async function connect({ cc = null, serverId = null, mode = null } = {}) {
  try {
    const r = await api('/connect', { method: 'POST', body: { cc, serverId, mode } });
    if (r.ok) {
      const snap = r.snapshot;
      toast(`Connected — ${snap.activeServer?.country} (${snap.ip?.egress ?? 'verified'})`, 'ok');
      state.snapshot = snap;
      render();
      renderQuickLocations();
      if (state.settings.protocol === 'gateway') {
        toast(`Point your apps at 127.0.0.1:${state.settings.gatewayPort}`, 'info', 6000);
      }
    } else {
      toast(r.error || 'Connection failed', 'err', 6000);
    }
  } catch (e) {
    toast(`Connect error: ${e.message}`, 'err', 6000);
  }
}

async function disconnect() {
  try {
    const r = await api('/disconnect', { method: 'POST' });
    state.snapshot = r.snapshot;
    render();
    toast('Disconnected — Windows proxy restored', 'info');
  } catch (e) {
    toast(`Disconnect error: ${e.message}`, 'err');
  }
}

/* ------------------------------------------------------------ stealth view */
async function renderStealth() {
  const s = state.snapshot;
  const geo = s?.geo;
  const connected = s?.state === 'connected';

  // device identity table
  const rows = [
    ['Exit country', geo ? `${s.activeServer?.country} (${geo.cc})` : '— not connected'],
    ['Region', geo?.region ?? '—'],
    ['IP timezone (IANA)', geo?.timezone ?? '—'],
    ['Device timezone applied', geo?.appliedTimezone ? geo.appliedTimezone : geo?.timezoneError ? 'blocked — needs admin' : '— not connected'],
    ['Browser locale hint', geo?.locale ?? 'en-US'],
    ['Public exit IP', s?.ip?.egress ?? '—'],
    ['Real IP hidden', connected && s?.ip?.hiding ? 'yes — verified' : connected ? 'not verified' : 'no'],
    ['System proxy', state.settings.protocol === 'gateway' ? 'local gateway only' : 'routed through engine'],
  ];
  $('#identityKv').innerHTML = rows
    .map(([k, v]) => `<li><span>${k}</span><b>${String(v)}</b></li>`)
    .join('');

  // keep the check list in sync without clobbering a fresh audit
  if (!state.stealthChecked) {
    const items = await quickStealthChecks();
    paintStealth(items, connected);
  }
}

/** Cheap checks we can always run; the audit button does the deep pass. */
async function quickStealthChecks() {
  const s = state.snapshot;
  const connected = s?.state === 'connected';
  const checks = [
    { id: 'ip', name: 'Exit IP differs from your real IP', pass: !!(connected && s?.ip?.hiding), detail: s?.ip?.direct && s?.ip?.egress ? `${s.ip.direct} → ${s.ip.egress}` : 'not connected' },
    { id: 'tz', name: 'Device timezone matches exit country', pass: !!(connected && s?.geo?.appliedTimezone), detail: s?.geo?.appliedTimezone ?? s?.geo?.timezoneError ?? 'not applied' },
    { id: 'webrtc', name: 'WebRTC leak guard', pass: !!state.settings.webRtcGuard, detail: state.settings.webRtcGuard ? 'non-proxied UDP blocked' : 'off' },
    { id: 'proxy', name: 'Traffic routed through the tunnel', pass: !!(connected && state.settings.protocol !== 'gateway'), detail: state.settings.protocol },
    { id: 'verify', name: 'IP verified before reporting protected', pass: !!state.settings.hideIpOnLaunch, detail: state.settings.hideIpOnLaunch ? 'yes' : 'disabled' },
  ];
  return checks;
}

function paintStealth(checks, connected) {
  const score = Math.round((checks.filter((c) => c.pass).length / Math.max(checks.length, 1)) * 100);
  const cls = !connected ? 'bad' : score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
  const num = $('#stealthScore');
  num.textContent = connected ? score : '—';
  num.className = cls;

  const ring = $('#scoreRing');
  const circumference = 327;
  ring.style.strokeDashoffset = String(circumference - (circumference * (connected ? score : 0)) / 100);
  ring.style.stroke = !connected ? 'var(--tx-mute)' : score >= 80 ? 'var(--ok)' : score >= 50 ? 'var(--warn)' : 'var(--err)';

  $('#stealthPill').textContent = !connected ? 'idle' : score >= 80 ? 'strong' : score >= 50 ? 'moderate' : 'weak';
  $('#stealthVerdict').textContent = !connected
    ? 'Connect to a server, then run the audit to see how you look from the outside.'
    : score >= 80
    ? 'Your device presents a consistent exit-country identity. Datacenter IPs can still be flagged by some sites.'
    : 'Some layers still show your real environment — connect first, or enable the hardening switches below.';

  $('#stealthList').innerHTML = checks
    .map((c) => `<li class="${c.pass ? 'ok' : 'no'}"><b>${c.name}</b> <small>${c.detail || ''}</small></li>`)
    .join('');
  $('#stealthChecked').textContent = `${checks.filter((c) => c.pass).length}/${checks.length}`;
}

async function runStealthAudit() {
  const btn = $('#btnStealthRun');
  btn.disabled = true;
  btn.textContent = 'Auditing…';
  try {
    const [leaks, ip] = await Promise.all([api('/leaktests'), api('/ip')]);
    const s = state.snapshot;
    const connected = s?.state === 'connected';

    const checks = [
      { id: 'ip', name: 'IP address masked', pass: !!(ip.hiding), detail: ip.direct && ip.egress ? `${ip.direct} → ${ip.egress}` : 'no egress measured' },
      { id: 'exit', name: 'Exit node reachable and verified', pass: !!ip.egress, detail: ip.egress ?? '—' },
      { id: 'tz', name: 'Device timezone matches exit country', pass: !!(connected && s?.geo?.appliedTimezone), detail: s?.geo?.appliedTimezone ?? s?.geo?.timezoneError ?? 'not applied' },
      { id: 'webrtc', name: 'WebRTC cannot leak your real IP', pass: !!state.settings.webRtcGuard, detail: state.settings.webRtcGuard ? 'UDP blocked in app window' : 'disabled' },
      ...((leaks.checks || []).map((c) => ({ id: c.id, name: c.name, pass: c.pass, detail: c.detail, optional: c.optional }))),
    ];

    paintStealth(checks, connected);
    state.stealthChecked = true;

    const failed = checks.filter((c) => !c.pass && !c.optional);
    toast(
      failed.length ? `${failed.length} layer(s) still expose you` : 'All detection layers look consistent',
      failed.length ? 'warn' : 'ok',
      6000
    );
  } catch (e) {
    toast(`Audit failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ic ic-eye"></i> Run detection audit';
  }
}

/* ------------------------------------------------------------ about view */
let aboutWired = false;
function wireAbout() {
  if (aboutWired) return;
  aboutWired = true;
  const URL_FB = 'https://www.facebook.com/share/18ceMbc9uW/';
  $('#btnContact').onclick = () => window.open(URL_FB, '_blank');
  $('#btnCopyContact').onclick = () => {
    navigator.clipboard?.writeText(URL_FB);
    toast('Contact link copied', 'ok');
  };
}

/* ------------------------------------------------------------ stats view */
function renderStats() {
  const s = state.snapshot;
  $('#kpiServers').textContent = s?.pool?.total ?? state.servers.length ?? '—';
  $('#kpiServersSub').textContent = `${s?.pool?.tested ?? 0} tested · ${s?.pool?.alive ?? 0} alive`;
  $('#kpiCountries').textContent = s?.pool?.countries ?? state.countries.length ?? '—';
  const lat = state.servers.map((x) => x.latencyMs).filter(Boolean);
  $('#kpiBest').textContent = lat.length ? `${Math.min(...lat)} ms` : '—';
  $('#kpiSessions').textContent = s ? '—' : '—';

  const life = state.lifetime || {};
  $('#kpiSessions').textContent = life.sessions ?? '0';
  $('#dataDown').textContent = fmtBytes(s?.session?.bytesIn);
  $('#dataUp').textContent = fmtBytes(s?.session?.bytesOut);
  $('#dataLife').textContent = fmtBytes((life.totalBytesIn || 0) + (life.totalBytesOut || 0));

  // latency bars
  const per = state.countries
    .map((c) => ({ cc: c.cc, name: c.name, lat: countryLatency(c.cc) }))
    .filter((x) => x.lat)
    .sort((a, b) => a.lat - b.lat)
    .slice(0, 12);
  const max = per.length ? Math.max(...per.map((p) => p.lat)) : 1;
  $('#latencyBars').innerHTML = per.length
    ? per
        .map(
          (p) => `<div class="bar-row"><span class="nm">${p.name}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(6, (p.lat / max) * 100)}%"></span></span>
        <b>${p.lat} ms</b></div>`
        )
        .join('')
    : '<p class="muted small">No latency data yet — run “Test all latency”.</p>';

  // recent
  $('#recentList').innerHTML = state.recent.length
    ? state.recent
        .map(
          (r) => `<div class="list-item"><span>${CC_EMOJI(r.cc)}</span><span class="nm">${r.country || r.cc}</span><small>${new Date(r.at).toLocaleTimeString()}</small></div>`
        )
        .join('')
    : '<p class="muted small">No connections yet.</p>';
}

/* ------------------------------------------------------------ sparkline */
function drawSpark() {
  const cv = $('#spark');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) {
    cv.width = w * dpr;
    cv.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const samples = state.samples;
  if (samples.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.font = '11px Segoe UI, sans-serif';
    ctx.fillText('waiting for traffic…', 8, h / 2);
    return;
  }
  const max = Math.max(1024, ...samples.map((s) => s.down + s.up));
  const px = (i) => (i / (samples.length - 1)) * w;
  const py = (v) => h - (v / max) * (h - 8) - 4;

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#8b5cf6';

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `${accent}66`);
  grad.addColorStop(1, `${accent}00`);

  ctx.beginPath();
  ctx.moveTo(0, h);
  samples.forEach((s, i) => ctx.lineTo(px(i), py(s.down)));
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(px(i), py(s.down)) : ctx.moveTo(px(i), py(s.down))));
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.8;
  ctx.stroke();

  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(px(i), py(s.up)) : ctx.moveTo(px(i), py(s.up))));
  ctx.strokeStyle = 'rgba(34,211,238,.85)';
  ctx.lineWidth = 1.4;
  ctx.stroke();
}

function pushSample() {
  const s = state.snapshot;
  state.samples.push({ down: state.rate.down, up: state.rate.up, at: Date.now() });
  if (state.samples.length > 90) state.samples.shift();
  drawSpark();
  if ($$('.view')[2]?.classList.contains('is-active')) renderStats();
}

/* ------------------------------------------------------------ security */
async function runLeakTests() {
  const btn = $('#btnLeak');
  btn.disabled = true;
  btn.textContent = 'Running…';
  $('#leakList').innerHTML = '<li class="muted">Testing your tunnel…</li>';
  try {
    const r = await api('/leaktests');
    $('#leakList').innerHTML = (r.checks || [])
      .map((c) => {
        const cls = c.pass ? 'ok' : c.optional ? '' : 'no';
        const tag = c.optional ? ' <small style="opacity:.7">optional</small>' : '';
        return `<li class="${cls}"><b>${c.name}</b>${tag} <small>${c.detail || ''}</small></li>`;
      })
      .join('');
    const failed = r.failed ?? (r.checks || []).filter((c) => !c.pass && !c.optional).length;
    toast(failed ? `${failed} required check(s) failed` : 'All required security checks passed', failed ? 'warn' : 'ok');
  } catch (e) {
    toast(`Leak test error: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="ic ic-shield"></i> Run tests';
  }
}

async function renderSystem() {
  try {
    const p = await api('/system/proxy');
    $('#sysProxyPill').textContent = p.enabled ? 'enabled' : 'off';
    $('#sysGrid').innerHTML = `
      <div class="sys-item"><span>Windows proxy</span><b>${p.enabled ? 'ON' : 'OFF'}</b></div>
      <div class="sys-item"><span>Proxy server</span><b>${p.server ?? '—'}</b></div>
      <div class="sys-item"><span>PAC / AutoConfig</span><b>${p.pac ?? '—'}</b></div>
      <div class="sys-item"><span>Bypass list</span><b>${(p.bypass ?? '—').split(';').slice(0, 4).join(', ')}…</b></div>`;
  } catch {
    /* ignore */
  }
}

async function renderEngineKv() {
  const meta = await api('/meta').catch(() => ({}));
  const port = state.settings.gatewayPort ?? 8899;
  $('#engineKv').innerHTML = `
    <li><span>HTTP / HTTPS proxy</span><b>127.0.0.1:${port}</b></li>
    <li><span>SOCKS5 proxy</span><b>127.0.0.1:${port}</b></li>
    <li><span>PAC URL</span><b>http://127.0.0.1:${meta.controlPort ?? 8787}/api/pac</b></li>
    <li><span>Control API</span><b>http://127.0.0.1:${meta.controlPort ?? 8787}/api</b></li>
    <li><span>Engine</span><b>${meta.engineListening ? 'listening' : 'stopped'}</b></li>
    <li><span>Node runtime</span><b>${meta.node ?? '—'}</b></li>
    <li><span>Administrator</span><b>${meta.elevated ? 'yes' : 'no'}</b></li>
    <li><span>Data folder</span><b>${meta.dataDir ?? '—'}</b></li>`;
}

/* ------------------------------------------------------------ settings */
async function saveSettings(patch, { silent = true } = {}) {
  const r = await api('/settings', { method: 'POST', body: patch });
  state.settings = r.settings;
  if (!silent) toast('Settings saved', 'ok');
  applyTheme();
  return r.settings;
}

function applyTheme() {
  const theme = state.settings.theme || 'dark';
  document.body.className = `theme-${theme}`;
  const accents = { violet: ['#8b5cf6', '#22d3ee'], cyan: ['#06b6d4', '#3b82f6'], emerald: ['#10b981', '#22d3ee'], amber: ['#f59e0b', '#f43f5e'], rose: ['#f43f5e', '#8b5cf6'] };
  const [a, b] = accents[state.settings.accent] || accents.violet;
  document.documentElement.style.setProperty('--accent', a);
  document.documentElement.style.setProperty('--accent-2', b);
  $$('.acc').forEach((el) => el.classList.toggle('is-active', el.dataset.accent === (state.settings.accent || 'violet')));
}

function wireSettings() {
  const bind = (sel, key, transform = (v) => v) => {
    const el = $(sel);
    if (!el) return;
    const handler = () => {
      const value = el.type === 'checkbox' ? el.checked : transform(el.value);
      saveSettings({ [key]: value });
    };
    el.addEventListener('change', handler);
    if (el.type === 'range') el.addEventListener('input', () => ($('#setMaxLatVal').textContent = `${el.value} ms`));
  };

  bind('#setProtocol', 'protocol');
  bind('#setMode', 'mode');
  bind('#setMaxLat', 'maxLatencyMs', Number);
  bind('#setProbeStart', 'probeOnStart');
  bind('#setHideIp', 'hideIpOnLaunch');
  bind('#setConnectLaunch', 'connectOnLaunch');
  bind('#setStartup', 'launchOnStartup');
  bind('#setNotify', 'notifications');
  bind('#setTheme', 'theme');
  // #setKillSwitch is wired separately below (needs admin + firewall side effects)
  bind('#setWebRtc', 'webRtcGuard');
  bind('#setFailover', 'autoFailover');
  // stealth page mirrors
  bind('#setSyncTz', 'syncTimezone');
  bind('#setNeutralLocale', 'neutralLocale');
  bind('#setWebRtc2', 'webRtcGuard');
  bind('#setHideIp2', 'hideIpOnLaunch');

  $$('.acc').forEach((el) =>
    el.addEventListener('click', () => {
      saveSettings({ accent: el.dataset.accent });
      applyTheme();
    })
  );

  $('#btnSaveSplit').onclick = async () => {
    const list = $('#setSplit').value
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    await saveSettings({ splitTunnel: list }, { silent: false });
  };
  $('#btnFlushDns').onclick = async () => {
    const r = await api('/system/flushdns', { method: 'POST' });
    toast(r.ok ? 'DNS cache flushed' : 'Could not flush DNS', r.ok ? 'ok' : 'warn');
  };
  $('#btnResetProxy').onclick = async () => {
    await api('/system/proxy', { method: 'POST', body: { action: 'off' } });
    toast('Windows proxy restored to direct', 'ok');
    renderSystem();
  };
  $('#btnDisableKs').onclick = async () => {
    await api('/system/killswitch', { method: 'POST', body: { enabled: false } });
    toast('Kill switch removed', 'ok');
  };
  $('#setKillSwitch').addEventListener('change', async (e) => {
    if (!e.target.checked) return;
    const r = await api('/system/killswitch', { method: 'POST', body: { enabled: true } });
    if (r && r.ok === false) {
      e.target.checked = false;
      await saveSettings({ killSwitch: false });
      toast(r.error || 'Could not arm the kill switch', 'err', 8000);
    } else {
      toast('Kill switch armed', 'ok');
    }
  });
  $('#btnSysOn').onclick = async () => {
    await api('/system/proxy', { method: 'POST', body: {} });
    toast('System proxy applied', 'ok');
    renderSystem();
  };
  $('#btnSysOff').onclick = async () => {
    await api('/system/proxy', { method: 'POST', body: { action: 'off' } });
    toast('System proxy disabled', 'ok');
    renderSystem();
  };
  $('#btnNetInfo').onclick = async () => {
    const el = $('#netInfo');
    el.hidden = false;
    el.textContent = 'gathering…';
    const info = await api('/system/network');
    el.textContent = JSON.stringify(info, null, 2);
  };
  $('#btnCopyProxy').onclick = () => {
    navigator.clipboard?.writeText(`127.0.0.1:${state.settings.gatewayPort ?? 8899}`);
    toast('Proxy address copied', 'ok');
  };
  $('#btnCopyPac').onclick = () => {
    navigator.clipboard?.writeText(`http://127.0.0.1:8787/api/pac`);
    toast('PAC URL copied', 'ok');
  };
  $('#btnOpenPac').onclick = () => window.open('/api/pac', '_blank');
}

function fillSettingsForm() {
  const s = state.settings;
  const set = (sel, val, prop = 'value') => {
    const el = $(sel);
    if (el) el[prop] = val;
  };
  set('#setProtocol', s.protocol);
  set('#setMode', s.mode);
  set('#setMaxLat', s.maxLatencyMs);
  set('#setMaxLatVal', `${s.maxLatencyMs} ms`, 'textContent');
  set('#setProbeStart', !!s.probeOnStart, 'checked');
  set('#setHideIp', !!s.hideIpOnLaunch, 'checked');
  set('#setConnectLaunch', !!s.connectOnLaunch, 'checked');
  set('#setStartup', !!s.launchOnStartup, 'checked');
  set('#setNotify', !!s.notifications, 'checked');
  set('#setTheme', s.theme);
  set('#setKillSwitch', !!s.killSwitch, 'checked');
  set('#setWebRtc', !!s.webRtcGuard, 'checked');
  set('#setFailover', !!s.autoFailover, 'checked');
  set('#setSplit', (s.splitTunnel || []).join('\n'));
  set('#setSyncTz', s.syncTimezone !== false, 'checked');
  set('#setNeutralLocale', s.neutralLocale !== false, 'checked');
  set('#setWebRtc2', !!s.webRtcGuard, 'checked');
  set('#setHideIp2', !!s.hideIpOnLaunch, 'checked');
  applyTheme();
}

/* ------------------------------------------------------------ logs */
function addLog(entry) {
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  const el = $('#appLog');
  const line = document.createElement('div');
  line.className = `log-line ${entry.level || 'info'}`;
  line.innerHTML = `<time>${new Date(entry.at || Date.now()).toLocaleTimeString()}</time><span>${entry.msg}</span>`;
  el.appendChild(line);
  while (el.childElementCount > 300) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

/* ------------------------------------------------------------ websocket */
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const e = msg.event;
    if (!e) return;
    if (e.kind === 'state' || e.kind === 'tick') {
      if (e.snapshot) {
        state.snapshot = e.snapshot;
        render();
        if (e.kind === 'state' && e.state === 'connected') loadServers();
      }
    } else if (e.kind === 'log') {
      addLog(e);
      if (e.level === 'error') toast(e.msg, 'err', 5000);
    } else if (e.kind === 'probe') {
      onProbeEvent(e);
    } else if (e.kind === 'health') {
      if (!e.ok) addLog({ level: 'warn', msg: `health check failed: ${e.error}`, at: Date.now() });
    } else if (e.kind === 'pool') {
      $('#navServerCount').textContent = e.count;
    } else if (e.kind === 'settings') {
      state.settings = e.settings;
      fillSettingsForm();
    }
  };
  ws.onclose = () => {
    addLog({ level: 'warn', msg: 'live link lost — reconnecting…', at: Date.now() });
    setTimeout(connectWs, 1500);
    // if the API is gone too, the engine really has stopped
    setTimeout(async () => {
      try {
        const r = await fetch('/healthz', { signal: AbortSignal.timeout(2500), cache: 'no-store' });
        if (!r.ok) showEngineLost('Health check failed.');
      } catch {
        showEngineLost('Could not reach the local engine.');
      }
    }, 3000);
  };
}

/* ------------------------------------------------------------ wire UI */
function wireUi() {
  $$('.nav-item').forEach((b) => (b.onclick = () => go(b.dataset.view)));

  $('#powerBtn').onclick = () => (state.snapshot?.state === 'connected' ? disconnect() : connect({ mode: 'smart' }));
  $('#btnConnect').onclick = () => (state.snapshot?.state === 'connected' ? disconnect() : connect({ mode: 'smart' }));
  $('#btnAuto').onclick = () => connect({ mode: 'fastest' });
  $('#btnQuick').onclick = () => (state.snapshot?.state === 'connected' ? disconnect() : connect({ mode: 'fastest' }));

  $('#btnRefresh').onclick = async () => {
    toast('Refreshing server catalogue…', 'info');
    await api('/servers?limit=1');
    await loadServers();
    toast('Server list refreshed', 'ok');
  };

  let searchTimer;
  $('#srvSearch').addEventListener('input', (e) => {
    state.query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderServerTable, 140);
  });
  $('#srvTestedOnly').onchange = (e) => {
    state.testedOnly = e.target.checked;
    renderServerTable();
  };
  $('#srvFavOnly').onchange = (e) => {
    state.favOnly = e.target.checked;
    renderServerTable();
  };
  $('#btnProbeAll').onclick = probeAll;
  $('#btnProbeCancel').onclick = async () => {
    await api('/probe', { method: 'POST', body: { cancel: true } });
    toast('Latency test cancelled', 'info');
  };
  $('#srvAutoOnConnect').onchange = (e) => {
    state.autoBestOnConnect = e.target.checked;
  };
  $('#btnLeak').onclick = runLeakTests;
  $('#btnStealthRun').onclick = runStealthAudit;
  $('#btnClearLog').onclick = () => ($('#appLog').innerHTML = '');
  $('#modalOk').onclick = () => ($('#modal').hidden = true);
  $('#modal').addEventListener('click', (e) => {
    if (e.target.id === 'modal') $('#modal').hidden = true;
  });

  window.addEventListener('resize', drawSpark);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('#modal').hidden = true;
  });
}

/* ------------------------------------------------------------ boot */
let engineLost = false;

/** Called when the live link or the API stops responding. */
function showEngineLost(detail) {
  if (engineLost) return;
  engineLost = true;
  const el = document.createElement('div');
  el.id = 'engineLost';
  el.className = 'warn-banner';
  el.style.background = 'color-mix(in srgb, var(--err) 14%, var(--card-solid))';
  el.style.borderColor = 'color-mix(in srgb, var(--err) 50%, transparent)';
  el.innerHTML =
    `<div class="wb-ic" style="background:color-mix(in srgb, var(--err) 24%, transparent);color:var(--err);border-color:color-mix(in srgb, var(--err) 55%, transparent)">!</div>
     <div class="wb-body">
       <b>The VPN engine stopped responding.</b>
       <small>${detail || 'The background process is not reachable.'}</small>
       <div class="wb-actions">
         <button class="btn btn-sm btn-primary" id="elReload">Reload interface</button>
         <button class="btn btn-sm btn-ghost" id="elHow">What to do</button>
       </div>
     </div>`;
  $('.views').prepend(el);
  $('#elReload').onclick = () => location.reload();
  $('#elHow').onclick = () =>
    showModal(
      'Engine not responding',
      'Close this window, then start "Mollah Pro Zone.exe" again.\n\n' +
        'If it keeps happening, open the log file for the exact reason:\n' +
        '%LOCALAPPDATA%\\MollahProZone\\launcher.log'
    );
}

async function boot() {
  wireUi();
  wireSettings();
  let status;
  try {
    status = await api('/status');
  } catch (e) {
    showEngineLost(e.message);
    throw e;
  }
  if (!status || !status.snapshot) {
    showEngineLost('The engine replied but sent no status.');
    return;
  }
  engineLost = false;
  state.snapshot = status.snapshot;
  state.settings = status.settings;
  state.favorites = status.favorites;
  state.recent = status.recent;
  state.lifetime = status.lifetime;
  (status.log || []).forEach(addLog);
  fillSettingsForm();
  render();
  renderSystem();
  await loadServers();
  await renderEngineKv();
  connectWs();
  setInterval(pushSample, 1000);
  pushSample();

  if (state.settings.connectOnLaunch && state.snapshot.state !== 'connected') {
    connect({ mode: 'smart' });
  }
  if (state.settings.probeOnStart) {
    setTimeout(() => probeAll().catch(() => {}), 1200);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    console.error(e);
    toast(`Startup error: ${e.message}`, 'err', 8000);
  });
});
