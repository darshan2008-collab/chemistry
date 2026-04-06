function resolveImageUrl(src) {
  let candidate = src;
  if (candidate && typeof candidate === 'object') {
    candidate = candidate.url || candidate.src || candidate.path || '';
  }
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:)/i.test(raw)) return raw;

  let normalized = raw;
  if (raw.startsWith('/api/uploads/')) {
    normalized = `/api/files/${raw.slice('/api/uploads/'.length).replace(/^\/+/, '')}`;
  } else if (raw.startsWith('/uploads/')) {
    normalized = `/api/files/${raw.slice('/uploads/'.length).replace(/^\/+/, '')}`;
  } else if (raw.startsWith('uploads/')) {
    normalized = `/api/files/${raw.slice('uploads/'.length).replace(/^\/+/, '')}`;
  } else if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.includes('\\')) {
    const name = raw.split(/[/\\]/).pop();
    normalized = name ? `/api/files/${name}` : '';
  } else if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const idx = u.pathname.toLowerCase().lastIndexOf('/files/');
      const uploadIdx = u.pathname.toLowerCase().lastIndexOf('/uploads/');
      if (idx >= 0) {
        normalized = `/api/files/${u.pathname.slice(idx + '/files/'.length).replace(/^\/+/, '')}`;
      } else if (uploadIdx >= 0) {
        normalized = `/api/files/${u.pathname.slice(uploadIdx + '/uploads/'.length).replace(/^\/+/, '')}`;
      }
    } catch (_err) {
      normalized = raw;
    }
  }

  if (!normalized.startsWith('/api/files/')) return normalized;
  const token = getStudentSession()?.token || '';
  if (!token) return normalized;
  return `${normalized}${normalized.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

function resolveStudentPptOpenUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '#';

  let normalized = raw;
  if (raw.startsWith('/uploads/')) {
    normalized = `/api/files/${encodeURIComponent(raw.split('/').pop() || '')}`;
  } else if (raw.startsWith('uploads/')) {
    normalized = `/api/files/${encodeURIComponent(raw.split('/').pop() || '')}`;
  } else if (raw.startsWith('/api/uploads/')) {
    normalized = `/api/files/${encodeURIComponent(raw.split('/').pop() || '')}`;
  }

  if (!normalized.startsWith('/api/files/')) return normalized;
  const token = getStudentSession()?.token || '';
  if (!token) return normalized;
  return `${normalized}${normalized.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}
// ── Auth guard (runs BEFORE DOMContentLoaded) ─────────────────
// students-db.js must be loaded before this file
requireStudentAuth();

const DB_KEY = 'chemtest_submissions';
let editingSubmissionId = null;
let editingExistingImages = [];
let mySubmissionsById = new Map();
let authExpiryHandled = false;

function handleStudentAuthExpired() {
  if (authExpiryHandled) return;
  authExpiryHandled = true;
  clearStudentSession();
  alert('Session expired. Please login again.');
  window.location.href = 'login.html';
}

function getStudentAuthTokenOrThrow() {
  const session = getStudentSession();
  const token = session?.token || '';
  if (!token) throw new Error('Unauthorized');
  return token;
}

async function fetchSubmissions({ rollNumber, includeArchived = false } = {}) {
  const token = getStudentAuthTokenOrThrow();
  const params = new URLSearchParams();
  if (rollNumber) params.set('rollNumber', rollNumber);
  params.set('includeArchived', String(includeArchived));
  const res = await fetch(`/api/submissions?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('Failed to load submissions');
  const payload = await res.json();
  return payload.submissions || [];
}

async function createSubmission(submission) {
  const token = getStudentAuthTokenOrThrow();
  console.log('[API-SUBMIT] Sending submission to /api/submissions');
  const res = await fetch('/api/submissions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(submission),
  });
  console.log('[API-SUBMIT] Response status:', res.status);
  if (!res.ok) {
    const errText = await res.text();
    console.error('[API-SUBMIT] Error response:', errText);
    throw new Error('Failed to save submission: ' + errText);
  }
  const result = await res.json();
  console.log('[API-SUBMIT] ✓ Submission saved, response:', result);
  return result;
}

async function updateSubmission(id, updates) {
  const token = getStudentAuthTokenOrThrow();
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to update submission: ${errText}`);
  }
  return res.json();
}

