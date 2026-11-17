// Admin Portal Logic & Password Protection

let currentTab = 'dashboard';
let currentStudentPage = 1;
let studentSearchTimeout = null;

function getAdminPassword() {
  return sessionStorage.getItem('scienceday_admin_pass') || '';
}

document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  const savedPass = getAdminPassword();
  if (savedPass === 'Nikila2008326@') {
    unlockPortal();
  }

  updateQrSheetCount();

  setInterval(() => {
    if (getAdminPassword() && currentTab === 'dashboard') {
      refreshDashboard();
    }
  }, 5000);
});

// -----------------------------------------------------------------------------
// AUTHENTICATION
// -----------------------------------------------------------------------------
async function handleAdminLogin(e) {
  e.preventDefault();
  const passInput = document.getElementById('admin-password-input');
  const errorMsg = document.getElementById('auth-error-msg');
  const password = passInput.value.trim();

  try {
    const res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });

    const data = await res.json();
    if (data.success) {
      sessionStorage.setItem('scienceday_admin_pass', password);
      errorMsg.classList.add('hidden');
      unlockPortal();
    } else {
      errorMsg.classList.remove('hidden');
      passInput.classList.add('border-rose-500');
    }
  } catch (err) {
    alert('Server connection error: ' + err.message);
  }
}

function unlockPortal() {
  document.getElementById('auth-lock-screen').classList.add('hidden');
  document.getElementById('main-admin-portal').classList.remove('hidden');
  if (window.lucide) lucide.createIcons();

  refreshDashboard();
  loadNetworkInfo();
}

function logoutAdmin() {
  sessionStorage.removeItem('scienceday_admin_pass');
  document.getElementById('auth-lock-screen').classList.remove('hidden');
  document.getElementById('main-admin-portal').classList.add('hidden');
  document.getElementById('admin-password-input').value = '';
}

// -----------------------------------------------------------------------------
// TAB SWITCHING
// -----------------------------------------------------------------------------
function switchTab(tabName) {
  currentTab = tabName;

  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');

  document.querySelectorAll('.tab-content').forEach(sec => sec.classList.add('hidden'));
  const activeSec = document.getElementById(`tab-${tabName}`);
  if (activeSec) activeSec.classList.remove('hidden');

  if (window.lucide) lucide.createIcons();

  if (tabName === 'dashboard') {
    refreshDashboard();
  } else if (tabName === 'students') {
    fetchStudents();
  } else if (tabName === 'phoneconnect') {
    loadNetworkInfo();
  }
}

// -----------------------------------------------------------------------------
// DASHBOARD & REALTIME STATS
// -----------------------------------------------------------------------------
async function refreshDashboard() {
  try {
    const res = await fetch('/api/stats', {
      headers: { 'x-admin-password': getAdminPassword() }
    });
    const data = await res.json();
    if (!data.success) return;

    const stats = data.stats;
    document.getElementById('stat-inside').textContent = stats.inside;
    document.getElementById('stat-left').textContent = stats.left;
    document.getElementById('stat-registered').textContent = stats.registered;
    document.getElementById('stat-total').textContent = stats.totalPasses;

    document.getElementById('stat-exits').textContent = `${stats.totalExits || 0} exits recorded`;
    document.getElementById('stat-pending').textContent = `${stats.pending} passes unassigned`;

    const regPct = stats.totalPasses > 0 ? Math.round((stats.registered / stats.totalPasses) * 100) : 0;
    document.getElementById('stat-registered-pct').textContent = `${regPct}% of passes assigned`;

    renderRecentLogs(data.recentLogs);

  } catch (err) {
    console.warn('Dashboard error:', err);
  }
}

