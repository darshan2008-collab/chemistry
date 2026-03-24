// ── Redirect if already logged in ─────────────────────────────
if (getStudentSession()) { window.location.href = 'index.html'; }

let pendingRegNo = null; // holds reg no while password change modal is open

document.addEventListener('DOMContentLoaded', () => {
  initBg();
  initRegLookup();
  initPasswordToggle();
  initForm();
  initChangePwModal();
});

// ── Background particles ──────────────────────────────────────
function initBg() {
  const canvas = document.getElementById('bgCanvas');
  const ctx = canvas.getContext('2d');
  let W, H, pts = [];
  function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
  resize(); window.addEventListener('resize', resize);
  for (let i = 0; i < 50; i++) pts.push({ x: Math.random()*1920, y: Math.random()*1080, vx: (Math.random()-.5)*.3, vy: (Math.random()-.5)*.3, r: Math.random()*1.4+.3, a: Math.random()*.5+.1 });
  (function draw() {
    ctx.clearRect(0,0,W,H);
    pts.forEach(p => {
      p.x+=p.vx; p.y+=p.vy;
      if(p.x<0)p.x=W; if(p.x>W)p.x=0; if(p.y<0)p.y=H; if(p.y>H)p.y=0;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(124,58,237,${p.a})`; ctx.fill();
    }); requestAnimationFrame(draw);
  })();
}

// ── Live register number lookup ───────────────────────────────
function initRegLookup() {
  const input = document.getElementById('regNo');
  const preview = document.getElementById('namePreview');
  const previewName = document.getElementById('previewName');

  input.addEventListener('input', () => {
    const val = input.value.trim().toUpperCase();
    const name = STUDENTS_DB[val];
    if (name) {
      previewName.textContent = name;
      preview.hidden = false;
      input.style.borderColor = '#06b6d4';
      document.getElementById('regErr').textContent = '';
    } else {
      preview.hidden = true;
      input.style.borderColor = '';
    }
  });
}

// ── Password visibility toggle ────────────────────────────────
function initPasswordToggle() {
  document.getElementById('togglePw').addEventListener('click', () => {
    const pw = document.getElementById('password');
    pw.type = pw.type === 'password' ? 'text' : 'password';
  });
}

// ── Login form ────────────────────────────────────────────────
function initForm() {
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const regNo = document.getElementById('regNo').value.trim().toUpperCase();
    const pw    = document.getElementById('password').value;

    // Validate register number
    if (!STUDENTS_DB[regNo]) {
      document.getElementById('regErr').textContent = 'Register number not found in database';
      document.getElementById('regNo').classList.add('err-border');
      return;
    }
    document.getElementById('regErr').textContent = '';
    document.getElementById('regNo').classList.remove('err-border');

    if (!pw) {
      document.getElementById('pwErr').textContent = 'Enter your password';
      return;
    }

    // Show loader
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.querySelector('.btn-text').hidden = true;
    btn.querySelector('.btn-loader').hidden = false;
    await new Promise(r => setTimeout(r, 900));
    btn.disabled = false;
    btn.querySelector('.btn-text').hidden = false;
    btn.querySelector('.btn-loader').hidden = true;

    const storedPw = getStudentPassword(regNo);
    if (pw !== storedPw) {
      document.getElementById('pwErr').textContent = 'Incorrect password';
      const card = document.querySelector('.login-card');
      card.classList.remove('shake');
      void card.offsetWidth; // trigger reflow
      card.classList.add('shake');
      if (window.navigator.vibrate) window.navigator.vibrate(200);
      document.getElementById('password').classList.add('err-border');
      showToast('❌ Incorrect password', 'error');
      return;
    }
    document.getElementById('pwErr').textContent = '';
    document.getElementById('password').classList.remove('err-border');

    // First login? → force password change
    if (!hasChangedPassword(regNo)) {
      pendingRegNo = regNo;
      document.getElementById('changePwModal').classList.add('show');
      document.body.style.overflow = 'hidden';
      return;
    }

    // All good — set session and go
    setStudentSession(regNo);
    showToast('✅ Welcome, ' + STUDENTS_DB[regNo] + '!', 'success');
    setTimeout(() => { window.location.href = 'index.html'; }, 700);
  });

  // Clear pw error on input
  document.getElementById('password').addEventListener('input', () => {
    document.getElementById('pwErr').textContent = '';
    document.getElementById('password').classList.remove('err-border');
  });
}

// ── Change Password Modal ─────────────────────────────────────
function initChangePwModal() {
  document.getElementById('savePwBtn').addEventListener('click', saveNewPassword);

  // Live strength indicator
  document.getElementById('newPw').addEventListener('input', () => {
    const v = document.getElementById('newPw').value;
    const el = document.getElementById('pwStrength');
    const fill = document.getElementById('strengthFill');
    const label = document.getElementById('strengthLabel');
    if (!v) { el.hidden = true; return; }
    el.hidden = false;
    const strength = getStrength(v);
    const configs = [
      { w: '25%', bg: '#f43f5e', text: 'Weak' },
      { w: '50%', bg: '#f97316', text: 'Fair' },
      { w: '75%', bg: '#eab308', text: 'Good' },
      { w: '100%', bg: '#22c55e', text: 'Strong 💪' },
    ];
    const c = configs[strength];
    fill.style.width = c.w; fill.style.background = c.bg;
    label.textContent = c.text; label.style.color = c.bg;
  });
}

function getStrength(pw) {
  let s = 0;
  if (pw.length >= 6) s++;
  if (pw.length >= 10) s++;
  if (/[A-Z]/.test(pw) && /[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return Math.min(s, 3);
}

function saveNewPassword() {
  const newPw = document.getElementById('newPw').value;
  const confirmPw = document.getElementById('confirmPw').value;

  document.getElementById('newPwErr').textContent = '';
  document.getElementById('confirmPwErr').textContent = '';

  if (!newPw || newPw.length < 6) {
    document.getElementById('newPwErr').textContent = 'Password must be at least 6 characters';
    return;
  }
  if (newPw !== confirmPw) {
    document.getElementById('confirmPwErr').textContent = 'Passwords do not match';
    return;
  }
  if (newPw === pendingRegNo) {
    document.getElementById('newPwErr').textContent = 'Please choose a different password (not your register number)';
    return;
  }

  setStudentPassword(pendingRegNo, newPw);
  markPasswordChanged(pendingRegNo);

  document.getElementById('changePwModal').classList.remove('show');
  document.body.style.overflow = '';

  setStudentSession(pendingRegNo);
  showToast('🎉 Password set! Redirecting…', 'success');
  setTimeout(() => { window.location.href = 'index.html'; }, 800);
}

// ── Toast ─────────────────────────────────────────────────────
let _t;
function showToast(msg, type='info') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast ${type} show`;
  clearTimeout(_t); _t = setTimeout(() => el.classList.remove('show'), 3500);
}
