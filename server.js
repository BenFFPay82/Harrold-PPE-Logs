const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== Database (Postgres / Supabase) ==========
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Supabase pooler uses TLS
});

// Helpers around the pool
async function query(sql, params = []) {
  return pool.query(sql, params);
}
async function all(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows;
}
async function get(sql, params = []) {
  const r = await pool.query(sql, params);
  return r.rows[0] || null;
}

// Make sure schema exists (idempotent — safe to run on every boot)
async function ensureSchema() {
  await query(`
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
      firefighter_id TEXT NOT NULL REFERENCES firefighters(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS monthly_checks (
      id TEXT PRIMARY KEY,
      firefighter_id TEXT NOT NULL REFERENCES firefighters(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      UNIQUE(firefighter_id, month)
    );
    CREATE TABLE IF NOT EXISTS item_checks (
      id TEXT PRIMARY KEY,
      monthly_check_id TEXT NOT NULL REFERENCES monthly_checks(id) ON DELETE CASCADE,
      barcode TEXT NOT NULL,
      condition TEXT NOT NULL,
      notes TEXT,
      photo_url TEXT,
      checked_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audits (
      id TEXT PRIMARY KEY,
      quarter TEXT NOT NULL,
      audited_by TEXT NOT NULL,
      audited_at TEXT NOT NULL,
      notes TEXT
    );
  `);
}

// ========== Middleware ==========
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// File upload config for defect photos
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ========== Email ==========
let transporter = null;
if (process.env.EMAIL_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT || 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

async function sendEmail(subject, html) {
  if (!transporter) {
    console.log('Email not configured. Would send:', subject);
    return;
  }
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: process.env.EMAIL_TO || 'ben.paynter@bedsfire.gov.uk',
      subject,
      html
    });
  } catch (err) {
    console.error('Email error:', err.message);
  }
}

// ========== Helpers ==========
function getUKTime() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
}
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ========== API ROUTES ==========

