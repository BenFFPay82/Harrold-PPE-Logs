const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const multer = require('multer');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath);

// Middleware
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

// Email transporter (configure via env vars)
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

// Helper: Send email notification
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

// Helper: Get current UK time
function getUKTime() {
  return new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' });
}

// Helper: Get current month (YYYY-MM)
function getCurrentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ==================== API ROUTES ====================

// GET /api/firefighters - List all firefighters
app.get('/api/firefighters', (req, res) => {
  const firefighters = db.prepare(`
    SELECT f.*, COUNT(e.barcode) as equipment_count
    FROM firefighters f
    LEFT JOIN equipment e ON e.firefighter_id = f.id
    GROUP BY f.id
    ORDER BY f.name
  `).all();

  res.json(firefighters);
});

// GET /api/firefighters/:id/equipment - List equipment for a firefighter
app.get('/api/firefighters/:id/equipment', (req, res) => {
  const equipment = db.prepare(`
    SELECT * FROM equipment
    WHERE firefighter_id = ?
    ORDER BY type, description
  `).all(req.params.id);

  res.json(equipment);
});

// GET /api/firefighters/:id/checks - List monthly checks for a firefighter
app.get('/api/firefighters/:id/checks', (req, res) => {
  const checks = db.prepare(`
    SELECT mc.*,
           COUNT(ic.id) as items_checked,
           SUM(CASE WHEN ic.condition = 'defect' THEN 1 ELSE 0 END) as defects
    FROM monthly_checks mc
    LEFT JOIN item_checks ic ON ic.monthly_check_id = mc.id
    WHERE mc.firefighter_id = ?
    GROUP BY mc.id
    ORDER BY mc.month DESC
  `).all(req.params.id);

  res.json(checks);
});

// GET /api/firefighters/:id/checks/:month - Get specific month check with item details
app.get('/api/firefighters/:id/checks/:month', (req, res) => {
  const check = db.prepare(`
    SELECT * FROM monthly_checks
    WHERE firefighter_id = ? AND month = ?
  `).get(req.params.id, req.params.month);

  if (!check) {
    return res.json({ check: null, items: [] });
  }

  const items = db.prepare(`
    SELECT ic.*, e.type, e.description, e.size
    FROM item_checks ic
    JOIN equipment e ON e.barcode = ic.barcode
    WHERE ic.monthly_check_id = ?
  `).all(check.id);

  res.json({ check, items });
});

