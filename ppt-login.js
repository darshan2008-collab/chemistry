document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('pptLoginForm');
  const btn = document.getElementById('loginBtn');
  const errorMsg = document.getElementById('errorMsg');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorMsg.textContent = '';

    const email = String(document.getElementById('email').value || '').trim().toLowerCase();
    const password = String(document.getElementById('password').value || '');

    if (!email || !password) {
      errorMsg.textContent = 'Enter both username and password.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
      const res = await fetch('/api/auth/staff/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const payload = await res.json().catch(() => ({}));
      if (!res.ok || !payload?.token || !payload?.staff) {
        throw new Error(payload?.error || 'Invalid credentials');
      }

      sessionStorage.setItem('chemtest_ppt_staff', JSON.stringify({
        token: payload.token,
        email: payload.staff.email,
        name: payload.staff.name,
        role: payload.staff.role,
        loggedInAt: new Date().toISOString(),
      }));

      window.location.href = 'ppt-dashboard.html';
    } catch (err) {
      errorMsg.textContent = err.message || 'Login failed.';
      btn.disabled = false;
      btn.textContent = 'Sign In to PPT Portal';
    }
  });
});
