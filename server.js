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
const { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  collection, 
  deleteDoc 
} = require('firebase/firestore');

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

// -----------------------------------------------------------------------------
// TWO-WAY FIRESTORE SYNC
// -----------------------------------------------------------------------------
let lastFirestoreSync = 0;

async function syncFromFirestore(force = false) {
  if (!firestoreDb) return;
  const now = Date.now();
  if (!force && now - lastFirestoreSync < 3000) return;
  lastFirestoreSync = now;

  try {
    const snap = await getDocs(collection(firestoreDb, 'passes'));
    if (!snap.empty) {
      const updateStmt = db.prepare(`
        INSERT INTO passes (
          code, student_name, grade, classroom, school_or_grade,
          is_registered, registered_at, arrival_time, exit_time, status, scan_count, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          student_name = excluded.student_name,
          grade = excluded.grade,
          classroom = excluded.classroom,
          school_or_grade = excluded.school_or_grade,
          is_registered = excluded.is_registered,
          registered_at = excluded.registered_at,
          arrival_time = excluded.arrival_time,
          exit_time = excluded.exit_time,
          status = excluded.status,
          scan_count = excluded.scan_count,
          notes = excluded.notes
      `);

      const firestoreRegisteredCodes = new Set();

      db.exec('BEGIN TRANSACTION');
      snap.forEach(d => {
        const data = d.data();
        if (data.is_registered) {
          firestoreRegisteredCodes.add(d.id);
        }
        updateStmt.run(
          d.id,
          data.student_name || null,
          data.grade || null,
          data.classroom || null,
          data.school_or_grade || null,
          data.is_registered ? 1 : 0,
          data.registered_at || null,
          data.arrival_time || null,
          data.exit_time || null,
          data.status || 'UNREGISTERED',
          Number(data.scan_count || 0),
          data.notes || null
        );
      });

      // Clear any passes in SQLite that were wiped or reset in Firestore
      const localRegistered = db.prepare('SELECT code FROM passes WHERE is_registered = 1').all();
      for (const row of localRegistered) {
        if (!firestoreRegisteredCodes.has(row.code)) {
          db.prepare(`
            UPDATE passes SET
              student_name = NULL, grade = NULL, classroom = NULL, school_or_grade = NULL,
              is_registered = 0, registered_at = NULL, arrival_time = NULL, exit_time = NULL,
              status = 'UNREGISTERED', scan_count = 0, notes = NULL
            WHERE code = ?
          `).run(row.code);
        }
      }

      db.exec('COMMIT');
      console.log(`[Firebase Sync] Synced ${snap.size} passes from Firestore.`);
    }
  } catch (err) {
    console.warn('[Firebase Pull Notice]', err.message);
  }
}

async function syncToFirestore(collectionName, docId, data) {
  if (!firestoreDb) return;
  try {
    const docRef = doc(firestoreDb, collectionName, docId);
    await setDoc(docRef, data, { merge: true });
  } catch (err) {
    console.warn(`[Firebase Sync Error] ${err.message}`);
  }
}

// Initial Sync from Firestore on startup
syncFromFirestore(true).catch(e => console.warn('[Initial Sync Notice]', e.message));

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

