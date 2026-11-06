import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
const db = new DatabaseSync(path, { readOnly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);

console.log(`tables (${tables.length}):`, tables.join(', '));
console.log('schema_version:', JSON.stringify(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()));
console.log('integrity_check:', JSON.stringify(db.prepare('PRAGMA integrity_check').get()));

for (const t of ['page', 'block', 'fts_block', 'recent', 'setting']) {
  if (!tables.includes(t)) continue;
  const n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  console.log(`  ${t}: ${n} row(s)`);
}
db.close();