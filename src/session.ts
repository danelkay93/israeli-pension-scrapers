import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, rmSync, chmodSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionStore } from './types.js';

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
interface SessionBundle { savedAt: number; cookies: unknown[]; }

export function defaultDataDir(appName = 'israeli-pension-scrapers'): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', appName);
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), appName);
  return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), appName);
}

/** Hash the entire provider-qualified identity, without sanitizing or truncating. */
export function connectionKey(fundId: string, connectionId?: string, memberId?: string): string {
  if (!connectionId?.trim() && !memberId?.trim()) throw new Error('CONNECTION_ID_REQUIRED');
  return createHash('sha256').update(JSON.stringify([fundId, connectionId ?? null, memberId?.trim() ?? null])).digest('hex');
}

function fileKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface FileSessionStoreOptions {
  baseDir?: string;
  appName?: string;
  /** Invalid, future-dated and expired bundles are deleted on load. */
  maxAgeMs?: number;
}

/** Explicitly share this store to reuse cookies in memory across scrapes.
 * The scrape default creates a fresh instance each time and persists nothing. */
export function createMemorySessionStore(): SessionStore {
  const cookiesByKey = new Map<string, unknown[]>();
  return {
    async load(key) { return cookiesByKey.get(key) ?? null; },
    async save(key, cookies) { cookiesByKey.set(key, cookies); },
    async clear(key) { cookiesByKey.delete(key); },
  };
}

/** Plaintext storage. POSIX modes do not provide Windows ACL protection. */
export function createFileSessionStore(opts: FileSessionStoreOptions = {}): SessionStore {
  const dir = opts.baseDir ?? defaultDataDir(opts.appName);
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('INVALID_SESSION_TTL');
  const pathFor = (key: string): string => join(dir, 'session-' + fileKey(key) + '.json');
  const clear = async (key: string): Promise<void> => {
    try { unlinkSync(pathFor(key)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  return {
    async load(key) {
      try {
        const bundle = JSON.parse(readFileSync(pathFor(key), 'utf8')) as SessionBundle;
        const age = Date.now() - bundle.savedAt;
        if (!Number.isFinite(bundle.savedAt) || age < 0 || age > maxAgeMs
          || !Array.isArray(bundle.cookies) || !bundle.cookies.length) {
          await clear(key);
          return null;
        }
        return bundle.cookies;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await clear(key);
        return null;
      }
    },
    async save(key, cookies) {
      if (!cookies.length) return clear(key);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(dir, 0o700);
      const destination = pathFor(key);
      const temporary = destination + '.' + randomBytes(16).toString('hex') + '.tmp';
      try {
        writeFileSync(temporary, JSON.stringify({ savedAt: Date.now(), cookies }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameSync(temporary, destination);
      } finally {
        try { unlinkSync(temporary); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    },
    clear,
  };
}

/** Clear local cookies and the matching optional profile. Close active scrapes first.
 * This cannot revoke tokens at the provider; use its sign-out/revoke controls too. */
export async function clearPensionSession(args: {
  fundId: string; connectionId?: string; memberId?: string;
  session?: SessionStore; profileBaseDir?: string;
}): Promise<void> {
  const key = connectionKey(args.fundId, args.connectionId, args.memberId);
  await args.session?.clear(key);
  if (args.profileBaseDir) rmSync(join(args.profileBaseDir, key), { recursive: true, force: true });
}