async function deleteSubmission(id) {
  const token = getStudentAuthTokenOrThrow();
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Failed to delete submission: ${errText}`);
  }
  return res.json();
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initNavbar();
  initPasswordModal();
  prefillStudentFields();
  initParticles();
  await loadSubjectDropdown();       // ← populate subject selector
  // Stats
  await updateStats();
  initDropZone();
  initForm();

  // Sync sidebar when dropdown changes
  const subjectSelect = document.getElementById('subjectSelect');
  if (subjectSelect) {
    subjectSelect.addEventListener('change', () => {
      const val = subjectSelect.value;
      document.querySelectorAll('.sidebar-item').forEach(item => {
        item.classList.toggle('active', item.dataset.id === val);
      });
    });
  }

  await loadMyResults();
  initStudentCommsPanel();
  initStudentPersonalNotesPanel();
  initStudentPptPanel();
  initLightbox();
});

// ── Subject dropdown loader ────────────────────────────────────
// ── Subject loader (Sidebar & Dropdown) ───────────────────────
async function loadSubjectDropdown() {
  const select = document.getElementById('subjectSelect');
  const sidebarList = document.getElementById('subjectSidebarList');
  if (!select || !sidebarList) return;

  const getPreferredStaffDisplay = (code, name, currentStaffNames) => {
    const codeUpper = String(code || '').trim().toUpperCase();
    const nameUpper = String(name || '').trim().toUpperCase();
    if (codeUpper.includes('CHEM') || nameUpper.includes('CHEMISTRY')) return 'DR.SHREEKESAVAN';
    if (codeUpper.includes('UHV') || nameUpper.includes('UNIVERSAL HUMAN VALUES')) return 'MR.VIJAYAKUMAR';
    return String(currentStaffNames || '').trim();
  };

  try {
    const { subjects } = await studentApiJson('/api/student/subjects');
    const sourceSubjects = subjects || [];
    const visibleSubjects = (await Promise.all(sourceSubjects.map(async (subject) => {
      const subjectId = Number(subject.id || 0);
      if (!subjectId) return null;
      try {
        const staffResult = await studentApiJson(`/api/student/staff?subjectId=${subjectId}`);
        const staff = staffResult.staff || [];
        if (!staff.length) return null;
        const staffNames = staff
          .map(s => String(s.full_name || s.email || '').trim())
          .filter(Boolean)
          .join(', ');
        return { ...subject, staff_names: staffNames };
      } catch (_err) {
        return null;
      }
    }))).filter(Boolean);

    // Clear existing
    select.innerHTML = '<option value="" disabled selected>Select subject</option>';
    sidebarList.innerHTML = '';

    if (!visibleSubjects.length) {
      select.innerHTML = '<option value="" disabled selected>No subjects available</option>';
      sidebarList.innerHTML = '<div class="sidebar-loading">No subjects assigned yet</div>';
      return;
    }

    visibleSubjects.forEach(s => {
      const id = String(s.id);
      const code = String(s.code || '').trim();
      const name = String(s.name || '');
      const staffNames = getPreferredStaffDisplay(code, name, s.staff_names);
      const subjectLabel = code && name ? `${code} - ${name}` : (code || name || 'Subject');
      const staffLabel = staffNames ? `Staff: ${staffNames}` : 'Staff not assigned';

      // 1. Populate Dropdown
      const opt = document.createElement('option');
      opt.value = id;
      opt.dataset.name = name;
      opt.textContent = staffNames ? `${subjectLabel} · ${staffLabel}` : subjectLabel;
      select.appendChild(opt);

      // 2. Populate Sidebar
      const sideItem = document.createElement('div');
      sideItem.className = 'sidebar-item';
      sideItem.dataset.id = id;

      const iconDiv = document.createElement('div');
      iconDiv.className = 'item-icon';
      iconDiv.textContent = '📘';
      sideItem.appendChild(iconDiv);

      const infoDiv = document.createElement('div');
      infoDiv.className = 'item-info';

      const codeDiv = document.createElement('div');
      codeDiv.style.cssText = 'font-size:0.85rem; font-weight:800; color:var(--text);';
      codeDiv.textContent = subjectLabel;
      infoDiv.appendChild(codeDiv);

      const nameDiv = document.createElement('div');
      nameDiv.style.cssText = 'font-size:0.75rem; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px;';
      nameDiv.textContent = name;
      infoDiv.appendChild(nameDiv);

      const staffDiv = document.createElement('div');
      staffDiv.style.cssText = 'font-size:0.72rem; color:var(--accent-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px; margin-top:2px;';
      staffDiv.textContent = staffLabel;
      infoDiv.appendChild(staffDiv);

      sideItem.appendChild(infoDiv);
      sideItem.addEventListener('click', () => selectSubject(id));
      sidebarList.appendChild(sideItem);
    });

  } catch (err) {
    if (String(err?.message || '').toLowerCase().includes('unauthorized')) return;
    console.error('[SUBJECTS] Failed to load subjects:', err);
    select.innerHTML = '<option value="" disabled selected>Error loading subjects</option>';
    sidebarList.innerHTML = '<div class="sidebar-loading" style="color:#ffb8c7;">Failed to load subjects</div>';
  }
}

// Helper to sync selection
function selectSubject(id) {
  const select = document.getElementById('subjectSelect');
  if (select) {
    select.value = id;
    // Trigger any change listeners
    select.dispatchEvent(new Event('change'));
  }

  // Highlight sidebar
  document.querySelectorAll('.sidebar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === id);
  });

  // Visual feedback - highlight the form briefly
  const card = document.getElementById('uploadSection');
  if (card) {
    card.style.borderColor = 'var(--primary)';
    setTimeout(() => { card.style.borderColor = ''; }, 600);
  }

  // Auto-scroll on mobile if needed
  if (window.innerWidth < 850) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function studentApiJson(url, options = {}) {
  const token = getStudentAuthTokenOrThrow();
  const headers = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers, cache: 'no-store' });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401) {
    handleStudentAuthExpired();
    throw new Error('Unauthorized');
  }
  if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
  return payload;
}

function initStudentCommsPanel() {
  const host = document.getElementById('resultsSection');
  if (!host) return;

  const panel = document.createElement('section');
  panel.className = 'glass-card results-card';
  panel.style.marginTop = '18px';
  panel.innerHTML = `
    <div class="card-header">
      <div class="card-icon">📢</div>
      <div>
        <h2>Announcements & Q&A</h2>
        <p>Use the menu below to switch sections</p>
      </div>
      <button type="button" class="nav-pass-btn" id="studentCommsRefreshBtn" style="margin-left:auto;">Refresh</button>
    </div>
    <div class="student-menu-bar" role="tablist" aria-label="Student communication menu">
      <button type="button" class="student-menu-btn active" data-menu="emergency" aria-selected="true">Emergency</button>
      <button type="button" class="student-menu-btn" data-menu="announcements" aria-selected="false">Announcements</button>
      <button type="button" class="student-menu-btn" data-menu="qa" aria-selected="false">Q&A</button>
    </div>

    <div id="studentSectionEmergency" class="student-menu-section active" role="tabpanel">
      <h3 style="font-size:1rem;margin:0 0 8px;">Emergency Alerts</h3>
      <div id="studentEmergencyList" style="display:grid;gap:8px;"></div>
    </div>

    <div id="studentSectionAnnouncements" class="student-menu-section" role="tabpanel" hidden>
      <h3 style="font-size:1rem;margin:0 0 8px;">Latest Announcements</h3>
      <div id="studentAnnouncementsList" style="display:grid;gap:8px;max-height:320px;overflow:auto;"></div>
    </div>

    <div id="studentSectionQa" class="student-menu-section" role="tabpanel" hidden>
      <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
        <form id="studentQaCreateForm" style="display:grid;gap:8px;">
          <h3 style="font-size:1rem;margin:0;">Start Q&A Thread</h3>
          <select id="studentQaSubjectId" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" required>
            <option value="">Loading subjects...</option>
          </select>
          <select id="studentQaStaffEmail" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" required>
            <option value="">Select subject first</option>
          </select>
          <input id="studentQaTitle" placeholder="Thread title" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" required />
          <textarea id="studentQaMessage" rows="3" placeholder="Your question" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" required></textarea>
          <button type="submit" class="submit-btn" style="padding:10px 14px;">Create Thread</button>
          <p id="studentQaCreateMsg" style="margin:0;font-size:0.82rem;color:var(--text-muted);"></p>
        </form>
        <div>
          <h3 style="font-size:1rem;margin:0 0 8px;">My Q&A Threads</h3>
          <div id="studentQaThreadsList" style="display:grid;gap:8px;max-height:320px;overflow:auto;"></div>
          <h3 style="font-size:1rem;margin:14px 0 8px;">Subject Materials</h3>
          <div id="studentMaterialsList" style="display:grid;gap:8px;max-height:240px;overflow:auto;"></div>
        </div>
      </div>
    </div>
  `;
  host.parentNode.insertBefore(panel, host.nextSibling);

  const menuButtons = panel.querySelectorAll('.student-menu-btn');
  const menuSections = {
    emergency: panel.querySelector('#studentSectionEmergency'),
    announcements: panel.querySelector('#studentSectionAnnouncements'),
    qa: panel.querySelector('#studentSectionQa'),
  };
  const subjectSelect = panel.querySelector('#studentQaSubjectId');
  const staffSelect = panel.querySelector('#studentQaStaffEmail');
  const subjectLabelById = new Map();

  function switchCommsMenu(key) {
    menuButtons.forEach((btn) => {
      const active = btn.dataset.menu === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    Object.entries(menuSections).forEach(([sectionKey, sectionEl]) => {
      const active = sectionKey === key;
      sectionEl.classList.toggle('active', active);
      sectionEl.hidden = !active;
    });
  }

  menuButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchCommsMenu(btn.dataset.menu));
  });

  async function refreshEmergency() {
    const list = panel.querySelector('#studentEmergencyList');
    list.innerHTML = 'Loading...';
    try {
      const payload = await studentApiJson('/api/student/messages/emergency');
      const rows = payload.banners || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state"><p>No emergency alerts.</p></div>';
        return;
      }
      list.innerHTML = rows.slice(0, 5).map((b) =>
        `<div class="result-item" style="border-color:rgba(255,107,107,0.38);">
          <div class="result-header"><div class="result-title">${escapeHtml(b.title || 'Emergency')}</div></div>
          <div class="result-feedback" style="margin-top:6px;">${escapeHtml(b.message || '')}</div>
        </div>`
      ).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><p style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed')}</p></div>`;
    }
  }

  async function refreshAnnouncements() {
    const list = panel.querySelector('#studentAnnouncementsList');
    list.innerHTML = 'Loading...';
    try {
      const payload = await studentApiJson('/api/student/messages/announcements');
      const rows = payload.announcements || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state"><p>No announcements yet.</p></div>';
        return;
      }
      list.innerHTML = rows.slice(0, 40).map((a) =>
        `<div class="result-item">
          <div class="result-header">
            <div class="result-title">#${a.id} · ${escapeHtml(a.title || '')}</div>
            <span class="status-badge ${a.is_read ? 'status-graded' : 'status-pending'}">${a.is_read ? 'Read' : 'Unread'}</span>
          </div>
          <div class="result-feedback" style="margin-top:6px;">${escapeHtml(a.message || '')}</div>
          <div class="result-actions" style="margin-top:8px;">
            <button type="button" class="result-edit-btn" data-mark-read="${a.id}">Mark Read</button>
          </div>
        </div>`
      ).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><p style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed')}</p></div>`;
    }
  }

  async function refreshQaThreads() {
    const list = panel.querySelector('#studentQaThreadsList');
    list.innerHTML = 'Loading...';
    try {
      const payload = await studentApiJson('/api/student/qa/threads');
      const rows = payload.threads || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state"><p>No Q&A threads yet.</p></div>';
        return;
      }
      list.innerHTML = rows.slice(0, 30).map((t) =>
        `<div class="result-item">
          <div class="result-header">
            <div class="result-title">#${t.id} · ${escapeHtml(t.title || '')}</div>
            <span class="status-badge ${t.is_open ? 'status-review' : 'status-graded'}">${t.is_open ? 'Open' : 'Closed'}</span>
          </div>
          <div class="result-subtitle">Staff: ${escapeHtml(t.staff_email || '')} · Subject: ${escapeHtml(subjectLabelById.get(String(t.subject_id || '')) || String(t.subject_id || ''))}</div>
          <div class="result-actions" style="margin-top:8px;">
            <button type="button" class="result-edit-btn" data-view-thread="${t.id}">View Messages</button>
          </div>
        </div>`
      ).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><p style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed')}</p></div>`;
    }
  }

  async function refreshSubjectMaterials() {
    const list = panel.querySelector('#studentMaterialsList');
    if (!list) return;
    const subjectId = Number(String(subjectSelect.value || '').trim());
    if (!Number.isFinite(subjectId) || subjectId <= 0) {
      list.innerHTML = '<div class="empty-state"><p>Select subject first.</p></div>';
      return;
    }

    list.innerHTML = 'Loading...';
    try {
      const payload = await studentApiJson(`/api/student/materials?subjectId=${encodeURIComponent(subjectId)}`);
      const rows = payload.materials || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state"><p>No materials for this subject yet.</p></div>';
        return;
      }
      list.innerHTML = rows.map((m) => `
        <div class="result-item">
          <div class="result-header">
            <div class="result-title">${escapeHtml(m.title || m.file_name || 'Material')}</div>
            <span class="status-badge status-review">${escapeHtml(formatBytes(m.size_bytes || 0))}</span>
          </div>
          <div class="result-subtitle">${escapeHtml(m.file_name || '')}</div>
          <div class="result-actions" style="margin-top:8px;">
            <button type="button" class="result-edit-btn" data-open-material-id="${escapeHtml(String(m.id || ''))}">Open Material</button>
          </div>
        </div>
      `).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><p style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load materials')}</p></div>`;
    }
  }

  async function refreshStaffForSelectedSubject() {
    if (!subjectSelect || !staffSelect) return;
    const subjectId = Number(String(subjectSelect.value || '').trim());
    if (!Number.isFinite(subjectId) || subjectId <= 0) {
      staffSelect.innerHTML = '<option value="">Select subject first</option>';
      return;
    }

    staffSelect.innerHTML = '<option value="">Loading staff...</option>';
    try {
      const payload = await studentApiJson(`/api/student/staff?subjectId=${encodeURIComponent(subjectId)}`);
      const staff = payload.staff || [];
      if (!staff.length) {
        staffSelect.innerHTML = '<option value="">No mapped staff for this subject</option>';
        return;
      }
      staffSelect.innerHTML = staff.map((s) => {
        const email = String(s.email || '').trim();
        const label = `${email} - ${String(s.full_name || '').trim()}`;
        return `<option value="${escapeHtml(email)}">${escapeHtml(label)}</option>`;
      }).join('');
    } catch (err) {
      if (String(err?.message || '').toLowerCase().includes('unauthorized')) return;
      staffSelect.innerHTML = '<option value="">Failed to load staff</option>';
      showToast(err.message || 'Failed to load staff', 'error');
    }
  }

  async function refreshStudentSubjects() {
    if (!subjectSelect) return;
    subjectSelect.innerHTML = '<option value="">Loading subjects...</option>';
    subjectLabelById.clear();
    try {
      const payload = await studentApiJson('/api/student/subjects');
      const subjects = payload.subjects || [];
      if (!subjects.length) {
        subjectSelect.innerHTML = '<option value="">No assigned subjects</option>';
        return;
      }

      subjectSelect.innerHTML = subjects.map((s) => {
        const id = String(s.id || '');
        const code = String(s.code || '').trim();
        const name = String(s.name || '').trim();
        const staffNames = String(s.staff_names || '').trim();
        const label = code && name ? `${code} - ${name}` : (code || name || 'Subject');
        const displayLabel = staffNames ? `${label} · Staff: ${staffNames}` : label;
        subjectLabelById.set(id, label);
        return `<option value="${escapeHtml(id)}">${escapeHtml(displayLabel)}</option>`;
      }).join('');
      await refreshStaffForSelectedSubject();
    } catch (err) {
      subjectSelect.innerHTML = '<option value="">Failed to load subjects</option>';
      if (staffSelect) {
        staffSelect.innerHTML = '<option value="">Failed to load staff</option>';
      }
      showToast(err.message || 'Failed to load subjects', 'error');
    }
  }

  subjectSelect.addEventListener('change', async () => {
    await refreshStaffForSelectedSubject();
    await refreshSubjectMaterials();
  });

  panel.querySelector('#studentQaCreateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = panel.querySelector('#studentQaCreateMsg');
    const subjectId = Number(String(panel.querySelector('#studentQaSubjectId').value || '').trim());
    const staffEmail = String(panel.querySelector('#studentQaStaffEmail').value || '').trim();
    const title = String(panel.querySelector('#studentQaTitle').value || '').trim();
    const message = String(panel.querySelector('#studentQaMessage').value || '').trim();

    if (!Number.isFinite(subjectId) || subjectId <= 0 || !staffEmail || !title || !message) {
      msg.style.color = '#ffb8c7';
      msg.textContent = 'Select subject, and fill staff, title, and message.';
      return;
    }

    try {
      const payload = await studentApiJson('/api/student/qa/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId, staffEmail, title, message }),
      });
      msg.style.color = '#9de9ff';
      msg.textContent = `Thread created (#${payload.thread?.id || '-'})`;
      showToast('Q&A thread created', 'success');
      panel.querySelector('#studentQaMessage').value = '';
      panel.querySelector('#studentQaTitle').value = '';
      await refreshQaThreads();
    } catch (err) {
      msg.style.color = '#ffb8c7';
      msg.textContent = err.message || 'Failed to create thread';
    }
  });

  panel.addEventListener('click', async (e) => {
    const openMaterialBtn = e.target.closest('[data-open-material-id]');
    if (openMaterialBtn) {
      const id = String(openMaterialBtn.getAttribute('data-open-material-id') || '').trim();
      if (!id) return;

      const popup = window.open('', '_blank', 'noopener');
      if (popup) {
        popup.document.title = 'Opening material...';
        popup.document.body.textContent = 'Loading material...';
      }

      try {
        const token = getStudentAuthTokenOrThrow();
        const res = await fetch(`/api/materials/${encodeURIComponent(id)}/file`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `Request failed (${res.status})`);
        }

        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        if (popup) popup.location.replace(blobUrl);
        else window.open(blobUrl, '_blank', 'noopener');
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
      } catch (err) {
        if (popup) popup.close();
        showToast(err.message || 'Failed to open material', 'error');
      }
      return;
    }

    const markReadBtn = e.target.closest('[data-mark-read]');
    if (markReadBtn) {
      const id = markReadBtn.getAttribute('data-mark-read');
      try {
        await studentApiJson(`/api/student/messages/${encodeURIComponent(id)}/read`, { method: 'POST' });
        await refreshAnnouncements();
      } catch (err) {
        showToast(err.message || 'Failed to mark as read', 'error');
      }
      return;
    }

    const viewBtn = e.target.closest('[data-view-thread]');
    if (viewBtn) {
      const id = viewBtn.getAttribute('data-view-thread');
      try {
        const payload = await studentApiJson(`/api/student/qa/threads/${encodeURIComponent(id)}/messages`);
        const lines = (payload.messages || []).map((m) => `${m.sender_role}: ${m.message}`).join('\n\n');
        alert(lines || 'No messages in this thread yet.');
      } catch (err) {
        showToast(err.message || 'Failed to load thread messages', 'error');
      }
    }
  });

  panel.querySelector('#studentCommsRefreshBtn').addEventListener('click', async () => {
    await Promise.all([refreshEmergency(), refreshAnnouncements()]);
    await refreshStudentSubjects();
    await refreshSubjectMaterials();
    await refreshQaThreads();
    showToast('Announcements refreshed', 'success');
  });

  (async () => {
    await Promise.all([refreshEmergency(), refreshAnnouncements()]);
    await refreshStudentSubjects();
    await refreshSubjectMaterials();
    await refreshQaThreads();
  })();
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let unitIndex = 0;
  let current = value;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 100 ? 0 : current >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function initStudentPersonalNotesPanel() {
  const host = document.getElementById('resultsSection');
  if (!host || !host.parentNode) return;

  const panel = document.createElement('section');
  panel.className = 'glass-card results-card';
  panel.style.marginTop = '18px';
  panel.innerHTML = `
    <div class="card-header">
      <div class="card-icon">📁</div>
      <div>
        <h2>Personal Notes Storage</h2>
        <p>Upload your own notes and files (500MB total student storage)</p>
      </div>
      <button type="button" class="nav-pass-btn" id="studentNotesRefreshBtn" style="margin-left:auto;">Refresh</button>
    </div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
      <form id="studentNotesUploadForm" style="display:grid;gap:8px;">
        <label style="font-weight:700;">Upload Personal Notes</label>
        <input id="studentNotesFileInput" type="file" multiple accept=".pdf,.ppt,.pptx,.png,.jpg,.jpeg" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" />
        <button type="submit" class="submit-btn" style="padding:10px 14px;">Upload Notes</button>
        <p id="studentNotesQuotaText" style="margin:0;font-size:0.82rem;color:var(--text-muted);">Loading quota...</p>
        <p id="studentNotesMsg" style="margin:0;font-size:0.82rem;color:var(--text-muted);"></p>
      </form>
      <div>
        <h3 style="font-size:1rem;margin:0 0 8px;">My Uploaded Notes</h3>
        <div id="studentNotesList" style="display:grid;gap:8px;max-height:320px;overflow:auto;"></div>
      </div>
    </div>
  `;

  host.parentNode.insertBefore(panel, host.nextSibling);

  const notesList = panel.querySelector('#studentNotesList');
  const notesMsg = panel.querySelector('#studentNotesMsg');
  const quotaText = panel.querySelector('#studentNotesQuotaText');
  const fileInput = panel.querySelector('#studentNotesFileInput');

  function renderQuota(quota) {
    if (!quota) {
      quotaText.textContent = 'Quota unavailable';
      return;
    }
    const used = formatBytes(quota.usedBytes);
    const total = formatBytes(quota.totalBytes);
    const remaining = formatBytes(quota.remainingBytes);
    quotaText.textContent = `Used: ${used} / ${total} · Remaining: ${remaining}`;
  }

  async function refreshNotes() {
    notesList.innerHTML = 'Loading...';
    try {
      const payload = await studentApiJson('/api/student/notes');
      const notes = payload.notes || [];
      renderQuota(payload.quota || null);

      if (!notes.length) {
        notesList.innerHTML = '<div class="empty-state"><p>No personal notes uploaded yet.</p></div>';
        return;
      }

      notesList.innerHTML = notes.map((n) => {
        const created = n.created_at ? new Date(n.created_at).toLocaleString() : '-';
        const name = String(n.original_name || n.stored_name || 'file');
        const stored = String(n.stored_name || '');
        const href = String(n.file_url || '').trim();
        return `
          <div class="result-item">
            <div class="result-header">
              <div class="result-title">${escapeHtml(name)}</div>
              <span class="status-badge status-review">${escapeHtml(formatBytes(n.size_bytes || 0))}</span>
            </div>
            <div class="result-subtitle">Uploaded: ${escapeHtml(created)}</div>
            <div class="result-actions" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
              <a class="result-edit-btn" href="${escapeHtml(href || '#')}" target="_blank" rel="noopener">Open</a>
              <button type="button" class="result-delete-btn" data-delete-note="${escapeHtml(stored)}">Delete</button>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      notesList.innerHTML = `<div class="empty-state"><p style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load notes')}</p></div>`;
    }
  }

  panel.querySelector('#studentNotesUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const files = Array.from(fileInput.files || []);
    if (!files.length) {
      notesMsg.style.color = '#ffb8c7';
      notesMsg.textContent = 'Choose at least one file.';
      return;
    }

    try {
      const token = getStudentAuthTokenOrThrow();
      const formData = new FormData();
      files.forEach((f) => formData.append('files', f));

      const res = await fetch('/api/student/notes', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const payload = await res.json().catch(() => ({}));

      if (res.status === 401) {
        handleStudentAuthExpired();
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        throw new Error(payload?.error || `Upload failed (${res.status})`);
      }

      notesMsg.style.color = '#9de9ff';
      notesMsg.textContent = `Uploaded ${payload.files?.length || 0} file(s)`;
      showToast('Personal notes uploaded', 'success');
      fileInput.value = '';
      await refreshNotes();
    } catch (err) {
      notesMsg.style.color = '#ffb8c7';
      notesMsg.textContent = err.message || 'Failed to upload notes';
    }
  });

  panel.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('[data-delete-note]');
    if (!deleteBtn) return;
    const storedName = String(deleteBtn.getAttribute('data-delete-note') || '').trim();
    if (!storedName) return;
    if (!confirm('Delete this note file?')) return;

    try {
      await studentApiJson(`/api/student/notes/${encodeURIComponent(storedName)}`, { method: 'DELETE' });
      showToast('Note deleted', 'success');
      await refreshNotes();
    } catch (err) {
      showToast(err.message || 'Failed to delete note', 'error');
    }
  });

  panel.querySelector('#studentNotesRefreshBtn').addEventListener('click', async () => {
    await refreshNotes();
    showToast('Notes refreshed', 'success');
  });

  refreshNotes();
}

