const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const selfsigned = require('selfsigned');

// Firebase Firestore (Cloud Database - Zero Env Vars Needed!)
const { initializeApp } = require('firebase/app');
const { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  collection, 
  deleteDoc,
  query,
  orderBy,
  limit
} = require('firebase/firestore');

// Built-in Passwords & Firebase Configuration
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Nikila2008326@';
const PREFECT_PASSWORD = process.env.PREFECT_PASSWORD || '12345678';

const isVercel = Boolean(process.env.VERCEL);
const app = express();
const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Force no caching on all responses so browsers & Vercel always serve fresh data
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Static assets
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0
}));

// Firebase Cloud Configuration (studenyt-1c8b7)
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
  console.log('[Firebase] Connected directly to project: studenyt-1c8b7');
} catch (e) {
  console.warn('[Firebase] Init notice:', e.message);
}

// -----------------------------------------------------------------------------
// IN-MEMORY PASS STORE (Backed 100% by Firebase Firestore)
// -----------------------------------------------------------------------------
const passesStore = new Map();
const scanLogsStore = [];
let totalConfiguredPasses = 400;

function ensurePassesSeed(count = 400, prefix = 'SCI-') {
  if (count > totalConfiguredPasses) {
    totalConfiguredPasses = count;
  }
  for (let i = 1; i <= count; i++) {
    const code = `${prefix}${String(i).padStart(4, '0')}`;
    if (!passesStore.has(code)) {
      passesStore.set(code, {
        code,
        student_name: null,
        grade: null,
        classroom: null,
        school_or_grade: null,
        is_registered: 0,
        registered_at: null,
        arrival_time: null,
        exit_time: null,
        status: 'UNREGISTERED',
        scan_count: 0,
        notes: null
      });
    }
  }
}
ensurePassesSeed(400);

let lastSyncTimestamp = 0;

// Pull all live data from Firebase Firestore into Store
async function syncFromFirestore(force = false) {
  if (!firestoreDb) return;
  const now = Date.now();
  if (!force && now - lastSyncTimestamp < 2500) return;
  lastSyncTimestamp = now;

  try {
    const snap = await getDocs(collection(firestoreDb, 'passes'));
    const firestoreCodes = new Set();

    snap.forEach(d => {
      const data = d.data();
      const code = d.id;
      firestoreCodes.add(code);

      const existing = passesStore.get(code) || { code };
      passesStore.set(code, {
        ...existing,
        ...data,
        code,
        is_registered: data.is_registered ? 1 : 0,
        status: data.status || (data.is_registered ? 'INSIDE' : 'UNREGISTERED')
      });
    });

    // Reset any local pass that was deleted in Firestore
    for (const [code, pass] of passesStore.entries()) {
      if (pass.is_registered === 1 && !firestoreCodes.has(code)) {
        passesStore.set(code, {
          code,
          student_name: null,
          grade: null,
          classroom: null,
          school_or_grade: null,
          is_registered: 0,
          registered_at: null,
          arrival_time: null,
          exit_time: null,
          status: 'UNREGISTERED',
          scan_count: 0,
          notes: null
        });
      }
    }

    console.log(`[Firebase Sync] Synced ${snap.size} documents from Firestore.`);
  } catch (err) {
    console.warn('[Firebase Pull Notice]', err.message);
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
// SHORTCUT ROUTES (Guaranteed to serve correct HTML on Vercel & Local)
// -----------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/scanner', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

app.get('/scan', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scanner.html'));
});

app.get('/print-passes', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'print-passes.html'));
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

