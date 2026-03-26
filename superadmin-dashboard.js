(() => {
    function getSuperAdminSession() {
        try { return JSON.parse(sessionStorage.getItem('chemtest_superadmin') || 'null'); }
        catch { return null; }
    }

    const session = getSuperAdminSession();
    if (!session?.token) {
        window.location.replace('login.html');
        return;
    }

    const welcome = document.getElementById('welcome');
    welcome.textContent = `Welcome, ${session.name || session.email || 'Super Admin'} (${session.role || 'Super Admin'})`;

    const toastEl = document.getElementById('toast');
    function toast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('show');
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toastEl.classList.remove('show'), 2200);
    }

    function authHeaders(extra = {}) {
        return {
            Authorization: `Bearer ${session.token}`,
            ...extra,
        };
    }

    async function refreshStaff() {
        const list = document.getElementById('staffList');
        list.innerHTML = 'Loading...';
        try {
            const res = await fetch('/api/admin/staff', { headers: authHeaders() });
            if (!res.ok) throw new Error('Failed');
            const payload = await res.json();
            const staff = payload.staff || [];

            if (!staff.length) {
                list.innerHTML = '<div class="list-item"><div class="meta">No staff accounts found.</div></div>';
                return;
            }

            list.innerHTML = staff.map((s) => `
                <div class="list-item">
                    <div class="name">${escapeHtml(s.full_name)} <span style="color:#9db6e8">(${escapeHtml(s.role)})</span></div>
                    <div class="meta">${escapeHtml(s.email)} · ${s.is_active ? 'Active' : 'Inactive'}</div>
                </div>
            `).join('');
        } catch (_err) {
            list.innerHTML = '<div class="list-item"><div class="meta" style="color:#ffb8c7">Failed to load staff list.</div></div>';
        }
    }

    function escapeHtml(v) {
        return String(v || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    document.getElementById('staffForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('staffMsg');
        msg.textContent = '';

        const email = String(document.getElementById('staffEmail').value || '').trim();
        const fullName = String(document.getElementById('staffName').value || '').trim();
        const role = String(document.getElementById('staffRole').value || '').trim() || 'Chemistry Teacher';
        const password = String(document.getElementById('staffPassword').value || '');

        if (!email || !fullName || !password) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Please fill all required fields.';
            return;
        }

        try {
            const res = await fetch('/api/admin/staff', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ email, fullName, role, password }),
            });
            const payload = await res.json();
            if (!res.ok) throw new Error(payload?.error || 'Failed to save staff');

            msg.style.color = '#9de9ff';
            msg.textContent = `Saved: ${payload.staff.full_name} (${payload.staff.email})`;
            toast('Staff saved');
            document.getElementById('staffPassword').value = '';
            refreshStaff();
        } catch (err) {
            msg.style.color = '#ffb8c7';
            msg.textContent = err.message || 'Failed to save staff';
        }
    });

    document.getElementById('importForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('importMsg');
        msg.textContent = '';

        const stream = String(document.getElementById('stream').value || '').trim();
        const file = document.getElementById('studentFile').files?.[0];
        if (!file) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Please choose an Excel file.';
            return;
        }

        try {
            const formData = new FormData();
            formData.append('file', file);
            formData.append('stream', stream);

            const res = await fetch('/api/admin/students/import', {
                method: 'POST',
                headers: authHeaders(),
                body: formData,
            });
            const payload = await res.json();
            if (!res.ok) throw new Error(payload?.error || 'Import failed');

            const streamInfo = Object.entries(payload.streams || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');

            msg.style.color = '#9de9ff';
            msg.textContent = `Imported ${payload.total} rows (new: ${payload.inserted}, updated: ${payload.updated})${streamInfo ? ' · ' + streamInfo : ''}`;
            toast('Student import complete');
            document.getElementById('studentFile').value = '';
        } catch (err) {
            msg.style.color = '#ffb8c7';
            msg.textContent = err.message || 'Import failed';
        }
    });

    document.getElementById('refreshBtn').addEventListener('click', refreshStaff);

    document.getElementById('logoutBtn').addEventListener('click', () => {
        sessionStorage.removeItem('chemtest_superadmin');
        sessionStorage.removeItem('chemtest_staff');
        window.location.replace('login.html');
    });

    refreshStaff();
})();