function initStudentPptPanel() {
  const host = document.getElementById('resultsSection');
  if (!host || !host.parentNode) return;

  const panel = document.createElement('section');
  panel.className = 'glass-card results-card';
  panel.style.marginTop = '18px';
  panel.innerHTML = `
    <div class="card-header">
      <div class="card-icon">📽️</div>
      <div>
        <h2>Subject PPT Upload</h2>
        <p>Upload PPT/PPTX for a selected subject (e.g. UHV, Chemistry)</p>
      </div>
      <button type="button" class="nav-pass-btn" id="studentPptRefreshBtn" style="margin-left:auto;">Refresh</button>
    </div>
    <div style="display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
      <form id="studentPptUploadForm" style="display:grid;gap:8px;">
        <select id="studentPptSubject" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" required>
          <option value="">Loading subjects...</option>
        </select>
        <input id="studentPptTitle" placeholder="PPT title (optional)" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" />
        <input id="studentPptFile" type="file" accept=".ppt,.pptx,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation" style="padding:10px;border-radius:10px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.03);color:inherit;" required />
        <button type="submit" class="submit-btn" style="padding:10px 14px;">Upload PPT</button>
        <p id="studentPptMsg" style="margin:0;font-size:0.82rem;color:var(--text-muted);"></p>
      </form>
      <div>
        <h3 style="font-size:1rem;margin:0 0 8px;">My Uploaded PPTs</h3>
        <div id="studentPptList" style="display:grid;gap:8px;max-height:320px;overflow:auto;"></div>
      </div>
    </div>
  `;

  host.parentNode.insertBefore(panel, host.nextSibling);

  const subjectSelect = panel.querySelector('#studentPptSubject');
  const fileInput = panel.querySelector('#studentPptFile');
  const titleInput = panel.querySelector('#studentPptTitle');
  const list = panel.querySelector('#studentPptList');
  const msg = panel.querySelector('#studentPptMsg');
  const allowedSubjectIds = new Set();

  async function loadSubjects() {
    subjectSelect.innerHTML = '<option value="">Loading subjects...</option>';
    allowedSubjectIds.clear();
    try {
      const payload = await studentApiJson('/api/student/subjects');
      const sourceSubjects = payload.subjects || [];
      const subjects = (await Promise.all(sourceSubjects.map(async (subject) => {
        const subjectId = Number(subject.id || 0);
        if (!subjectId) return null;
        try {
          const staffPayload = await studentApiJson(`/api/student/staff?subjectId=${encodeURIComponent(subjectId)}`);
          const staff = staffPayload.staff || [];
          if (!staff.length) return null;
          const staffNames = staff
            .map((s) => String(s.full_name || s.email || '').trim())
            .filter(Boolean)
            .join(', ');
          return { ...subject, staff_names: staffNames };
        } catch (_err) {
          return null;
        }
      }))).filter(Boolean);

      if (!subjects.length) {
        subjectSelect.innerHTML = '<option value="">No assigned subjects</option>';
        return;
      }
      const options = subjects
        .map((s) => {
          const subjectId = String(s.id || '').trim();
          if (subjectId) allowedSubjectIds.add(subjectId);
          const code = String(s.code || '').trim();
          const name = String(s.name || '').trim();
          const staffNames = String(s.staff_names || '').trim();
          const label = code && name ? `${code} - ${name}` : (code || name || 'Subject');
          const displayLabel = staffNames ? `${label} · Staff: ${staffNames}` : label;
          return `<option value="${escapeHtml(subjectId)}">${escapeHtml(displayLabel)}</option>`;
        })
        .join('');
      subjectSelect.innerHTML = `<option value="" selected>Select subject</option>${options}`;
    } catch (err) {
      subjectSelect.innerHTML = '<option value="">Failed to load subjects</option>';
      msg.style.color = '#ffb8c7';
      msg.textContent = err.message || 'Failed to load subjects';
    }
  }

  async function refreshPptList() {
    const subjectId = Number(String(subjectSelect.value || '').trim());
    if (subjectSelect.value && !allowedSubjectIds.has(String(subjectSelect.value))) {
      list.innerHTML = '<div class="empty-state"><p>Selected subject is not assigned.</p></div>';
      return;
    }
    if (!Number.isFinite(subjectId) || subjectId <= 0) {
      list.innerHTML = '<div class="empty-state"><p>Select a subject to view only that subject PPT uploads.</p></div>';
      return;
    }
    const qs = `?subjectId=${encodeURIComponent(subjectId)}`;
    list.innerHTML = 'Loading...';
    try {
      const payload = await studentApiJson(`/api/student/ppts${qs}`);
      const rows = payload.ppts || [];
      if (!rows.length) {
        list.innerHTML = '<div class="empty-state"><p>No PPT uploads yet.</p></div>';
        return;
      }
      list.innerHTML = rows.map((row) => {
        const openUrl = resolveStudentPptOpenUrl(row.file_url);
        return `
          <div class="result-item">
            <div class="result-header">
              <div class="result-title">${escapeHtml(row.original_name || 'PPT')}</div>
              <span class="status-badge status-review">${escapeHtml(formatBytes(row.size_bytes || 0))}</span>
            </div>
            <div class="result-subtitle">${escapeHtml(String(row.subject_name || ''))} · ${escapeHtml(new Date(row.created_at).toLocaleString())}</div>
            <div class="result-actions" style="margin-top:8px;">
              <a class="result-edit-btn" href="${escapeHtml(openUrl)}" target="_blank" rel="noopener">Open PPT</a>
            </div>
          </div>
        `;
      }).join('');
    } catch (err) {
      list.innerHTML = `<div class="empty-state"><p style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load PPT uploads')}</p></div>`;
    }
  }

  panel.querySelector('#studentPptUploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectId = Number(String(subjectSelect.value || '').trim());
    const file = fileInput.files?.[0];
    const title = String(titleInput.value || '').trim();

    if (subjectSelect.value && !allowedSubjectIds.has(String(subjectSelect.value))) {
      msg.style.color = '#ffb8c7';
      msg.textContent = 'Selected subject is not assigned for PPT upload.';
      return;
    }

    if (!Number.isFinite(subjectId) || subjectId <= 0 || !file) {
      msg.style.color = '#ffb8c7';
      msg.textContent = 'Select subject and choose a PPT file.';
      return;
    }

    const lower = String(file.name || '').toLowerCase();
    if (!(lower.endsWith('.ppt') || lower.endsWith('.pptx'))) {
      msg.style.color = '#ffb8c7';
      msg.textContent = 'Only .ppt or .pptx files are allowed.';
      return;
    }

    try {
      const token = getStudentAuthTokenOrThrow();
      const formData = new FormData();
      formData.append('subjectId', String(subjectId));
      if (title) formData.append('title', title);
      formData.append('file', file);

      const res = await fetch('/api/student/ppts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const payload = await res.json().catch(() => ({}));

      if (res.status === 401) {
        handleStudentAuthExpired();
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        throw new Error(payload?.error || `Upload failed (${res.status})`);
      }

      msg.style.color = '#9de9ff';
      const subjectLabel = subjectSelect.options[subjectSelect.selectedIndex]?.text || `Subject ${subjectId}`;
      msg.textContent = `Uploaded to ${subjectLabel}: ${payload?.ppt?.originalName || file.name}`;
      showToast('PPT uploaded successfully', 'success');
      fileInput.value = '';
      titleInput.value = '';
      await refreshPptList();
    } catch (err) {
      msg.style.color = '#ffb8c7';
      msg.textContent = err.message || 'Failed to upload PPT';
    }
  });

  subjectSelect.addEventListener('change', refreshPptList);

  panel.querySelector('#studentPptRefreshBtn').addEventListener('click', async () => {
    await loadSubjects();
    await refreshPptList();
    showToast('PPT list refreshed', 'info');
  });

  (async () => {
    await loadSubjects();
    await refreshPptList();
  })();
}

