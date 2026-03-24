// ── Staff Accounts (hardcoded for demo) ──────────────────────
const STAFF_ACCOUNTS = [
  { email: 'admin@chemtest.in', password: 'admin123', name: 'Dr. Admin', role: 'Head of Department' },
  { email: 'teacher@school.edu', password: 'teacher123', name: 'Prof. Teacher', role: 'Chemistry Teacher' },
];

document.addEventListener('DOMContentLoaded', () => {
  initBg();
  initForm();
  initPasswordToggle();

  // Auto-fill from remember-me
  const saved = localStorage.getItem('chemtest_staff_email');
  if (saved) {
    document.getElementById('email').value = saved;
    document.getElementById('remember').checked = true;
  }
});

// ── Background Canvas ─────────────────────────────────────────
function initBg() {
  const canvas = document.getElementById('bgCanvas');
  const ctx = canvas.getContext('2d');
  let W, H, particles = [];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  for (let i = 0; i < 40; i++) {
    particles.push({
      x: Math.random() * 2000, y: Math.random() * 2000,
      r: Math.random() * 1.5 + 0.3,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      a: Math.random() * 0.5 + 0.1,
    });
  }

  (function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(108,99,255,${p.a})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  })();
}

// ── Form ──────────────────────────────────────────────────────
function initForm() {
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    if (!validate()) return;

    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.querySelector('.btn-text').hidden = true;
    btn.querySelector('.btn-loader').hidden = false;

    await new Promise(r => setTimeout(r, 1200));

    const email = document.getElementById('email').value.trim().toLowerCase();
    const pw = document.getElementById('password').value;

    const customPws = JSON.parse(localStorage.getItem('chemtest_staff_custom_pws') || '{}');
    const account = STAFF_ACCOUNTS.find(a => {
      const activePw = customPws[a.email] || a.password;
      return a.email === email && activePw === pw;
    });

    btn.disabled = false;
    btn.querySelector('.btn-text').hidden = false;
    btn.querySelector('.btn-loader').hidden = true;

    if (!account) {
      const card = document.querySelector('.login-card');
      card.classList.remove('shake');
      void card.offsetWidth; // trigger reflow
      card.classList.add('shake');
      if (window.navigator.vibrate) window.navigator.vibrate(200);
      showToast('❌ Invalid email or password', 'error');
      document.getElementById('password').classList.add('error-border');
      document.getElementById('pwErr').textContent = 'Incorrect credentials';
      return;
    }

    if (document.getElementById('remember').checked) {
      localStorage.setItem('chemtest_staff_email', email);
    } else {
      localStorage.removeItem('chemtest_staff_email');
    }

    // Store session
    sessionStorage.setItem('chemtest_staff', JSON.stringify({
      email: account.email, name: account.name, role: account.role,
      loggedInAt: new Date().toISOString(),
    }));

    showToast('✅ Login successful! Redirecting…', 'success');
    setTimeout(() => { window.location.href = 'staff-dashboard.html'; }, 800);
  });

  document.getElementById('forgotBtn').addEventListener('click', () => {
    showToast('📧 Contact: admin@chemtest.in for password reset', 'error');
  });
}

function validate() {
  let ok = true;
  const email = document.getElementById('email').value.trim();
  const pw = document.getElementById('password').value;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    document.getElementById('emailErr').textContent = 'Enter a valid email address';
    document.getElementById('email').classList.add('error-border');
    ok = false;
  } else {
    document.getElementById('emailErr').textContent = '';
    document.getElementById('email').classList.remove('error-border');
  }

  if (!pw || pw.length < 6) {
    document.getElementById('pwErr').textContent = 'Password must be at least 6 characters';
    document.getElementById('password').classList.add('error-border');
    ok = false;
  } else {
    document.getElementById('pwErr').textContent = '';
    document.getElementById('password').classList.remove('error-border');
  }
  return ok;
}

// ── Password Toggle ───────────────────────────────────────────
function initPasswordToggle() {
  const btn = document.getElementById('togglePw');
  const input = document.getElementById('password');
  btn.addEventListener('click', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
  });
}

// ── Toast ─────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}
