// Get submission ID from URL or sessionStorage
const urlParams = new URLSearchParams(window.location.search);
const currentId = urlParams.get('id') || sessionStorage.getItem('currentGradeId');

let currentSubmission = null;

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('backBtn').addEventListener('click', () => { window.location.href = 'staff-dashboard.html'; });
  document.getElementById('saveGradeBtn').addEventListener('click', saveGrade);
  initLightbox();
  loadSubmission();
});

async function apiGetSubmission(id) {
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('Submission not found');
  const payload = await res.json();
  return payload.submission;
}

async function apiUpdateSubmission(id, updates) {
  const res = await fetch(`/api/submissions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
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
  ].map(([l,v]) => `<div class="info-cell" style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px 14px;"><div class="info-label" style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:2px;">${l}</div><div class="info-value" style="font-size:0.9rem;font-weight:600;">${esc(v)}</div></div>`).join('');

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
      img.src = src; img.className = 'img-thumb'; img.alt = 'answer sheet ' + (i+1);
      img.addEventListener('click', () => {
        document.getElementById('lightboxImg').src = src;
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
function showToast(msg, type='info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