// ── Navbar ────────────────────────────────────────────────────
function initNavbar() {
  const session = getStudentSession();
  if (!session) return;
  const { name, regNo } = session;
  // Avatar initials
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2);
  document.getElementById('navAvatar').textContent = initials;
  document.getElementById('navStudentName').textContent = name;
  document.getElementById('navRegNo').textContent = regNo;
  const pwBtn = document.getElementById('navChangePasswordBtn');
  if (pwBtn) {
    pwBtn.addEventListener('click', openPasswordModal);
  }
  // Logout
  document.getElementById('navLogoutBtn').addEventListener('click', () => {
    clearStudentSession();
    window.location.href = 'login.html';
  });
}

function initPasswordModal() {
  const modal = document.getElementById('passwordModal');
  const cancelBtn = document.getElementById('cancelPasswordBtn');
  const saveBtn = document.getElementById('savePasswordBtn');
  if (!modal || !cancelBtn || !saveBtn) return;

  cancelBtn.addEventListener('click', closePasswordModal);
  saveBtn.addEventListener('click', handlePasswordSave);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePasswordModal();
  });
}

function openPasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (!modal) return;
  modal.classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closePasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (!modal) return;
  modal.classList.remove('show');
  document.body.style.overflow = '';
  const currentEl = document.getElementById('currentPasswordInput');
  const newEl = document.getElementById('newPasswordInput');
  const confirmEl = document.getElementById('confirmPasswordInput');
  if (currentEl) currentEl.value = '';
  if (newEl) newEl.value = '';
  if (confirmEl) confirmEl.value = '';
}