function renderRecentLogs(logs) {
  const container = document.getElementById('recent-logs-table');
  if (!container) return;

  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="text-center py-6 text-slate-500 text-xs">No scan events recorded yet.</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    let badgeClass = 'bg-slate-800 text-slate-300';
    let actionLabel = log.action;

    if (log.action === 'STUDENT_REGISTER_ENTRY' || log.action === 'STUDENT_ENTRY') {
      badgeClass = 'bg-emerald-950 text-emerald-400 border border-emerald-800/80';
      actionLabel = 'ENTERED (IN)';
    } else if (log.action === 'STUDENT_EXIT') {
      badgeClass = 'bg-amber-950 text-amber-400 border border-amber-800/80';
      actionLabel = 'LEFT HALL (OUT)';
    } else if (log.action === 'STUDENT_RE_ENTRY') {
      badgeClass = 'bg-cyan-950 text-cyan-400 border border-cyan-800/80';
      actionLabel = 'RE-ENTERED';
    }

    const timeStr = log.timestamp ? new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

    return `
      <div class="flex items-center justify-between p-2.5 bg-slate-950/70 rounded-xl border border-slate-800/70 text-xs">
        <div class="flex items-center gap-2.5">
          <span class="px-2 py-0.5 rounded font-mono font-bold text-[10px] ${badgeClass}">
            ${log.code}
          </span>
          <div>
            <span class="font-bold text-white">${escapeHtml(log.student_name || 'Pass')}</span>
            <span class="text-slate-400 text-[10px] ml-1">• ${escapeHtml(log.details || actionLabel)}</span>
          </div>
        </div>
        <span class="text-slate-400 font-mono text-[10px]">${timeStr}</span>
      </div>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

// -----------------------------------------------------------------------------
// CLASS-WISE REPORT DOWNLOAD ACTIONS
// -----------------------------------------------------------------------------
function downloadSelectedClassPdf() {
  const grade = document.getElementById('export-grade-select')?.value || 'all';
  const classroom = document.getElementById('export-class-select')?.value || 'all';
  const url = `/api/download-attendance-pdf?grade=${encodeURIComponent(grade)}&classroom=${encodeURIComponent(classroom)}`;
  window.open(url, '_blank');
}

function downloadSelectedClassCsv() {
  const grade = document.getElementById('export-grade-select')?.value || 'all';
  const classroom = document.getElementById('export-class-select')?.value || 'all';
  const url = `/api/export-csv?grade=${encodeURIComponent(grade)}&classroom=${encodeURIComponent(classroom)}`;
  window.open(url, '_blank');
}

function downloadFilteredTablePdf() {
  const grade = document.getElementById('student-filter-grade')?.value || 'all';
  const classroom = document.getElementById('student-filter-class')?.value || 'all';
  const url = `/api/download-attendance-pdf?grade=${encodeURIComponent(grade)}&classroom=${encodeURIComponent(classroom)}`;
  window.open(url, '_blank');
}

// -----------------------------------------------------------------------------
// STUDENTS DIRECTORY TABLE (With Grade & Class Filters)
// -----------------------------------------------------------------------------
function debounceStudentSearch() {
  clearTimeout(studentSearchTimeout);
  studentSearchTimeout = setTimeout(() => {
    currentStudentPage = 1;
    fetchStudents();
  }, 300);
}

function changeStudentPage(delta) {
  currentStudentPage += delta;
  if (currentStudentPage < 1) currentStudentPage = 1;
  fetchStudents();
}

async function fetchStudents() {
  const search = document.getElementById('student-search-input')?.value || '';
  const filter = document.getElementById('student-filter')?.value || 'all';
  const grade = document.getElementById('student-filter-grade')?.value || 'all';
  const classroom = document.getElementById('student-filter-class')?.value || 'all';

  try {
    const queryParams = new URLSearchParams({
      search,
      filter,
      grade,
      classroom,
      page: currentStudentPage,
      limit: 40
    });

    const res = await fetch(`/api/passes?${queryParams.toString()}`, {
      headers: { 'x-admin-password': getAdminPassword() }
    });
    const data = await res.json();
    if (!data.success) return;

    renderStudentsTable(data.passes);

    const startIdx = (data.page - 1) * 40 + 1;
    const endIdx = Math.min(data.page * 40, data.total);
    document.getElementById('students-page-info').textContent = data.total > 0
      ? `Showing ${startIdx} to ${endIdx} of ${data.total}`
      : 'No passes found';

    document.getElementById('prev-page-btn').disabled = data.page <= 1;
    document.getElementById('next-page-btn').disabled = data.page >= data.totalPages;

  } catch (err) {
    console.error('Fetch students error:', err);
  }
}

function renderStudentsTable(passes) {
  const tbody = document.getElementById('students-table-body');
  if (!tbody) return;

  if (!passes || passes.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center py-6 text-slate-500">No matching student passes found.</td></tr>`;
    return;
  }

  tbody.innerHTML = passes.map(p => {
    let statusBadge = '';
    if (p.status === 'INSIDE') {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-emerald-950 text-emerald-400 border border-emerald-800">In Hall</span>`;
    } else if (p.status === 'LEFT') {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-amber-950 text-amber-400 border border-amber-800">Left Hall</span>`;
    } else if (p.is_registered) {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-bold bg-blue-950 text-blue-400 border border-blue-800">Registered</span>`;
    } else {
      statusBadge = `<span class="px-2 py-0.5 rounded-full text-[9px] font-medium bg-slate-800 text-slate-400">Unassigned</span>`;
    }

    const arrTime = p.arrival_time ? new Date(p.arrival_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
    const extTime = p.exit_time ? new Date(p.exit_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

    // Show delete button only if registered, or fresh
    const deleteBtn = p.is_registered
      ? `<button onclick="resetPass('${p.code}', '${escapeJs(p.student_name || '')}')" title="Delete Student & Make QR Fresh Again" 
           class="px-2 py-1 bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800/80 rounded-lg text-[10px] font-bold flex items-center gap-1 ml-auto">
           <i data-lucide="trash-2" class="w-3 h-3"></i> Delete & Free QR
         </button>`
      : `<span class="text-[10px] text-slate-600 italic">Fresh QR</span>`;

    return `
      <tr class="hover:bg-slate-800/40 transition-colors">
        <td class="py-2.5 px-3 font-mono font-bold text-red-400">${p.code}</td>
        <td class="py-2.5 px-3 font-bold text-white">${escapeHtml(p.student_name || '—')}</td>
        <td class="py-2.5 px-3 text-slate-300 font-semibold">${escapeHtml(p.grade || '—')}</td>
        <td class="py-2.5 px-3 font-black text-emerald-400">${escapeHtml(p.classroom || '—')}</td>
        <td class="py-2.5 px-3">${statusBadge}</td>
        <td class="py-2.5 px-3 font-mono text-slate-300 text-[11px]">${arrTime}</td>
        <td class="py-2.5 px-3 font-mono text-amber-300 text-[11px]">${extTime}</td>
        <td class="py-2.5 px-3 text-right">
          ${deleteBtn}
        </td>
      </tr>
    `;
  }).join('');

  if (window.lucide) lucide.createIcons();
}

// Delete / Reset single student (Make QR fresh & reusable in SQLite + Firestore)
async function resetPass(code, studentName) {
  const confirmMsg = studentName
    ? `Are you sure you want to delete student "${studentName}" from pass ${code}?\n\nThis will wipe all data for this student in local database AND Firebase Firestore, making QR code ${code} 100% FRESH and UNASSIGNED again so you can assign it to someone else.`
    : `Reset pass ${code} back to unassigned?`;

  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch('/api/passes/reset', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': getAdminPassword()
      },
      body: JSON.stringify({ code })
    });
    const data = await res.json();
    if (data.success) {
      alert(`✅ Pass ${code} has been cleared! It is now a brand new unassigned QR pass.`);
      fetchStudents();
      refreshDashboard();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Failed to reset pass: ' + err.message);
  }
}

