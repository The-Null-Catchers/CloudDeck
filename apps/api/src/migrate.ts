import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, transaction } from './db.js';
const dir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
for (const name of readdirSync(dir).filter(n => n.endsWith('.sql')).sort()) {
  await transaction(async client => {
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (existing.rowCount) return;
    await client.query(readFileSync(join(dir, name), 'utf8'));
    await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
  });
  console.log(`migration checked: ${name}`);
}
await pool.end();
