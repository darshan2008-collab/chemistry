// ── Auth Guard ────────────────────────────────────────────────
const staff = JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null');
if (!staff || !staff.token) { window.location.href = 'login.html'; }

function getStaffAuthHeaders() {
  const s = JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null');
  if (!s || !s.token) throw new Error('Unauthorized');
  return { Authorization: `Bearer ${s.token}` };
}

let submissionsCache = [];
const getSubmissions = () => submissionsCache;
let trackerClassFilter = 'all';
let recordClassFilter = 'all';

const A7_PREFIXES = new Set(['BAD', 'BAM']);
const A3_PREFIXES = new Set(['BCS', 'BIT', 'BSC']);

function resolveImageUrl(src) {
  let candidate = src;
  if (candidate && typeof candidate === 'object') {
    candidate = candidate.url || candidate.src || candidate.path || '';
  }
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:)/i.test(raw)) return raw;
  if (raw.startsWith('/api/uploads/')) return raw;
  if (raw.startsWith('/uploads/')) return `/api${raw}`;
  if (raw.startsWith('uploads/')) return `/api/${raw}`;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.includes('\\')) {
    const name = raw.split(/[/\\]/).pop();
    return name ? `/api/uploads/${name}` : '';
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const idx = u.pathname.toLowerCase().lastIndexOf('/uploads/');
      if (idx >= 0) {
        return `/api/uploads/${u.pathname.slice(idx + '/uploads/'.length).replace(/^\/+/, '')}`;
      }
    } catch (_err) {
      // ignore
    }
  }
  return raw;
}

async function apiFetchSubmissions() {
  const params = new URLSearchParams({
    includeArchived: 'true',
    _ts: String(Date.now()),
    _uuid: Math.random().toString(36),
  });
  const res = await fetch(`/api/submissions?${params.toString()}`, {
    headers: {
      ...getStaffAuthHeaders(),
      'Pragma': 'no-cache',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    cache: 'no-store',
  });
  if (res.status === 401) {
    sessionStorage.removeItem('chemtest_staff');
    window.location.href = 'login.html';
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error('Failed to load submissions');
  const payload = await res.json();
  console.log('[AUTO-REFRESH] Fetched submissions:', payload.submissions?.length || 0);
  return payload.submissions || [];
}

async function apiArchiveAllSubmissions() {
  const res = await fetch('/api/submissions/archive-all', {
    method: 'POST',
    headers: getStaffAuthHeaders(),
  });
  if (!res.ok) throw new Error('Failed to archive submissions');
}

async function apiDeleteSubmission(id) {
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: getStaffAuthHeaders(),
  });
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
  initDownloadButtons();
  initLogout();
  initLightbox();
  initClearData();
  initAutoRefresh();
  initStaffCommsPanel();
  await refreshSubmissions();
  renderAll();
});

