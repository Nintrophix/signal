import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createUser } from '../src/server/auth/users.js';
import { openDb } from '../src/server/db/client.js';
import { backupNow } from '../src/server/services/backup.js';

describe('backups', () => {
  it('writes a consistent snapshot and prunes old ones', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-bk-'));
    const db = openDb(path.join(dir, 'live.db'));
    await createUser(db, 'a@example.com', 'correct horse battery staple');
    const bdir = path.join(dir, 'backups');
    fs.mkdirSync(bdir);
    for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.writeFileSync(path.join(bdir, `signal-${d}.db`), '');
    const file = await backupNow(db, bdir, 2);
    const copy = new Database(file, { readonly: true });
    expect((copy.prepare('select count(*) n from users').get() as { n: number }).n).toBe(1);
    copy.close();
    expect(fs.readdirSync(bdir).filter((f) => f.endsWith('.db'))).toHaveLength(2);
    db.$client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
