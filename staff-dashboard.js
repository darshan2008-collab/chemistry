// ── Auth Guard ────────────────────────────────────────────────
const staff = JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null');
if (!staff) { window.location.href = 'login.html'; }

let submissionsCache = [];
const getSubmissions = () => submissionsCache;

async function apiFetchSubmissions() {
  const res = await fetch('/api/submissions?includeArchived=true');
  if (!res.ok) throw new Error('Failed to load submissions');
  const payload = await res.json();
  return payload.submissions || [];
}

async function apiArchiveAllSubmissions() {
  const res = await fetch('/api/submissions/archive-all', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to archive submissions');
}

async function apiDeleteSubmission(id) {
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete submission');
}

async function refreshSubmissions() {
  submissionsCache = await apiFetchSubmissions();
}

let currentEditId = null;
let activeTab = 'dashboard';

document.addEventListener('DOMContentLoaded', async () => {
  setStaffUI();
  setDate();
  initSidebar();
  initTabs();
  initRefresh();
  initLogout();
  initLightbox();
  initClearData();
  initAutoRefresh();
  await refreshSubmissions();
  renderAll();
});

// ── Auto-refresh (poll + cross-tab storage events) ────────────
let _lastCount = -1;
function initAutoRefresh() {
  // Poll every 5 seconds for cross-device updates
  setInterval(async () => {
    try {
      await refreshSubmissions();
      const count = getSubmissions().length;
      if (count !== _lastCount) {
        _lastCount = count;
        renderAll();
      }
    } catch (_err) {
      // Keep UI usable even if refresh fails temporarily.
    }
  }, 5000);
}

// ── Clear all data ────────────────────────────────────────────
function initClearData() {
  const btn = document.getElementById('clearDataBtn');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!confirm('⚠️ This will CLEAR the Tracker for a new test. (Past tests will remain safely in Student Records). Proceed?')) return;
    try {
      await apiArchiveAllSubmissions();
      await refreshSubmissions();
      
      _lastCount = -1;
      
      // Force DOM update directly to be absolutely certain
      const rList = document.getElementById('recentSubmissions');
      if (rList) rList.innerHTML = emptyHTML('No submissions yet');
      
      const tDone = document.getElementById('trackerDone');
      if (tDone) tDone.textContent = '0';
      const tLeft = document.getElementById('trackerLeft');
      if (tLeft) tLeft.textContent = document.getElementById('trackerTotal')?.textContent || '63';
      
      ['ds-total', 'ds-pending', 'ds-graded'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = '0';
      });
      const avg = document.getElementById('ds-avg');
      if (avg) avg.textContent = '–';

      renderAll();
      showToast('✅ Tracker cleared! (Data saved in Student Records)', 'success');
    } catch(err) {
      console.error('Clear data error:', err);
      // Fallback reload if JS crashes somehow
      window.location.reload();
    }
  });
}

// ── Staff UI ──────────────────────────────────────────────────
function setStaffUI() {
  const initials = staff.name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
  document.getElementById('staffAvatar').textContent = initials;
  document.getElementById('topbarProfile').textContent = initials;
  document.getElementById('staffName').textContent = staff.name;
  document.getElementById('staffRole').textContent = staff.role;
}

function setDate() {
  const el = document.getElementById('dashDate');
  if (el) el.textContent = 'Today, ' + new Date().toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
}

// ── Sidebar ───────────────────────────────────────────────────
function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  document.getElementById('menuBtn').addEventListener('click', () => {
    if (window.innerWidth <= 768) sidebar.classList.toggle('open');
    else sidebar.classList.toggle('collapsed');
  });
  document.getElementById('sidebarClose').addEventListener('click', () => sidebar.classList.remove('open'));
  document.addEventListener('click', e => {
    if (window.innerWidth <= 768 && !sidebar.contains(e.target) && !document.getElementById('menuBtn').contains(e.target)) {
      sidebar.classList.remove('open');
    }
  });
}

