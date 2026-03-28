// ── Splash gate + redirect if already logged in ───────────────
if (!canOpenLoginPageDirectly()) {
  window.location.replace('splash.html');
}

bootstrapAuthRedirect();

function canOpenLoginPageDirectly() {
  if (hasAnyActiveSession()) return true;

  const url = new URL(window.location.href);
  if (url.searchParams.get('splash') === '1') {
    url.searchParams.delete('splash');
    const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, '', cleanUrl);
    return true;
  }

  if (cameFromSplashPage() && !isReloadNavigation()) {
    return true;
  }

  try {
    const splashAccess = sessionStorage.getItem('chemtest_prelogin_ok');
    if (splashAccess === '1') {
      sessionStorage.removeItem('chemtest_prelogin_ok');
      return true;
    }
  } catch (_err) {
    return false;
  }

  return false;
}

function cameFromSplashPage() {
  try {
    const ref = String(document.referrer || '');
    if (!ref) return false;
    const refUrl = new URL(ref);
    return /\/splash\.html$/i.test(refUrl.pathname);
  } catch (_err) {
    return false;
  }
}

function isReloadNavigation() {
  try {
    const navEntries = performance.getEntriesByType('navigation');
    if (navEntries && navEntries.length && navEntries[0].type === 'reload') {
      return true;
    }
    if (performance.navigation && performance.navigation.type === 1) {
      return true;
    }
  } catch (_err) {
    return false;
  }
  return false;
}

function hasAnyActiveSession() {
  try {
    return Boolean(
      sessionStorage.getItem('chemtest_student') ||
      sessionStorage.getItem('chemtest_staff') ||
      sessionStorage.getItem('chemtest_superadmin')
    );
  } catch (_err) {
    return false;
  }
}

async function bootstrapAuthRedirect() {
  const student = getStudentSession();
  const superAdmin = getSuperAdminSession();
  const staff = getStaffSession();

  if (!student && !superAdmin && !staff) return;

  const candidates = [];

  if (student && await isStudentSessionValid(student)) {
    candidates.push({ role: 'student', ts: sessionTs(student) });
  }
  if (superAdmin && await isSuperAdminSessionValid(superAdmin)) {
    candidates.push({ role: 'superadmin', ts: sessionTs(superAdmin) });
  }
  if (staff && await isStaffSessionValid(staff)) {
    candidates.push({ role: 'staff', ts: sessionTs(staff) });
  }

  if (!candidates.length) {
    clearAllRoleSessions();
    return;
  }

  candidates.sort((a, b) => b.ts - a.ts);
  const selected = candidates[0].role;
  if (selected === 'student') {
    window.location.replace('index.html');
  }
  if (selected === 'superadmin') {
    window.location.replace('superadmin-dashboard.html');
  }
  if (selected === 'staff') {
    window.location.replace('staff-dashboard.html');
  }
}

function sessionTs(session) {
  const ts = Date.parse(String(session?.loggedInAt || ''));
  return Number.isFinite(ts) ? ts : 0;
}

function clearAllRoleSessions() {
  sessionStorage.removeItem('chemtest_student');
  sessionStorage.removeItem('chemtest_staff');
  sessionStorage.removeItem('chemtest_superadmin');
}

