/**
 * User management. There is no signup route: this CLI is the only way in.
 *
 *   npm run user:add -- someone@example.com [--admin]
 *   npm run user:list
 *   npm run user:disable -- someone@example.com
 *   npm run user:add -- --reset someone@example.com   (new password)
 *
 * A strong password is generated and printed ONCE. To choose your own,
 * pipe it on stdin with --password-stdin.
 */
import { audit } from '../audit.js';
import { activeUserCount, createUser, disableUser, MAX_ACTIVE_USERS, setPassword, UserCapError } from '../auth/users.js';
import { loadConfig } from '../config.js';
import { randomToken } from '../crypto.js';
import { openDb } from '../db/client.js';
import { users } from '../db/schema.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const email = rest.find((a) => !a.startsWith('--'));
  const config = loadConfig();
  const db = openDb(config.databasePath);

  try {
    if (cmd === 'list') {
      const rows = db.select().from(users).all();
      console.log(`${activeUserCount(db)}/${MAX_ACTIVE_USERS} active users`);
      for (const u of rows) console.log(`${u.active ? '●' : '○'} ${u.email}  ${u.role}${u.active ? '' : '  (disabled)'}`);
      return;
    }
    if (!email) throw new Error('Usage: npm run user:add -- email@example.com [--admin] [--password-stdin] | --reset email');

    const password = flags.has('--password-stdin') ? await readStdin() : randomToken(18);

    if (cmd === 'disable') {
      if (!disableUser(db, email)) throw new Error('No such user.');
      audit(db, 'user.disabled', { detail: `cli: ${email}` });
      console.log(`Disabled ${email} and ended their sessions.`);
      return;
    }
    if (cmd === 'add' && flags.has('--reset')) {
      if (!(await setPassword(db, email, password))) throw new Error('No such user.');
      audit(db, 'user.password_reset', { detail: `cli: ${email}` });
      console.log(`Password reset for ${email}.`);
    } else if (cmd === 'add') {
      const u = await createUser(db, email, password, flags.has('--admin') ? 'admin' : 'member');
      audit(db, 'user.created', { userId: u.id, detail: `cli: role=${u.role}` });
      console.log(`Created ${u.email} (${u.role}). ${activeUserCount(db)}/${MAX_ACTIVE_USERS} active users.`);
    } else {
      throw new Error(`Unknown command: ${cmd}`);
    }
    if (!flags.has('--password-stdin')) {
      console.log('\nOne-time password (shown once, share it privately):\n');
      console.log(`  ${password}\n`);
    }
  } catch (e) {
    console.error(e instanceof UserCapError ? e.message : `Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  } finally {
    db.$client.close();
  }
}

void main();
