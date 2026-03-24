// ── Staff accounts ────────────────────────────────────────────
const STAFF = [
  { username: 'Shreekesavan', password: 'Kesavan@123', name: 'Shreekesavan', role: 'Chemistry Teacher' },
];

// ── Reidrect if already logged in ─────────────────────────────
if (getStudentSession())                                       window.location.replace('index.html');
if (sessionStorage.getItem('chemtest_staff'))                  window.location.replace('staff-dashboard.html');

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initBg();
  initTabs();
  initStudentForm();
  initStaffForm();
  initChangePwModal();
  initEyeBtns();
});

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

function initStudentForm() {
  // Auto-uppercase register number as user types
  const regInput = document.getElementById('sRegNo');
  regInput.addEventListener('input', () => {
    const pos = regInput.selectionStart;
    regInput.value = regInput.value.toUpperCase();
    regInput.setSelectionRange(pos, pos);
  });

  document.getElementById('studentForm').addEventListener('submit', e => {
    e.preventDefault();
    const regNo = document.getElementById('sRegNo').value.trim().toUpperCase();
    const pw    = document.getElementById('sPw').value;

    if (!STUDENTS_DB[regNo]) {
      document.getElementById('sRegErr').textContent = 'Register number not found';
      return;
    }
    document.getElementById('sRegErr').textContent = '';
    if (!pw) { document.getElementById('sPwErr').textContent = 'Enter your password'; return; }


    if (pw !== getStudentPassword(regNo)) {
      // Also allow case-insensitive match against default password (register number)
      const storedPw = getStudentPassword(regNo);
      if (pw.toUpperCase() !== storedPw.toUpperCase()) {
        document.getElementById('sPwErr').textContent = 'Incorrect password';
        showToast('❌ Wrong password', 'bad'); return;
      }
    }
    document.getElementById('sPwErr').textContent = '';

    if (!hasChangedPassword(regNo)) {
      pendingRegNo = regNo;
      document.getElementById('changePwOverlay').classList.add('show');
      document.body.style.overflow = 'hidden';
      return;
    }
    setStudentSession(regNo);
    showToast('✅ Welcome, ' + STUDENTS_DB[regNo] + '!', 'ok');
    setTimeout(() => window.location.href = 'index.html', 700);
  });
}

// ── Staff form ────────────────────────────────────────────────
function initStaffForm() {
  document.getElementById('staffForm').addEventListener('submit', e => {
    e.preventDefault();
    const username = document.getElementById('fEmail').value.trim();
    const pw       = document.getElementById('fPw').value;

    if (!username) {
      document.getElementById('fEmailErr').textContent = 'Enter your username'; return;
    }
    if (!pw) { document.getElementById('fPwErr').textContent = 'Enter your password'; return; }


    const account = STAFF.find(a => a.username === username && a.password === pw);
    if (!account) {
      document.getElementById('fPwErr').textContent = 'Invalid credentials';
      showToast('❌ Invalid username or password', 'bad'); return;
    }
    document.getElementById('fEmailErr').textContent = '';
    document.getElementById('fPwErr').textContent = '';

    sessionStorage.setItem('chemtest_staff', JSON.stringify({
      username: account.username, name: account.name, role: account.role,
      loggedInAt: new Date().toISOString(),
    }));
    showToast('✅ Welcome, ' + account.name + '!', 'ok');
    setTimeout(() => window.location.href = 'staff-dashboard.html', 700);
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

    setStudentPassword(pendingRegNo, np);
    markPasswordChanged(pendingRegNo);
    document.getElementById('changePwOverlay').classList.remove('show');
    document.body.style.overflow = '';

    setStudentSession(pendingRegNo);
    showToast('🎉 Password set! Redirecting…', 'ok');
    setTimeout(() => window.location.href = 'index.html', 750);
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

let _toastT;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(_toastT); _toastT = setTimeout(() => el.classList.remove('show'), 3400);
}

// Expose for students-db.js logout compatibility
window.clearStudentSession = clearStudentSession;