app.get('/api/firefighters', async (req, res) => {
  try {
    const rows = await all(`
      SELECT f.*, COUNT(e.barcode)::int AS equipment_count
      FROM firefighters f
      LEFT JOIN equipment e ON e.firefighter_id = f.id
      GROUP BY f.id
      ORDER BY f.name
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/firefighters', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/firefighters/:id/equipment', async (req, res) => {
  try {
    const rows = await all(
      `SELECT * FROM equipment WHERE firefighter_id = $1 ORDER BY type, description`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('GET /api/firefighters/:id/equipment', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/firefighters/:id/checks', async (req, res) => {
  try {
    const rows = await all(`
      SELECT mc.*,
             COUNT(ic.id)::int AS items_checked,
             SUM(CASE WHEN ic.condition = 'defect' THEN 1 ELSE 0 END)::int AS defects
      FROM monthly_checks mc
      LEFT JOIN item_checks ic ON ic.monthly_check_id = mc.id
      WHERE mc.firefighter_id = $1
      GROUP BY mc.id
      ORDER BY mc.month DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/firefighters/:id/checks', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/firefighters/:id/checks/:month', async (req, res) => {
  try {
    const check = await get(
      `SELECT * FROM monthly_checks WHERE firefighter_id = $1 AND month = $2`,
      [req.params.id, req.params.month]
    );
    if (!check) return res.json({ check: null, items: [] });

    const items = await all(`
      SELECT ic.*, e.type, e.description, e.size
      FROM item_checks ic
      JOIN equipment e ON e.barcode = ic.barcode
      WHERE ic.monthly_check_id = $1
    `, [check.id]);

    res.json({ check, items });
  } catch (err) {
    console.error('GET /api/firefighters/:id/checks/:month', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/checks', upload.any(), async (req, res) => {
  const client = await pool.connect();
  try {
    const { firefighter_id, month, items } = req.body;
    const parsedItems = JSON.parse(items);

    const firefighter = await get(`SELECT name FROM firefighters WHERE id = $1`, [firefighter_id]);
    const existing = await get(
      `SELECT id FROM monthly_checks WHERE firefighter_id = $1 AND month = $2`,
      [firefighter_id, month]
    );
    if (existing) {
      return res.status(400).json({ error: 'Already submitted for this month' });
    }

    const checkId = uuidv4();
    const completedAt = new Date().toISOString();

    await client.query('BEGIN');

    await client.query(
      `INSERT INTO monthly_checks (id, firefighter_id, month, completed_at) VALUES ($1, $2, $3, $4)`,
      [checkId, firefighter_id, month, completedAt]
    );

    const uploadedFiles = {};
    if (req.files) {
      for (const file of req.files) {
        uploadedFiles[file.fieldname] = `/uploads/${file.filename}`;
      }
    }

    const defects = [];
    for (const item of parsedItems) {
      const photoUrl = uploadedFiles[`photo_${item.barcode}`] || null;
      await client.query(
        `INSERT INTO item_checks (id, monthly_check_id, barcode, condition, notes, photo_url, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuidv4(), checkId, item.barcode, item.condition, item.notes || null, photoUrl, completedAt]
      );
      if (item.condition === 'defect') {
        defects.push({
          barcode: item.barcode,
          description: item.description,
          notes: item.notes,
          photoUrl
        });
      }
    }

    await client.query('COMMIT');

    if (defects.length > 0) {
      const defectList = defects.map(d =>
        `<li><strong>${d.description}</strong> (${d.barcode})<br>Notes: ${d.notes || 'None'}${d.photoUrl ? `<br><a href="${d.photoUrl}">View Photo</a>` : ''}</li>`
      ).join('');
      await sendEmail(
        `PPE Defect Report - ${firefighter?.name || 'Unknown'}`,
        `<h2>PPE Defect Reported</h2>
         <p><strong>Firefighter:</strong> ${firefighter?.name || 'Unknown'}</p>
         <p><strong>Date:</strong> ${getUKTime()}</p>
         <p><strong>Month:</strong> ${month}</p>
         <h3>Defects Found:</h3>
         <ul>${defectList}</ul>`
      );
    }

    res.json({ success: true, checkId });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* ignore */ }
    console.error('POST /api/checks', err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const month = req.query.month || getCurrentMonth();
    const firefighters = await all(`
      SELECT
        f.id,
        f.name,
        f.employee_no,
        mc.completed_at AS last_check,
        mc.month AS check_month,
        CASE WHEN mc.id IS NOT NULL THEN 'complete' ELSE 'incomplete' END AS status,
        (SELECT COUNT(*)::int FROM item_checks ic2
         JOIN monthly_checks mc2 ON mc2.id = ic2.monthly_check_id
         WHERE mc2.firefighter_id = f.id AND ic2.condition = 'defect') AS open_defects
      FROM firefighters f
      LEFT JOIN monthly_checks mc ON mc.firefighter_id = f.id AND mc.month = $1
      ORDER BY f.name
    `, [month]);

    res.json({
      month,
      total: firefighters.length,
      complete: firefighters.filter(f => f.status === 'complete').length,
      incomplete: firefighters.filter(f => f.status === 'incomplete').length,
      firefighters
    });
  } catch (err) {
    console.error('GET /api/dashboard', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/dashboard/:month', (req, res) => {
  req.query.month = req.params.month;
  // Re-route to /api/dashboard via internal redirect-like handler
  req.url = '/api/dashboard?month=' + encodeURIComponent(req.params.month);
  app._router.handle(req, res);
});

app.get('/api/audits', async (req, res) => {
  try {
    const rows = await all(`SELECT * FROM audits ORDER BY audited_at DESC`);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/audits', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audits/quarterly/:quarter', async (req, res) => {
  try {
    const quarter = req.params.quarter; // e.g. "2026-Q1"
    const [year, q] = quarter.split('-Q');
    const quarterNum = parseInt(q);
    const startMonth = (quarterNum - 1) * 3 + 1;
    const months = [
      `${year}-${String(startMonth).padStart(2, '0')}`,
      `${year}-${String(startMonth + 1).padStart(2, '0')}`,
      `${year}-${String(startMonth + 2).padStart(2, '0')}`
    ];

    const firefighters = await all(`SELECT * FROM firefighters ORDER BY name`);
    const quarterData = [];
    for (const ff of firefighters) {
      const monthStatus = {};
      for (const m of months) {
        const c = await get(
          `SELECT id FROM monthly_checks WHERE firefighter_id = $1 AND month = $2`,
          [ff.id, m]
        );
        monthStatus[m] = !!c;
      }
      quarterData.push({
        ...ff,
        months: monthStatus,
        complete: Object.values(monthStatus).every(v => v)
      });
    }

    const audit = await get(`SELECT * FROM audits WHERE quarter = $1`, [quarter]);
    res.json({ quarter, months, firefighters: quarterData, audit });
  } catch (err) {
    console.error('GET /api/audits/quarterly/:quarter', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/audits', async (req, res) => {
  try {
    const { quarter, audited_by, notes } = req.body;
    const id = uuidv4();
    const auditedAt = new Date().toISOString();
    await query(
      `INSERT INTO audits (id, quarter, audited_by, audited_at, notes) VALUES ($1, $2, $3, $4, $5)`,
      [id, quarter, audited_by, auditedAt, notes || null]
    );
    res.json({ success: true, id });
  } catch (err) {
    console.error('POST /api/audits', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/history/:month', async (req, res) => {
  try {
    const rows = await all(`
      SELECT
        mc.*,
        f.name AS firefighter_name,
        COUNT(ic.id)::int AS items_checked,
        SUM(CASE WHEN ic.condition = 'defect' THEN 1 ELSE 0 END)::int AS defects
      FROM monthly_checks mc
      JOIN firefighters f ON f.id = mc.firefighter_id
      LEFT JOIN item_checks ic ON ic.monthly_check_id = mc.id
      WHERE mc.month = $1
      GROUP BY mc.id, f.name
      ORDER BY f.name
    `, [req.params.month]);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/history/:month', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/defects', async (req, res) => {
  try {
    const rows = await all(`
      SELECT
        ic.*,
        e.type,
        e.description,
        mc.month,
        f.name AS firefighter_name
      FROM item_checks ic
      JOIN equipment e ON e.barcode = ic.barcode
      JOIN monthly_checks mc ON mc.id = ic.monthly_check_id
      JOIN firefighters f ON f.id = mc.firefighter_id
      WHERE ic.condition = 'defect'
      ORDER BY mc.month DESC, f.name
    `);
    res.json(rows);
  } catch (err) {
    console.error('GET /api/defects', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin SQL endpoint — allows ad-hoc SELECT/INSERT/UPDATE/DELETE.
// Single-statement only for safety.
app.post('/api/admin/sql', async (req, res) => {
  try {
    const { query: q } = req.body;
    if (!q || typeof q !== 'string') return res.json({ error: 'Invalid query' });
    if (q.includes(';') && q.trim().split(';').filter(s => s.trim()).length > 1) {
      return res.json({ error: 'Multiple statements not allowed' });
    }
    const upper = q.trim().toUpperCase();
    if (upper.startsWith('SELECT')) {
      const r = await pool.query(q);
      return res.json({ rows: r.rows, count: r.rowCount });
    }
    if (upper.startsWith('INSERT') || upper.startsWith('UPDATE') || upper.startsWith('DELETE')) {
      const r = await pool.query(q);
      return res.json({ changes: r.rowCount });
    }
    res.json({ error: 'Only SELECT, INSERT, UPDATE, DELETE supported' });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Catch-all — must be last
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== Start ==========
ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Harrold PPE Logs running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to ensure schema:', err);
    process.exit(1);
  });
