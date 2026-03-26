(() => {
    const REDIRECT_DEBUG_ENABLED = true;
    let redirectDebugPanel = null;

    function initRedirectDebugPanel() {
        if (!REDIRECT_DEBUG_ENABLED || redirectDebugPanel) return;
        redirectDebugPanel = document.createElement('div');
        redirectDebugPanel.style.cssText = [
            'position:fixed',
            'right:10px',
            'bottom:10px',
            'z-index:99999',
            'width:min(460px,92vw)',
            'max-height:42vh',
            'overflow:auto',
            'padding:10px',
            'border-radius:10px',
            'background:rgba(8,12,24,0.92)',
            'border:1px solid rgba(120,190,255,0.45)',
            'font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
            'color:#d8ecff'
        ].join(';');
        const header = document.createElement('div');
        header.textContent = 'Redirect Trace (superadmin-login.js)';
        header.style.cssText = 'font-weight:700;margin-bottom:8px;color:#7fd0ff';
        redirectDebugPanel.appendChild(header);
        (document.body || document.documentElement).appendChild(redirectDebugPanel);
    }

    function redirectTrace(message) {
        if (!REDIRECT_DEBUG_ENABLED) return;
        initRedirectDebugPanel();
        const line = document.createElement('div');
        const stamp = new Date().toISOString().slice(11, 23);
        line.textContent = `[${stamp}] ${message}`;
        line.style.cssText = 'padding:2px 0;border-top:1px dashed rgba(180,220,255,0.18)';
        redirectDebugPanel.appendChild(line);
        while (redirectDebugPanel.childElementCount > 22) {
            redirectDebugPanel.removeChild(redirectDebugPanel.children[1]);
        }
        console.log('[RedirectTrace][superadmin-login.js]', message);
    }

    redirectTrace('Super admin login script initialized');

    const form = document.getElementById('superAdminForm');
    const emailEl = document.getElementById('saEmail');
    const passwordEl = document.getElementById('saPassword');
    const togglePw = document.getElementById('togglePw');
    const errEl = document.getElementById('saErr');
    const btn = document.getElementById('saBtn');
    const btnText = btn.querySelector('.btn-text');
    const btnLoader = btn.querySelector('.btn-loader');
    const toast = document.getElementById('toast');

    function showToast(msg) {
        toast.textContent = msg;
        toast.classList.add('show');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    function setLoading(loading) {
        btn.disabled = loading;
        btnText.hidden = loading;
        btnLoader.hidden = !loading;
    }

    function setSuperAdminSession(admin) {
        sessionStorage.setItem('chemtest_superadmin', JSON.stringify({
            ...admin,
            loggedInAt: new Date().toISOString(),
        }));
    }

    async function apiStaffLogin(email, password) {
        redirectTrace(`Calling /api/auth/staff/login for ${email}`);
        const res = await fetch('/api/auth/staff/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        redirectTrace(`Staff login API HTTP ${res.status}`);
        if (!res.ok) throw new Error('Invalid credentials');
        return res.json();
    }

    togglePw.addEventListener('click', () => {
        passwordEl.type = passwordEl.type === 'password' ? 'text' : 'password';
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errEl.textContent = '';

        const email = String(emailEl.value || '').trim().toLowerCase();
        const password = String(passwordEl.value || '');
        redirectTrace(`Submit received -> email:${email || '(empty)'}`);

        if (!email || !password) {
            errEl.textContent = 'Enter email and password';
            return;
        }

        setLoading(true);
        try {
            const payload = await apiStaffLogin(email, password);
            const role = String(payload?.staff?.role || '');
            redirectTrace(`Role resolved from API -> ${role || 'unknown'}`);
            if (!/admin/i.test(role)) {
                redirectTrace('Blocked: role is not admin-like');
                errEl.textContent = 'This account is not authorized for super admin access';
                showToast('Access denied');
                setLoading(false);
                return;
            }

            // Keep super admin identity isolated from staff dashboard session.
            sessionStorage.removeItem('chemtest_staff');
            setSuperAdminSession({
                email: payload.staff.email,
                name: payload.staff.name,
                role: payload.staff.role,
                token: payload.token,
            });

            showToast('Login successful');
            redirectTrace('Login success -> navigating to superadmin-dashboard.html');
            setTimeout(() => {
                window.location.href = 'superadmin-dashboard.html';
            }, 350);
        } catch (_err) {
            redirectTrace('Login failed -> invalid credentials or API error');
            errEl.textContent = 'Invalid super admin credentials';
            showToast('Login failed');
            setLoading(false);
        }
    });
})();