async function handlePasswordSave() {
  const session = getStudentSession();
  if (!session) {
    showToast('❌ Session expired. Please login again.', 'error');
    window.location.href = 'login.html';
    return;
  }

  const currentPassword = String(document.getElementById('currentPasswordInput')?.value || '');
  const newPassword = String(document.getElementById('newPasswordInput')?.value || '');
  const confirmPassword = String(document.getElementById('confirmPasswordInput')?.value || '');

  if (!currentPassword) {
    showToast('⚠️ Enter current password', 'error');
    return;
  }
  if (!newPassword || newPassword.length < 6) {
    showToast('⚠️ New password must be at least 6 characters', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('⚠️ New password and confirm password do not match', 'error');
    return;
  }
  if (newPassword === session.regNo) {
    showToast('⚠️ New password cannot be register number', 'error');
    return;
  }

  const saveBtn = document.getElementById('savePasswordBtn');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Updating...';
  }

  try {
    const verifyRes = await fetch('/api/auth/student/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ regNo: session.regNo, password: currentPassword }),
    });
    if (!verifyRes.ok) {
      showToast('❌ Current password is incorrect', 'error');
      return;
    }

    const token = getStudentAuthTokenOrThrow();
    const updateRes = await fetch('/api/auth/student/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ newPassword }),
    });

    if (!updateRes.ok) {
      const payload = await updateRes.json().catch(() => ({}));
      throw new Error(payload?.error || 'Failed to update password');
    }

    closePasswordModal();
    showToast('✅ Password updated in database successfully', 'success');
  } catch (err) {
    showToast(`❌ ${err.message || 'Password update failed'}`, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Update Password';
    }
  }
}