// Get next available unassigned pass for manual entry
app.get('/api/next-pass', async (req, res) => {
  try {
    await syncFromFirestore();
    const sortedCodes = Array.from(passesStore.keys()).sort();
    for (const c of sortedCodes) {
      const p = passesStore.get(c);
      if (p && !p.is_registered) {
        return res.json({ success: true, code: c });
      }
    }
    const nextCode = `SCI-${String(passesStore.size + 1).padStart(4, '0')}`;
    return res.json({ success: true, code: nextCode });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 1. Scan QR Code (Shows identity without auto-exiting)
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

    let pass = passesStore.get(code);
    if (!pass) {
      pass = {
        code,
        student_name: null,
        grade: null,
        classroom: null,
        school_or_grade: null,
        is_registered: 0,
        registered_at: null,
        arrival_time: null,
        exit_time: null,
        status: 'UNREGISTERED',
        scan_count: 0
      };
      passesStore.set(code, pass);
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
      currentStatus: pass.status,
      arrivalTime: arrTime,
      exitTime: extTime,
      message: `Verified: ${pass.student_name} (${pass.school_or_grade})`
    });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Explicitly Mark Student Status (EXIT / RE-ENTRY)
app.post('/api/mark-status', async (req, res) => {
  try {
    await syncFromFirestore();

    let { code, action = 'EXIT' } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Code is required' });

    code = code.trim().toUpperCase();
    let pass = passesStore.get(code);

    if (!pass || !pass.is_registered) {
      return res.status(400).json({ success: false, error: 'Pass not registered' });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const dateFormatted = now.toLocaleDateString();
    const timeFormatted = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const newCount = (pass.scan_count || 1) + 1;

    if (action === 'EXIT') {
      const updated = {
        ...pass,
        status: 'LEFT',
        exit_time: nowIso,
        scan_count: newCount,
        last_updated: nowIso
      };
      passesStore.set(code, updated);

      const logEntry = {
        id: Date.now(),
        code,
        student_name: pass.student_name,
        action: 'STUDENT_EXIT',
        timestamp: nowIso,
        scanner_device: 'Mobile Scanner',
        details: `Left hall at ${timeFormatted}`
      };
      scanLogsStore.unshift(logEntry);

      // Save to Firestore
      if (firestoreDb) {
        try {
          await setDoc(doc(firestoreDb, 'passes', code), updated, { merge: true });
        } catch (e) {
          console.warn('[Firebase Update Error]', e.message);
        }
      }

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
      const updated = {
        ...pass,
        status: 'INSIDE',
        arrival_time: nowIso,
        scan_count: newCount,
        last_updated: nowIso
      };
      passesStore.set(code, updated);

      const logEntry = {
        id: Date.now(),
        code,
        student_name: pass.student_name,
        action: 'STUDENT_RE_ENTRY',
        timestamp: nowIso,
        scanner_device: 'Mobile Scanner',
        details: `Re-entered hall at ${timeFormatted}`
      };
      scanLogsStore.unshift(logEntry);

      // Save to Firestore
      if (firestoreDb) {
        try {
          await setDoc(doc(firestoreDb, 'passes', code), updated, { merge: true });
        } catch (e) {
          console.warn('[Firebase Update Error]', e.message);
        }
      }

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

    const newPass = {
      code,
      student_name,
      grade,
      classroom,
      school_or_grade,
      is_registered: 1,
      registered_at: nowIso,
      arrival_time: nowIso,
      exit_time: null,
      status: 'INSIDE',
      scan_count: 1,
      last_updated: nowIso
    };

    passesStore.set(code, newPass);

    const logEntry = {
      id: Date.now(),
      code,
      student_name,
      action: 'STUDENT_REGISTER_ENTRY',
      timestamp: nowIso,
      scanner_device,
      details: `${school_or_grade} • Registered & Admitted to Malalasekara Hall`
    };
    scanLogsStore.unshift(logEntry);

    // Save directly to Firebase Firestore
    if (firestoreDb) {
      try {
        await setDoc(doc(firestoreDb, 'passes', code), newPass, { merge: true });
      } catch (e) {
        console.warn('[Firebase Register Error]', e.message);
      }
    }

    res.json({
      success: true,
      message: `Pass ${code} permanently assigned to ${student_name}!`,
      pass: newPass,
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
    let students = Array.from(passesStore.values()).filter(p => p.is_registered === 1);

    if (search.trim()) {
      const s = search.trim().toLowerCase();
      students = students.filter(p => 
        (p.student_name && p.student_name.toLowerCase().includes(s)) ||
        (p.code && p.code.toLowerCase().includes(s)) ||
        (p.classroom && p.classroom.toLowerCase().includes(s)) ||
        (p.grade && p.grade.toLowerCase().includes(s))
      );
    }

    // Sort by most recently registered
    students.sort((a, b) => (b.registered_at || '').localeCompare(a.registered_at || ''));
    students = students.slice(0, Number(limit));

    res.json({ success: true, students });
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

    const allPasses = Array.from(passesStore.values());
    const registered = allPasses.filter(p => p.is_registered === 1);
    const inside = registered.filter(p => p.status === 'INSIDE').length;
    const left = registered.filter(p => p.status === 'LEFT').length;

    res.json({
      success: true,
      stats: {
        totalPasses: allPasses.length,
        registered: registered.length,
        inside,
        left,
        totalExits: scanLogsStore.filter(l => l.action === 'STUDENT_EXIT').length,
        pending: allPasses.length - registered.length
      },
      recentLogs: scanLogsStore.slice(0, 15)
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

    let passes = Array.from(passesStore.values());

    if (search.trim()) {
      const s = search.trim().toLowerCase();
      passes = passes.filter(p => 
        (p.code && p.code.toLowerCase().includes(s)) ||
        (p.student_name && p.student_name.toLowerCase().includes(s)) ||
        (p.school_or_grade && p.school_or_grade.toLowerCase().includes(s)) ||
        (p.grade && p.grade.toLowerCase().includes(s)) ||
        (p.classroom && p.classroom.toLowerCase().includes(s))
      );
    }

    if (filter === 'inside') {
      passes = passes.filter(p => p.status === 'INSIDE');
    } else if (filter === 'left') {
      passes = passes.filter(p => p.status === 'LEFT');
    } else if (filter === 'registered') {
      passes = passes.filter(p => p.is_registered === 1);
    } else if (filter === 'unregistered') {
      passes = passes.filter(p => !p.is_registered);
    }

    if (grade !== 'all' && grade.trim()) {
      passes = passes.filter(p => p.grade === grade.trim());
    }

    if (classroom !== 'all' && classroom.trim()) {
      passes = passes.filter(p => p.classroom === classroom.trim().toUpperCase());
    }

    passes.sort((a, b) => a.code.localeCompare(b.code));

    const total = passes.length;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const offset = (pageNum - 1) * limitNum;
    const paginated = passes.slice(offset, offset + limitNum);

    res.json({
      success: true,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      passes: paginated
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reset / Delete single student pass
app.post('/api/passes/reset', checkAdminAuth, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Code required' });

    passesStore.set(code, {
      code,
      student_name: null,
      grade: null,
      classroom: null,
      school_or_grade: null,
      is_registered: 0,
      registered_at: null,
      arrival_time: null,
      exit_time: null,
      status: 'UNREGISTERED',
      scan_count: 0,
      notes: null
    });

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

// WIPE ALL TEST DATA
app.post('/api/passes/reset-all', checkAdminAuth, async (req, res) => {
  try {
    for (const [code] of passesStore.entries()) {
      passesStore.set(code, {
        code,
        student_name: null,
        grade: null,
        classroom: null,
        school_or_grade: null,
        is_registered: 0,
        registered_at: null,
        arrival_time: null,
        exit_time: null,
        status: 'UNREGISTERED',
        scan_count: 0,
        notes: null
      });
    }

    scanLogsStore.length = 0;

    if (firestoreDb) {
      try {
        const snap = await getDocs(collection(firestoreDb, 'passes'));
        const deleteOps = [];
        snap.forEach(d => deleteOps.push(deleteDoc(d.ref)));
        await Promise.all(deleteOps);
      } catch (e) {
        console.warn('[Firebase Reset All Error]', e.message);
      }
    }

    return res.json({
      success: true,
      message: 'All test data wiped successfully! All passes are now fresh and unassigned.'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -----------------------------------------------------------------------------
// QR PDF GENERATION (FLEXIBLE: 2, 20, 50, 400 OR CUSTOM)
// -----------------------------------------------------------------------------
app.get('/api/download-qr-pdf', async (req, res) => {
  try {
    const from = Math.max(1, parseInt(req.query.from || '1', 10));
    const to = Math.max(from, parseInt(req.query.to || '400', 10));
    const prefix = req.query.prefix || 'SCI-';

    ensurePassesSeed(to, prefix);

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

      // Dotted cutting lines
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
    let students = Array.from(passesStore.values()).filter(p => p.is_registered === 1);

    if (grade !== 'all' && grade.trim()) {
      students = students.filter(p => p.grade === grade.trim());
    }

    if (classroom !== 'all' && classroom.trim()) {
      students = students.filter(p => p.classroom === classroom.trim().toUpperCase());
    }

    students.sort((a, b) => {
      const gCmp = (a.grade || '').localeCompare(b.grade || '');
      if (gCmp !== 0) return gCmp;
      const cCmp = (a.classroom || '').localeCompare(b.classroom || '');
      if (cCmp !== 0) return cCmp;
      return (a.student_name || '').localeCompare(b.student_name || '');
    });

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

    if (isSpecificClass) {
      drawHeader(`CLASS ATTENDANCE SHEET: ${grade.toUpperCase()} - ${classroom}`, `Official Class Attendance & Hall Status`);

      const totalInClass = students.length;
      const insideInClass = students.filter(s => s.status === 'INSIDE').length;
      const leftInClass = students.filter(s => s.status === 'LEFT').length;

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
      // MASTER CLASS-WISE ATTENDANCE REPORT
      drawHeader('MASTER CLASS-BY-CLASS ATTENDANCE REPORT', 'Complete breakdown for Grade 12 & Grade 13 (Biology & Maths)');

      const totalStudents = students.length;
      const totalInside = students.filter(s => s.status === 'INSIDE').length;
      const totalLeft = students.filter(s => s.status === 'LEFT').length;

      doc.save();
      doc.roundedRect(30, 70, 535, 24, 4).fillColor('#f8fafc').fill();
      doc.lineWidth(0.5).strokeColor('#cbd5e1').roundedRect(30, 70, 535, 24, 4).stroke();
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#0f172a')
        .text(`OVERALL EVENT STATS:   Total Registered: ${totalStudents}   |   🟢 Inside Hall: ${totalInside}   |   🔴 Left Hall: ${totalLeft}`, 40, 77);
      doc.restore();

      const gradesList = ['Grade 12', 'Grade 13'];
      const bioClasses = ['B1', 'B2', 'B3', 'B4'];
      const mathClasses = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7'];

      // Summary Matrix
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

      let currentY = gridY + 20;

      gradesList.forEach(gr => {
        const allClasses = [...bioClasses, ...mathClasses];

        allClasses.forEach(clz => {
          const inThisClz = students.filter(s => s.grade === gr && s.classroom === clz);
          if (inThisClz.length === 0) return;

          const stream = bioClasses.includes(clz) ? 'Biology' : 'Mathematics';
          const insCount = inThisClz.filter(s => s.status === 'INSIDE').length;
          const lftCount = inThisClz.filter(s => s.status === 'LEFT').length;

          if (currentY + 60 > 750) {
            doc.addPage();
            drawHeader('MASTER CLASS-BY-CLASS ATTENDANCE REPORT (Cont.)', 'Detailed Student Entries');
            currentY = 70;
          }

          doc.save();
          doc.roundedRect(30, currentY, 535, 20, 3).fillColor('#0f172a').fill();
          doc.fontSize(8.5).font('Helvetica-Bold').fillColor('#ffffff')
            .text(`📌 ${gr.toUpperCase()} - ${clz} (${stream.toUpperCase()})  •  Registered: ${inThisClz.length}  |  🟢 In Hall: ${insCount}  |  🔴 Left: ${lftCount}`, 38, currentY + 5);
          doc.restore();
          currentY += 20;

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
            doc.fontSize(7.5).font('Helvetica-Bold').fillColor(statusColor).text(statusText, 490, currentY + 5);

            doc.save();
            doc.lineWidth(0.2).strokeColor('#e2e8f0').moveTo(30, currentY + rowH).lineTo(565, currentY + rowH).stroke();
            doc.restore();

            currentY += rowH;
          });

          currentY += 12;
        });
      });
    }

    doc.end();

  } catch (err) {
    console.error('Attendance PDF Error:', err);
    res.status(500).send('Error generating attendance report PDF: ' + err.message);
  }
});

// Export Attendance as CSV
app.get('/api/export-csv', async (req, res) => {
  try {
    await syncFromFirestore();

    const { grade = 'all', classroom = 'all' } = req.query;
    let passes = Array.from(passesStore.values()).filter(p => p.is_registered === 1);

    if (grade !== 'all' && grade.trim()) {
      passes = passes.filter(p => p.grade === grade.trim());
    }

    if (classroom !== 'all' && classroom.trim()) {
      passes = passes.filter(p => p.classroom === classroom.trim().toUpperCase());
    }

    passes.sort((a, b) => {
      const gCmp = (a.grade || '').localeCompare(b.grade || '');
      if (gCmp !== 0) return gCmp;
      return (a.classroom || '').localeCompare(b.classroom || '');
    });

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
