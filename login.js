// ── Reidrect if already logged in ─────────────────────────────
if (getStudentSession())                                       window.location.replace('index.html');
if (getStaffSession())                                         window.location.replace('staff-dashboard.html');

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  runIntroAnimation();
  initBg();
  initTabs();
  initStudentForm();
  initStaffForm();
  initChangePwModal();
  initEyeBtns();
  initCardMotion();
});

function runIntroAnimation() {
  const fx = document.getElementById('introFx');
  if (!fx) return;
  fx.classList.add('show');
  setTimeout(() => {
    fx.classList.remove('show');
  }, 1900);
}

function initCardMotion() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const card = document.querySelector('.card');
  if (!card) return;

  card.addEventListener('mousemove', (e) => {
    const rect = card.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const rotateY = (x - 0.5) * 4;
    const rotateX = (0.5 - y) * 4;
    card.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateY(-2px)`;
    card.style.boxShadow = '0 30px 72px rgba(0,0,0,0.52), 0 0 0 1px rgba(255,255,255,0.06)';
  });

  card.addEventListener('mouseleave', () => {
    card.style.transform = '';
    card.style.boxShadow = '';
  });
}

// ── Background canvas ─────────────────────────────────────────
function initBg() {
  const cvs = document.getElementById('bgCanvas');
  const ctx = cvs.getContext('2d');
  let W, H;
  const pts = Array.from({ length: 55 }, () => ({
    x: Math.random() * 2000, y: Math.random() * 1200,
    vx: (Math.random() - .5) * .28, vy: (Math.random() - .5) * .28,
    r: Math.random() * 1.4 + .3,
    a: Math.random() * .5 + .08,
    blue: Math.random() > .5,
  }));
  function resize() { W = cvs.width = innerWidth; H = cvs.height = innerHeight; }
  resize(); window.addEventListener('resize', resize);
  (function draw() {
    ctx.clearRect(0, 0, W, H);
    pts.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.blue ? `rgba(59,91,255,${p.a})` : `rgba(0,198,255,${p.a})`;
      ctx.fill();
    }); requestAnimationFrame(draw);
  })();
}

// ── Tab switching ─────────────────────────────────────────────
let activeTab = 'student';

function initTabs() {
  document.getElementById('tabStudent').addEventListener('click', () => switchTab('student'));
  document.getElementById('tabStaff').addEventListener('click',   () => switchTab('staff'));
}

function switchTab(tab) {
  activeTab = tab;
  const slider  = document.getElementById('tabSlider');
  const btnS    = document.getElementById('tabStudent');
  const btnF    = document.getElementById('tabStaff');
  const panS    = document.getElementById('panelStudent');
  const panF    = document.getElementById('panelStaff');

  if (tab === 'student') {
    slider.classList.remove('right');
    btnS.classList.add('active');    btnF.classList.remove('active');
    panS.classList.remove('hidden'); panF.classList.add('hidden');
  } else {
    slider.classList.add('right');
    btnF.classList.add('active');    btnS.classList.remove('active');
    panF.classList.remove('hidden'); panS.classList.add('hidden');
  }
  // Re-trigger panel animation
  const panel = tab === 'student' ? panS : panF;
  panel.style.animation = 'none';
  requestAnimationFrame(() => { panel.style.animation = ''; });
}

// ── Student form ──────────────────────────────────────────────
let pendingRegNo = null;
let pendingStudentToken = '';
let pendingStudentName = '';

function initStudentForm() {
  // Auto-uppercase register number as user types
  const regInput = document.getElementById('sRegNo');
  regInput.addEventListener('input', () => {
    const pos = regInput.selectionStart;
    regInput.value = regInput.value.toUpperCase();
    regInput.setSelectionRange(pos, pos);
  });

  document.getElementById('studentForm').addEventListener('submit', async e => {
    e.preventDefault();
    const regNo = document.getElementById('sRegNo').value.trim().toUpperCase();
    const pw    = document.getElementById('sPw').value;

    if (!STUDENTS_DB[regNo]) {
      document.getElementById('sRegErr').textContent = 'Register number not found';
      return;
    }
    document.getElementById('sRegErr').textContent = '';
    if (!pw) { document.getElementById('sPwErr').textContent = 'Enter your password'; return; }


    try {
      const payload = await apiStudentLogin(regNo, pw);
      document.getElementById('sPwErr').textContent = '';

      if (payload.mustChangePassword) {
        pendingRegNo = regNo;
        pendingStudentToken = payload.token;
        pendingStudentName = payload?.student?.name || STUDENTS_DB[regNo] || '';
        document.getElementById('changePwOverlay').classList.add('show');
        document.body.style.overflow = 'hidden';
        return;
      }

      setStudentSession(regNo, payload.token, payload?.student?.name || STUDENTS_DB[regNo]);
      showToast('✅ Welcome, ' + (payload?.student?.name || STUDENTS_DB[regNo]) + '!', 'ok');
      setTimeout(() => window.location.href = 'index.html', 700);
    } catch (_err) {
      document.getElementById('sPwErr').textContent = 'Incorrect password';
      showToast('❌ Wrong password', 'bad');
    }
  });
}

// ── Staff form ────────────────────────────────────────────────
function initStaffForm() {
  document.getElementById('staffForm').addEventListener('submit', async e => {
    e.preventDefault();
    const username = document.getElementById('fEmail').value.trim().toLowerCase();
    const pw       = document.getElementById('fPw').value;

    if (!username) {
      document.getElementById('fEmailErr').textContent = 'Enter your username'; return;
    }
    if (!pw) { document.getElementById('fPwErr').textContent = 'Enter your password'; return; }

    try {
      const payload = await apiStaffLogin(username, pw);
      document.getElementById('fEmailErr').textContent = '';
      document.getElementById('fPwErr').textContent = '';

      setStaffSession({
        email: payload.staff.email,
        name: payload.staff.name,
        role: payload.staff.role,
        token: payload.token,
      });
      showToast('✅ Welcome, ' + payload.staff.name + '!', 'ok');
      setTimeout(() => window.location.href = 'staff-dashboard.html', 700);
    } catch (_err) {
      document.getElementById('fPwErr').textContent = 'Invalid credentials';
      showToast('❌ Invalid username or password', 'bad');
    }
  });
}

// ── Change Password Modal ─────────────────────────────────────
function initChangePwModal() {
  document.getElementById('newPw').addEventListener('input', () => {
    const v = document.getElementById('newPw').value;
    const fill = document.getElementById('pwFill');
    const label = document.getElementById('pwLabel');
    if (!v) { fill.style.width = '0'; label.textContent = ''; return; }
    const s = pwStrength(v);
    const cfg = [
      { w: '25%', bg: '#ff5777', txt: 'Weak', col: '#ff5777' },
      { w: '50%', bg: '#ff9900', txt: 'Fair', col: '#ff9900' },
      { w: '75%', bg: '#eab308', txt: 'Good', col: '#eab308' },
      { w: '100%',bg: '#00b894', txt: 'Strong 💪', col: '#00b894' },
    ][s];
    fill.style.width = cfg.w; fill.style.background = cfg.bg;
    label.textContent = cfg.txt; label.style.color = cfg.col;
  });

  document.getElementById('savePwBtn').addEventListener('click', () => {
    const np = document.getElementById('newPw').value;
    const cp = document.getElementById('confirmPw').value;
    document.getElementById('newPwErr').textContent = '';
    document.getElementById('confirmPwErr').textContent = '';

    if (!np || np.length < 6) { document.getElementById('newPwErr').textContent = 'Min. 6 characters'; return; }
    if (np !== cp)            { document.getElementById('confirmPwErr').textContent = 'Passwords do not match'; return; }
    if (np === pendingRegNo)  { document.getElementById('newPwErr').textContent = 'Choose a different password'; return; }

    apiStudentChangePassword(np, pendingStudentToken)
      .then(() => {
        document.getElementById('changePwOverlay').classList.remove('show');
        document.body.style.overflow = '';

        setStudentSession(pendingRegNo, pendingStudentToken, pendingStudentName || STUDENTS_DB[pendingRegNo]);
        showToast('🎉 Password set! Redirecting…', 'ok');
        setTimeout(() => window.location.href = 'index.html', 750);
      })
      .catch(() => {
        document.getElementById('newPwErr').textContent = 'Failed to update password';
      });
  });
}

// ── Eye toggle ────────────────────────────────────────────────
function initEyeBtns() {
  [['sEyeBtn','sPw'],['fEyeBtn','fPw'],['newPwEye','newPw'],['confirmPwEye','confirmPw']].forEach(([btn,inp]) => {
    const el = document.getElementById(btn);
    if (!el) return;
    el.addEventListener('click', () => {
      const field = document.getElementById(inp);
      field.type = field.type === 'password' ? 'text' : 'password';
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────
function setBtnLoading(textId, loaderId, loading) {
  const textEl   = document.getElementById(textId);
  const loaderEl = document.getElementById(loaderId);
  const btn      = textEl.closest('button');
  btn.disabled          = loading;
  textEl.hidden         = loading;
  loaderEl.hidden       = !loading;
}

function pwStrength(v) {
  let s = 0;
  if (v.length >= 6)  s++;
  if (v.length >= 10) s++;
  if (/[A-Z]/.test(v) && /[0-9]/.test(v)) s++;
  return Math.min(s, 3);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiStudentLogin(regNo, password) {
  const res = await fetch('/api/auth/student/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ regNo, password }),
  });
  if (!res.ok) throw new Error('Student login failed');
  return res.json();
}

async function apiStudentChangePassword(newPassword, token) {
  const res = await fetch('/api/auth/student/password', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ newPassword }),
  });
  if (!res.ok) throw new Error('Student password change failed');
  return res.json();
}

async function apiStaffLogin(email, password) {
  const res = await fetch('/api/auth/staff/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error('Staff login failed');
  return res.json();
}

let _toastT;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('show'), 3400);
}

// Expose for students-db.js logout compatibility
window.clearStudentSession = clearStudentSession;
