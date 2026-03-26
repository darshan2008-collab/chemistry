// Get submission ID from URL or sessionStorage
const urlParams = new URLSearchParams(window.location.search);
const currentId = urlParams.get('id') || sessionStorage.getItem('currentGradeId');
const staffSession = JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null');

if (!staffSession || !staffSession.token) {
  window.location.href = 'login.html';
}

function staffAuthHeaders() {
  const s = JSON.parse(sessionStorage.getItem('chemtest_staff') || 'null');
  if (!s || !s.token) throw new Error('Unauthorized');
  return { Authorization: `Bearer ${s.token}` };
}

let currentSubmission = null;

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

function attachImageFallback(img) {
  img.dataset.fallbackStep = '0';
  img.onerror = () => {
    const step = Number(img.dataset.fallbackStep || '0');
    const current = img.getAttribute('src') || '';
    const fileName = current.split('/').pop() || '';
    if (step === 0 && current.includes('/api/uploads/')) {
      img.dataset.fallbackStep = '1';
      img.src = current.replace('/api/uploads/', '/uploads/');
      return;
    }
    if (step === 1 && fileName) {
      img.dataset.fallbackStep = '2';
      img.src = `/api/uploads/${fileName}`;
      return;
    }
    img.onerror = null;
  };
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('backBtn').addEventListener('click', () => { window.location.href = 'staff-dashboard.html'; });
  document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
  initLightbox();
  loadSubmission();
});

async function apiGetSubmission(id) {
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
    headers: staffAuthHeaders(),
  });
  if (!res.ok) throw new Error('Submission not found');
  const payload = await res.json();
  return payload.submission;
}

async function apiUpdateSubmission(id, updates) {
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...staffAuthHeaders(),
    },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error('Failed to save grade');
  const payload = await res.json();
  return payload.submission;
}

async function loadSubmission() {
  if (!currentId) return goBackError();
  try {
    currentSubmission = await apiGetSubmission(currentId);
  } catch (_err) {
    return goBackError();
  }

  const s = currentSubmission;

  // Student Info Grid
  document.getElementById('infoGrid').innerHTML = [
    ['Student', s.studentName], ['Roll No.', s.rollNumber],
    ['Test', s.testTitle], ['Submitted', new Date(s.submittedAt).toLocaleString('en-IN')],
  ].map(([l, v]) => `<div class="info-cell" style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px 14px;"><div class="info-label" style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:2px;">${l}</div><div class="info-value" style="font-size:0.9rem;font-weight:600;">${esc(v)}</div></div>`).join('');

  // Form
  document.getElementById('marksInput').value = s.marks !== null ? s.marks : '';
  document.getElementById('totalMarksInput').value = s.totalMarks || '';
  document.getElementById('statusSelect').value = s.status;
  document.getElementById('feedbackInput').value = s.feedback || '';

  // Images
  const imgCont = document.getElementById('imagesGrid');
  imgCont.innerHTML = '';
  document.getElementById('photoCount').textContent = s.images && s.images.length ? `${s.images.length} photo(s) submitted.` : 'No photos submitted.';

  if (s.images && s.images.length) {
    s.images.forEach((src, i) => {
      const img = document.createElement('img');
      const safeSrc = resolveImageUrl(src);
      img.src = safeSrc; img.className = 'img-thumb'; img.alt = 'answer sheet ' + (i + 1);
      attachImageFallback(img);
      img.addEventListener('click', () => {
        document.getElementById('lightboxImg').src = safeSrc;
        document.getElementById('lightbox').classList.add('show');
      });
      imgCont.appendChild(img);
    });
  }
}

async function saveGrade() {
  const marks = document.getElementById('marksInput').value;
  const total = document.getElementById('totalMarksInput').value;
  const status = document.getElementById('statusSelect').value;
  const feedback = document.getElementById('feedbackInput').value.trim();

  if (status === 'graded') {
    if (!marks) { showToast('⚠️ Please enter marks for a graded submission.', 'error'); return; }
    if (!total) { showToast('⚠️ Please enter total marks limit.', 'error'); return; }
  }

  try {
    const updates = {
      marks: marks || null,
      totalMarks: total || null,
      status,
      feedback,
    };
    if (status === 'graded' && !currentSubmission?.gradedAt) {
      updates.gradedAt = new Date().toISOString();
    }

    currentSubmission = await apiUpdateSubmission(currentId, updates);
    showToast('✅ Grade saved!', 'success');

    // Auto-return after short delay
    const btn = document.getElementById('saveGradeBtn');
    btn.disabled = true;
    btn.innerHTML = 'Saved! Returning...';
    setTimeout(() => { window.location.href = 'staff-dashboard.html'; }, 800);
  } catch (err) {
    showToast('⚠️ Failed to save grade', 'error');
  }
}

function initLightbox() {
  document.getElementById('lightboxClose').addEventListener('click', closeLb);
  document.getElementById('lightbox').addEventListener('click', e => {
    if (e.target.id === 'lightbox') closeLb();
  });
}
function closeLb() { document.getElementById('lightbox').classList.remove('show'); }

function goBackError() {
  alert('Submission not found. Returning to dashboard.');
  window.location.href = 'staff-dashboard.html';
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g,
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag));
}

let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
