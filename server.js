const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const selfsigned = require('selfsigned');

// Firebase App & Firestore
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Nikila2008326@';
const PREFECT_PASSWORD = process.env.PREFECT_PASSWORD || '12345678';

const isVercel = Boolean(process.env.VERCEL);
const app = express();
const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Firebase Config
const firebaseConfig = {
  apiKey: "AIzaSyAOD8Nhh_tCI1H_7xzM3dxWFVWcEZtrMr8",
  authDomain: "studenyt-1c8b7.firebaseapp.com",
  projectId: "studenyt-1c8b7",
  storageBucket: "studenyt-1c8b7.firebasestorage.app",
  messagingSenderId: "10341282240",
  appId: "1:10341282240:web:02bd977e6b14275f549825",
  measurementId: "G-P5F4VBZ0DC"
};

let firestoreDb = null;
try {
  const fbApp = initializeApp(firebaseConfig);
  firestoreDb = getFirestore(fbApp);
  console.log('[Firebase] Connected to project: studenyt-1c8b7');
} catch (e) {
  console.warn('[Firebase] Init notice:', e.message);
}

// Background sync to Firestore
async function syncToFirestore(collectionName, docId, data) {
  if (!firestoreDb) return;
  try {
    const docRef = doc(firestoreDb, collectionName, docId);
    await setDoc(docRef, data, { merge: true });
  } catch (err) {
    console.warn(`[Firebase Sync Notice] ${err.message}`);
  }
}

// Database directory (On Vercel use /tmp, locally use ./data)
const dataDir = isVercel ? '/tmp' : path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const dbPath = path.join(dataDir, 'scienceday.db');
const db = new DatabaseSync(dbPath);

// Setup / Migrate tables
db.exec(`
  CREATE TABLE IF NOT EXISTS passes (
    code TEXT PRIMARY KEY,
    student_name TEXT,
    grade TEXT,
    classroom TEXT,
    school_or_grade TEXT,
    index_number TEXT,
    contact_number TEXT,
    is_registered INTEGER DEFAULT 0,
    registered_at TEXT,
    arrival_time TEXT,
    exit_time TEXT,
    status TEXT DEFAULT 'UNREGISTERED',
    scan_count INTEGER DEFAULT 0,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT,
    student_name TEXT,
    action TEXT,
    timestamp TEXT,
    scanner_device TEXT,
    details TEXT
  );
`);

