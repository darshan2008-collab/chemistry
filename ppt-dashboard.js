let currentToken = '';
let subjects = [];
let currentSubjectId = '';

function getSession() {
  const pptSession = JSON.parse(sessionStorage.getItem('chemtest_ppt_staff') || 'null');
  if (pptSession && pptSession.token) return pptSession;

  const staffSession = JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null');
  if (staffSession && staffSession.token) return staffSession;

  return null;
}

function authHeaders() {
  return { Authorization: `Bearer ${currentToken}` };
}

async function apiJson(url, options = {}) {
  const headers = {
    ...authHeaders(),
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || `Request failed (${res.status})`);
  }
  return payload;
}

function formatDate(raw) {
  if (!raw) return '-';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let idx = 0;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  return `${n.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeUploadUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '#';
  if (raw.startsWith('/api/uploads/')) return raw;
  if (raw.startsWith('/uploads/')) return `/api${raw}`;
  if (raw.startsWith('uploads/')) return `/api/${raw}`;
  return raw;
}

function sanitizeLinkUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '#';
  if (raw.startsWith('/')) return raw;
  if (/^https?:\/\//i.test(raw)) return raw;
  return '#';
}

async function loadSubjects() {
  const payload = await apiJson('/api/staff/subjects');
  subjects = payload.subjects || [];

  const filter = document.getElementById('subjectFilter');
  filter.innerHTML = '<option value="">All Assigned Subjects</option>';
  for (const subject of subjects) {
    const option = document.createElement('option');
    option.value = String(subject.id);
    option.textContent = `${subject.code} - ${subject.name}`;
    filter.appendChild(option);
  }

  if (subjects.length === 0) {
    document.getElementById('summary').textContent = 'No subjects assigned to this staff account.';
  }
}

function renderRows(rows) {
  const groupsNode = document.getElementById('pptGroups');
  const summaryNode = document.getElementById('summary');
  groupsNode.innerHTML = '';

  if (!rows.length) {
    summaryNode.textContent = 'No student PPT uploads found.';
    groupsNode.innerHTML = '<div class="empty">No PPT uploads available for this subject selection.</div>';
    return;
  }

  summaryNode.textContent = `Showing ${rows.length} uploaded PPT file(s).`;

  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.subject_id || ''}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  for (const rowsForSubject of grouped.values()) {
    const headCode = String(rowsForSubject[0]?.subject_code || '').trim() || 'Subject';
    const headName = String(rowsForSubject[0]?.subject_name || '').trim() || 'Unknown';

    const section = document.createElement('section');
    section.className = 'subject-group';
    const heading = document.createElement('div');
    heading.className = 'subject-head';
    heading.textContent = `${headCode} - ${headName} (${rowsForSubject.length})`;
    section.appendChild(heading);

    const rowsWrap = document.createElement('div');
    rowsWrap.className = 'rows';

    for (const row of rowsForSubject) {
      const item = document.createElement('div');
      item.className = 'row';
      const href = sanitizeLinkUrl(normalizeUploadUrl(row.file_url));
      const student = `${String(row.student_name || '').trim() || 'Student'} (${String(row.owner_reg_no || '-').trim() || '-'})`;
      const fileName = String(row.original_name || 'PPT').trim() || 'PPT';

      const fileBlock = document.createElement('div');
      const nameNode = document.createElement('div');
      nameNode.className = 'name';
      nameNode.textContent = fileName;
      const uploadMeta = document.createElement('div');
      uploadMeta.className = 'meta';
      uploadMeta.textContent = `Uploaded: ${formatDate(row.created_at)}`;
      fileBlock.appendChild(nameNode);
      fileBlock.appendChild(uploadMeta);

      const studentMeta = document.createElement('div');
      studentMeta.className = 'meta';
      studentMeta.textContent = student;

      const sizeMeta = document.createElement('div');
      sizeMeta.className = 'meta';
      sizeMeta.textContent = `Size: ${formatBytes(row.size_bytes)}`;

      const openLink = document.createElement('a');
      openLink.className = 'link-btn';
      openLink.href = href;
      openLink.target = '_blank';
      openLink.rel = 'noopener';
      openLink.textContent = 'Open PPT';

      item.appendChild(fileBlock);
      item.appendChild(studentMeta);
      item.appendChild(sizeMeta);
      item.appendChild(openLink);

      rowsWrap.appendChild(item);
    }

    section.appendChild(rowsWrap);
    groupsNode.appendChild(section);
  }
}

async function loadPpts() {
  const errorNode = document.getElementById('errorMsg');
  errorNode.textContent = '';

  const qs = currentSubjectId ? `?subjectId=${encodeURIComponent(currentSubjectId)}` : '';
  const payload = await apiJson(`/api/staff/student-ppts${qs}`);
  const rows = payload.ppts || [];
  renderRows(rows);
}

async function init() {
  const session = getSession();
  if (!session) {
    window.location.href = 'ppt-login.html';
    return;
  }

  currentToken = String(session.token || '');
  if (!currentToken) {
    window.location.href = 'ppt-login.html';
    return;
  }

  document.getElementById('staffMeta').textContent = `${session.name || 'Staff'} | ${session.email || ''}`;

  const subjectFilter = document.getElementById('subjectFilter');
  subjectFilter.addEventListener('change', async () => {
    currentSubjectId = subjectFilter.value;
    try {
      await loadPpts();
    } catch (err) {
      document.getElementById('errorMsg').textContent = err.message || 'Failed to load subject-wise PPTs.';
    }
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    try {
      await loadPpts();
    } catch (err) {
      document.getElementById('errorMsg').textContent = err.message || 'Failed to refresh.';
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', () => {
    sessionStorage.removeItem('chemtest_ppt_staff');
    window.location.href = 'ppt-login.html';
  });

  try {
    await loadSubjects();
    await loadPpts();
  } catch (err) {
    if (String(err.message || '').toLowerCase().includes('unauthorized')) {
      sessionStorage.removeItem('chemtest_ppt_staff');
      window.location.href = 'ppt-login.html';
      return;
    }
    document.getElementById('errorMsg').textContent = err.message || 'Unable to load dashboard.';
  }
}

document.addEventListener('DOMContentLoaded', init);