async function isStudentSessionValid(session) {
  if (!session?.token || !session?.regNo) return false;
  try {
    const params = new URLSearchParams({
      rollNumber: String(session.regNo),
      includeArchived: 'false',
      _ts: String(Date.now()),
    });
    const res = await fetch(`/api/submissions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: 'no-store',
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

async function isStaffSessionValid(session) {
  if (!session?.token) return false;
  try {
    const params = new URLSearchParams({ includeArchived: 'true', _ts: String(Date.now()) });
    const res = await fetch(`/api/submissions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: 'no-store',
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

async function isSuperAdminSessionValid(session) {
  if (!session?.token) return false;
  try {
    const res = await fetch('/api/admin/staff', {
      headers: { Authorization: `Bearer ${session.token}` },
      cache: 'no-store',
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  runIntroAnimation();
  initBg();
  initUnifiedForm();
  initChangePwModal();
  initEyeBtns();
  initCardMotion();
});

function runIntroAnimation() {
  const fx = document.getElementById('introFx');
  if (!fx) return;
  const isMobile = window.matchMedia('(max-width: 480px)').matches;
  const durationMs = isMobile ? 700 : 1050;
  fx.classList.add('show');
  setTimeout(() => {
    fx.classList.remove('show');
  }, durationMs);
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

// ── Student form ──────────────────────────────────────────────
let pendingRegNo = null;
let pendingStudentToken = '';
let pendingStudentName = '';

function initUnifiedForm() {
  const idInput = document.getElementById('loginId');
  const pwInput = document.getElementById('loginPw');
  const idErr = document.getElementById('loginIdErr');
  const pwErr = document.getElementById('loginPwErr');

  idInput.addEventListener('input', () => {
    idErr.textContent = '';
  });

  pwInput.addEventListener('input', () => {
    pwErr.textContent = '';
  });

  document.getElementById('unifiedLoginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const rawId = document.getElementById('loginId').value.trim();
    const pw = document.getElementById('loginPw').value;

    if (!rawId) {
      idErr.textContent = 'Enter register number or email';
      return;
    }
    if (!pw) {
      pwErr.textContent = 'Enter your password';
      return;
    }

    const regCandidate = rawId.toUpperCase();

    try {
      // Always try student auth first so login does not depend on cached STUDENTS_DB in browser.
      try {
        const payload = await apiStudentLogin(regCandidate, pw);

        if (payload.mustChangePassword) {
          pendingRegNo = regCandidate;
          pendingStudentToken = payload.token;
          pendingStudentName = payload?.student?.name || STUDENTS_DB[regCandidate] || '';
          document.getElementById('changePwOverlay').classList.add('show');
          document.body.style.overflow = 'hidden';
          return;
        }

        setStudentSession(regCandidate, payload.token, payload?.student?.name || STUDENTS_DB[regCandidate]);
        sessionStorage.removeItem('chemtest_staff');
        sessionStorage.removeItem('chemtest_superadmin');
        showToast('👋 Welcome, ' + (payload?.student?.name || STUDENTS_DB[regCandidate]) + '!', 'ok top');
        setTimeout(() => window.location.href = 'index.html', 700);
        return;
      } catch (_studentErr) {
        // Fall through to staff/super-admin auth.
      }

      const payload = await apiStaffLogin(rawId.toLowerCase(), pw);
      const role = String(payload?.staff?.role || '').toLowerCase();

      if (/super\s*admin/.test(role) || role === 'superadmin') {
        setSuperAdminSession({
          email: payload.staff.email,
          name: payload.staff.name,
          role: payload.staff.role,
          token: payload.token,
        });
        sessionStorage.removeItem('chemtest_staff');
        sessionStorage.removeItem('chemtest_student');
        showToast('👑 Welcome Super Admin!', 'ok top');
        setTimeout(() => window.location.href = 'superadmin-dashboard.html', 700);
        return;
      }

      setStaffSession({
        email: payload.staff.email,
        name: payload.staff.name,
        role: payload.staff.role,
        token: payload.token,
      });
      sessionStorage.removeItem('chemtest_student');
      sessionStorage.removeItem('chemtest_superadmin');
      showToast('👋 Welcome, ' + payload.staff.name + '!', 'ok top');
      setTimeout(() => window.location.href = 'staff-dashboard.html', 700);
    } catch (_err) {
      pwErr.textContent = 'Invalid credentials';
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
      { w: '100%', bg: '#00b894', txt: 'Strong 💪', col: '#00b894' },
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
    if (np !== cp) { document.getElementById('confirmPwErr').textContent = 'Passwords do not match'; return; }
    if (np === pendingRegNo) { document.getElementById('newPwErr').textContent = 'Choose a different password'; return; }

    apiStudentChangePassword(np, pendingStudentToken)
      .then(() => {
        document.getElementById('changePwOverlay').classList.remove('show');
        document.body.style.overflow = '';

        setStudentSession(pendingRegNo, pendingStudentToken, pendingStudentName || STUDENTS_DB[pendingRegNo]);
        sessionStorage.removeItem('chemtest_staff');
        sessionStorage.removeItem('chemtest_superadmin');
        showToast('🎉 Password set! Redirecting…', 'ok top');
        setTimeout(() => window.location.href = 'index.html', 750);
      })
      .catch(() => {
        document.getElementById('newPwErr').textContent = 'Failed to update password';
      });
  });
}

// ── Eye toggle ────────────────────────────────────────────────
function initEyeBtns() {
  [['loginEyeBtn', 'loginPw'], ['newPwEye', 'newPw'], ['confirmPwEye', 'confirmPw']].forEach(([btn, inp]) => {
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
  const textEl = document.getElementById(textId);
  const loaderEl = document.getElementById(loaderId);
  const btn = textEl.closest('button');
  btn.disabled = loading;
  textEl.hidden = loading;
  loaderEl.hidden = !loading;
}

function pwStrength(v) {
  let s = 0;
  if (v.length >= 6) s++;
  if (v.length >= 10) s++;
  if (/[A-Z]/.test(v) && /[0-9]/.test(v)) s++;
  return Math.min(s, 3);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getSuperAdminSession() {
  try { return JSON.parse(sessionStorage.getItem('chemtest_superadmin') || 'null'); }
  catch { return null; }
}

function setSuperAdminSession(admin) {
  sessionStorage.setItem('chemtest_superadmin', JSON.stringify({
    ...admin,
    loggedInAt: new Date().toISOString(),
  }));
}

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
