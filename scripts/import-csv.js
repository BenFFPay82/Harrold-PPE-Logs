#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const Database = require('better-sqlite3');

// Database setup
const dbPath = path.join(__dirname, '..', 'database.sqlite');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS firefighters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    employee_no TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS equipment (
    barcode TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    size TEXT,
    firefighter_id TEXT NOT NULL,
    FOREIGN KEY (firefighter_id) REFERENCES firefighters(id)
  );

  CREATE TABLE IF NOT EXISTS monthly_checks (
    id TEXT PRIMARY KEY,
    firefighter_id TEXT NOT NULL,
    month TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    FOREIGN KEY (firefighter_id) REFERENCES firefighters(id),
    UNIQUE(firefighter_id, month)
  );

  CREATE TABLE IF NOT EXISTS item_checks (
    id TEXT PRIMARY KEY,
    monthly_check_id TEXT NOT NULL,
    barcode TEXT NOT NULL,
    condition TEXT NOT NULL,
    notes TEXT,
    photo_url TEXT,
    checked_at TEXT NOT NULL,
    FOREIGN KEY (monthly_check_id) REFERENCES monthly_checks(id),
    FOREIGN KEY (barcode) REFERENCES equipment(barcode)
  );

  CREATE TABLE IF NOT EXISTS audits (
    id TEXT PRIMARY KEY,
    quarter TEXT NOT NULL,
    audited_by TEXT NOT NULL,
    audited_at TEXT NOT NULL,
    notes TEXT
  );
`);

// Equipment type mapping based on garment details keywords
function mapEquipmentType(garmentDetails) {
  const details = garmentDetails.toUpperCase();

  if (details.includes('COAT') && (details.includes('GOLD PBI') || details.includes('TITAN'))) {
    return 'fire_tunic';
  }
  if (details.includes('COAT') && details.includes('HI VIS')) {
    return 'rtc_tunic';
  }
  if (details.includes('TROUSER')) {
    return 'trousers';
  }
  if (details.includes('FIRE FIGHTER GLOVE') || details.includes('FIRE FIGHTER GLOVE')) {
    return 'fire_gloves';
  }
  if (details.includes('RESCUE GLOVE') || details.includes('RSQ')) {
    return 'rtc_gloves';
  }
  if (details.includes('BOOT')) {
    return 'boots';
  }
  if (details.includes('HOOD')) {
    return 'hood';
  }
  if (details.includes('HEL') || details.includes('HELMET') || details.includes('HEROS')) {
    return 'helmet';
  }
  if (details.includes('HALF') && details.includes('MASK')) {
    return 'half_mask';
  }
  if (details.includes('BA') && details.includes('MASK')) {
    return 'ba_mask';
  }

  return 'other';
}

// Check if condition indicates item should be excluded
function shouldExclude(currentCondition) {
  if (!currentCondition) return false;
  const condition = currentCondition.toUpperCase();
  return condition.includes('CONDEMNED') ||
         condition.includes('LOST') ||
         condition.includes('STOLEN');
}

// Generate unique ID
function generateId() {
  return require('crypto').randomUUID();
}

// Process CSV files
function processCSVFiles(csvPaths) {
  const firefighters = new Map();
  const equipment = [];

  for (const csvPath of csvPaths) {
    console.log(`Processing: ${csvPath}`);

    const content = fs.readFileSync(csvPath, 'utf-8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true
    });

    for (const record of records) {
      // Skip rows without employee number (service history continuation rows)
      if (!record['Employee No'] || record['Employee No'].trim() === '') {
        continue;
      }

      // Only import Harrold station items
      const location = record['Location'] || '';
      if (!location.toUpperCase().includes('HARROLD')) {
        continue;
      }

      // Skip condemned, lost or stolen items
      const currentCondition = record['Current Condition'] || '';
      if (shouldExclude(currentCondition)) {
        console.log(`  Skipping (${currentCondition.split(' - ').pop()}): ${record['Product ID']}`);
        continue;
      }

      const employeeNo = record['Employee No'].trim();
      const employeeName = record['Employee Name'].trim();
      const productId = record['Product ID'].trim();
      const garmentDetails = record['Garment Details'] || '';
      const size = record['Size'] || '';

      // Add firefighter if not exists
      if (!firefighters.has(employeeNo)) {
        firefighters.set(employeeNo, {
          id: generateId(),
          name: employeeName,
          employee_no: employeeNo
        });
      }

      // Add equipment
      const equipmentType = mapEquipmentType(garmentDetails);
      equipment.push({
        barcode: productId,
        type: equipmentType,
        description: garmentDetails,
        size: size,
        firefighter_id: firefighters.get(employeeNo).id
      });
    }
  }

  return { firefighters: Array.from(firefighters.values()), equipment };
}

// Insert data into database
function insertData(firefighters, equipment) {
  // Clear existing data
  db.exec('DELETE FROM item_checks');
  db.exec('DELETE FROM monthly_checks');
  db.exec('DELETE FROM equipment');
  db.exec('DELETE FROM firefighters');

  // Insert firefighters
  const insertFirefighter = db.prepare(
    'INSERT INTO firefighters (id, name, employee_no) VALUES (?, ?, ?)'
  );

  for (const ff of firefighters) {
    insertFirefighter.run(ff.id, ff.name, ff.employee_no);
    console.log(`Added firefighter: ${ff.name} (${ff.employee_no})`);
  }

  // Insert equipment (handle duplicates by barcode)
  const insertEquipment = db.prepare(
    'INSERT OR REPLACE INTO equipment (barcode, type, description, size, firefighter_id) VALUES (?, ?, ?, ?, ?)'
  );

  const seenBarcodes = new Set();
  let equipmentCount = 0;

  for (const eq of equipment) {
    if (!seenBarcodes.has(eq.barcode)) {
      insertEquipment.run(eq.barcode, eq.type, eq.description, eq.size, eq.firefighter_id);
      seenBarcodes.add(eq.barcode);
      equipmentCount++;
    }
  }

  console.log(`\nImport complete:`);
  console.log(`  Firefighters: ${firefighters.length}`);
  console.log(`  Equipment items: ${equipmentCount}`);
}

// Main
function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Default: process all CSVs in data directory
    const dataDir = path.join(__dirname, '..', 'data');
    const csvFiles = fs.readdirSync(dataDir)
      .filter(f => f.endsWith('.csv'))
      .map(f => path.join(dataDir, f));

    if (csvFiles.length === 0) {
      console.error('No CSV files found in data directory');
      process.exit(1);
    }

    console.log(`Found ${csvFiles.length} CSV files\n`);
    const { firefighters, equipment } = processCSVFiles(csvFiles);
    insertData(firefighters, equipment);
  } else {
    // Process specified files
    const { firefighters, equipment } = processCSVFiles(args);
    insertData(firefighters, equipment);
  }
}

main();
db.close();