// ── Pre-fill form from session ────────────────────────────────
function prefillStudentFields() {
  const session = getStudentSession();
  if (!session) return;
  document.getElementById('studentName').value = session.name;
  document.getElementById('rollNumber').value = session.regNo;

  // Always refresh profile from DB so superadmin updates appear immediately.
  studentApiJson('/api/student/profile')
    .then((payload) => {
      const student = payload?.student || {};
      const latestRegNo = String(student.reg_no || session.regNo || '').trim().toUpperCase();
      const latestName = String(student.full_name || session.name || '').trim();

      const nameEl = document.getElementById('studentName');
      const rollEl = document.getElementById('rollNumber');
      if (nameEl) nameEl.value = latestName;
      if (rollEl) rollEl.value = latestRegNo;

      setStudentSession(latestRegNo, session.token, latestName);
    })
    .catch(() => {
      // Keep existing session values if profile refresh fails.
    });
}

// ── Stats ─────────────────────────────────────────────────────
async function updateStats() {
  const session = getStudentSession();
  if (!session) return;
  const all = await fetchSubmissions({ rollNumber: session.regNo, includeArchived: false });
  const mine = session ? all.filter(s => s.rollNumber === session.regNo) : all;
  const graded = mine.filter(s => s.status === 'graded').length;
  const pending = mine.filter(s => s.status !== 'graded').length;
  animateNumber('totalSubmissions', mine.length);
  animateNumber('gradedCount', graded);
  animateNumber('pendingCount', pending);
}

function animateNumber(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  let c = 0;
  const step = Math.max(1, Math.ceil(target / 30));
  const t = setInterval(() => { c = Math.min(c + step, target); el.textContent = c; if (c >= target) clearInterval(t); }, 40);
}