app.get('/api/next-pass', async (req, res) => {
  try {
    await syncFromFirestore();
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

// 1. Scan QR Code (Verifies identity without auto-exiting)
app.post('/api/scan', async (req, res) => {
  try {
    await syncFromFirestore();

    let { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Code is required' });
    }

    code = code.trim().toUpperCase();

    // Verify it is an official NCSS Science Day pass
    if (!code.startsWith('SCI-')) {
      return res.json({
        success: false,
        status: 'INVALID_QR',
        message: 'Invalid QR Code! Only official NCSS Science Day passes are accepted.'
      });
    }

    let pass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);

    if (!pass) {
      db.prepare(`
        INSERT INTO passes (code, is_registered, status, scan_count)
        VALUES (?, 0, 'UNREGISTERED', 0)
      `).run(code);
      pass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
    }

    // CASE 1: Pass is unassigned (First time scan) -> Prompt registration form
    if (!pass.is_registered) {
      return res.json({
        success: true,
        status: 'UNREGISTERED',
        code,
        message: 'Unassigned pass. Please enter student details.'
      });
    }

    // CASE 2: Pass is ALREADY REGISTERED -> Returns current details & status!
    // NO AUTO EXIT! Prefect explicitly taps "Mark as Left" if student is leaving.
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

// 2. Explicitly Mark Student Status (EXIT / RE-ENTRY) with button click
app.post('/api/mark-status', async (req, res) => {
  try {
    await syncFromFirestore();

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
      `).run(code, pass.student_name, nowIso, `Left hall at ${timeFormatted}`);

      const updated = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
      await syncToFirestore('passes', code, { ...updated, last_updated: nowIso });

      return res.json({
        success: true,
        action: 'EXIT',
        pass: updated,
        time: timeFormatted,
        date: dateFormatted,
        message: `Student ${pass.student_name} marked as LEFT HALL at ${timeFormatted}`,
        spokenAnnouncement: `Thank you, ${pass.student_name}! Exit recorded.`
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
      `).run(code, pass.student_name, nowIso, `Re-entered hall at ${timeFormatted}`);

      const updated = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);
      await syncToFirestore('passes', code, { ...updated, last_updated: nowIso });

      return res.json({
        success: true,
        action: 'ENTRY',
        pass: updated,
        time: timeFormatted,
        date: dateFormatted,
        message: `Student ${pass.student_name} marked as RE-ENTERED at ${timeFormatted}`,
        spokenAnnouncement: `Welcome back, ${pass.student_name}! You may enter the Malalasekara Hall.`
      });
    }

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Register Student & Admit to Hall
app.post('/api/register', async (req, res) => {
  try {
    await syncFromFirestore();

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
      `${school_or_grade} • Registered & Admitted to Malalasekara Hall`
    );

    const savedPass = db.prepare('SELECT * FROM passes WHERE code = ?').get(code);

    // Save to Firestore and AWAIT
    await syncToFirestore('passes', code, {
      ...savedPass,
      last_updated: nowIso
    });

    res.json({
      success: true,
      message: `Pass ${code} permanently assigned to ${student_name}!`,
      pass: savedPass,
      date: now.toLocaleDateString(),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      spokenGreeting: `Welcome, ${student_name}! You can now enter the Malalasekara Hall.`
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Registered students list for Mobile Scanner
app.get('/api/registered-students', async (req, res) => {
  try {
    await syncFromFirestore();

    const { search = '', limit = 100 } = req.query;
    let query = 'SELECT code, student_name, grade, classroom, status, arrival_time, exit_time FROM passes WHERE is_registered = 1';
    const params = [];

    if (search.trim()) {
      query += ' AND (student_name LIKE ? OR code LIKE ? OR classroom LIKE ? OR grade LIKE ?)';
      const s = `%${search.trim()}%`;
      params.push(s, s, s, s);
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

app.get('/api/stats', checkAdminAuth, async (req, res) => {
  try {
    await syncFromFirestore();

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

app.get('/api/passes', checkAdminAuth, async (req, res) => {
  try {
    await syncFromFirestore();

    const { 
      search = '', 
      filter = 'all', 
      grade = 'all', 
      classroom = 'all', 
      page = 1, 
      limit = 50 
    } = req.query;

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

    if (grade !== 'all' && grade.trim()) {
      query += ' AND grade = ?';
      params.push(grade.trim());
    }

    if (classroom !== 'all' && classroom.trim()) {
      query += ' AND classroom = ?';
      params.push(classroom.trim().toUpperCase());
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

// Reset / Delete single student pass (Make QR fresh & reusable)
app.post('/api/passes/reset', checkAdminAuth, async (req, res) => {
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

    if (firestoreDb) {
      try {
        await deleteDoc(doc(firestoreDb, 'passes', code));
      } catch (e) {
        console.warn('[Firebase Delete Doc]', e.message);
      }
    }

    return res.json({ success: true, message: `Pass ${code} is now completely fresh, unassigned and ready for reuse!` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// WIPE ALL TEST DATA (Reset all passes in SQLite AND Firestore)
app.post('/api/passes/reset-all', checkAdminAuth, async (req, res) => {
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

    if (firestoreDb) {
      try {
        const snap = await getDocs(collection(firestoreDb, 'passes'));
        const deleteOps = [];
        snap.forEach(d => {
          deleteOps.push(deleteDoc(d.ref));
        });
        await Promise.all(deleteOps);
        console.log(`[Firebase] Cleared ${snap.size} documents during Reset All`);
      } catch (e) {
        console.warn('[Firebase Reset All Error]', e.message);
      }
    }

    return res.json({
      success: true,
      message: 'All test data wiped successfully from local database and Firestore! All passes are now fresh and unassigned.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// QR PDF GENERATION (FLEXIBLE COUNT: 2, 20, 50, 400, OR CUSTOM)
// -----------------------------------------------------------------------------
app.get('/api/download-qr-pdf', async (req, res) => {
  try {
    const from = Math.max(1, parseInt(req.query.from || '1', 10));
    const to = Math.max(from, parseInt(req.query.to || '400', 10));
    const prefix = req.query.prefix || 'SCI-';

    // Ensure database has passes seeded up to `to`
    seedPasses(to, prefix);

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

      // Card border with dotted cutting guide
      doc.save();
      doc.lineWidth(0.6)
        .dash(3, { space: 2.5 })
        .strokeColor('#94a3b8')
        .roundedRect(x, y, cardWidth, cardHeight, 4)
        .stroke();
      doc.restore();

      // Card Header
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

      // QR Code
      const qrSize = 95;
      const qrX = x + (cardWidth - qrSize) / 2;
      const qrY = y + 18;
      doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

      // Embed NCSS Logo in center of QR
      if (hasLogo) {
        doc.save();
        const centerX = qrX + qrSize / 2;
        const centerY = qrY + qrSize / 2;
        doc.circle(centerX, centerY, 13).fillColor('#ffffff').fill();
        doc.image(logoPath, centerX - 10, centerY - 10, { width: 20, height: 20 });
        doc.restore();
      }

      // Code Pill
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

      // Footer
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

// -----------------------------------------------------------------------------
// CLASS-WISE ATTENDANCE PDF REPORT GENERATOR (GRADE 12 & 13: B1-B4, M1-M7)
// -----------------------------------------------------------------------------
app.get('/api/download-attendance-pdf', async (req, res) => {
  try {
    await syncFromFirestore();

    const { grade = 'all', classroom = 'all' } = req.query;

    let query = 'SELECT * FROM passes WHERE is_registered = 1';
    const params = [];

    if (grade !== 'all' && grade.trim()) {
      query += ' AND grade = ?';
      params.push(grade.trim());
    }

    if (classroom !== 'all' && classroom.trim()) {
      query += ' AND classroom = ?';
      params.push(classroom.trim().toUpperCase());
    }

    query += ' ORDER BY grade ASC, classroom ASC, student_name ASC';
    const students = db.prepare(query).all(...params);

    const isSpecificClass = (grade !== 'all' && classroom !== 'all');
    const filename = isSpecificClass 
      ? `NCSS_Attendance_${grade.replace(/\s+/g, '_')}_${classroom}_${new Date().toISOString().slice(0, 10)}.pdf`
      : `NCSS_Master_Classwise_Attendance_${new Date().toISOString().slice(0, 10)}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 30, bottom: 30, left: 30, right: 30 }
    });

    doc.pipe(res);

    const logoPath = path.join(__dirname, 'public', 'logo.png');
    const hasLogo = fs.existsSync(logoPath);

    // Header Drawing Function
    function drawHeader(title, subtitle) {
      if (hasLogo) {
        doc.image(logoPath, 30, 24, { width: 36, height: 36 });
      }
      doc.fontSize(14).font('Helvetica-Bold').fillColor('#991b1b')
        .text('NCSS SCIENCE DAY 2026', 74, 25);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a')
        .text(title, 74, 40);
      doc.fontSize(7.5).font('Helvetica').fillColor('#64748b')
        .text(`${subtitle} • Generated: ${new Date().toLocaleString()}`, 74, 53);
    }

    // Single Class Report Mode
    if (isSpecificClass) {
      drawHeader(`CLASS ATTENDANCE SHEET: ${grade.toUpperCase()} - ${classroom}`, `Official Class Attendance & Hall Status`);

      const totalInClass = students.length;
      const insideInClass = students.filter(s => s.status === 'INSIDE').length;
      const leftInClass = students.filter(s => s.status === 'LEFT').length;

      // Summary Bar
      doc.save();
      doc.roundedRect(30, 70, 535, 24, 4).fillColor('#f8fafc').fill();
      doc.lineWidth(0.5).strokeColor('#cbd5e1').roundedRect(30, 70, 535, 24, 4).stroke();
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#0f172a')
        .text(`Class: ${grade} - ${classroom}   |   Total Registered: ${totalInClass}   |   🟢 In Hall: ${insideInClass}   |   🔴 Left Hall: ${leftInClass}`, 40, 77);
      doc.restore();

      let currentY = 104;
      const rowHeight = 22;

      function drawClassTableHeader(y) {
        doc.save();
        doc.rect(30, y, 535, 18).fillColor('#1e293b').fill();
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#ffffff');
        doc.text('#', 35, y + 5, { width: 25 });
        doc.text('PASS CODE', 65, y + 5, { width: 65 });
        doc.text('STUDENT NAME', 135, y + 5, { width: 175 });
        doc.text('ARRIVAL (IN)', 315, y + 5, { width: 85 });
        doc.text('EXIT (OUT)', 405, y + 5, { width: 80 });
        doc.text('STATUS', 490, y + 5, { width: 70 });
        doc.restore();
      }

      drawClassTableHeader(currentY);
      currentY += 18;

      if (students.length === 0) {
        doc.fontSize(9).font('Helvetica-Oblique').fillColor('#94a3b8')
          .text(`No students registered yet for ${grade} - ${classroom}.`, 35, currentY + 15, { align: 'center', width: 525 });
      } else {
        students.forEach((s, idx) => {
          if (currentY + rowHeight > 750) {
            doc.addPage();
            drawHeader(`CLASS ATTENDANCE SHEET: ${grade.toUpperCase()} - ${classroom} (Cont.)`, `Official Class Attendance & Hall Status`);
            currentY = 70;
            drawClassTableHeader(currentY);
            currentY += 18;
          }

          if (idx % 2 === 1) {
            doc.save();
            doc.rect(30, currentY, 535, rowHeight).fillColor('#f8fafc').fill();
            doc.restore();
          }

          const arrTime = s.arrival_time ? new Date(s.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
          const extTime = s.exit_time ? new Date(s.exit_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
          const statusText = s.status === 'INSIDE' ? '🟢 IN HALL' : (s.status === 'LEFT' ? '🔴 LEFT' : 'REGISTERED');
          const statusColor = s.status === 'INSIDE' ? '#16a34a' : (s.status === 'LEFT' ? '#dc2626' : '#64748b');

          doc.fontSize(7).font('Helvetica').fillColor('#64748b').text(String(idx + 1), 35, currentY + 6);
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0284c7').text(s.code, 65, currentY + 6);
          doc.fontSize(8).font('Helvetica-Bold').fillColor('#0f172a').text(s.student_name || '—', 135, currentY + 6, { width: 170, ellipsis: true });
          doc.fontSize(7).font('Helvetica').fillColor('#475569').text(arrTime, 315, currentY + 6);
          doc.fontSize(7).font('Helvetica').fillColor('#475569').text(extTime, 405, currentY + 6);
          doc.fontSize(7.5).font('Helvetica-Bold').fillColor(statusColor).text(statusText, 490, currentY + 6);

          doc.save();
          doc.lineWidth(0.3).strokeColor('#e2e8f0').moveTo(30, currentY + rowHeight).lineTo(565, currentY + rowHeight).stroke();
          doc.restore();

          currentY += rowHeight;
        });

        // Signatures at bottom
        currentY += 30;
        if (currentY > 730) {
          doc.addPage();
          currentY = 60;
        }
        doc.save();
        doc.lineWidth(0.5).strokeColor('#94a3b8');
        doc.moveTo(40, currentY + 40).lineTo(200, currentY + 40).stroke();
        doc.moveTo(365, currentY + 40).lineTo(525, currentY + 40).stroke();
        doc.fontSize(8).font('Helvetica').fillColor('#64748b');
        doc.text('Prefect / Gate In-charge Signature', 40, currentY + 44, { width: 160, align: 'center' });
        doc.text('Teacher / Section Head Signature', 365, currentY + 44, { width: 160, align: 'center' });
        doc.restore();
      }

    } else {
      // MASTER CLASS-WISE REPORT (Organized by Grade 12 & Grade 13 classes: B1-B4, M1-M7)
      drawHeader('MASTER CLASS-BY-CLASS ATTENDANCE REPORT', 'Complete breakdown for Grade 12 & Grade 13 (Biology & Maths)');

      const totalStudents = students.length;
      const totalInside = students.filter(s => s.status === 'INSIDE').length;
      const totalLeft = students.filter(s => s.status === 'LEFT').length;

      // Overall Summary Banner
      doc.save();
      doc.roundedRect(30, 70, 535, 24, 4).fillColor('#f8fafc').fill();
      doc.lineWidth(0.5).strokeColor('#cbd5e1').roundedRect(30, 70, 535, 24, 4).stroke();
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#0f172a')
        .text(`OVERALL EVENT STATS:   Total Registered: ${totalStudents}   |   🟢 Inside Hall: ${totalInside}   |   🔴 Left Hall: ${totalLeft}`, 40, 77);
      doc.restore();

      // Class categories to iterate through
      const gradesList = ['Grade 12', 'Grade 13'];
      const bioClasses = ['B1', 'B2', 'B3', 'B4'];
      const mathClasses = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

      // Quick Summary Grid on Page 1
      doc.fontSize(9.5).font('Helvetica-Bold').fillColor('#991b1b').text('CLASS ATTENDANCE SUMMARY MATRIX', 30, 105);

      let gridY = 120;
      doc.save();
      doc.rect(30, gridY, 535, 16).fillColor('#1e293b').fill();
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#ffffff');
      doc.text('STREAM & CLASS', 35, gridY + 4, { width: 150 });
      doc.text('REGISTERED', 210, gridY + 4, { width: 80, align: 'center' });
      doc.text('🟢 IN HALL', 310, gridY + 4, { width: 80, align: 'center' });
      doc.text('🔴 LEFT HALL', 410, gridY + 4, { width: 80, align: 'center' });
      doc.restore();
      gridY += 16;

      gradesList.forEach(gr => {
        const allClasses = [...bioClasses, ...mathClasses];
        allClasses.forEach(clz => {
          const inThisClz = students.filter(s => s.grade === gr && s.classroom === clz);
          const regCount = inThisClz.length;
          if (regCount > 0) {
            const insCount = inThisClz.filter(s => s.status === 'INSIDE').length;
            const lftCount = inThisClz.filter(s => s.status === 'LEFT').length;
            const stream = bioClasses.includes(clz) ? 'Biology' : 'Mathematics';

            doc.save();
            doc.rect(30, gridY, 535, 14).fillColor(gridY % 2 === 0 ? '#ffffff' : '#f8fafc').fill();
            doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0f172a').text(`${gr} - ${clz} (${stream})`, 35, gridY + 3);
            doc.fontSize(7.5).font('Helvetica').fillColor('#0369a1').text(String(regCount), 210, gridY + 3, { width: 80, align: 'center' });
            doc.fontSize(7.5).font('Helvetica').fillColor('#16a34a').text(String(insCount), 310, gridY + 3, { width: 80, align: 'center' });
            doc.fontSize(7.5).font('Helvetica').fillColor('#dc2626').text(String(lftCount), 410, gridY + 3, { width: 80, align: 'center' });
            doc.lineWidth(0.2).strokeColor('#e2e8f0').moveTo(30, gridY + 14).lineTo(565, gridY + 14).stroke();
            doc.restore();
            gridY += 14;
          }
        });
      });

      // Now detailed class lists
      let currentY = gridY + 20;

      gradesList.forEach(gr => {
        const allClasses = [...bioClasses, ...mathClasses];

        allClasses.forEach(clz => {
          const inThisClz = students.filter(s => s.grade === gr && s.classroom === clz);
          if (inThisClz.length === 0) return; // Skip empty classes in detailed print

          const stream = bioClasses.includes(clz) ? 'Biology' : 'Mathematics';
          const insCount = inThisClz.filter(s => s.status === 'INSIDE').length;
          const lftCount = inThisClz.filter(s => s.status === 'LEFT').length;

          // Check if space is available for header + at least 2 rows
          if (currentY + 60 > 750) {
            doc.addPage();
            drawHeader('MASTER CLASS-BY-CLASS ATTENDANCE REPORT (Cont.)', 'Detailed Student Entries');
            currentY = 70;
          }

          // Class Banner
          doc.save();
          doc.roundedRect(30, currentY, 535, 20, 3).fillColor('#0f172a').fill();
          doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#ffffff')
            .text(`📌 ${gr.toUpperCase()} - ${clz} (${stream.toUpperCase()})  •  Registered: ${inThisClz.length}  |  🟢 In Hall: ${insCount}  |  🔴 Left: ${lftCount}`, 38, currentY + 5);
          doc.restore();
          currentY += 20;

          // Table Header
          doc.save();
          doc.rect(30, currentY, 535, 16).fillColor('#334155').fill();
          doc.fontSize(7).font('Helvetica-Bold').fillColor('#f8fafc');
          doc.text('#', 35, currentY + 4, { width: 25 });
          doc.text('CODE', 65, currentY + 4, { width: 65 });
          doc.text('STUDENT NAME', 135, currentY + 4, { width: 175 });
          doc.text('ARRIVAL (IN)', 315, currentY + 4, { width: 85 });
          doc.text('EXIT (OUT)', 405, currentY + 4, { width: 80 });
          doc.text('STATUS', 490, currentY + 4, { width: 70 });
          doc.restore();
          currentY += 16;

          const rowH = 18;
          inThisClz.forEach((s, idx) => {
            if (currentY + rowH > 750) {
              doc.addPage();
              drawHeader('MASTER CLASS-BY-CLASS ATTENDANCE REPORT (Cont.)', `${gr} - ${clz} Continued`);
              currentY = 70;
            }

            if (idx % 2 === 1) {
              doc.save();
              doc.rect(30, currentY, 535, rowH).fillColor('#f8fafc').fill();
              doc.restore();
            }

            const arrTime = s.arrival_time ? new Date(s.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
            const extTime = s.exit_time ? new Date(s.exit_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
            const statusText = s.status === 'INSIDE' ? '🟢 IN HALL' : (s.status === 'LEFT' ? '🔴 LEFT' : 'REGISTERED');
            const statusColor = s.status === 'INSIDE' ? '#16a34a' : (s.status === 'LEFT' ? '#dc2626' : '#64748b');

            doc.fontSize(7).font('Helvetica').fillColor('#64748b').text(String(idx + 1), 35, currentY + 5);
            doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0284c7').text(s.code, 65, currentY + 5);
            doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#0f172a').text(s.student_name || '—', 135, currentY + 5, { width: 170, ellipsis: true });
            doc.fontSize(7).font('Helvetica').fillColor('#475569').text(arrTime, 315, currentY + 5);
            doc.fontSize(7).font('Helvetica').fillColor('#475569').text(extTime, 405, currentY + 5);
            doc.fontSize(7).font('Helvetica-Bold').fillColor(statusColor).text(statusText, 490, currentY + 5);

            doc.save();
            doc.lineWidth(0.2).strokeColor('#e2e8f0').moveTo(30, currentY + rowH).lineTo(565, currentY + rowH).stroke();
            doc.restore();

            currentY += rowH;
          });

          currentY += 12; // Gap between classes
        });
      });
    }

    doc.end();

  } catch (err) {
    console.error('Attendance PDF Error:', err);
    res.status(500).send('Error generating attendance report PDF: ' + err.message);
  }
});

// Export Attendance as CSV (Supports grade and classroom filter)
app.get('/api/export-csv', async (req, res) => {
  try {
    await syncFromFirestore();

    const { grade = 'all', classroom = 'all' } = req.query;
    let query = 'SELECT * FROM passes WHERE is_registered = 1';
    const params = [];

    if (grade !== 'all' && grade.trim()) {
      query += ' AND grade = ?';
      params.push(grade.trim());
    }

    if (classroom !== 'all' && classroom.trim()) {
      query += ' AND classroom = ?';
      params.push(classroom.trim().toUpperCase());
    }

    query += ' ORDER BY grade ASC, classroom ASC, student_name ASC';
    const passes = db.prepare(query).all(...params);

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