// WIPE ALL TEST DATA (Reset all passes in SQLite AND Firestore)
async function wipeAllTestData() {
  const confirm1 = confirm("⚠️ WIPE ALL TEST DATA:\n\nAre you sure you want to delete ALL registered test students from local DB and Firebase Firestore?\nAll QR passes will become brand new, blank and unassigned!");
  if (!confirm1) return;

  const confirm2 = confirm("⚠️ FINAL CONFIRMATION:\n\nClick OK to permanently erase all test registrations and reset all scan logs.");
  if (!confirm2) return;

  try {
    const res = await fetch('/api/passes/reset-all', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-password': getAdminPassword()
      }
    });
    const data = await res.json();
    if (data.success) {
      alert("🎉 All test data wiped from Local DB and Firestore! All QR passes are now brand new and ready for Science Day.");
      fetchStudents();
      refreshDashboard();
    } else {
      alert('Error: ' + data.error);
    }
  } catch (err) {
    alert('Failed to wipe data: ' + err.message);
  }
}

// -----------------------------------------------------------------------------
// PRINT QR CODES (FLEXIBLE RANGE: 2, 20, 50, 400, CUSTOM)
// -----------------------------------------------------------------------------
function setQrRange(from, to) {
  const fromInput = document.getElementById('qr-from-input');
  const toInput = document.getElementById('qr-to-input');
  if (fromInput) fromInput.value = from;
  if (toInput) toInput.value = to;
  updateQrSheetCount();
}

function updateQrSheetCount() {
  const from = parseInt(document.getElementById('qr-from-input')?.value || '1', 10);
  const to = parseInt(document.getElementById('qr-to-input')?.value || '400', 10);
  const count = Math.max(1, to - from + 1);
  const sheets = Math.ceil(count / 20);

  const calcEl = document.getElementById('qr-calc-summary');
  if (calcEl) {
    calcEl.textContent = `Generating ${count} QR passes (from #${from} to #${to}) = ${sheets} A4 Sheet${sheets > 1 ? 's' : ''}`;
  }
}

function handleDownloadQrPdf(e) {
  e.preventDefault();
  const from = document.getElementById('qr-from-input').value || '1';
  const to = document.getElementById('qr-to-input').value || '400';
  const url = `/api/download-qr-pdf?from=${from}&to=${to}`;
  window.open(url, '_blank');
}

// -----------------------------------------------------------------------------
// PHONE SCANNER LINK & QR PAIRING
// -----------------------------------------------------------------------------
async function loadNetworkInfo() {
  try {
    const res = await fetch('/api/network-info');
    const data = await res.json();
    if (!data.success) return;

    const qrImg = document.getElementById('phone-scanner-qr');
    const urlLabel = document.getElementById('phone-scanner-url');
    const sampleToken = document.getElementById('sample-qr-token');

    if (qrImg) qrImg.src = data.qrDataUrl;
    if (sampleToken) sampleToken.src = data.qrDataUrl;
    if (urlLabel) urlLabel.textContent = data.scannerUrlHttps;

  } catch (err) {
    console.warn('Network info error:', err);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeJs(str) {
  if (!str) return '';
  return String(str).replace(/'/g, "\\'").replace(/"/g, '\\"');
}
