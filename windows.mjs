/**
 * Windows platform integration for Mollah Pro Zone.
 *  - system-wide proxy (WinINet / Internet Settings) with auto-config + PAC
 *  - WinINet refresh so already-running browsers pick up changes
 *  - admin detection
 *  - kill switch via Windows Firewall (netsh advfirewall)
 *  - startup registration (HKCU Run)
 *  - DNS cache flush
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);
const IS_WIN = process.platform === 'win32';
const INET_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const KILLSWITCH_RULE = 'MollahProZone-KillSwitch';

async function reg(args, { timeout = 15000 } = {}) {
  if (!IS_WIN) throw new Error('Windows only');
  try {
    const { stdout } = await exec('reg.exe', args, { timeout, windowsHide: true });
    return stdout;
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || '').trim();
    const e = new Error(detail || err.message);
    e.code = err.code;
    e.regArgs = args;
    throw e;
  }
}

async function regQueryValue(name) {
  try {
    const out = await reg(['query', INET_KEY, '/v', name]);
    const m = out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`, 'i'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** single-quote a value for a PowerShell literal */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const POWERSHELL = 'powershell.exe';
const PS_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * Run a PowerShell script using -EncodedCommand (base64 UTF-16LE).
 *
 * The script is never re-parsed from the command line, which matters because when the
 * engine runs as a windowless child with redirected stdio, passing the same script via
 * -Command gets mangled ("Command failed: powershell.exe ... HKCU:\Software\.").
 */
async function runPowerShell(script, { timeout = 25000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout, stderr } = await exec(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }
  );
  return { stdout: String(stdout || ''), stderr: String(stderr || '') };
}

/**
 * Ask the desktop launcher (a normal, console-free Win32 process) to write the value.
 * The launcher opens a loopback JSON helper for exactly this purpose, which makes proxy
 * changes work on machines where spawning PowerShell or reg.exe is blocked by policy.
 * @returns {Promise<boolean>} true when the helper confirms the write
 */
async function viaLauncherHelper({ action = 'set', name, type, value }) {
  const port = Number(process.env.MOLLAH_HELPER_PORT || 0);
  if (!port) return false;
  try {
    const net = await import('node:net');
    const payload = JSON.stringify({ action, name, type, value: value == null ? null : String(value) });
    return await new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(v);
      };
      sock.setTimeout(4000, () => finish(false));
      sock.on('error', () => finish(false));
      sock.on('connect', () => sock.write(payload));
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('utf8');
        if (buf.includes('}')) {
          try {
            finish(!!JSON.parse(buf).ok);
          } catch {
            finish(false);
          }
        }
      });
      sock.on('close', () => finish(buf.includes('"ok":true')));
    });
  } catch {
    return false;
  }
}

/**
 * Write a Windows Internet Settings value.
 *
 * Three mechanisms, in order:
 *   1. the launcher's registry helper (most reliable; no external tools)
 *   2. PowerShell's registry provider via -EncodedCommand
 *   3. reg.exe
 * The value is then read back to confirm it really landed.
 */
async function regSetValue(name, type, value) {
  const v = String(value);
  const isDword = type === 'REG_DWORD';
  const psValue = isDword ? (v === '1' || v === '0x1' ? 1 : 0) : psQuote(v);
  const psType = isDword ? 'DWord' : 'String';
  const expect = isDword ? (v === '1' || v === '0x1' ? 1 : 0) : v;

  // 1. launcher helper
  if (await viaLauncherHelper({ action: 'set', name, type, value: v })) {
    if (await verifyValue(name, expect, isDword)) return;
  }

  // 2. PowerShell registry provider
  let psErr = null;
  try {
    const script =
      `$ErrorActionPreference='Stop'\n` +
      `Set-ItemProperty -Path ${psQuote(PS_KEY)} -Name ${psQuote(name)} -Value ${psValue} -Type ${psType}\n` +
      `Write-Output 'mpz-ok'`;
    const { stdout } = await runPowerShell(script);
    if (String(stdout).includes('mpz-ok') && (await verifyValue(name, expect, isDword))) return;
    psErr = new Error('PowerShell did not confirm the write');
  } catch (err) {
    psErr = err;
  }

  // 3. reg.exe
  let regErr = null;
  try {
    await reg(['add', INET_KEY, '/v', name, '/t', type, '/d', v, '/f']);
    if (await verifyValue(name, expect, isDword)) return;
    regErr = new Error('reg.exe reported success but the value did not change');
  } catch (err) {
    regErr = err;
  }

  // final check: maybe it actually landed despite the noise above
  if (await verifyValue(name, expect, isDword)) return;

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const e = new Error(
    `Windows blocked the proxy setting change (${name} = "${v}"). ` +
      `Launcher helper: unavailable or refused. PowerShell: ${clean(psErr?.message)}. ` +
      `reg.exe: ${clean(regErr?.message)}. ` +
      `Fix: close Mollah Pro Zone, right-click "Mollah Pro Zone.exe" and pick ` +
      `"Run as administrator", then connect again. ` +
      `(Some corporate lockdowns and security suites block this by design.)`
  );
  e.code = regErr?.code;
  throw e;
}

