#!/usr/bin/env node
// One-shot: copy data from local SQLite to the Postgres database
// pointed to by DATABASE_URL. Creates the schema if needed, then
// inserts every row. Safe to re-run: tables are dropped first.

const path = require('path');
const Database = require('better-sqlite3');
const { Client } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL in the environment.');
  process.exit(1);
}

const sqlitePath = path.join(__dirname, '..', 'database.sqlite');
const sqlite = new Database(sqlitePath, { readonly: true });

const SCHEMA = `
DROP TABLE IF EXISTS item_checks CASCADE;
DROP TABLE IF EXISTS monthly_checks CASCADE;
DROP TABLE IF EXISTS equipment CASCADE;
DROP TABLE IF EXISTS firefighters CASCADE;
DROP TABLE IF EXISTS audits CASCADE;

CREATE TABLE firefighters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  employee_no TEXT UNIQUE NOT NULL
);

CREATE TABLE equipment (
  barcode TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  size TEXT,
  firefighter_id TEXT NOT NULL REFERENCES firefighters(id) ON DELETE CASCADE
);

CREATE TABLE monthly_checks (
  id TEXT PRIMARY KEY,
  firefighter_id TEXT NOT NULL REFERENCES firefighters(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  UNIQUE(firefighter_id, month)
);

CREATE TABLE item_checks (
  id TEXT PRIMARY KEY,
  monthly_check_id TEXT NOT NULL REFERENCES monthly_checks(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  condition TEXT NOT NULL,
  notes TEXT,
  photo_url TEXT,
  checked_at TEXT NOT NULL
);

CREATE TABLE audits (
  id TEXT PRIMARY KEY,
  quarter TEXT NOT NULL,
  audited_by TEXT NOT NULL,
  audited_at TEXT NOT NULL,
  notes TEXT
);

CREATE INDEX idx_item_checks_monthly_check_id ON item_checks(monthly_check_id);
CREATE INDEX idx_item_checks_barcode ON item_checks(barcode);
CREATE INDEX idx_monthly_checks_firefighter_id ON monthly_checks(firefighter_id);
CREATE INDEX idx_monthly_checks_month ON monthly_checks(month);
CREATE INDEX idx_equipment_firefighter_id ON equipment(firefighter_id);
`;

async function main() {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  console.log('Connected to Postgres.');

  console.log('Resetting schema...');
  await pg.query(SCHEMA);
  console.log('  Schema created.');

  const tables = [
    { name: 'firefighters', cols: ['id', 'name', 'employee_no'] },
    { name: 'equipment', cols: ['barcode', 'type', 'description', 'size', 'firefighter_id'] },
    { name: 'monthly_checks', cols: ['id', 'firefighter_id', 'month', 'completed_at'] },
    { name: 'item_checks', cols: ['id', 'monthly_check_id', 'barcode', 'condition', 'notes', 'photo_url', 'checked_at'] },
    { name: 'audits', cols: ['id', 'quarter', 'audited_by', 'audited_at', 'notes'] }
  ];

  for (const t of tables) {
    const rows = sqlite.prepare(`SELECT ${t.cols.join(', ')} FROM ${t.name}`).all();
    console.log(`Copying ${rows.length} rows into ${t.name}...`);
    if (rows.length === 0) continue;

    const placeholders = (i) => '(' + t.cols.map((_, j) => `$${i * t.cols.length + j + 1}`).join(', ') + ')';
    const values = [];
    rows.forEach((r) => t.cols.forEach((c) => values.push(r[c] ?? null)));
    const sql =
      `INSERT INTO ${t.name} (${t.cols.join(', ')}) VALUES ` +
      rows.map((_, i) => placeholders(i)).join(', ');
    await pg.query(sql, values);
  }

  console.log('\nDone. Final counts:');
  for (const t of tables) {
    const r = await pg.query(`SELECT COUNT(*) AS n FROM ${t.name}`);
    console.log(`  ${t.name}: ${r.rows[0].n}`);
  }

  await pg.end();
  sqlite.close();
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
