/**
 * Persistent store for Mollah Pro Zone.
 * - settings / favourites / history in JSON (atomic writes)
 * - secrets (proxy tokens) encrypted at rest with a machine-bound key
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const DEFAULTS = {
  settings: {
    autoConnect: false,
    autoConnectCc: 'AUTO',
    protocol: 'system', // system | pac | manual | gateway
    mode: 'smart', // smart | fastest | specific  (smart = probe then connect)
    killSwitch: false,
    splitTunnel: [], // user exclusion domains
    dnsPreset: 'system',
    theme: 'dark',
    accent: 'violet',
    startMinimized: false,
    launchOnStartup: false,
    autoFailover: true,
    probeOnStart: true,
    connectOnLaunch: false,
    gatewayPort: 8899,
    controlPort: 8898,
    maxLatencyMs: 3000,
    language: 'bn',
    hideIpOnLaunch: true,
    webRtcGuard: true,
    notifications: true,
    /** match the Windows clock + browser locale to the exit country */
    syncTimezone: true,
    /** app window reports en-US instead of the system language */
    neutralLocale: true,
  },
  favorites: [], // server/country codes
  recent: [], // {cc,id,at}
  stats: { sessions: 0, totalBytesIn: 0, totalBytesOut: 0, totalMs: 0, lastConnectedAt: 0 },
};

export class Store {
  #dir;
  #file;
  #keyFile;
  #data;
  #saveTimer = null;
  #key = null;
  #writable = true;

  constructor(dir) {
    this.#dir = dir;
    const dirOk = this.#ensureDir(dir);
    if (!dirOk) {
      // Fall back rather than crashing: a read-only or malformed data path must never
      // stop the engine from starting.
      const fallback = path.join(os.tmpdir(), 'MollahProZone');
      this.#dir = this.#ensureDir(fallback) ? fallback : os.tmpdir();
      this.#writable = false;
    }
    this.#file = path.join(this.#dir, 'mollah-pro-zone.json');
    this.#keyFile = path.join(this.#dir, 'vault.key');
    this.#data = this.#load();
  }

  #ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  get writable() {
    return this.#writable;
  }

  #load() {
    try {
      const raw = fs.readFileSync(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        ...structuredClone(DEFAULTS),
        ...parsed,
        settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
        stats: { ...DEFAULTS.stats, ...(parsed.stats || {}) },
      };
    } catch {
      return structuredClone(DEFAULTS);
    }
  }

  get settings() {
    return this.#data.settings;
  }
  get favorites() {
    return this.#data.favorites;
  }
  get recent() {
    return this.#data.recent;
  }
  get stats() {
    return this.#data.stats;
  }

  update(patch = {}) {
    this.#data.settings = { ...this.#data.settings, ...patch };
    this.save();
    return this.#data.settings;
  }

  toggleFavorite(cc) {
    const set = new Set(this.#data.favorites);
    if (set.has(cc)) set.delete(cc);
    else set.add(cc);
    this.#data.favorites = [...set];
    this.save();
    return this.#data.favorites;
  }

  pushRecent(entry) {
    const list = this.#data.recent.filter((r) => r.cc !== entry.cc);
    list.unshift({ ...entry, at: Date.now() });
    this.#data.recent = list.slice(0, 12);
    this.save();
    return this.#data.recent;
  }

  addStats({ bytesIn = 0, bytesOut = 0, ms = 0 }) {
    const s = this.#data.stats;
    s.sessions += 1;
    s.totalBytesIn += bytesIn;
    s.totalBytesOut += bytesOut;
    s.totalMs += ms;
    s.lastConnectedAt = Date.now();
    this.save();
  }

  save() {
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      try {
        const tmp = `${this.#file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
        fs.renameSync(tmp, this.#file);
      } catch {
        /* ignore persistence errors */
      }
    }, 120);
  }

  // ------------------------------------------------------------- vault

  #vaultKey() {
    if (this.#key) return this.#key;
    try {
      this.#key = fs.readFileSync(this.#keyFile);
      if (this.#key.length !== 32) throw new Error('bad key');
    } catch {
      this.#key = crypto.randomBytes(32);
      try {
        fs.writeFileSync(this.#keyFile, this.#key, { mode: 0o600 });
      } catch {
        /* in-memory key only: secrets just will not survive a restart */
      }
    }
    return this.#key;
  }

  /** encrypt a secret for at-rest storage */
  sealSecret(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.#vaultKey(), iv);
    const enc = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  }

  openSecret(sealed) {
    try {
      const raw = Buffer.from(sealed, 'base64');
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.#vaultKey(), iv);
      decipher.setAuthTag(tag);
      return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    } catch {
      return null;
    }
  }

  get dataDir() {
    return this.#dir;
  }

  // ------------------------------------------------------------- secrets
  // Small encrypted key/value area for session tokens, so a restart reuses the
  // same anonymous identity instead of requesting a brand new one every launch.

  #secrets = null;

  #loadSecrets() {
    if (this.#secrets) return this.#secrets;
    this.#secrets = {};
    try {
      const raw = fs.readFileSync(`${this.#file}.secrets`, 'utf8');
      const opened = this.openSecret(raw.trim());
      if (opened && typeof opened === 'object') this.#secrets = opened;
    } catch {
      /* start empty */
    }
    return this.#secrets;
  }

  getSecret(key) {
    return this.#loadSecrets()[key] ?? null;
  }

  setSecret(key, value) {
    const all = this.#loadSecrets();
    all[key] = value;
    try {
      const tmp = `${this.#file}.secrets.tmp`;
      fs.writeFileSync(tmp, this.sealSecret(all));
      fs.renameSync(tmp, `${this.#file}.secrets`);
    } catch {
      /* best effort */
    }
  }
}

export function defaultDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, 'MollahProZone');
}

export function resolveDataDir(explicit) {
  return explicit || process.env.MOLLAH_DATA_DIR || defaultDataDir();
}