/** read a value back and compare, tolerating string/number forms */
async function verifyValue(name, expect, isDword) {
  const current = await regQueryValue(name);
  if (current == null) return false;
  if (isDword) return Number(current) === Number(expect);
  return String(current) === String(expect);
}

async function regDeleteValue(name) {
  if (await viaLauncherHelper({ action: 'delete', name })) return;

  const script =
    `$ErrorActionPreference='SilentlyContinue'\n` +
    `Remove-ItemProperty -Path ${psQuote(PS_KEY)} -Name ${psQuote(name)} -Force\n` +
    `Write-Output 'mpz-ok'`;
  try {
    await runPowerShell(script, { timeout: 20000 });
    return;
  } catch {
    /* fall through */
  }
  try {
    await reg(['delete', INET_KEY, '/v', name, '/f']);
  } catch {
    /* value may not exist */
  }
}

/** Refresh WinINet settings so running apps see the change immediately. */
export async function refreshWinInet() {
  if (!IS_WIN) return false;
  const script = `
$sig = @'
[DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
try {
  $t = Add-Type -MemberDefinition $sig -Name WinInet -Namespace MPZ -PassThru -ErrorAction Stop
  [void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)
  [void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)
  Write-Output "mpz-ok"
} catch { Write-Output "mpz-skip" }
`;
  try {
    const { stdout } = await runPowerShell(script, { timeout: 20000 });
    return stdout.includes('mpz-ok');
  } catch {
    return false;
  }
}