function seedPasses(total = 400, prefix = 'SCI-') {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM passes').get();
  if (countRow.count < total) {
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO passes (code, is_registered, status, scan_count)
      VALUES (?, 0, 'UNREGISTERED', 0)
    `);

    db.exec('BEGIN TRANSACTION');
    for (let i = 1; i <= total; i++) {
      const code = `${prefix}${String(i).padStart(4, '0')}`;
      insertStmt.run(code);
    }
    db.exec('COMMIT');
  }
}
seedPasses(400);

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

function checkAdminAuth(req, res, next) {
  const token = req.headers['x-admin-password'] || req.query.admin_key || req.body.admin_key;
  if (token === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Unauthorized: Invalid Admin Password' });
}

// -----------------------------------------------------------------------------
// SHORTCUT ROUTES
// -----------------------------------------------------------------------------
app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

// -----------------------------------------------------------------------------
// AUTH APIS
// -----------------------------------------------------------------------------
app.post('/api/auth/verify', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, message: 'Admin authenticated successfully' });
  }
  return res.status(401).json({ success: false, error: 'Incorrect Admin Password' });
});

app.post('/api/auth/prefect', (req, res) => {
  const { password } = req.body;
  if (password === PREFECT_PASSWORD) {
    return res.json({ success: true, message: 'Prefect scanner unlocked' });
  }
  return res.status(401).json({ success: false, error: 'Incorrect Passcode (Enter: 12345678)' });
});

// -----------------------------------------------------------------------------
// SCANNER APIS
// -----------------------------------------------------------------------------

app.get('/api/next-pass', (req, res) => {
  try {
    const unassigned = db.prepare("SELECT code FROM passes WHERE is_registered = 0 ORDER BY code ASC LIMIT 1").get();
    if (unassigned) {
      return res.json({ success: true, code: unassigned.code });
    }
    const maxRow = db.prepare("SELECT code FROM passes ORDER BY code DESC LIMIT 1").get();
    let nextNum = 1;
    if (maxRow && maxRow.code) {
      const match = maxRow.code.match(/\d+$/);
      if (match) nextNum = parseInt(match[0], 10) + 1;
    }
    const newCode = `SCI-${String(nextNum).padStart(4, '0')}`;
    return res.json({ success: true, code: newCode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1. Scan QR Code (Shows status WITHOUT auto-changing!)
app.post('/api/scan', (req, res) => {
  try {
    let { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Code is required' });
    }

    code = code.trim().toUpperCase();
    let pass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);

    if (!pass) {
      if (!code.startsWith('SCI-')) {
        return res.json({
          success: false,
          status: 'INVALID_QR',
          message: 'Not a valid Science Day QR code! Only official passes are accepted.'
        });
      }

      db.prepare(`
        INSERT INTO passes (code, is_registered, status, scan_count)
        VALUES (?, 0, 'UNREGISTERED', 0)
      `).run(code);
      pass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
    }

    // CASE 1: Pass is unassigned (First time scan) -> Prompt registration!
    if (!pass.is_registered) {
      return res.json({
        success: true,
        status: 'UNREGISTERED',
        code,
        message: 'Unassigned pass. Please enter student details.'
      });
    }

    // CASE 2: Pass is ALREADY REGISTERED -> Returns current details & status!
    // NO AUTO EXIT! Prefect explicitly taps "Mark as Left" if the student is leaving!
    const arrTime = pass.arrival_time ? new Date(pass.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
    const extTime = pass.exit_time ? new Date(pass.exit_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';

    return res.json({
      success: true,
      status: 'REGISTERED',
      pass,
      currentStatus: pass.status, // 'INSIDE' or 'LEFT'
      arrivalTime: arrTime,
      exitTime: extTime,
      message: `Verified: ${pass.student_name} (${pass.school_or_grade})`
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Explicitly Mark Student Status (EXIT / RE-ENTRY) with confirmation button!
app.post('/api/mark-status', (req, res) => {
  try {
    let { code, action = 'EXIT' } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Code is required' });

    code = code.trim().toUpperCase();
    let pass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);

    if (!pass || !pass.is_registered) {
      return res.status(400).json({ success: false, error: 'Pass not registered' });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const dateFormatted = now.toLocaleDateString();
    const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const newCount = (pass.scan_count || 1) + 1;

    if (action === 'EXIT') {
      db.prepare(`
        UPDATE passes 
        SET status = 'LEFT', exit_time = ?, scan_count = ?
        WHERE code = ?
      `).run(nowIso, newCount, code);

      db.prepare(`
        INSERT INTO scan_logs (code, student_name, action, timestamp, scanner_device, details)
        VALUES (?, ?, 'STUDENT_EXIT', ?, 'Mobile Scanner', ?)
      `).run(code, pass.student_name, nowIso, `Left at ${timeFormatted}`);

      const updated = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
      syncToFirestore('passes', code, { ...updated, last_updated: nowIso });

      return res.json({
        success: true,
        action: 'EXIT',
        pass: updated,
        time: timeFormatted,
        date: dateFormatted,
        message: `Student ${pass.student_name} marked as LEFT HALL at ${timeFormatted}`
      });

    } else {
      // Re-entry / Entry
      db.prepare(`
        UPDATE passes 
        SET status = 'INSIDE', arrival_time = ?, scan_count = ?
        WHERE code = ?
      `).run(nowIso, newCount, code);

      db.prepare(`
        INSERT INTO scan_logs (code, student_name, action, timestamp, scanner_device, details)
        VALUES (?, ?, 'STUDENT_RE_ENTRY', ?, 'Mobile Scanner', ?)
      `).run(code, pass.student_name, nowIso, `Re-entered at ${timeFormatted}`);

      const updated = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
      syncToFirestore('passes', code, { ...updated, last_updated: nowIso });

      return res.json({
        success: true,
        action: 'ENTRY',
        pass: updated,
        time: timeFormatted,
        date: dateFormatted,
        message: `Student ${pass.student_name} marked as RE-ENTERED at ${timeFormatted}`
      });
    }

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Register Student
app.post('/api/register', async (req, res) => {
  try {
    let {
      code,
      student_name,
      grade,
      classroom,
      scanner_device = 'Mobile Scanner'
    } = req.body;

    if (!code || !student_name || !grade || !classroom) {
      return res.status(400).json({
        success: false,
        error: 'Code, Student Name, Grade, and Class are required'
      });
    }

    code = code.trim().toUpperCase();
    student_name = student_name.trim();
    grade = grade.trim();
    classroom = classroom.trim().toUpperCase();
    const school_or_grade = `${grade} - ${classroom}`;

    const now = new Date();
    const nowIso = now.toISOString();

    let existing = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);

    if (!existing) {
      db.prepare(`
        INSERT INTO passes (
          code, student_name, grade, classroom, school_or_grade,
          is_registered, registered_at, arrival_time, status, scan_count
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'INSIDE', 1)
      `).run(code, student_name, grade, classroom, school_or_grade, nowIso, nowIso);
    } else {
      db.prepare(`
        UPDATE passes SET 
          student_name = ?,
          grade = ?,
          classroom = ?,
          school_or_grade = ?,
          is_registered = 1,
          registered_at = ?,
          arrival_time = ?,
          status = 'INSIDE',
          scan_count = 1
        WHERE code = ?
      `).run(student_name, grade, classroom, school_or_grade, nowIso, nowIso, code);
    }

    db.prepare(`
      INSERT INTO scan_logs (code, student_name, action, timestamp, scanner_device, details)
      VALUES (?, ?, 'STUDENT_REGISTER_ENTRY', ?, ?, ?)
    `).run(
      code,
      student_name,
      nowIso,
      scanner_device,
      `${school_or_grade} • Registered & Entered`
    );

    const savedPass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);

    syncToFirestore('passes', code, {
      ...savedPass,
      last_updated: nowIso
    });

    res.json({
      success: true,
      message: `Pass ${code} permanently assigned to ${student_name}!`,
      pass: savedPass,
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Registered students list for Mobile Scanner
app.get('/api/registered-students', (req, res) => {
  try {
    const { search = '', limit = 60 } = req.query;
    let query = 'SELECT code, student_name, grade, classroom, status, arrival_time, exit_time FROM passes WHERE is_registered = 1';
    const params = [];

    if (search.trim()) {
      query += ' AND (student_name LIKE ? OR code LIKE ? OR classroom LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s, s);
    }

    query += ' ORDER BY rowid DESC LIMIT ?';
    params.push(Number(limit));

    const rows = db.prepare(query).all(...params);
    res.json({ success: true, students: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// PROTECTED ADMIN APIS
// -----------------------------------------------------------------------------

app.get('/api/stats', checkAdminAuth, (req, res) => {
  try {
    const totalRow = db.prepare('SELECT COUNT(*) as count FROM passes').get();
    const registeredRow = db.prepare('SELECT COUNT(*) as count FROM passes WHERE is_registered = 1').get();
    const insideRow = db.prepare("SELECT COUNT(*) as count FROM passes WHERE status = 'INSIDE'").get();
    const leftRow = db.prepare("SELECT COUNT(*) as count FROM passes WHERE status = 'LEFT'").get();
    const exitLogCount = db.prepare("SELECT COUNT(*) as count FROM scan_logs WHERE action = 'STUDENT_EXIT'").get();

    const recentLogs = db.prepare(`
      SELECT * FROM scan_logs 
      ORDER BY id DESC 
      LIMIT 15
    `).all();

    res.json({
      success: true,
      stats: {
        totalPasses: totalRow.count,
        registered: registeredRow.count,
        inside: insideRow.count,
        left: leftRow.count,
        totalExits: exitLogCount.count,
        pending: totalRow.count - registeredRow.count
      },
      recentLogs
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/passes', checkAdminAuth, (req, res) => {
  try {
    const { search = '', filter = 'all', page = 1, limit = 50 } = req.query;
    let query = 'SELECT * FROM passes WHERE 1=1';
    const params = [];

    if (search.trim()) {
      query += ' AND (code LIKE ? OR student_name LIKE ? OR school_or_grade LIKE ? OR grade LIKE ? OR classroom LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s, s, s, s);
    }

    if (filter === 'inside') {
      query += " AND status = 'INSIDE'";
    } else if (filter === 'left') {
      query += " AND status = 'LEFT'";
    } else if (filter === 'registered') {
      query += ' AND is_registered = 1';
    } else if (filter === 'unregistered') {
      query += ' AND is_registered = 0';
    }

    query += ' ORDER BY code ASC';

    const allMatches = db.prepare(query).all(...params);
    const total = allMatches.length;

    const offset = (Number(page) - 1) * Number(limit);
    const paginatedQuery = `${query} LIMIT ? OFFSET ?`;
    const rows = db.prepare(paginatedQuery).all(...params, Number(limit), offset);

    res.json({
      success: true,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / Number(limit)),
      passes: rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset / Delete single student pass
app.post('/api/passes/reset', checkAdminAuth, (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Code required' });

    db.prepare(`
      UPDATE passes SET
        student_name = NULL,
        grade = NULL,
        classroom = NULL,
        school_or_grade = NULL,
        is_registered = 0,
        registered_at = NULL,
        arrival_time = NULL,
        exit_time = NULL,
        status = 'UNREGISTERED',
        scan_count = 0,
        notes = NULL
      WHERE code = ?
    `).run(code);

    syncToFirestore('passes', code, {
      is_registered: 0,
      status: 'UNREGISTERED',
      student_name: null,
      grade: null,
      classroom: null,
      arrival_time: null,
      exit_time: null
    });

    return res.json({ success: true, message: `Pass ${code} is now completely fresh, unassigned and ready for reuse!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// WIPE ALL TEST DATA
app.post('/api/passes/reset-all', checkAdminAuth, (req, res) => {
  try {
    db.prepare(`
      UPDATE passes SET
        student_name = NULL,
        grade = NULL,
        classroom = NULL,
        school_or_grade = NULL,
        is_registered = 0,
        registered_at = NULL,
        arrival_time = NULL,
        exit_time = NULL,
        status = 'UNREGISTERED',
        scan_count = 0,
        notes = NULL
    `).run();

    db.prepare("DELETE FROM scan_logs").run();

    return res.json({
      success: true,
      message: 'All test data wiped successfully! All 400 QR passes are now brand new and blank.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/generate-batch', checkAdminAuth, (req, res) => {
  try {
    const count = parseInt(req.body.count || '100', 10);
    const prefix = req.body.prefix || 'SCI-';

    const currentMaxRow = db.prepare(`
      SELECT code FROM passes WHERE code LIKE ? ORDER BY code DESC LIMIT 1
    `).get(`${prefix}%`);

    let startNum = 1;
    if (currentMaxRow && currentMaxRow.code) {
      const match = currentMaxRow.code.match(/\d+$/);
      if (match) {
        startNum = parseInt(match[0], 10) + 1;
      }
    }

    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO passes (code, is_registered, status, scan_count)
      VALUES (?, 0, 'UNREGISTERED', 0)
    `);

    db.exec('BEGIN TRANSACTION');
    for (let i = 0; i < count; i++) {
      const code = `${prefix}${String(startNum + i).padStart(4, '0')}`;
      insertStmt.run(code);
    }
    db.exec('COMMIT');

    res.json({
      success: true,
      message: `Generated ${count} new passes (${prefix}${String(startNum).padStart(4, '0')} to ${prefix}${String(startNum + count - 1).padStart(4, '0')})`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Download 20-per-sheet QR PDF
app.get('/api/download-qr-pdf', async (req, res) => {
  try {
    const from = parseInt(req.query.from || '1', 10);
    const to = parseInt(req.query.to || '400', 10);
    const prefix = req.query.prefix || 'SCI-';

    const passesList = [];
    for (let i = from; i <= to; i++) {
      const code = `${prefix}${String(i).padStart(4, '0')}`;
      passesList.push(code);
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="NCSS_Science_Day_QRs_${from}_to_${to}.pdf"`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 20, bottom: 20, left: 20, right: 20 }
    });

    doc.pipe(res);

    const cols = 4;
    const rows = 5;
    const perPage = cols * rows;

    const cardWidth = 132;
    const cardHeight = 150;
    const startX = 20;
    const startY = 24;
    const gapX = 9;
    const gapY = 9;

    const logoPath = path.join(__dirname, 'public', 'logo.png');
    const hasLogo = fs.existsSync(logoPath);

    for (let idx = 0; idx < passesList.length; idx++) {
      const code = passesList[idx];
      const pageIndex = idx % perPage;

      if (idx > 0 && pageIndex === 0) {
        doc.addPage();
      }

      const col = pageIndex % cols;
      const row = Math.floor(pageIndex / cols);

      const x = startX + col * (cardWidth + gapX);
      const y = startY + row * (cardHeight + gapY);

      const qrBuffer = await QRCode.toBuffer(code, {
        margin: 0,
        width: 160,
        errorCorrectionLevel: 'H',
        color: { dark: '#0f172a', light: '#ffffff' }
      });

      doc.save();
      doc.lineWidth(0.6)
        .dash(3, { space: 2.5 })
        .strokeColor('#94a3b8')
        .roundedRect(x, y, cardWidth, cardHeight, 4)
        .stroke();
      doc.restore();

      doc.save();
      if (hasLogo) {
        doc.image(logoPath, x + 8, y + 4, { width: 12, height: 12 });
      }
      doc.fontSize(6.5)
        .font('Helvetica-Bold')
        .fillColor('#991b1b')
        .text('NCSS SCIENCE DAY 2026', x + (hasLogo ? 22 : 0), y + 6, {
          width: hasLogo ? cardWidth - 28 : cardWidth,
          align: hasLogo ? 'left' : 'center'
        });
      doc.restore();

      const qrSize = 95;
      const qrX = x + (cardWidth - qrSize) / 2;
      const qrY = y + 18;
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

      if (hasLogo) {
        doc.save();
        const centerX = qrX + qrSize / 2;
        const centerY = qrY + qrSize / 2;
        doc.circle(centerX, centerY, 13).fillColor('#ffffff').fill();
        doc.image(logoPath, centerX - 10, centerY - 10, { width: 20, height: 20 });
        doc.restore();
      }

      const pillW = 86;
      const pillH = 17;
      const pillX = x + (cardWidth - pillW) / 2;
      const pillY = y + 118;

      doc.save();
      doc.roundedRect(pillX, pillY, pillW, pillH, 3)
        .fillColor('#f1f5f9')
        .fill();

      doc.fontSize(9.5)
        .font('Helvetica-Bold')
        .fillColor('#0f172a')
        .text(code, pillX, pillY + 4, { width: pillW, align: 'center' });
      doc.restore();

      doc.fontSize(5.5)
        .font('Helvetica')
        .fillColor('#94a3b8')
        .text('Official Student Pass', x, y + 138, { width: cardWidth, align: 'center' });
    }

    doc.end();

  } catch (err) {
    console.error('QR PDF Error:', err);
    res.status(500).send('Error generating QR PDF: ' + err.message);
  }
});

// Download Attendance Report PDF
app.get('/api/download-attendance-pdf', (req, res) => {
  try {
    const students = db.prepare(`
      SELECT * FROM passes 
      WHERE is_registered = 1 
      ORDER BY grade ASC, classroom ASC, student_name ASC
    `).all();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="NCSS_Science_Day_Attendance_${new Date().toISOString().slice(0, 10)}.pdf"`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 30, bottom: 30, left: 30, right: 30 }
    });

    doc.pipe(res);

    const logoPath = path.join(__dirname, 'public', 'logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 30, 26, { width: 34, height: 34 });
    }

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f172a').text('NCSS SCIENCE DAY 2026 • ATTENDANCE REPORT', 70, 30);
    doc.fontSize(8.5).font('Helvetica').fillColor('#64748b').text(`Generated: ${new Date().toLocaleString()} | Total Students: ${students.length}`, 70, 48);
    doc.moveDown(1.2);

    const insideCount = students.filter(s => s.status === 'INSIDE').length;
    const leftCount = students.filter(s => s.status === 'LEFT').length;

    doc.save();
    doc.rect(30, 75, 535, 24).fillColor('#f1f5f9').fill();
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#0369a1')
      .text(`🟢 In Hall: ${insideCount}   |   🔴 Left Hall: ${leftCount}   |   Total Registered: ${students.length}`, 40, 83);
    doc.restore();

    const tableTop = 110;
    const rowHeight = 20;

    function drawTableHeader(y) {
      doc.save();
      doc.rect(30, y, 535, 18).fillColor('#1e293b').fill();
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('#', 35, y + 5, { width: 20 });
      doc.text('CODE', 60, y + 5, { width: 55 });
      doc.text('STUDENT NAME', 120, y + 5, { width: 140 });
      doc.text('GRADE', 265, y + 5, { width: 50 });
      doc.text('CLASS', 320, y + 5, { width: 40 });
      doc.text('ARRIVAL (IN)', 365, y + 5, { width: 75 });
      doc.text('EXIT (OUT)', 445, y + 5, { width: 75 });
      doc.text('STATUS', 525, y + 5, { width: 40 });
      doc.restore();
    }

    drawTableHeader(tableTop);

    let currentY = tableTop + 18;

    students.forEach((s, idx) => {
      if (currentY + rowHeight > 780) {
        doc.addPage();
        drawTableHeader(40);
        currentY = 40 + 18;
      }

      if (idx % 2 === 1) {
        doc.save();
        doc.rect(30, currentY, 535, rowHeight).fillColor('#f8fafc').fill();
        doc.restore();
      }

      const arrTime = s.arrival_time ? new Date(s.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
      const extTime = s.exit_time ? new Date(s.exit_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
      const statusText = s.status === 'INSIDE' ? 'INSIDE' : (s.status === 'LEFT' ? 'LEFT' : 'REGISTERED');
      const statusColor = s.status === 'INSIDE' ? '#16a34a' : (s.status === 'LEFT' ? '#dc2626' : '#64748b');

      doc.fontSize(7).font('Helvetica').fillColor('#475569').text(String(idx + 1), 35, currentY + 6);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0284c7').text(s.code, 60, currentY + 6);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0f172a').text(s.student_name || '-', 120, currentY + 6, { width: 140, ellipsis: true });
      doc.fontSize(7.5).font('Helvetica').fillColor('#334155').text(s.grade || '-', 265, currentY + 6);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155').text(s.classroom || '-', 320, currentY + 6);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#334155').text(s.classroom || '-', 320, currentY + 6);
      doc.fontSize(7).font('Helvetica').fillColor('#475569').text(arrTime, 365, currentY + 6);
      doc.fontSize(7).font('Helvetica').fillColor('#475569').text(extTime, 445, currentY + 6);
      doc.fontSize(7).font('Helvetica-Bold').fillColor(statusColor).text(statusText, 525, currentY + 6);

      doc.save();
      doc.lineWidth(0.3).strokeColor('#e2e8f0').moveTo(30, currentY + rowHeight).lineTo(565, currentY + rowHeight).stroke();
      doc.restore();

      currentY += rowHeight;
    });

    doc.end();

  } catch (err) {
    console.error('Attendance PDF Error:', err);
    res.status(500).send('Error generating attendance report PDF: ' + err.message);
  }
});

// Export Attendance as CSV
app.get('/api/export-csv', (req, res) => {
  try {
    const passes = db.prepare(`
      SELECT * FROM passes 
      WHERE is_registered = 1 
      ORDER BY grade ASC, classroom ASC, student_name ASC
    `).all();

    let csv = '\uFEFF';
    csv += 'Pass Code,Student Name,Grade,Class,Arrival Time (IN),Exit Time (OUT),Current Status,Scan Count,Registered Date\n';

    passes.forEach(p => {
      const arrTime = p.arrival_time ? new Date(p.arrival_time).toLocaleString() : '';
      const extTime = p.exit_time ? new Date(p.exit_time).toLocaleString() : '';
      const regTime = p.registered_at ? new Date(p.registered_at).toLocaleString() : '';

      const escape = (val) => {
        if (!val) return '""';
        return `"${String(val).replace(/"/g, '""')}"`;
      };

      csv += [
        escape(p.code),
        escape(p.student_name),
        escape(p.grade),
        escape(p.classroom),
        escape(arrTime),
        escape(extTime),
        escape(p.status),
        escape(p.scan_count || 1),
        escape(regTime)
      ].join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="Science_Day_Attendance_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);

  } catch (err) {
    res.status(500).send('Error generating CSV: ' + err.message);
  }
});