// ── Particles ─────────────────────────────────────────────────
function initParticles() {
  const canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let particles = [];
  let W, H;
  function resize() { W = canvas.width = window.innerWidth; H = canvas.height = window.innerHeight; }
  resize(); window.addEventListener('resize', resize);
  for (let i = 0; i < 60; i++) particles.push({ x: Math.random() * 2000, y: Math.random() * 2000, r: Math.random() * 1.5 + 0.3, vx: (Math.random() - .5) * .3, vy: (Math.random() - .5) * .3, alpha: Math.random() * .6 + .1 });
  (function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0; if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(108,99,255,${p.alpha})`; ctx.fill();
    }); requestAnimationFrame(draw);
  })();
}

// ── Drop Zone ─────────────────────────────────────────────────
let selectedFiles = [];
let uploadStartTimeMs = 0;

function setUploadProgress(percent, speedLabel) {
  const bar = document.getElementById('uploadProgress');
  const fill = document.getElementById('uploadProgressFill');
  const percentEl = document.getElementById('uploadPercentLabel');
  const speedEl = document.getElementById('uploadSpeedLabel');
  if (!bar || !fill || !percentEl || !speedEl) return;

  const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
  fill.style.width = `${safePercent}%`;
  percentEl.textContent = `${safePercent}%`;
  speedEl.textContent = speedLabel || '0 KB/s';
}

function showUploadProgress() {
  const bar = document.getElementById('uploadProgress');
  if (!bar) return;
  bar.classList.add('active');
  bar.setAttribute('aria-hidden', 'false');
  uploadStartTimeMs = Date.now();
  setUploadProgress(0, '0 KB/s');
}

function hideUploadProgress() {
  const bar = document.getElementById('uploadProgress');
  if (!bar) return;
  bar.classList.remove('active');
  bar.setAttribute('aria-hidden', 'true');
}

function formatUploadSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0 KB/s';
  const kbps = bytesPerSecond / 1024;
  if (kbps < 1024) return `${kbps.toFixed(kbps >= 100 ? 0 : 1)} KB/s`;
  const mbps = kbps / 1024;
  return `${mbps.toFixed(mbps >= 10 ? 1 : 2)} MB/s`;
}

function initDropZone() {
  const zone = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');
  if (!input) {
    console.error('[INIT] fileInput not found!');
    return;
  }
  if (!zone) {
    console.error('[INIT] dropZone not found!');
    return;
  }
  console.log('[INIT] Setting up drop zone and file input');
  zone.addEventListener('click', (e) => {
    if (e.target === input) return;
    console.log('[USER] Clicked drop zone, triggering file picker');
    input.click();
  });
  input.addEventListener('change', () => {
    console.log('[USER] File picker closed with', input.files.length, 'files selected');
    if (input.files.length > 0) {
      handleFiles([...input.files]);
      input.value = '';
    }
  });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); console.log('[USER] Dropped', e.dataTransfer.files.length, 'files'); handleFiles([...e.dataTransfer.files]); });
}

function handleFiles(newFiles) {
  console.log('[FILE-SELECT] User selected', newFiles.length, 'files');
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
  let added = 0;
  for (const f of newFiles) {
    if (!allowed.some(t => f.type === t || f.name.toLowerCase().endsWith('.heic') || f.name.toLowerCase().endsWith('.pdf'))) {
      showToast('⚠️ Only images and PDFs allowed', 'error'); continue;
    }
    const sizeInMB = (f.size / 1024 / 1024).toFixed(2);
    console.log(`[FILE-SELECT] Adding file: ${f.name} (${sizeInMB}MB, type: ${f.type})`);
    if (selectedFiles.length + editingExistingImages.length >= 20) {
      showToast('⚠️ Maximum 20 files allowed', 'error');
      break;
    }
    selectedFiles.push(f);
    added++;
  }
  console.log('[FILE-SELECT] Total selected files now:', selectedFiles.length);
  renderPreviews();
}

function renderPreviews() {
  const grid = document.getElementById('previewGrid');
  grid.innerHTML = '';

  editingExistingImages.forEach((src, i) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    if (/\.pdf($|\?)/i.test(src)) {
      const icon = document.createElement('div');
      icon.textContent = '📄';
      icon.style.cssText = 'font-size:2.2rem;display:flex;align-items:center;justify-content:center;height:100%;';
      item.appendChild(icon);
    } else {
      const img = document.createElement('img');
      img.alt = `existing-${i + 1}`;
      img.src = src;
      item.appendChild(img);
      item.addEventListener('click', ev => { if (!ev.target.classList.contains('remove-btn')) openLightbox(src); });
    }
    const badge = document.createElement('div');
    badge.className = 'file-badge';
    badge.textContent = 'existing';
    item.appendChild(badge);
    const rm = document.createElement('button');
    rm.className = 'remove-btn';
    rm.innerHTML = '✕';
    rm.addEventListener('click', e => {
      e.stopPropagation();
      editingExistingImages.splice(i, 1);
      renderPreviews();
    });
    item.appendChild(rm);
    grid.appendChild(item);
  });
  selectedFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'preview-item';
    if (f.type.startsWith('image/')) {
      const img = document.createElement('img'); img.alt = f.name;
      const reader = new FileReader(); reader.onload = e => img.src = e.target.result; reader.readAsDataURL(f);
      item.appendChild(img);
      item.addEventListener('click', ev => { if (!ev.target.classList.contains('remove-btn')) openLightboxFromFile(f); });
    } else {
      const icon = document.createElement('div'); icon.textContent = '📄'; icon.style.cssText = 'font-size:2.2rem;display:flex;align-items:center;justify-content:center;height:100%;'; item.appendChild(icon);
    }
    const badge = document.createElement('div'); badge.className = 'file-badge'; badge.textContent = f.name.length > 14 ? f.name.slice(0, 12) + '…' : f.name; item.appendChild(badge);
    const rm = document.createElement('button'); rm.className = 'remove-btn'; rm.innerHTML = '✕';
    rm.addEventListener('click', e => { e.stopPropagation(); selectedFiles.splice(i, 1); renderPreviews(); }); item.appendChild(rm);
    grid.appendChild(item);
  });
}

// ── Form Submit ───────────────────────────────────────────────
function initForm() {
  document.getElementById('uploadForm').addEventListener('submit', handleSubmit);
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', cancelEditMode);
}

function setFormEditMode(isEdit) {
  const submitBtn = document.getElementById('submitBtn');
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (submitBtn) submitBtn.textContent = isEdit ? 'Update Test' : 'Submit Test';
  if (cancelBtn) cancelBtn.hidden = !isEdit;
}

function cancelEditMode() {
  editingSubmissionId = null;
  editingExistingImages = [];
  selectedFiles = [];
  document.getElementById('uploadForm').reset();
  prefillStudentFields();
  renderPreviews();
  setFormEditMode(false);
}

function startEditSubmission(submissionId) {
  const s = mySubmissionsById.get(submissionId);
  if (!s) {
    showToast('Submission not found', 'error');
    return;
  }
  if (s.status !== 'pending') {
    showToast('Only pending submissions can be edited', 'error');
    return;
  }
  editingSubmissionId = s.id;
  editingExistingImages = Array.isArray(s.images) ? [...s.images] : [];
  selectedFiles = [];
  document.getElementById('testTitle').value = s.testTitle || '';
  const notesEl = document.getElementById('notes');
  if (notesEl) notesEl.value = s.notes || '';
  renderPreviews();
  setFormEditMode(true);
  document.getElementById('uploadSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteMySubmission(submissionId) {
  const s = mySubmissionsById.get(submissionId);
  if (!s) {
    showToast('Submission not found', 'error');
    return;
  }
  if (s.status !== 'pending') {
    showToast('Only pending submissions can be deleted', 'error');
    return;
  }

  const ok = window.confirm('Delete this uploaded test? This action cannot be undone.');
  if (!ok) return;

  try {
    await deleteSubmission(submissionId);
    if (editingSubmissionId === submissionId) {
      cancelEditMode();
    }
    showToast('Submission deleted successfully', 'success');
    await updateStats();
    await loadMyResults();
  } catch (err) {
    showToast(err.message || 'Failed to delete submission', 'error');
  }
}

async function handleSubmit(e) {
  e.preventDefault();


  // Validate subject
  const subjectEl = document.getElementById('subjectSelect');
  const subjectErr = document.getElementById('subjectError');
  if (!subjectEl || !subjectEl.value) {
    if (subjectErr) subjectErr.textContent = 'Please select a subject';
    subjectEl && subjectEl.focus();
    return;
  }
  if (subjectErr) subjectErr.textContent = '';

  // Validate title
  const titleEl = document.getElementById('testTitle');
  const titleErr = document.getElementById('titleError');
  if (!titleEl || !titleEl.value.trim()) {
    if (titleErr) titleErr.textContent = 'Please enter the test title';
    titleEl && titleEl.focus();
    return;
  }
  if (titleErr) titleErr.textContent = '';

  if (selectedFiles.length + editingExistingImages.length === 0) {
    console.warn('[VALIDATION] No files selected');
    showToast('📸 Please keep at least one file', 'error');
    const fe = document.getElementById('fileError');
    if (fe) fe.textContent = 'Please keep at least one file';
    return;
  }
  if (selectedFiles.length + editingExistingImages.length > 20) {
    showToast('⚠️ Maximum 20 photos allowed', 'error');
    return;
  }
  const totalSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
  const totalSizeMB = (totalSize / 1024 / 1024).toFixed(1);
  if (totalSize > 150 * 1024 * 1024) {
    showToast(`⚠️ Total size ${totalSizeMB}MB exceeds 150MB limit`, 'error');
    return;
  }
  console.log('[VALIDATION] ✓ All checks passed. Files:', selectedFiles.length, 'Total:', totalSizeMB + 'MB');
  const fe = document.getElementById('fileError');
  if (fe) fe.textContent = '';

  // Get session
  const session = getStudentSession();
  if (!session) {
    showToast('❌ Session expired. Please login again.', 'error');
    setTimeout(() => window.location.href = 'login.html', 1200);
    return;
  }

  // Disable button to prevent double-submit
  const btn = document.getElementById('submitBtn');
  if (btn) btn.disabled = true;
  showUploadProgress();

  try {
    let imageData = [...editingExistingImages];
    if (selectedFiles.length > 0) {
      console.log('[SUBMIT] Starting file upload with', selectedFiles.length, 'new files');
      const uploaded = await uploadFiles(selectedFiles.slice(0, 20), (percent, speed) => setUploadProgress(percent, speed));
      imageData = imageData.concat(uploaded);
      console.log('[SUBMIT] Upload complete! New URLs:', uploaded);
    }
    console.log('[SUBMIT] Final image URLs:', imageData);
    setUploadProgress(100, 'Done');

    if (!imageData || imageData.length === 0) {
      throw new Error('Upload succeeded but no image URLs returned');
    }

    const selectedOpt = subjectEl.options[subjectEl.selectedIndex];
    const subjectCode = subjectEl.value || '';
    const subjectId = /^\d+$/.test(String(subjectEl.value)) ? Number(subjectEl.value) : null;
    const subjectName = selectedOpt?.dataset?.name || selectedOpt?.textContent || subjectCode;

    const submission = {
      id: editingSubmissionId || generateId(),
      studentName: session.name,
      rollNumber: session.regNo,
      subjectId: subjectId,
      subject: subjectCode,
      classroom: '',
      testTitle: document.getElementById('testTitle').value.trim(),
      notes: (document.getElementById('notes') || {}).value || '',
      images: imageData,
      fileCount: imageData.length,
      status: 'pending', marks: null, totalMarks: null, feedback: '',
      submittedAt: new Date().toISOString(), gradedAt: null,
    };
    console.log('[SUBMIT] Subject selected:', subjectName, '| subjectId:', subjectId);

    if (editingSubmissionId) {
      await updateSubmission(editingSubmissionId, {
        testTitle: submission.testTitle,
        notes: submission.notes,
        images: submission.images,
        fileCount: submission.fileCount,
      });
      showToast('Submission updated successfully', 'success');
    } else {
      console.log('[SUBMIT] Creating submission with', submission.images.length, 'images:', submission);
      await createSubmission(submission);
      console.log('[SUBMIT] ✓ Submission saved successfully');
    }

    // Success
    const idDisplay = document.getElementById('submissionIdDisplay');
    if (idDisplay) idDisplay.textContent = submission.id;
    if (!editingSubmissionId) {
      document.getElementById('successModal').classList.add('show');
    }
    document.getElementById('uploadForm').reset();
    prefillStudentFields();
    selectedFiles = [];
    editingExistingImages = [];
    editingSubmissionId = null;
    setFormEditMode(false);
    document.getElementById('previewGrid').innerHTML = '';
    await updateStats();
    await loadMyResults();

  } catch (err) {
    hideUploadProgress();
    const errorMsg = err.message || 'Unknown error';
    console.error('[SUBMIT-ERROR] Full error:', err);

    let displayMsg = `❌ Upload failed: ${errorMsg}`;
    if (errorMsg.includes('assigned to this subject')) {
      displayMsg = '⚠️ You are not assigned to this subject. Please contact your teacher.';
    } else if (errorMsg.includes('403')) {
      displayMsg = '⚠️ Access Forbidden. Check subject assignment.';
    }

    showToast(displayMsg.substring(0, 100), 'error');
  } finally {
    setTimeout(hideUploadProgress, 800);
    if (btn) btn.disabled = false;
  }
}


// ── Auto-load my results ──────────────────────────────────────
async function loadMyResults() {
  const session = getStudentSession();
  if (!session) return;
  const submissions = await fetchSubmissions({ rollNumber: session.regNo, includeArchived: false });
  const mine = submissions.filter(s => s.rollNumber === session.regNo);
  mySubmissionsById = new Map(mine.map((s) => [s.id, s]));
  const list = document.getElementById('resultsList');
  if (!mine.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">📭</div><p>You haven't submitted any tests yet</p></div>`;
    return;
  }
  list.innerHTML = '';
  mine.forEach(s => list.appendChild(buildResultCard(s)));
}

