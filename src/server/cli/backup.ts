/** npm run db:backup — write a consistent snapshot to BACKUP_DIR now. */
import { loadConfig } from '../config.js';
import { openDb } from '../db/client.js';
import { backupNow } from '../services/backup.js';

const config = loadConfig();
const db = openDb(config.databasePath);
const file = await backupNow(db, config.BACKUP_DIR ?? `${config.DATA_DIR}/backups`, config.BACKUP_KEEP);
console.log(`Backup written: ${file}`);
db.$client.close();
