/**
 * Mollah Pro Zone - shared constants
 * Free server backend: Urban VPN public free-tier endpoints (verified live).
 */

export const APP = {
  name: 'Mollah Pro Zone',
  short: 'MPZ',
  version: '1.0.0',
  tagline: 'Real Tunnel. Real Speed. Real Privacy.',
  vendor: 'Mollah Pro Zone',
};

export const CLIENT_APP = 'URBAN_VPN_BROWSER_EXTENSION';

export const EP = {
  accountApi: 'https://api-pro.urban-vpn.com/rest/v1',
  securityApi: 'https://api-pro.urban-vpn.com/rest/v1',
  statsApi: 'https://stats.urban-vpn.com/api/rest/v2',
  configApi: 'https://config-toolbar.urban-vpn.com/rest/v3/configs/extensions/urban-vpn',
};

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Default local control + UI port.
 * 8898 is chosen deliberately: 8787 is heavily used by other tools (Burp, Tomcat,
 * various dev servers), and a collision there makes the launcher attach to a
 * foreign app and show a blank window.
 */
export const DEFAULT_CONTROL_PORT = 8898;

/** Upstream proxy port used by the free pool */
export const UPSTREAM_PORT = 8081;

/** How many servers to latency-probe in parallel */
export const PROBE_CONCURRENCY = 24;

/** Server list cache TTL (ms) */
export const POOL_TTL_MS = 5 * 60 * 1000;

/** Proxy token cache: refresh this long before expiry (ms) */
export const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

/** Health-check cadence while connected (ms) */
export const HEALTH_INTERVAL_MS = 20 * 1000;

/**
 * Hosts that must NEVER be tunnelled (auth + local), mirrors upstream bypass list.
 */
export const NEVER_TUNNEL = [
  'dns.google',
  'dns.alidns.com',
  'cloudflare-dns.com',
  'authentication.urban-vpn.com',
  'config-toolbar.urban-vpn.com',
  'api-pro.urban-vpn.com',
  'stats.urban-vpn.com',
  'analytics.urban-vpn.com',
  'www.google-analytics.com',
  'sessions.bugsnag.com',
  'notify.bugsnag.com',
  'localhost',
  '127.0.0.1',
  '::1',
];

/** IP echo services used to prove the tunnel (tried in order) */
export const IP_ECHO = [
  { url: 'https://api.ipify.org?format=json', pick: (j) => j.ip, type: 'json' },
  { url: 'https://ipinfo.io/json', pick: (j) => j.ip, type: 'json' },
  { url: 'https://api.myip.com', pick: (j) => j.ip, type: 'json' },
  { url: 'https://ifconfig.me/ip', pick: (t) => t.trim(), type: 'text' },
  { url: 'https://icanhazip.com', pick: (t) => t.trim(), type: 'text' },
];

/**
 * Latency probe endpoint.
 * NOTE: the upstream free pool accepts CONNECT only for TLS (443); plain HTTP
 * destinations must go through the absolute-URI path. So probe over HTTPS.
 */
export const PROBE_URL = 'https://www.gstatic.com/generate_204';

/** Secondary probe target if the primary is blocked from a given node */
export const PROBE_URL_ALT = 'https://cp.cloudflare.com/generate_204';