// Network Info for Phone Pairing
app.get('/api/network-info', async (req, res) => {
  try {
    const localIp = getLocalIpAddress();
    const scannerUrlHttp = `http://${localIp}:${HTTP_PORT}/scanner`;
    const scannerUrlHttps = `https://${localIp}:${HTTPS_PORT}/scanner`;

    const qrDataUrl = await QRCode.toDataURL(scannerUrlHttps, {
      margin: 1,
      width: 220,
      errorCorrectionLevel: 'H'
    });

    res.json({
      success: true,
      localIp,
      httpPort: HTTP_PORT,
      httpsPort: HTTPS_PORT,
      scannerUrlHttp,
      scannerUrlHttps,
      qrDataUrl,
      prefectPassword: PREFECT_PASSWORD
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export app for Vercel Serverless Function
module.exports = app;

// Start local HTTP / HTTPS servers (Only when not in Vercel serverless mode)
if (!isVercel) {
  const httpServer = http.createServer(app);
  httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
    const localIp = getLocalIpAddress();
    console.log(`\n======================================================`);
    console.log(`🚀 NCSS SCIENCE DAY 2026 PASS SYSTEM READY!`);
    console.log(`💻 Admin Dashboard (Laptop): http://localhost:${HTTP_PORT}`);
    console.log(`📱 Mallila Mobile Scanner  : http://${localIp}:${HTTP_PORT}/scanner`);
    console.log(`🔑 Admin Password          : Nikila2008326@`);
    console.log(`🔑 Prefect Passcode        : 12345678`);
    console.log(`======================================================`);
  });

  try {
    const pems = selfsigned.generate([
      { name: 'commonName', value: 'ScienceDayScanner' },
      { name: 'organizationName', value: 'NCSS Science Day' }
    ], { days: 365 });

    const httpsServer = https.createServer({
      key: pems.private,
      cert: pems.cert
    }, app);

    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      const localIp = getLocalIpAddress();
      console.log(`🔒 Phone Scanner (HTTPS)  : https://${localIp}:${HTTPS_PORT}/scanner`);
      console.log(`   (On phone, open HTTPS and click "Proceed/Advanced")`);
      console.log(`======================================================\n`);
    });
  } catch (sslErr) {
    console.warn('[HTTPS Warning] Could not start HTTPS server:', sslErr.message);
  }
}
