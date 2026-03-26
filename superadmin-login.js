(() => {
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
        const res = await fetch('/api/auth/staff/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
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

        if (!email || !password) {
            errEl.textContent = 'Enter email and password';
            return;
        }

        setLoading(true);
        try {
            const payload = await apiStaffLogin(email, password);
            const role = String(payload?.staff?.role || '');
            if (!/admin/i.test(role)) {
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
            setTimeout(() => {
                window.location.href = 'superadmin-dashboard.html';
            }, 350);
        } catch (_err) {
            errEl.textContent = 'Invalid super admin credentials';
            showToast('Login failed');
            setLoading(false);
        }
    });
})();