// ── Tabs ──────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      switchTab(item.dataset.tab);
      document.getElementById('sidebar').classList.remove('open');
    });
  });
  document.querySelectorAll('.view-all-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  // Search
  const sea = document.getElementById('recordSearch');
  if (sea) sea.addEventListener('input', renderRecords);
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab' + cap(tab)).classList.add('active');
  document.getElementById('nav' + cap(tab)).classList.add('active');
  document.getElementById('topbarTitle').textContent = { dashboard:'Dashboard', tracker:'Student Tracker', records:'Student Records' }[tab];
  if (tab === 'tracker') renderStudentTracker();
  if (tab === 'records') renderRecords();
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Render All ────────────────────────────────────────────────
function renderAll() {
  renderDashboard();
  renderStudentTracker();
  renderRecords();
}

// ── Dashboard ─────────────────────────────────────────────────
function renderDashboard() {
  const all = getSubmissions().filter(s => !s.archived);
  const graded = all.filter(s => s.status === 'graded');
  const pending = all.filter(s => s.status !== 'graded');
  const avg = graded.length ? Math.round(graded.reduce((a, s) => a + (s.marks / (s.totalMarks||100))*100, 0) / graded.length) : null;

  animNum('ds-total', all.length);
  animNum('ds-pending', pending.length);
  animNum('ds-graded', graded.length);
  document.getElementById('ds-avg').textContent = avg !== null ? avg + '%' : '–';

  const recent = [...all].sort((a,b) => new Date(b.submittedAt)-new Date(a.submittedAt)).slice(0,5);
  const el = document.getElementById('recentSubmissions');
  el.innerHTML = '';
  if (!recent.length) { el.innerHTML = emptyHTML('No submissions yet'); return; }
  recent.forEach(s => el.appendChild(buildCard(s)));
}

// ── Student Tracker (all 63, ordered by reg no) ───────────────
function renderStudentTracker() {
  const el = document.getElementById('studentTrackerList');
  if (!el) return;
  const submissions = getSubmissions().filter(s => !s.archived);
  // Map regNo -> latest submission
  const subMap = {};
  submissions.forEach(s => { subMap[s.rollNumber] = s; });

  const regNos = Object.keys(STUDENTS_DB).sort();
  const submitted   = regNos.filter(r => subMap[r]).length;
  const notYet      = regNos.length - submitted;

  // Update tracker summary counts
  const trackerTotal = document.getElementById('trackerTotal');
  const trackerDone  = document.getElementById('trackerDone');
  const trackerLeft  = document.getElementById('trackerLeft');
  if (trackerTotal) trackerTotal.textContent = regNos.length;
  if (trackerDone)  trackerDone.textContent  = submitted;
  if (trackerLeft)  trackerLeft.textContent  = notYet;

  el.innerHTML = '';
  regNos.forEach((regNo, idx) => {
    const name = STUDENTS_DB[regNo];
    const sub  = subMap[regNo];
    const row  = document.createElement('div');
    row.className = 'tracker-row' + (sub ? '' : ' tracker-not-submitted');
    const statusBadge = sub
      ? ({ graded: '<span class="t-badge t-graded">✅ Graded</span>',
             review: '<span class="t-badge t-review">🔍 Review</span>',
             pending: '<span class="t-badge t-pending">⏳ Pending</span>' }[sub.status] || '<span class="t-badge t-pending">⏳ Pending</span>')
      : '<span class="t-badge t-none">❌ Not Submitted</span>';
    const marksCell = sub && sub.status === 'graded' && sub.marks !== null
      ? `<span class="t-marks">${sub.marks}/${sub.totalMarks||100}</span>`
      : '<span class="t-marks-none">–</span>';
    const gradeBtn = sub
      ? `<button class="t-grade-btn" onclick="event.stopPropagation(); sessionStorage.setItem('currentGradeId', '${sub.id}'); window.location.href='grade.html';">✏️ Grade</button>`
      : '<span class="t-no-sub">—</span>';
    row.innerHTML = `
      <div class="t-num">${idx + 1}</div>
      <div class="t-reg">${esc(regNo)}</div>
      <div class="t-name">${esc(name)}</div>
      <div class="t-status">${statusBadge}</div>
      <div class="t-marks-col">${marksCell}</div>
      <div class="t-action">${gradeBtn}</div>
    `;
    if (sub) {
      row.style.cursor = 'pointer';
      row.setAttribute('onclick', `sessionStorage.setItem('currentGradeId', '${sub.id}'); window.location.href='grade.html'`);
    }
    el.appendChild(row);
  });
}

// ── Student Records (Multiple Tests Directory) ─────────────────
function renderRecords() {
  const el = document.getElementById('recordsList');
  if (!el) return;
  const submissions = getSubmissions();
  
  // Group submissions by roll number
  const history = {};
  submissions.forEach(s => {
    history[s.rollNumber] = history[s.rollNumber] || [];
    history[s.rollNumber].push(s);
  });

  const q = (document.getElementById('recordSearch')?.value || '').toLowerCase();

  const regNos = Object.keys(STUDENTS_DB).sort();
  el.innerHTML = '';

  let count = 0;
  regNos.forEach(regNo => {
    const name = STUDENTS_DB[regNo];
    if (q && !name.toLowerCase().includes(q) && !regNo.toLowerCase().includes(q)) return;
    count++;

    const subs = (history[regNo] || []).sort((a,b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    
    const card = document.createElement('div');
    card.className = 'record-card';
    
    let testsHTML = '';
    if (subs.length === 0) {
      testsHTML = '<div class="t-no-sub" style="padding:10px 14px;background:rgba(255,255,255,0.02);border-radius:6px;">No tests submitted yet.</div>';
    } else {
      testsHTML = subs.map((s, idx) => {
        const marksStr = s.status === 'graded' && s.marks !== null ? `<span class="t-marks">${s.marks}/${s.totalMarks||100}</span>` : '<span class="t-marks-none">Un-graded</span>';
        const badgeStr = { graded: '<span class="t-badge t-graded">✅ Graded</span>', review: '<span class="t-badge t-review">🔍 Review</span>', pending: '<span class="t-badge t-pending">⏳ Pending</span>' }[s.status] || '<span class="t-badge t-pending">⏳ Pending</span>';
        
        return `
          <div class="record-test-row" onclick="sessionStorage.setItem('currentGradeId', '${s.id}'); window.location.href='grade.html'">
            <div style="flex:1;">
              <div style="font-weight:600;font-size:0.85rem;color:var(--primary-light);">${esc(s.testTitle)}</div>
              <div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">${esc(s.subject)} • ${timeAgo(new Date(s.submittedAt))}</div>
            </div>
            <div style="display:flex;align-items:center;gap:12px;">
              ${marksStr}
              ${badgeStr}
              <button class="t-grade-btn" onclick="event.stopPropagation(); sessionStorage.setItem('currentGradeId', '${s.id}'); window.location.href='grade.html';" style="padding:4px 8px;font-size:0.7rem;">Open</button>
              <button class="t-grade-btn" onclick="window.deleteTestSubmission(event, '${s.id}');" style="padding:4px;font-size:12px;background:rgba(255,107,107,0.15);color:#ff6b6b;border:1px solid rgba(255,107,107,0.3);" title="Delete Test">🗑️</button>
            </div>
          </div>
        `;
      }).join('');
    }

    card.innerHTML = `
      <div class="record-card-header">
        <div style="display:flex; justify-content:space-between; align-items:flex-start;">
          <div>
            <div style="font-weight:600;font-size:1rem;">${esc(name)}</div>
            <div style="font-size:0.8rem;color:var(--text-muted);margin-top:2px;font-family:'Space Grotesk',sans-serif;">${esc(regNo)}</div>
          </div>
          <button class="t-grade-btn" onclick="resetStudentPassword('${regNo}')" style="background:#ff6b6b;font-size:0.65rem;padding:4px 8px;">🔑 Change PW</button>
        </div>
      </div>
      <div class="record-card-body">
        <div style="font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-muted);margin-bottom:8px;">Test History (${subs.length})</div>
        ${testsHTML}
      </div>
    `;
    el.appendChild(card);
  });
  
  if (count === 0) el.innerHTML = emptyHTML('No students found matching your search.');
}

// ── Reset Student Password (Staff Only) ───────────────────────
window.resetStudentPassword = function(regNo) {
  const newPw = prompt(`Enter new password for ${regNo} (${STUDENTS_DB[regNo]}):`, regNo);
  if (!newPw) return;
  setStudentPassword(regNo, newPw);
  markPasswordChanged(regNo);
  showToast(`✅ Password updated for ${regNo}`, 'success');
};

// ── Change Own Password (Staff) ───────────────────────────────
window.changeOwnPassword = function() {
  const pw = prompt('Enter your new secure password:');
  if (!pw) return;
  if (pw.length < 6) {
    showToast('❌ Password must be at least 6 characters', 'error');
    return;
  }
  const customPws = JSON.parse(localStorage.getItem('chemtest_staff_custom_pws') || '{}');
  customPws[staff.email] = pw;
  localStorage.setItem('chemtest_staff_custom_pws', JSON.stringify(customPws));
  showToast('✅ Your password has been changed successfully!', 'success');
};

// ── Delete Individual Test (Staff Only) ───────────────────────
window.deleteTestSubmission = function(e, id) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!confirm('Are you sure you want to permanently delete this test submission?')) return;
  (async () => {
    try {
      await apiDeleteSubmission(id);
      await refreshSubmissions();
      _lastCount = -1;
      renderAll();
      showToast('🗑️ Test submission deleted', 'info');
    } catch(err) {
      console.error('Delete error:', err);
      showToast('⚠️ Error: ' + err.message, 'error');
    }
  })();
};

// ── Card Builder ──────────────────────────────────────────────
function buildCard(s) {
  const card = document.createElement('div');
  card.className = 'sub-card';
  card.dataset.id = s.id;

  const statusClass = { pending:'status-pending', graded:'status-graded', review:'status-review' }[s.status]||'status-pending';
  const statusLabel = { pending:'⏳ Pending', graded:'✅ Graded', review:'🔍 In Review' }[s.status]||'Pending';
  const dateStr = timeAgo(new Date(s.submittedAt));

  const thumbHTML = s.images && s.images.length
    ? `<div class="sub-thumb-wrap">${s.images.slice(0,2).map(src => `<img class="sub-thumb" src="${src}" alt="answer" />`).join('')}</div>`
    : `<div class="sub-thumb-wrap"><div class="sub-thumb-placeholder">📄</div></div>`;

  const marksHTML = s.status === 'graded' && s.marks !== null
    ? `<div class="sub-marks">${s.marks}/${s.totalMarks||100}</div>`
    : `<div class="sub-marks-none">${s.fileCount} photo${s.fileCount!==1?'s':''}</div>`;

  card.innerHTML = `
    ${thumbHTML}
    <div class="sub-info">
      <div class="sub-name">${esc(s.studentName)}</div>
      <div class="sub-meta">
        <span class="sub-meta-tag">🎓 ${esc(s.rollNumber)}</span>
        <span class="sub-meta-tag">📚 ${esc(s.subject)}</span>
        <span class="sub-meta-tag">🏫 ${esc(s.classroom)}</span>
        <span class="sub-meta-tag">🕐 ${dateStr}</span>
      </div>
      <div style="font-size:0.8rem;color:var(--text-muted);margin-top:6px;">${esc(s.testTitle)}</div>
    </div>
    <div class="sub-right">
      <span class="status-badge ${statusClass}">${statusLabel}</span>
      ${marksHTML}
      <button class="grade-btn" onclick="event.stopPropagation(); sessionStorage.setItem('currentGradeId', '${s.id}'); window.location.href='grade.html';">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        ${s.status === 'graded' ? 'Edit Grade' : 'Grade'}
      </button>
    </div>
  `;

  card.style.cursor = 'pointer';
  card.setAttribute('onclick', `sessionStorage.setItem('currentGradeId', '${s.id}'); window.location.href='grade.html'`);
  return card;
}

function emptyHTML(msg) {
  return `<div class="no-data"><div class="icon">📭</div><p>${msg}</p></div>`;
}

// ── Lightbox ──────────────────────────────────────────────────
function initLightbox() {
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightbox').addEventListener('click', e => { if (e.target.id==='lightbox') closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key==='Escape') closeLightbox(); });
}
function openLightbox(src) { document.getElementById('lightboxImg').src=src; document.getElementById('lightbox').classList.add('show'); }
function closeLightbox() { document.getElementById('lightbox').classList.remove('show'); }
window.openLightbox = openLightbox;

// ── Refresh ───────────────────────────────────────────────────
function initRefresh() {
  document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    setTimeout(async () => {
      try {
        await refreshSubmissions();
        renderAll();
        showToast('🔄 Refreshed', 'info');
      } catch (err) {
        showToast('⚠️ Refresh failed', 'error');
      } finally {
        btn.classList.remove('spinning');
      }
    }, 600);
  });
}

// ── Logout ────────────────────────────────────────────────────
function initLogout() {
  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('chemtest_staff');
    window.location.href = 'login.html';
  });
}

// ── Helpers ───────────────────────────────────────────────────
function getGrade(m, t) {
  const p = (m/(t||100))*100;
  if (p>=90) return 'A+'; if (p>=80) return 'A'; if (p>=70) return 'B+'; if (p>=60) return 'B'; if (p>=50) return 'C'; return 'F';
}
function genId() { return 'CT-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,5).toUpperCase(); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function timeAgo(d) {
  const s = Math.floor((Date.now()-d)/1000);
  if (s<60) return 'just now'; if (s<3600) return Math.floor(s/60)+'m ago';
  if (s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}
function animNum(id, target) {
  const el = document.getElementById(id); if (!el) return;
  let c=0; const step=Math.max(1,Math.ceil(target/25));
  const t = setInterval(()=>{ c=Math.min(c+step,target); el.textContent=c; if(c>=target)clearInterval(t); },40);
}

let toastTimer;
function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent=msg; t.className=`toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),3500);
}