function buildResultCard(s) {
  const div = document.createElement('div'); div.className = 'result-item';
  const statusClass = { pending: 'status-pending', graded: 'status-graded', review: 'status-review' }[s.status] || 'status-pending';
  const statusLabel = { pending: '⏳ Pending', graded: '✅ Graded', review: '🔍 Under Review' }[s.status] || '⏳ Pending';
  const dateStr = new Date(s.submittedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  let marksHTML = '';
  if (s.status === 'graded' && s.marks !== null) {
    const pct = Math.round((s.marks / (s.totalMarks || 100)) * 100);
    marksHTML = `<div class="result-marks"><span class="marks-display">${s.marks}/${s.totalMarks || 100}</span><div><div class="marks-label">Marks · Grade: ${getGrade(s.marks, s.totalMarks)}</div><div style="font-size:0.75rem;color:var(--text-muted);">${pct}%</div></div></div>`;
  }
  let feedbackHTML = s.feedback ? `<div class="result-feedback"><strong>📝 Teacher Feedback:</strong> ${escapeHtml(s.feedback)}</div>` : '';
  let thumbsHTML = (s.images && s.images.length) ? `<div class="result-images">${s.images.map((src, i) => { const safe = resolveImageUrl(src); return `<img class="result-thumb" src="${safe}" alt="Answer ${i + 1}" onclick="openLightbox('${safe}')" />`; }).join('')}</div>` : '';
  const editActionHTML = s.status === 'pending'
    ? `<div class="result-actions"><button type="button" class="result-edit-btn" onclick="startEditSubmission('${escapeHtml(s.id)}')">Edit Submission</button><button type="button" class="result-delete-btn" onclick="deleteMySubmission('${escapeHtml(s.id)}')">Delete Submission</button></div>`
    : '';
  div.innerHTML = `
    <div class="result-header">
      <div><div class="result-title">${escapeHtml(s.testTitle)} · ${escapeHtml(s.subject)}</div>
        <div class="result-subtitle">${escapeHtml(s.classroom)} · Submitted ${dateStr}</div></div>
      <span class="status-badge ${statusClass}">${statusLabel}</span>
    </div>${marksHTML}${feedbackHTML}${thumbsHTML}${editActionHTML}`;
  return div;
}

function getGrade(m, t) { const p = (m / (t || 100)) * 100; if (p >= 90) return 'A+'; if (p >= 80) return 'A'; if (p >= 70) return 'B+'; if (p >= 60) return 'B'; if (p >= 50) return 'C'; return 'F'; }

// ── Modal ─────────────────────────────────────────────────────
document.getElementById('modalCloseBtn').addEventListener('click', () => {
  document.getElementById('successModal').classList.remove('show');
  showToast('Submission saved! 🎉', 'success');
});

// ── Lightbox ──────────────────────────────────────────────────
function initLightbox() {
  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);
  document.getElementById('lightbox').addEventListener('click', e => { if (e.target === document.getElementById('lightbox')) closeLightbox(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
}
function openLightbox(src) { document.getElementById('lightboxImg').src = src; document.getElementById('lightbox').classList.add('show'); document.body.style.overflow = 'hidden'; }
function openLightboxFromFile(file) { const r = new FileReader(); r.onload = e => openLightbox(e.target.result); r.readAsDataURL(file); }
function closeLightbox() { document.getElementById('lightbox').classList.remove('show'); document.body.style.overflow = ''; }
window.openLightbox = openLightbox;
window.startEditSubmission = startEditSubmission;
window.deleteMySubmission = deleteMySubmission;

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast'); t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

// ── Helpers ───────────────────────────────────────────────────
function generateId() { return 'CT-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 5).toUpperCase(); }
function fileToBase64(file) { return new Promise(r => { const rd = new FileReader(); rd.onload = e => r(e.target.result); rd.readAsDataURL(file); }); }
function escapeHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function uploadFiles(files, onProgress) {
  if (!files || files.length === 0) {
    return Promise.reject(new Error('No files to upload'));
  }

  const token = getStudentAuthTokenOrThrow();
  const form = new FormData();
  console.log('[FORMDATA] Creating FormData with', files.length, 'files');
  files.forEach((f, i) => {
    console.log(`[FORMDATA] Appending file ${i + 1}:`, f.name, 'size:', f.size, 'type:', f.type);
    form.append('files', f);
  });
  const fallbackTotalBytes = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload', true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    let lastLoaded = 0;
    let lastTs = Date.now();

    xhr.upload.onloadstart = () => {
      if (typeof onProgress === 'function') {
        onProgress(0, '0 KB/s');
      }
    };

    xhr.upload.onprogress = (event) => {
      if (typeof onProgress !== 'function') return;

      const loaded = Number(event.loaded) || 0;
      const total = event.lengthComputable && event.total > 0 ? Number(event.total) : fallbackTotalBytes;
      const now = Date.now();
      const dt = Math.max((now - lastTs) / 1000, 0.001);
      const speed = formatUploadSpeed(Math.max(0, loaded - lastLoaded) / dt);

      lastLoaded = loaded;
      lastTs = now;

      const percent = total > 0 ? (loaded / total) * 100 : 0;
      onProgress(percent, speed);
    };

    xhr.onerror = () => {
      console.error('[CLIENT-UPLOAD] Network error');
      reject(new Error('Upload failed - network error'));
    };
    xhr.onloadend = () => {
      if (typeof onProgress === 'function') {
        onProgress(100, 'Done');
      }
    };
    xhr.onload = () => {
      console.log('[CLIENT-UPLOAD] Response status:', xhr.status);
      if (xhr.status < 200 || xhr.status >= 300) {
        console.error('[CLIENT-UPLOAD] Upload error:', xhr.responseText);
        return reject(new Error(xhr.responseText || 'Upload failed'));
      }
      try {
        const payload = JSON.parse(xhr.responseText || '{}');
        console.log('[CLIENT-UPLOAD] Success! Got', (payload.files || []).length, 'files');
        resolve((payload.files || []).map(f => f.url));
      } catch (_err) {
        console.error('[CLIENT-UPLOAD] Parse error:', _err.message);
        reject(new Error('Invalid upload response'));
      }
    };

    console.log('[CLIENT-UPLOAD] Sending', files.length, 'files to /api/upload');
    xhr.send(form);
  });
}