export async function isElevated() {
  if (!IS_WIN) return false;
  try {
    const { stdout } = await runPowerShell(
      '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      { timeout: 15000 }
    );
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

/** Raw registry state — used internally for exact backup/restore (port kept even when off). */
export async function readProxyState() {
  if (!IS_WIN) return { enabled: false, server: null, pac: null, bypass: null, autoDetect: false };
  const [enabled, server, pac, bypass, autoDetect] = await Promise.all([
    regQueryValue('ProxyEnable'),
    regQueryValue('ProxyServer'),
    regQueryValue('AutoConfigURL'),
    regQueryValue('ProxyOverride'),
    regQueryValue('AutoDetect'),
  ]);
  const isOn = (v) => v === '0x1' || v === '1';
  return {
    enabled: isOn(enabled),
    server: server || null,
    pac: pac || null,
    bypass: bypass || null,
    autoDetect: isOn(autoDetect),
  };
}

/** User-facing view: hides a stale server/PAC string while the proxy is switched off. */
export async function getSystemProxy() {
  const s = await readProxyState();
  if (!s.enabled) return { ...s, server: null, pac: null };
  return s;
}

/** Back up current proxy config so we can restore exactly what the user had. */
export async function backupProxy() {
  return await readProxyState();
}

export async function restoreProxy(backup) {
  if (!IS_WIN) return false;
  if (!backup) return await disableSystemProxy();
  if (backup.enabled) {
    if (backup.server) await regSetValue('ProxyServer', 'REG_SZ', backup.server);
    if (backup.bypass) await regSetValue('ProxyOverride', 'REG_SZ', backup.bypass);
    if (backup.pac) await regSetValue('AutoConfigURL', 'REG_SZ', backup.pac);
    else await regDeleteValue('AutoConfigURL');
    await regSetValue('ProxyEnable', 'REG_DWORD', 1);
  } else {
    await regSetValue('ProxyEnable', 'REG_DWORD', 0);
    await regDeleteValue('AutoConfigURL');
  }
  await refreshWinInet();
  return true;
}

/**
 * Enable a system-wide proxy.
 * @param {{http:string, https?:string, socks?:string, bypass?:string, pacUrl?:string}} cfg
 */
export async function enableSystemProxy(cfg) {
  if (!IS_WIN) throw new Error('Windows only');
  if (cfg.pacUrl) {
    await regDeleteValue('ProxyServer');
    await regSetValue('AutoConfigURL', 'REG_SZ', cfg.pacUrl);
    await regSetValue('ProxyEnable', 'REG_DWORD', 1);
  } else {
    await regDeleteValue('AutoConfigURL');
    const server = cfg.socks
      ? cfg.socks
      : [cfg.http, cfg.https].filter(Boolean).join(';');
    await regSetValue('ProxyServer', 'REG_SZ', server);
    const bypass =
      cfg.bypass ??
      ['localhost', '127.*', '10.*', '172.16.*', '172.17.*', '172.18.*', '172.19.*', '172.2*', '172.30.*', '172.31.*', '192.168.*', '<local>'].join(';');
    await regSetValue('ProxyOverride', 'REG_SZ', bypass);
    await regSetValue('ProxyEnable', 'REG_DWORD', 1);
  }
  const refreshed = await refreshWinInet();
  return { ok: true, refreshed, ...(await readProxyState()) };
}

export async function disableSystemProxy() {
  if (!IS_WIN) throw new Error('Windows only');
  await regSetValue('ProxyEnable', 'REG_DWORD', 0);
  await regDeleteValue('AutoConfigURL');
  const refreshed = await refreshWinInet();
  return { ok: true, refreshed, ...(await readProxyState()) };
}

// --------------------------------------------------------------- kill switch

export async function enableKillSwitch(allowedIps = []) {
  if (!IS_WIN) throw new Error('Windows only');
  await disableKillSwitch();
  const cmds = [
    // block all outbound
    ['advfirewall', 'firewall', 'add', 'rule', `name=${KILLSWITCH_RULE}`, 'dir=out', 'action=block', 'enable=yes', 'profile=any'],
  ];
  for (const ip of allowedIps.filter(Boolean)) {
    cmds.push([
      'advfirewall',
      'firewall',
      'add',
      'rule',
      `name=${KILLSWITCH_RULE}-allow-${ip}`,
      'dir=out',
      'action=allow',
      `remoteip=${ip}`,
      'enable=yes',
      'profile=any',
    ]);
  }
  for (const args of cmds) {
    await exec('netsh.exe', args, { timeout: 30000, windowsHide: true });
  }
  return { ok: true, allowedIps };
}

export async function disableKillSwitch() {
  if (!IS_WIN) return { ok: false };
  try {
    const { stdout } = await exec('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=all`], {
      timeout: 30000,
      windowsHide: true,
    });
    const names = [...new Set((stdout.match(new RegExp(`${KILLSWITCH_RULE}[^\\r\\n]*`, 'g')) || []).map((s) => s.trim()))];
    for (const name of names) {
      await exec('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`], {
        timeout: 30000,
        windowsHide: true,
      }).catch(() => {});
    }
    // also delete the base rule unconditionally
    await exec('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', `name=${KILLSWITCH_RULE}`], {
      timeout: 30000,
      windowsHide: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
  return { ok: true };
}

export async function killSwitchActive() {
  if (!IS_WIN) return false;
  try {
    const { stdout } = await exec('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', `name=${KILLSWITCH_RULE}`], {
      timeout: 20000,
      windowsHide: true,
    });
    return stdout.includes(KILLSWITCH_RULE);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ startup

export async function setLaunchOnStartup(enabled, exePath) {
  if (!IS_WIN) return false;
  if (enabled) {
    await reg(['add', RUN_KEY, '/v', 'MollahProZone', '/t', 'REG_SZ', '/d', `"${exePath}"`, '/f']);
  } else {
    try {
      await reg(['delete', RUN_KEY, '/v', 'MollahProZone', '/f']);
    } catch {
      /* ignore */
    }
  }
  return true;
}

export async function flushDns() {
  if (!IS_WIN) return false;
  try {
    await exec('ipconfig.exe', ['/flushdns'], { timeout: 20000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ timezone

/** Read the current Windows timezone id, e.g. "Bangladesh Standard Time". */
export async function getTimezone() {
  if (!IS_WIN) return null;
  try {
    const { stdout } = await exec('tzutil.exe', ['/g'], { timeout: 12000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Translate an IANA zone (e.g. "Asia/Tokyo") to the id tzutil expects.
 * Modern Windows accepts IANA names directly; older builds need the Windows id.
 */
export async function ianaToWindowsZone(iana) {
  if (!IS_WIN || !iana) return iana;
  try {
    const json = JSON.stringify(iana);
    const script =
      `$ErrorActionPreference='Stop'\n` +
      `$want = ${json}\n` +
      `$tz = Get-TimeZone -ListAvailable | Where-Object { $_.Id -eq $want } | Select-Object -First 1\n` +
      `if (-not $tz) { $leaf = ($want -split '/')[-1]; $tz = Get-TimeZone -ListAvailable | Where-Object { $_.Id -like ('*' + $leaf + '*') } | Select-Object -First 1 }\n` +
      `if ($tz) { Write-Output $tz.Id } else { Write-Output $want }`;
    const { stdout } = await runPowerShell(script, { timeout: 25000 });
    const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
    return lines.length ? lines[lines.length - 1].trim() : iana;
  } catch {
    return iana;
  }
}

/**
 * Change the Windows timezone so the desktop clock matches the exit country.
 * Some machines require elevation for this; failures raise a clear message.
 */
export async function setTimezone(zone) {
  if (!IS_WIN) throw new Error('Windows only');
  if (!zone) throw new Error('no timezone given');

  const resolved = await ianaToWindowsZone(zone);
  const before = await getTimezone();

  try {
    await exec('tzutil.exe', ['/s', resolved], { timeout: 15000, windowsHide: true });
  } catch (err) {
    const detail = String(err.stderr || err.message || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    throw new Error(
      `Windows refused the timezone change to "${resolved}".` +
        (detail ? ` ${detail}.` : '') +
        ` Run Mollah Pro Zone as administrator to enable automatic timezone matching.`
    );
  }

  const applied = await getTimezone();
  if (applied && resolved && applied !== resolved) {
    throw new Error(
      `Windows did not apply the timezone "${resolved}" (still "${applied}"). ` +
        `Administrator rights are required for this machine.`
    );
  }
  return { requested: zone, zone: resolved, previous: before, applied };
}

// -------------------------------------------------------------- diagnostics

export async function networkInfo() {
  const info = { hostname: null, adapters: [], dns: [] };
  try {
    info.hostname = (await exec('hostname', [], { windowsHide: true })).stdout.trim();
  } catch {
    /* ignore */
  }
  if (IS_WIN) {
    try {
      const { stdout } = await runPowerShell(
        'Get-NetIPConfiguration | Where-Object {$_.NetAdapter.Status -eq "Up"} | ForEach-Object { "{0}|{1}" -f $_.InterfaceAlias, ($_.IPv4Address.IPAddress -join ",") }',
        { timeout: 25000 }
      );
      info.adapters = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, ips] = l.split('|');
          return { name, ips: (ips || '').split(',').filter(Boolean) };
        });
    } catch {
      /* ignore */
    }
    try {
      const ps = `$ErrorActionPreference='SilentlyContinue'; Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses} | ForEach-Object { ($_.ServerAddresses -join ',') }`;
      const { stdout } = await runPowerShell(ps, { timeout: 25000 });
      info.dns = [...new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
    } catch {
      /* ignore */
    }
  }
  return info;
}

export function exePath() {
  return process.execPath;
}

export function appRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
}

export function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
