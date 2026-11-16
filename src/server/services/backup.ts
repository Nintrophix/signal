import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db/client.js';
import { istDate, nowS } from '../time.js';

/**
 * Online, consistent SQLite backups (better-sqlite3 backup API — safe while
 * the app is writing). Keeps the newest `keep` daily files.
 */
export async function backupNow(db: DB, dir: string, keep = 14): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `signal-${istDate(nowS())}.db`);
  await db.$client.backup(`${file}.tmp`);
  fs.renameSync(`${file}.tmp`, file);
  const all = fs
    .readdirSync(dir)
    .filter((f) => /^signal-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) fs.rmSync(path.join(dir, old));
  return file;
}

/** Run once at boot (if today's backup is missing) and then every 6h. */
export function scheduleBackups(db: DB, dir: string, keep: number, log: (msg: string) => void): NodeJS.Timeout {
  const run = async () => {
    const today = path.join(dir, `signal-${istDate(nowS())}.db`);
    if (fs.existsSync(today)) return;
    try {
      log(`backup written: ${await backupNow(db, dir, keep)}`);
    } catch (e) {
      log(`backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  void run();
  const t = setInterval(() => void run(), 6 * 3600_000);
  t.unref();
  return t;
}
