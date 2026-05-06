#!/usr/bin/env node
// One-shot: remove WOOD and import USHER from data/Usher.csv,
// preserving existing monthly_checks / item_checks / audits.

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath);

function mapEquipmentType(garmentDetails) {
  const d = (garmentDetails || '').toUpperCase();
  if (d.includes('COAT') && (d.includes('GOLD PBI') || d.includes('TITAN'))) return 'fire_tunic';
  if (d.includes('COAT') && d.includes('HI VIS')) return 'rtc_tunic';
  if (d.includes('TROUSER')) return 'trousers';
  if (d.includes('FIRE FIGHTER GLOVE')) return 'fire_gloves';
  if (d.includes('RESCUE GLOVE') || d.includes('RSQ')) return 'rtc_gloves';
  if (d.includes('BOOT')) return 'boots';
  if (d.includes('HOOD')) return 'hood';
  if (d.includes('HEL') || d.includes('HELMET') || d.includes('HEROS')) return 'helmet';
  if (d.includes('HALF') && d.includes('MASK')) return 'half_mask';
  if (d.includes('BA') && d.includes('MASK')) return 'ba_mask';
  return 'other';
}

function shouldExclude(currentCondition) {
  const c = (currentCondition || '').toUpperCase();
  return c.includes('CONDEMNED') || c.includes('LOST') || c.includes('STOLEN');
}

const swap = db.transaction(() => {
  // Find WOOD
  const wood = db.prepare("SELECT id, name FROM firefighters WHERE name = 'WOOD'").get();
  if (wood) {
    console.log(`Removing WOOD (id=${wood.id})...`);
    // Remove WOOD's item_checks via their monthly_checks
    const checkIds = db.prepare('SELECT id FROM monthly_checks WHERE firefighter_id = ?').all(wood.id).map(r => r.id);
    for (const cid of checkIds) {
      const r = db.prepare('DELETE FROM item_checks WHERE monthly_check_id = ?').run(cid);
      console.log(`  Removed ${r.changes} item_checks for monthly_check ${cid}`);
    }
    db.prepare('DELETE FROM monthly_checks WHERE firefighter_id = ?').run(wood.id);
    db.prepare('DELETE FROM equipment WHERE firefighter_id = ?').run(wood.id);
    db.prepare('DELETE FROM firefighters WHERE id = ?').run(wood.id);
    console.log('  WOOD removed.');
  } else {
    console.log('WOOD not found, skipping removal.');
  }

  // Import USHER
  const csvPath = path.join(__dirname, '..', 'data', 'Usher.csv');
  const content = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true
  });

  let usherFf = null;
  const equipment = [];
  for (const rec of records) {
    if (!rec['Employee No'] || rec['Employee No'].trim() === '') continue;
    const location = rec['Location'] || '';
    if (!location.toUpperCase().includes('HARROLD')) continue;
    if (shouldExclude(rec['Current Condition'])) continue;

    const empNo = rec['Employee No'].trim();
    const empName = rec['Employee Name'].trim();
    const productId = rec['Product ID'].trim();
    const garmentDetails = rec['Garment Details'] || '';
    const size = rec['Size'] || '';

    if (!usherFf) {
      // Re-use existing if same employee_no, else new
      const existing = db.prepare('SELECT id FROM firefighters WHERE employee_no = ?').get(empNo);
      usherFf = { id: existing?.id || crypto.randomUUID(), name: empName, employee_no: empNo };
      if (!existing) {
        db.prepare('INSERT INTO firefighters (id, name, employee_no) VALUES (?, ?, ?)').run(usherFf.id, usherFf.name, usherFf.employee_no);
        console.log(`Added firefighter: ${usherFf.name} (${usherFf.employee_no})`);
      } else {
        console.log(`Found existing firefighter ${empName} (${empNo})`);
      }
    }

    equipment.push({
      barcode: productId,
      type: mapEquipmentType(garmentDetails),
      description: garmentDetails,
      size,
      firefighter_id: usherFf.id
    });
  }

  const insertEq = db.prepare('INSERT OR REPLACE INTO equipment (barcode, type, description, size, firefighter_id) VALUES (?, ?, ?, ?, ?)');
  const seen = new Set();
  let count = 0;
  for (const eq of equipment) {
    if (seen.has(eq.barcode)) continue;
    insertEq.run(eq.barcode, eq.type, eq.description, eq.size, eq.firefighter_id);
    seen.add(eq.barcode);
    count++;
  }
  console.log(`USHER equipment items inserted: ${count}`);
});

swap();

console.log('\nFinal firefighter list:');
for (const ff of db.prepare('SELECT name, employee_no FROM firefighters ORDER BY name').all()) {
  console.log(`  ${ff.name} (${ff.employee_no})`);
}
console.log('\nIntegrity:');
console.log('  monthly_checks:', db.prepare('SELECT COUNT(*) as n FROM monthly_checks').get().n);
console.log('  item_checks:   ', db.prepare('SELECT COUNT(*) as n FROM item_checks').get().n);

db.close();