async function staffApiJson(url, options = {}) {
  const headers = {
    ...getStaffAuthHeaders(),
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload;
}

function initStaffCommsPanel() {
  const dashboardTab = document.getElementById('tabDashboard');
  if (!dashboardTab) return;

  const card = document.createElement('section');
  card.className = 'section-panel';
  card.style.marginTop = '20px';
  card.innerHTML = `
    <div class="section-header" style="margin-bottom:12px;">
      <h2 style="margin:0;">Communication & Q&A</h2>
      <button class="clear-btn" id="staffCommsRefreshBtn" type="button">Refresh</button>
    </div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
      <form id="staffAnnouncementForm" class="record-card" style="padding:12px;display:grid;gap:8px;">
        <div style="font-weight:700;">Send Announcement</div>
        <input id="staffAnnTitle" placeholder="Title" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required />
        <textarea id="staffAnnMessage" placeholder="Message" rows="3" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input id="staffAnnSubjectId" placeholder="Subject ID (optional)" style="flex:1;min-width:120px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" />
          <select id="staffAnnChannel" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;">
            <option value="global">Global</option>
            <option value="subject">Subject</option>
            <option value="class">Class</option>
            <option value="student">Student</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input id="staffAnnClassroom" placeholder="Classroom (if class channel)" style="flex:1;min-width:120px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" />
          <input id="staffAnnTargetReg" placeholder="Reg No (if student channel)" style="flex:1;min-width:120px;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" />
        </div>
        <button class="t-grade-btn" type="submit">Publish</button>
        <p id="staffAnnMsg" style="margin:0;font-size:0.78rem;color:var(--text-muted);"></p>
      </form>

      <form id="staffEmergencyForm" class="record-card" style="padding:12px;display:grid;gap:8px;">
        <div style="font-weight:700;">Emergency Banner</div>
        <input id="staffEmergencyTitle" value="Emergency Notice" placeholder="Title" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" />
        <textarea id="staffEmergencyMessage" placeholder="Urgent message" rows="3" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required></textarea>
        <button class="t-grade-btn" type="submit">Send Emergency</button>
        <p id="staffEmergencyMsg" style="margin:0;font-size:0.78rem;color:var(--text-muted);"></p>
      </form>

      <form id="staffReceiptForm" class="record-card" style="padding:12px;display:grid;gap:8px;">
        <div style="font-weight:700;">Read Receipts</div>
        <input id="staffReceiptMessageId" placeholder="Announcement ID" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required />
        <button class="t-grade-btn" type="submit">Fetch Receipts</button>
        <div id="staffReceiptList" style="max-height:180px;overflow:auto;font-size:0.8rem;color:var(--text-muted);"></div>
      </form>
    </div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-top:12px;">
      <div class="record-card" style="padding:12px;">
        <div style="font-weight:700;margin-bottom:8px;">My Announcements</div>
        <div id="staffAnnouncementsList" style="max-height:220px;overflow:auto;font-size:0.8rem;color:var(--text-muted);"></div>
      </div>
      <div class="record-card" style="padding:12px;">
        <div style="font-weight:700;margin-bottom:8px;">Student Q&A Threads</div>
        <div id="staffQaThreadsList" style="max-height:220px;overflow:auto;font-size:0.8rem;color:var(--text-muted);"></div>
      </div>
      <form id="staffMaterialForm" class="record-card" style="padding:12px;display:grid;gap:8px;">
        <div style="font-weight:700;">Subject Materials</div>
        <input id="staffMaterialSubjectId" placeholder="Subject ID" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required />
        <input id="staffMaterialTitle" placeholder="Material title" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required />
        <textarea id="staffMaterialDescription" placeholder="Description (optional)" rows="2" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;"></textarea>
        <input id="staffMaterialFile" type="file" style="padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.04);color:inherit;" required />
        <button class="t-grade-btn" type="submit">Upload Material</button>
        <p id="staffMaterialMsg" style="margin:0;font-size:0.78rem;color:var(--text-muted);"></p>
        <div id="staffMaterialList" style="max-height:220px;overflow:auto;font-size:0.8rem;color:var(--text-muted);"></div>
      </form>
    </div>
  `;
  dashboardTab.appendChild(card);

  const annMsg = card.querySelector('#staffAnnMsg');
  const emergencyMsg = card.querySelector('#staffEmergencyMsg');
  const materialMsg = card.querySelector('#staffMaterialMsg');

  async function refreshMaterials() {
    const list = card.querySelector('#staffMaterialList');
    if (!list) return;
    list.innerHTML = 'Loading...';
    try {
      const payload = await staffApiJson('/api/staff/materials');
      const rows = payload.materials || [];
      if (!rows.length) {
        list.innerHTML = 'No materials uploaded yet.';
        return;
      }
      list.innerHTML = rows.slice(0, 30).map((m) => `
        <div style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-weight:600;color:var(--text);">${esc(m.title || '')}</div>
          <div>Subject: ${esc(String(m.subject_id || ''))} · ${esc(m.file_name || '')}</div>
          <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap;">
            <a class="t-grade-btn" style="padding:4px 8px;font-size:0.72rem;text-decoration:none;" href="/api/materials/${encodeURIComponent(m.id)}/file" target="_blank" rel="noopener">Open</a>
          </div>
        </div>
      `).join('');
    } catch (err) {
      list.innerHTML = `<span style="color:#ffb8c7;">${esc(err.message || 'Failed')}</span>`;
    }
  }

  async function refreshAnnouncements() {
    const list = card.querySelector('#staffAnnouncementsList');
    list.innerHTML = 'Loading...';
    try {
      const payload = await staffApiJson('/api/staff/messages/broadcast');
      const rows = payload.messages || [];
      if (!rows.length) {
        list.innerHTML = 'No announcements yet.';
        return;
      }
      list.innerHTML = rows.slice(0, 20).map((m) =>
        `<div style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-weight:600;color:var(--text);">#${m.id} · ${esc(m.title || '')}</div>
          <div>${esc(m.message || '')}</div>
        </div>`
      ).join('');
    } catch (err) {
      list.innerHTML = `<span style="color:#ffb8c7;">${esc(err.message || 'Failed')}</span>`;
    }
  }

  async function refreshQaThreads() {
    const list = card.querySelector('#staffQaThreadsList');
    list.innerHTML = 'Loading...';
    try {
      const payload = await staffApiJson('/api/staff/qa/threads');
      const rows = payload.threads || [];
      if (!rows.length) {
        list.innerHTML = 'No Q&A threads.';
        return;
      }
      list.innerHTML = rows.slice(0, 30).map((t) =>
        `<div style="padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
          <div style="font-weight:600;color:var(--text);">#${t.id} · ${esc(t.title || '')}</div>
          <div>${esc(t.reg_no || '')} · subject ${esc(String(t.subject_id || ''))} · ${t.is_open ? 'Open' : 'Closed'}</div>
          <button class="t-grade-btn" style="margin-top:6px;padding:4px 8px;font-size:0.72rem;" data-reply-thread="${t.id}">Reply</button>
          <button class="t-grade-btn" style="margin-top:6px;padding:4px 8px;font-size:0.72rem;background:rgba(255,107,107,0.15);" data-close-thread="${t.id}">Reply + Close</button>
        </div>`
      ).join('');
    } catch (err) {
      list.innerHTML = `<span style="color:#ffb8c7;">${esc(err.message || 'Failed')}</span>`;
    }
  }

  card.querySelector('#staffAnnouncementForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = String(card.querySelector('#staffAnnTitle').value || '').trim();
    const message = String(card.querySelector('#staffAnnMessage').value || '').trim();
    const channelType = String(card.querySelector('#staffAnnChannel').value || 'global').trim();
    const subjectIdRaw = String(card.querySelector('#staffAnnSubjectId').value || '').trim();
    const classroom = String(card.querySelector('#staffAnnClassroom').value || '').trim();
    const targetRegNo = String(card.querySelector('#staffAnnTargetReg').value || '').trim();
    if (!title || !message) {
      annMsg.style.color = '#ffb8c7';
      annMsg.textContent = 'Title and message are required';
      return;
    }
    try {
      const body = {
        title,
        message,
        channelType,
      };
      if (subjectIdRaw) body.subjectId = Number(subjectIdRaw);
      if (classroom) body.classroom = classroom;
      if (targetRegNo) body.targetRegNo = targetRegNo;

      const payload = await staffApiJson('/api/staff/messages/announcement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      annMsg.style.color = '#9de9ff';
      annMsg.textContent = `Announcement published (#${payload.announcement?.id || '-'})`;
      showToast('Announcement sent', 'success');
      await refreshAnnouncements();
    } catch (err) {
      annMsg.style.color = '#ffb8c7';
      annMsg.textContent = err.message || 'Failed to publish';
    }
  });

  card.querySelector('#staffEmergencyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = String(card.querySelector('#staffEmergencyTitle').value || '').trim();
    const message = String(card.querySelector('#staffEmergencyMessage').value || '').trim();
    if (!message) {
      emergencyMsg.style.color = '#ffb8c7';
      emergencyMsg.textContent = 'Emergency message is required';
      return;
    }
    try {
      const payload = await staffApiJson('/api/staff/messages/emergency', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message }),
      });
      emergencyMsg.style.color = '#9de9ff';
      emergencyMsg.textContent = `Emergency banner posted (#${payload.banner?.id || '-'})`;
      showToast('Emergency banner sent', 'success');
      await refreshAnnouncements();
    } catch (err) {
      emergencyMsg.style.color = '#ffb8c7';
      emergencyMsg.textContent = err.message || 'Failed to send emergency banner';
    }
  });

  card.querySelector('#staffMaterialForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectId = Number(String(card.querySelector('#staffMaterialSubjectId').value || '').trim());
    const title = String(card.querySelector('#staffMaterialTitle').value || '').trim();
    const description = String(card.querySelector('#staffMaterialDescription').value || '').trim();
    const file = card.querySelector('#staffMaterialFile').files?.[0];

    if (!Number.isFinite(subjectId) || subjectId <= 0 || !title || !file) {
      materialMsg.style.color = '#ffb8c7';
      materialMsg.textContent = 'Subject ID, title and file are required';
      return;
    }

    try {
      const formData = new FormData();
      formData.append('subjectId', String(subjectId));
      formData.append('title', title);
      formData.append('description', description);
      formData.append('file', file);

      const res = await fetch('/api/staff/materials', {
        method: 'POST',
        headers: getStaffAuthHeaders(),
        body: formData,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);

      materialMsg.style.color = '#9de9ff';
      materialMsg.textContent = `Material uploaded (#${payload.material?.id || '-'})`;
      card.querySelector('#staffMaterialFile').value = '';
      showToast('Material uploaded', 'success');
      await refreshMaterials();
    } catch (err) {
      materialMsg.style.color = '#ffb8c7';
      materialMsg.textContent = err.message || 'Failed to upload material';
    }
  });

  card.querySelector('#staffReceiptForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = String(card.querySelector('#staffReceiptMessageId').value || '').trim();
    const list = card.querySelector('#staffReceiptList');
    if (!id) {
      list.innerHTML = '<span style="color:#ffb8c7;">Enter an announcement ID.</span>';
      return;
    }
    list.innerHTML = 'Loading...';
    try {
      const payload = await staffApiJson(`/api/staff/messages/broadcast/${encodeURIComponent(id)}/read-receipts`);
      const rows = payload.receipts || [];
      if (!rows.length) {
        list.innerHTML = 'No reads yet.';
        return;
      }
      list.innerHTML = rows.map((r) => `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.08);">${esc(r.reg_no)} · ${new Date(r.read_at).toLocaleString()}</div>`).join('');
    } catch (err) {
      list.innerHTML = `<span style="color:#ffb8c7;">${esc(err.message || 'Failed')}</span>`;
    }
  });

  card.addEventListener('click', async (e) => {
    const replyBtn = e.target.closest('[data-reply-thread]');
    const closeBtn = e.target.closest('[data-close-thread]');
    const target = replyBtn || closeBtn;
    if (!target) return;
    const threadId = String(target.getAttribute(replyBtn ? 'data-reply-thread' : 'data-close-thread') || '');
    const message = prompt(`Reply to thread #${threadId}`);
    if (!message || !message.trim()) return;
    try {
      await staffApiJson(`/api/staff/qa/threads/${encodeURIComponent(threadId)}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim(), closeThread: Boolean(closeBtn) }),
      });
      showToast(closeBtn ? 'Reply sent and thread closed' : 'Reply sent', 'success');
      await refreshQaThreads();
    } catch (err) {
      showToast(err.message || 'Reply failed', 'error');
    }
  });

  card.querySelector('#staffCommsRefreshBtn').addEventListener('click', async () => {
    await Promise.all([refreshAnnouncements(), refreshQaThreads(), refreshMaterials()]);
    showToast('Communication panel refreshed', 'info');
  });

  refreshAnnouncements();
  refreshQaThreads();
  refreshMaterials();
}

// ── Auto-refresh (poll + cross-tab storage events) ────────────
let _lastDataSignature = '';
function getSubmissionsSignature() {
  return JSON.stringify(
    getSubmissions()
      .map((s) => `${s.id}|${s.status}|${s.archived ? 1 : 0}|${s.marks ?? ''}|${s.submittedAt}|${s.gradedAt || ''}`)
      .sort()
  );
}

function initAutoRefresh() {
  // Poll every 500ms (AGGRESSIVE) for instant real-time updates
  setInterval(async () => {
    try {
      await refreshSubmissions();
      const signature = getSubmissionsSignature();
      if (signature !== _lastDataSignature) {
        console.log('[AUTO-REFRESH] DATA CHANGED - Re-rendering dashboard');
        _lastDataSignature = signature;
        renderAll();
      }
    } catch (err) {
      console.error('[AUTO-REFRESH] Error:', err.message);
    }
  }, 500);
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

      _lastDataSignature = '';

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
    } catch (err) {
      console.error('Clear data error:', err);
      // Fallback reload if JS crashes somehow
      window.location.reload();
    }
  });
}

// ── Staff UI ──────────────────────────────────────────────────
function setStaffUI() {
  const initials = staff.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  document.getElementById('staffAvatar').textContent = initials;
  document.getElementById('topbarProfile').textContent = initials;
  document.getElementById('staffName').textContent = staff.name;
  document.getElementById('staffRole').textContent = staff.role;
}

function setDate() {
  const el = document.getElementById('dashDate');
  if (el) el.textContent = 'Today, ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
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

  const trackerFilter = document.getElementById('trackerClassFilter');
  if (trackerFilter) {
    trackerFilter.addEventListener('change', () => {
      trackerClassFilter = trackerFilter.value;
      renderStudentTracker();
    });
  }

  const recordFilter = document.getElementById('recordClassFilter');
  if (recordFilter) {
    recordFilter.addEventListener('change', () => {
      recordClassFilter = recordFilter.value;
      renderRecords();
    });
  }
}

function getSectionFromRegNo(regNo) {
  const prefix = String(regNo || '').slice(6, 9).toUpperCase();
  if (A7_PREFIXES.has(prefix)) return 'A7';
  if (A3_PREFIXES.has(prefix)) return 'A3';
  return 'other';
}

function matchesSectionFilter(regNo, sectionFilter) {
  if (sectionFilter === 'all') return true;
  return getSectionFromRegNo(regNo) === sectionFilter;
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('tab' + cap(tab)).classList.add('active');
  document.getElementById('nav' + cap(tab)).classList.add('active');
  document.getElementById('topbarTitle').textContent = { dashboard: 'Dashboard', tracker: 'Student Tracker', records: 'Student Records' }[tab];
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
  const avg = graded.length ? Math.round(graded.reduce((a, s) => a + (s.marks / (s.totalMarks || 100)) * 100, 0) / graded.length) : null;

  animNum('ds-total', all.length);
  animNum('ds-pending', pending.length);
  animNum('ds-graded', graded.length);
  document.getElementById('ds-avg').textContent = avg !== null ? avg + '%' : '–';

  const recent = [...all].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)).slice(0, 5);
  const el = document.getElementById('recentSubmissions');
  if (!el) return;
  el.innerHTML = '';
  if (!recent.length) { el.innerHTML = emptyHTML('No submissions yet'); return; }
  recent.forEach(s => el.appendChild(buildCard(s)));
}

// ── Student Tracker (all 63, ordered by reg no) ───────────────
function renderStudentTracker() {
  const el = document.getElementById('studentTrackerList');
  if (!el) return;
  const submissions = getSubmissions().filter(s => !s.archived);
  // Map regNo -> all submissions (latest first) so tracker can represent multiple tests.
  const historyByRegNo = {};
  submissions.forEach(s => {
    historyByRegNo[s.rollNumber] = historyByRegNo[s.rollNumber] || [];
    historyByRegNo[s.rollNumber].push(s);
  });
  Object.keys(historyByRegNo).forEach((regNo) => {
    historyByRegNo[regNo].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  });

  const regNos = Object.keys(STUDENTS_DB)
    .filter(regNo => matchesSectionFilter(regNo, trackerClassFilter))
    .sort();
  const submitted = regNos.filter(r => (historyByRegNo[r] || []).length > 0).length;
  const notYet = regNos.length - submitted;

  // Update tracker summary counts
  const trackerTotal = document.getElementById('trackerTotal');
  const trackerDone = document.getElementById('trackerDone');
  const trackerLeft = document.getElementById('trackerLeft');
  if (trackerTotal) trackerTotal.textContent = regNos.length;
  if (trackerDone) trackerDone.textContent = submitted;
  if (trackerLeft) trackerLeft.textContent = notYet;

  el.innerHTML = '';
  regNos.forEach((regNo, idx) => {
    const name = STUDENTS_DB[regNo];
    const tests = historyByRegNo[regNo] || [];
    const sub = tests[0] || null;
    const row = document.createElement('div');
    row.className = 'tracker-row' + (sub ? '' : ' tracker-not-submitted');
    const statusBadge = sub
      ? ({
        graded: '<span class="t-badge t-graded">✅ Graded</span>',
        review: '<span class="t-badge t-review">🔍 Review</span>',
        pending: '<span class="t-badge t-pending">⏳ Pending</span>'
      }[sub.status] || '<span class="t-badge t-pending">⏳ Pending</span>')
      : '<span class="t-badge t-none">❌ Not Submitted</span>';
    const marksCell = sub && sub.status === 'graded' && sub.marks !== null
      ? `<span class="t-marks">${sub.marks}/${sub.totalMarks || 100}</span>`
      : '<span class="t-marks-none">–</span>';
    const gradeActions = sub
      ? `<div class="t-action-wrap">
          ${tests.map((t, i) => `<button class="t-grade-mini-btn" onclick="event.stopPropagation(); sessionStorage.setItem('currentGradeId', '${t.id}'); window.location.href='grade.html';" title="${esc(t.testTitle || `Test ${i + 1}`)}">✏️ Q${i + 1}</button>`).join('')}
        </div>`
      : '<span class="t-no-sub">—</span>';
    const testInfo = sub
      ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;">Tests: ${tests.length}</div>`
      : '';
    row.innerHTML = `
      <div class="t-num">${idx + 1}</div>
      <div class="t-reg">${esc(regNo)}</div>
      <div class="t-name">${esc(name)}${testInfo}</div>
      <div class="t-status">${statusBadge}</div>
      <div class="t-marks-col">${marksCell}</div>
      <div class="t-action">${gradeActions}</div>
    `;
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

  const regNos = Object.keys(STUDENTS_DB)
    .filter(regNo => matchesSectionFilter(regNo, recordClassFilter))
    .sort();
  el.innerHTML = '';

  let count = 0;
  regNos.forEach(regNo => {
    const name = STUDENTS_DB[regNo];
    if (q && !name.toLowerCase().includes(q) && !regNo.toLowerCase().includes(q)) return;
    count++;

    const subs = (history[regNo] || []).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    const card = document.createElement('div');
    card.className = 'record-card';

    let testsHTML = '';
    if (subs.length === 0) {
      testsHTML = '<div class="t-no-sub" style="padding:10px 14px;background:rgba(255,255,255,0.02);border-radius:6px;">No tests submitted yet.</div>';
    } else {
      testsHTML = subs.map((s, idx) => {
        const marksStr = s.status === 'graded' && s.marks !== null ? `<span class="t-marks">${s.marks}/${s.totalMarks || 100}</span>` : '<span class="t-marks-none">Un-graded</span>';
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
window.resetStudentPassword = function (regNo) {
  const newPw = prompt(`Enter new password for ${regNo} (${STUDENTS_DB[regNo]}):`, regNo);
  if (!newPw) return;
  setStudentPassword(regNo, newPw);
  markPasswordChanged(regNo);
  showToast(`✅ Password updated for ${regNo}`, 'success');
};

// ── Change Own Password (Staff) ───────────────────────────────
window.changeOwnPassword = function () {
  const pw = prompt('Enter your new secure password:');
  if (!pw) return;
  if (pw.length < 6) {
    showToast('❌ Password must be at least 6 characters', 'error');
    return;
  }
  (async () => {
    try {
      const res = await fetch('/api/auth/staff/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getStaffAuthHeaders(),
        },
        body: JSON.stringify({ newPassword: pw }),
      });
      if (!res.ok) throw new Error('Failed to update password');
      showToast('✅ Your password has been changed successfully!', 'success');
    } catch (_err) {
      showToast('⚠️ Failed to update password', 'error');
    }
  })();
};

// ── Delete Individual Test (Staff Only) ───────────────────────
window.deleteTestSubmission = function (e, id) {
  if (e) { e.preventDefault(); e.stopPropagation(); }
  if (!confirm('Are you sure you want to permanently delete this test submission?')) return;
  (async () => {
    try {
      await apiDeleteSubmission(id);
      await refreshSubmissions();
      _lastDataSignature = '';
      renderAll();
      showToast('🗑️ Test submission deleted', 'info');
    } catch (err) {
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

  const statusClass = { pending: 'status-pending', graded: 'status-graded', review: 'status-review' }[s.status] || 'status-pending';
  const statusLabel = { pending: '⏳ Pending', graded: '✅ Graded', review: '🔍 In Review' }[s.status] || 'Pending';
  const dateStr = timeAgo(new Date(s.submittedAt));

  const thumbHTML = s.images && s.images.length
    ? `<div class="sub-thumb-wrap">${s.images.slice(0, 2).map(src => `<img class="sub-thumb" src="${resolveImageUrl(src)}" alt="answer" />`).join('')}</div>`
    : `<div class="sub-thumb-wrap"><div class="sub-thumb-placeholder">📄</div></div>`;

  const marksHTML = s.status === 'graded' && s.marks !== null
    ? `<div class="sub-marks">${s.marks}/${s.totalMarks || 100}</div>`
    : `<div class="sub-marks-none">${s.fileCount} photo${s.fileCount !== 1 ? 's' : ''}</div>`;

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
  document.getElementById('lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
}
function openLightbox(src) { document.getElementById('lightboxImg').src = src; document.getElementById('lightbox').classList.add('show'); }
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

async function downloadExcelWithAuth(endpoint, filename) {
  const res = await fetch(endpoint, {
    headers: getStaffAuthHeaders(),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new Error(payload?.error || `Download failed (${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── Download Reports ─────────────────────────────────────────
function initDownloadButtons() {
  const studentsListBtn = document.getElementById('downloadStudentsListBtn');
  if (studentsListBtn) {
    studentsListBtn.addEventListener('click', async () => {
      try {
        await downloadExcelWithAuth('/api/reports/students-list.xlsx', 'students-list.xlsx');
        showToast('📥 Downloading students list...', 'success');
      } catch (err) {
        console.error('Download students list error:', err);
        showToast(`⚠️ ${err.message || 'Download failed'}`, 'error');
      }
    });
  }

  const gradedBtn = document.getElementById('downloadGradedReportBtn');
  if (gradedBtn) {
    gradedBtn.addEventListener('click', async () => {
      try {
        await downloadExcelWithAuth('/api/reports/graded.xlsx', 'graded-report.xlsx');
        showToast('📊 Downloading graded report...', 'success');
      } catch (err) {
        console.error('Download graded report error:', err);
        showToast(`⚠️ ${err.message || 'Download failed'}`, 'error');
      }
    });
  }
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
  const p = (m / (t || 100)) * 100;
  if (p >= 90) return 'A+'; if (p >= 80) return 'A'; if (p >= 70) return 'B+'; if (p >= 60) return 'B'; if (p >= 50) return 'C'; return 'F';
}
function genId() { return 'CT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase(); }
function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function timeAgo(d) {
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function animNum(id, target) {
  const el = document.getElementById(id); if (!el) return;
  let c = 0; const step = Math.max(1, Math.ceil(target / 25));
  const t = setInterval(() => { c = Math.min(c + step, target); el.textContent = c; if (c >= target) clearInterval(t); }, 40);
}

let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
