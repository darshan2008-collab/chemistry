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
// ── Auth guard (runs BEFORE DOMContentLoaded) ─────────────────
// students-db.js must be loaded before this file
requireStudentAuth();

const DB_KEY = 'chemtest_submissions';
let editingSubmissionId = null;
let editingExistingImages = [];
let mySubmissionsById = new Map();

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
  await updateStats();
  initDropZone();
  initForm();
  await loadMyResults();
  initLightbox();
});

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
  zone.addEventListener('click', () => {
    console.log('[USER] Clicked drop zone, triggering file picker');
    input.click();
  });
  input.addEventListener('change', () => {
    console.log('[USER] File picker closed with', input.files.length, 'files selected');
    handleFiles([...input.files]);
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

  // Validate
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

    const submission = {
      id: editingSubmissionId || generateId(),
      studentName: session.name,
      rollNumber: session.regNo,
      subject: 'Chemistry',
      classroom: '',
      testTitle: document.getElementById('testTitle').value.trim(),
      notes: (document.getElementById('notes') || {}).value || '',
      images: imageData,
      fileCount: imageData.length,
      status: 'pending', marks: null, totalMarks: null, feedback: '',
      submittedAt: new Date().toISOString(), gradedAt: null,
    };

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
    const displayMsg = `❌ Upload failed: ${errorMsg}`.substring(0, 80);
    showToast(displayMsg, 'error');
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