// POST /api/checks - Submit a monthly check
app.post('/api/checks', upload.any(), async (req, res) => {
  try {
    const { firefighter_id, month, items } = req.body;
    const parsedItems = JSON.parse(items);

    // Get firefighter name for email
    const firefighter = db.prepare('SELECT name FROM firefighters WHERE id = ?').get(firefighter_id);

    // Check if already submitted for this month
    const existing = db.prepare(
      'SELECT id FROM monthly_checks WHERE firefighter_id = ? AND month = ?'
    ).get(firefighter_id, month);

    if (existing) {
      return res.status(400).json({ error: 'Already submitted for this month' });
    }

    // Create monthly check record
    const checkId = uuidv4();
    const completedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO monthly_checks (id, firefighter_id, month, completed_at)
      VALUES (?, ?, ?, ?)
    `).run(checkId, firefighter_id, month, completedAt);

    // Map uploaded files by field name
    const uploadedFiles = {};
    if (req.files) {
      for (const file of req.files) {
        uploadedFiles[file.fieldname] = `/uploads/${file.filename}`;
      }
    }

    // Insert item checks
    const insertItem = db.prepare(`
      INSERT INTO item_checks (id, monthly_check_id, barcode, condition, notes, photo_url, checked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const defects = [];

    for (const item of parsedItems) {
      const photoUrl = uploadedFiles[`photo_${item.barcode}`] || null;
      insertItem.run(
        uuidv4(),
        checkId,
        item.barcode,
        item.condition,
        item.notes || null,
        photoUrl,
        completedAt
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

    // Send defect notification email
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
    console.error('Check submission error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard - Summary for WM dashboard
app.get('/api/dashboard', (req, res) => {
  const month = req.query.month || getCurrentMonth();

  const firefighters = db.prepare(`
    SELECT
      f.id,
      f.name,
      f.employee_no,
      mc.completed_at as last_check,
      mc.month as check_month,
      CASE WHEN mc.id IS NOT NULL THEN 'complete' ELSE 'incomplete' END as status,
      (SELECT COUNT(*) FROM item_checks ic2
       JOIN monthly_checks mc2 ON mc2.id = ic2.monthly_check_id
       WHERE mc2.firefighter_id = f.id AND ic2.condition = 'defect') as open_defects
    FROM firefighters f
    LEFT JOIN monthly_checks mc ON mc.firefighter_id = f.id AND mc.month = ?
    ORDER BY f.name
  `).all(month);

  const summary = {
    month,
    total: firefighters.length,
    complete: firefighters.filter(f => f.status === 'complete').length,
    incomplete: firefighters.filter(f => f.status === 'incomplete').length,
    firefighters
  };

  res.json(summary);
});

// GET /api/dashboard/:month - Summary for specific month
app.get('/api/dashboard/:month', (req, res) => {
  req.query.month = req.params.month;
  app.handle(req, res);
});

// GET /api/audits - List all audits
app.get('/api/audits', (req, res) => {
  const audits = db.prepare('SELECT * FROM audits ORDER BY audited_at DESC').all();
  res.json(audits);
});

// GET /api/audits/quarterly/:quarter - Get quarterly audit data
app.get('/api/audits/quarterly/:quarter', (req, res) => {
  const quarter = req.params.quarter; // e.g. "2026-Q1"
  const [year, q] = quarter.split('-Q');
  const quarterNum = parseInt(q);

  // Calculate months in quarter
  const startMonth = (quarterNum - 1) * 3 + 1;
  const months = [
    `${year}-${String(startMonth).padStart(2, '0')}`,
    `${year}-${String(startMonth + 1).padStart(2, '0')}`,
    `${year}-${String(startMonth + 2).padStart(2, '0')}`
  ];

  // Get completion status for each firefighter for each month
  const firefighters = db.prepare('SELECT * FROM firefighters ORDER BY name').all();

  const quarterData = firefighters.map(ff => {
    const monthStatus = {};
    for (const month of months) {
      const check = db.prepare(
        'SELECT id FROM monthly_checks WHERE firefighter_id = ? AND month = ?'
      ).get(ff.id, month);
      monthStatus[month] = !!check;
    }

    return {
      ...ff,
      months: monthStatus,
      complete: Object.values(monthStatus).every(v => v)
    };
  });

  // Check if audit exists
  const audit = db.prepare('SELECT * FROM audits WHERE quarter = ?').get(quarter);

  res.json({
    quarter,
    months,
    firefighters: quarterData,
    audit
  });
});

// POST /api/audits - Record quarterly audit sign-off
app.post('/api/audits', (req, res) => {
  const { quarter, audited_by, notes } = req.body;

  const id = uuidv4();
  const auditedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO audits (id, quarter, audited_by, audited_at, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, quarter, audited_by, auditedAt, notes || null);

  res.json({ success: true, id });
});

// GET /api/history/:month - Get all checks for a specific month
app.get('/api/history/:month', (req, res) => {
  const checks = db.prepare(`
    SELECT
      mc.*,
      f.name as firefighter_name,
      COUNT(ic.id) as items_checked,
      SUM(CASE WHEN ic.condition = 'defect' THEN 1 ELSE 0 END) as defects
    FROM monthly_checks mc
    JOIN firefighters f ON f.id = mc.firefighter_id
    LEFT JOIN item_checks ic ON ic.monthly_check_id = mc.id
    WHERE mc.month = ?
    GROUP BY mc.id
    ORDER BY f.name
  `).all(req.params.month);

  res.json(checks);
});

// GET /api/defects - Get all open defects
app.get('/api/defects', (req, res) => {
  const defects = db.prepare(`
    SELECT
      ic.*,
      e.type,
      e.description,
      mc.month,
      f.name as firefighter_name
    FROM item_checks ic
    JOIN equipment e ON e.barcode = ic.barcode
    JOIN monthly_checks mc ON mc.id = ic.monthly_check_id
    JOIN firefighters f ON f.id = mc.firefighter_id
    WHERE ic.condition = 'defect'
    ORDER BY mc.month DESC, f.name
  `).all();

  res.json(defects);
});

// Serve the app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
// Admin SQL endpoint (add this BEFORE the app.listen() line)
app.post('/api/admin/sql', (req, res) => {
  const { query } = req.body;
  
  if (!query || typeof query !== 'string') {
    return res.json({ error: 'Invalid query' });
  }

  // Security check - prevent multiple statements
  if (query.includes(';') && query.trim().split(';').filter(q => q.trim()).length > 1) {
    return res.json({ error: 'Multiple statements not allowed' });
  }

  const trimmedQuery = query.trim().toUpperCase();
  
  // Check if it's a SELECT query (returns data)
  if (trimmedQuery.startsWith('SELECT')) {
    db.all(query, [], (err, rows) => {
      if (err) {
        return res.json({ error: err.message });
      }
      res.json({ rows, count: rows.length });
    });
  } 
  // For UPDATE, INSERT, DELETE (modifies data)
  else if (
    trimmedQuery.startsWith('UPDATE') || 
    trimmedQuery.startsWith('INSERT') || 
    trimmedQuery.startsWith('DELETE')
  ) {
    db.run(query, [], function(err) {
      if (err) {
        return res.json({ error: err.message });
      }
      res.json({ changes: this.changes });
    });
  }
  else {
    res.json({ error: 'Only SELECT, UPDATE, INSERT, and DELETE queries are supported' });
  }
});app.listen(PORT, () => {
  console.log(`Harrold PPE Logs running on http://localhost:${PORT}`);
});
