(() => {
    function getSuperAdminSession() {
        try { return JSON.parse(sessionStorage.getItem('chemtest_superadmin') || 'null'); }
        catch { return null; }
    }

    const session = getSuperAdminSession();
    if (!session?.token) {
        window.location.replace('superadmin-login.html');
        return;
    }

    function handleAuthExpired() {
        sessionStorage.removeItem('chemtest_superadmin');
        sessionStorage.removeItem('chemtest_staff');
        alert('Session expired. Please login again.');
        window.location.replace('superadmin-login.html');
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

    async function apiJson(url, options = {}) {
        const headers = {
            ...authHeaders(),
            ...(options.headers || {}),
        };
        const res = await fetch(url, { ...options, headers });
        const payload = await res.json().catch(() => ({}));
        if (res.status === 401) {
            handleAuthExpired();
            throw new Error('Unauthorized');
        }
        if (!res.ok) throw new Error(payload?.error || `Request failed (${res.status})`);
        return payload;
    }

    async function refreshStaff() 
    {
        const list = document.getElementById('staffList');
        list.innerHTML = 'Loading...';
        try {
            const payload = await apiJson('/api/admin/staff');
            const staff = payload.staff || [];

            if (!staff.length) {
                list.innerHTML = '<div class="list-item"><div class="meta">No staff accounts found.</div></div>';
                return;
            }

            list.innerHTML = staff.map((s) => `
                <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                    <div style="flex:1;">
                        <div class="name">${escapeHtml(s.full_name)} <span style="color:#9db6e8">(${escapeHtml(s.role)})</span></div>
                        <div class="meta">${escapeHtml(s.email)} · ${s.is_active ? '✓ Active' : '✗ Inactive'}</div>
                    </div>
                    <button class="btn ghost staff-remove-btn" data-email="${escapeHtml(s.email)}" data-name="${escapeHtml(s.full_name)}" type="button" style="padding:6px 10px;font-size:0.85rem;${!s.is_active ? 'opacity:0.5;cursor:default;' : ''}">Remove</button>
                </div>
            `).join('');

            // Add event listeners to remove buttons
            list.querySelectorAll('.staff-remove-btn').forEach((btn) => {
                if (btn.dataset.email === session.email) {
                    btn.disabled = true;
                    btn.textContent = 'Cannot remove self';
                    btn.style.cursor = 'not-allowed';
                    btn.style.opacity = '0.5';
                    return;
                }
                
                btn.addEventListener('click', async () => {
                    const email = btn.dataset.email;
                    const name = btn.dataset.name;
                    if (!confirm(`Delete staff "${name}" (${email}) permanently? This will remove their account and related mappings.`)) {
                        return;
                    }
                    try {
                        await apiJson(`/api/admin/staff/${encodeURIComponent(email)}`, { method: 'DELETE' });
                        toast(`Staff "${name}" deleted`);
                        await refreshStaff();
                    } catch (err) {
                        if (String(err?.message || '').toLowerCase().includes('unauthorized')) return;
                        alert(`Error removing staff: ${err.message}`);
                    }
                });
            });
        } catch (err) {
            if (String(err?.message || '').toLowerCase().includes('unauthorized')) return;
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
            const payload = await apiJson('/api/admin/staff', {
                method: 'POST',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ email, fullName, role, password }),
            });

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

    function initSuperAdminMenu() {
        const menuButtons = Array.from(document.querySelectorAll('.admin-menu-btn'));
        const panels = Array.from(document.querySelectorAll('.menu-panel'));
        if (!menuButtons.length || !panels.length) return;

        function showPanel(targetKey) {
            menuButtons.forEach((btn) => {
                const active = btn.dataset.menuTarget === targetKey;
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-selected', active ? 'true' : 'false');
            });

            panels.forEach((panelEl) => {
                const active = panelEl.dataset.panel === targetKey;
                panelEl.hidden = !active;
                panelEl.classList.toggle('active', active);
            });
        }

        menuButtons.forEach((btn) => {
            btn.addEventListener('click', () => showPanel(btn.dataset.menuTarget));
        });

        showPanel('staff');
    }

    function initAssignmentPanel() {
        const shell = document.querySelector('main.shell');
        if (!shell) return;

        const panel = document.createElement('div');
        panel.className = 'menu-panel';
        panel.dataset.panel = 'assignments';
        panel.hidden = true;
        panel.innerHTML = `
            <div style="margin-bottom:24px;">
                <h2 style="margin-bottom:12px;">Student-Teacher Assignment</h2>
                <p style="color:var(--muted);font-size:0.9rem;">Select students, choose a teacher and subject, then assign or manage assignments in bulk.</p>
            </div>
            
            <div class="grid">
                <section class="card" style="grid-column:1 / -1;">
                    <div class="head-row">
                        <h3 style="font-size:1rem;">1️⃣ Select Students</h3>
                        <div style="display:flex;gap:6px;">
                            <button class="btn ghost" type="button" id="assignSelectAllBtn" style="font-size:0.85rem;">Select All</button>
                            <button class="btn ghost" type="button" id="assignClearAllBtn" style="font-size:0.85rem;">Clear All</button>
                        </div>
                    </div>
                    <input id="assignStudentSearch" type="text" placeholder="🔍 Search by register no or name..." style="width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:11px 12px;font-size:0.9rem;margin-bottom:12px;" />
                    <div id="assignStudentList" style="border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);padding:12px 0;max-height:360px;overflow-y:auto;font-size:0.88rem;"></div>
                </section>

                <section class="card">
                    <h3 style="font-size:1rem;margin-bottom:12px;">2️⃣ Select Teacher</h3>
                    <select id="assignStaff" required style="width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:11px 12px;font-size:0.9rem;"></select>
                </section>

                <section class="card">
                    <h3 style="font-size:1rem;margin-bottom:12px;">3️⃣ Select Subject</h3>
                    <select id="assignSubject" required style="width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:11px 12px;font-size:0.9rem;"></select>
                </section>
            </div>

            <section class="card" style="margin-top:24px;">
                <div class="head-row">
                    <h3 style="font-size:1rem;">Actions</h3>
                </div>
                <form id="assignForm" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
                    <button class="btn primary" type="submit" style="flex:1;min-width:200px;">✓ Assign Selected Students</button>
                    <button class="btn" type="button" id="assignBulkDeleteBtn" style="flex:1;min-width:200px;">✕ Delete All Assignments</button>
                </form>
                <p id="assignMsg" class="msg"></p>
            </section>

            <section class="card" style="margin-top:24px;">
                <div class="head-row">
                    <h3 style="font-size:1rem;">📋 Current Assignments</h3>
                    <button class="btn ghost" id="assignRefreshBtn" type="button">Refresh</button>
                </div>
                <div id="assignMatrix" class="list"></div>
            </section>
        `;
        shell.appendChild(panel);

        const studentList = panel.querySelector('#assignStudentList');
        const studentSearch = panel.querySelector('#assignStudentSearch');
        const staffSel = panel.querySelector('#assignStaff');
        const subjectSel = panel.querySelector('#assignSubject');
        const msg = panel.querySelector('#assignMsg');
        const matrix = panel.querySelector('#assignMatrix');
        let allStudents = [];

        function setMsg(text, isError = false) {
            msg.style.color = isError ? '#ffb8c7' : '#9de9ff';
            msg.textContent = text;
        }

        function fillSelect(selectEl, items, valueKey, labelBuilder) {
            if (!items.length) {
                selectEl.innerHTML = '<option value="">No data</option>';
                return;
            }
            selectEl.innerHTML = items.map((it) => {
                const value = escapeHtml(String(it[valueKey] || ''));
                const label = escapeHtml(labelBuilder(it));
                return `<option value="${value}">${label}</option>`;
            }).join('');
        }

        function getSelectedStudentRegNos() {
            const checkboxes = studentList.querySelectorAll('input[type="checkbox"]:checked');
            return Array.from(checkboxes).map((cb) => cb.value);
        }

        function renderStudentOptions(queryText = '') {
            const q = String(queryText || '').trim().toLowerCase();
            const filtered = q
                ? allStudents.filter((s) =>
                    String(s.reg_no || '').toLowerCase().includes(q) ||
                    String(s.full_name || '').toLowerCase().includes(q)
                )
                : allStudents;

            if (!filtered.length) {
                studentList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);">No matching students found</div>';
                return;
            }

            studentList.innerHTML = filtered.map((s) => {
                const regNo = escapeHtml(String(s.reg_no || ''));
                const fullName = escapeHtml(String(s.full_name || ''));
                return `
                    <label style="display:flex;align-items:center;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;transition:background-color 0.2s;">
                        <input type="checkbox" value="${regNo}" style="margin-right:12px;cursor:pointer;width:18px;height:18px;" />
                        <div style="flex:1;">
                            <div style="font-weight:600;color:var(--text);">${regNo}</div>
                            <div style="font-size:0.85rem;color:var(--muted);">${fullName}</div>
                        </div>
                    </label>
                `;
            }).join('');

            // Add hover effect
            const labels = studentList.querySelectorAll('label');
            labels.forEach((label) => {
                label.addEventListener('mouseenter', () => {
                    label.style.backgroundColor = 'var(--panel)';
                });
                label.addEventListener('mouseleave', () => {
                    label.style.backgroundColor = 'transparent';
                });
            });
        }

        async function loadOptions() {
            try {
                const [studentsPayload, staffPayload, subjectsPayload] = await Promise.all([
                    apiJson('/api/admin/students'),
                    apiJson('/api/admin/staff'),
                    apiJson('/api/admin/subjects'),
                ]);

                const students = (studentsPayload.students || []).filter((s) => s.reg_no);
                const staff = (staffPayload.staff || []).filter((s) => s.email && s.is_active);
                const subjects = (subjectsPayload.subjects || []).filter((s) => s.id && s.is_active);

                allStudents = students;
                renderStudentOptions(studentSearch.value);
                fillSelect(staffSel, staff, 'email', (s) => `${s.email} - ${s.full_name || ''}`);
                fillSelect(subjectSel, subjects, 'id', (s) => `${s.code || ''} - ${s.name || ''}`);
            } catch (err) {
                setMsg(err.message || 'Failed to load dropdown data', true);
            }
        }

        studentSearch.addEventListener('input', () => {
            renderStudentOptions(studentSearch.value);
        });

        async function refreshMatrix() {
            matrix.innerHTML = 'Loading...';
            try {
                const payload = await apiJson('/api/admin/assignments/matrix');
                const assignments = payload.assignments || [];
                if (!assignments.length) {
                    matrix.innerHTML = '<div class="list-item"><div class="meta">No assignments found.</div></div>';
                    return;
                }
                matrix.innerHTML = assignments.map((a) => `
                    <div class="list-item">
                        <div class="name">${escapeHtml(a.student_name || a.reg_no)} → ${escapeHtml(a.staff_name || a.staff_email)}</div>
                        <div class="meta">${escapeHtml(a.reg_no || '')} · ${escapeHtml(a.staff_email || '')} · ${escapeHtml(a.subject_code || '')}</div>
                    </div>
                `).join('');
            } catch (err) {
                matrix.innerHTML = `<div class="list-item"><div class="meta" style="color:#ffb8c7">${escapeHtml(err.message || 'Failed to load assignment matrix')}</div></div>`;
            }
        }

        panel.querySelector('#assignForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const selectedRegNos = getSelectedStudentRegNos();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);
            
            if (!selectedRegNos.length || !staffEmail || !subjectId) {
                setMsg('Select at least one student, teacher, and subject', true);
                return;
            }

            try {
                let assigned = 0;
                for (const regNo of selectedRegNos) {
                    try {
                        await apiJson('/api/admin/assign/student-staff-subject', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ regNo, staffEmail, subjectId }),
                        });
                        assigned++;
                    } catch (_err) {
                        // Continue with other students even if one fails
                    }
                }
                setMsg(`Assigned ${assigned}/${selectedRegNos.length} students to ${staffEmail}`);
                toast(`${assigned} assignments saved`);
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Failed to save assignment', true);
            }
        });

        panel.querySelector('#assignBulkDeleteBtn').addEventListener('click', async () => {
            const selectedRegNos = getSelectedStudentRegNos();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);
            
            if (!selectedRegNos.length || !staffEmail || !subjectId) {
                setMsg('Select at least one student, teacher, and subject', true);
                return;
            }

            if (!confirm(`Delete all assignments for ${selectedRegNos.length} student(s) under ${staffEmail}? This cannot be undone.`)) {
                return;
            }

            try {
                let deleted = 0;
                for (const regNo of selectedRegNos) {
                    try {
                        await apiJson('/api/admin/assign/student-staff-subject', {
                            method: 'DELETE',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ regNo, staffEmail, subjectId }),
                        });
                        deleted++;
                    } catch (_err) {
                        // Continue with other students even if one fails
                    }
                }
                setMsg(`Deleted all assignments for ${deleted}/${selectedRegNos.length} students under ${staffEmail}`);
                toast(`${deleted} assignments deleted`);
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Failed to delete assignments', true);
            }
        });

        panel.querySelector('#assignSelectAllBtn').addEventListener('click', () => {
            const checkboxes = studentList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach((cb) => { cb.checked = true; });
            setMsg(`Selected ${checkboxes.length} students`);
        });

        panel.querySelector('#assignClearAllBtn').addEventListener('click', () => {
            const checkboxes = studentList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach((cb) => { cb.checked = false; });
            setMsg('Cleared all selections');
        });

        panel.querySelector('#assignRefreshBtn').addEventListener('click', async () => {
            await loadOptions();
            await refreshMatrix();
        });

        loadOptions();
        refreshMatrix();
    }

    function initAdminOpsPanel() {
        const shell = document.querySelector('main.shell');
        if (!shell) return;

        const panel = document.createElement('section');
        panel.className = 'card menu-panel';
        panel.dataset.panel = 'operations';
        panel.hidden = true;
        panel.innerHTML = `
            <div class="head-row">
                <h2>Operations Panel</h2>
                <button class="btn ghost" id="opsRefreshAuditBtn" type="button">Refresh Audit</button>
            </div>
            <div style="display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));">
                <form id="opsStaffActionForm" class="form" novalidate>
                    <label for="opsStaffEmail">Staff Email/Username</label>
                    <input id="opsStaffEmail" type="text" placeholder="e.g. unitaryx" required />
                    <label for="opsStaffPassword">New Password (for reset)</label>
                    <input id="opsStaffPassword" type="text" placeholder="Minimum 6 characters" />
                    <div style="display:flex;gap:8px;flex-wrap:wrap;">
                        <button class="btn" type="button" id="opsActivateBtn">Activate</button>
                        <button class="btn" type="button" id="opsDeactivateBtn">Deactivate</button>
                        <button class="btn primary" type="button" id="opsResetPwBtn">Reset PW</button>
                    </div>
                    <p id="opsStaffMsg" class="msg"></p>
                </form>

                <form id="opsPolicyForm" class="form" novalidate>
                    <label for="opsPolicyEmail">Policy Target Email</label>
                    <input id="opsPolicyEmail" type="text" placeholder="e.g. unitaryx" required />
                    <label for="opsPolicyJson">Permissions JSON</label>
                    <input id="opsPolicyJson" type="text" value='{"sendAnnouncements":true,"uploadMaterials":true}' />
                    <button class="btn" type="submit">Upsert Policy</button>
                    <p id="opsPolicyMsg" class="msg"></p>
                </form>

                <form id="opsDryRunForm" class="form" novalidate>
                    <label for="opsDryRunFile">Dry-Run Student Import File</label>
                    <input id="opsDryRunFile" type="file" accept=".xlsx,.xls,.csv" required />
                    <button class="btn" type="submit">Run Dry-Run</button>
                    <p id="opsDryRunMsg" class="msg"></p>
                </form>
            </div>
            <div style="margin-top:14px;display:grid;gap:8px;">
                <label style="font-size:0.76rem;color:var(--muted);font-weight:800;letter-spacing:0.02em;">Audit Logs (latest 25)</label>
                <div id="opsAuditList" class="list"></div>
            </div>
        `;
        shell.appendChild(panel);

        const staffMsg = panel.querySelector('#opsStaffMsg');
        const policyMsg = panel.querySelector('#opsPolicyMsg');
        const dryRunMsg = panel.querySelector('#opsDryRunMsg');

        async function runStaffAction(kind) {
            const email = String(panel.querySelector('#opsStaffEmail').value || '').trim();
            const password = String(panel.querySelector('#opsStaffPassword').value || '').trim();
            if (!email) {
                staffMsg.style.color = '#ffb8c7';
                staffMsg.textContent = 'Enter staff email/username';
                return;
            }
            try {
                if (kind === 'activate') {
                    await apiJson(`/api/admin/staff/${encodeURIComponent(email)}/activate`, { method: 'POST' });
                } else if (kind === 'deactivate') {
                    await apiJson(`/api/admin/staff/${encodeURIComponent(email)}/deactivate`, { method: 'POST' });
                } else {
                    if (password.length < 6) throw new Error('Password must be at least 6 characters');
                    await apiJson(`/api/admin/staff/${encodeURIComponent(email)}/reset-password`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password }),
                    });
                }
                staffMsg.style.color = '#9de9ff';
                staffMsg.textContent = `Success: ${kind} updated for ${email}`;
                toast(`Staff ${kind} success`);
                refreshStaff();
            } catch (err) {
                staffMsg.style.color = '#ffb8c7';
                staffMsg.textContent = err.message || 'Action failed';
            }
        }

        panel.querySelector('#opsActivateBtn').addEventListener('click', () => runStaffAction('activate'));
        panel.querySelector('#opsDeactivateBtn').addEventListener('click', () => runStaffAction('deactivate'));
        panel.querySelector('#opsResetPwBtn').addEventListener('click', () => runStaffAction('reset-password'));

        panel.querySelector('#opsPolicyForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const email = String(panel.querySelector('#opsPolicyEmail').value || '').trim();
            const jsonText = String(panel.querySelector('#opsPolicyJson').value || '').trim();
            if (!email || !jsonText) {
                policyMsg.style.color = '#ffb8c7';
                policyMsg.textContent = 'Email and policy JSON are required';
                return;
            }
            try {
                const permissions = JSON.parse(jsonText);
                await apiJson(`/api/admin/role-policies/${encodeURIComponent(email)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ permissions }),
                });
                policyMsg.style.color = '#9de9ff';
                policyMsg.textContent = `Policy saved for ${email}`;
                toast('Role policy saved');
            } catch (err) {
                policyMsg.style.color = '#ffb8c7';
                policyMsg.textContent = err.message || 'Policy update failed';
            }
        });

        panel.querySelector('#opsDryRunForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const file = panel.querySelector('#opsDryRunFile').files?.[0];
            if (!file) {
                dryRunMsg.style.color = '#ffb8c7';
                dryRunMsg.textContent = 'Choose a file for dry-run';
                return;
            }
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('dryRun', 'true');
                const res = await fetch('/api/admin/students/import', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: formData,
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload?.error || 'Dry-run failed');
                dryRunMsg.style.color = '#9de9ff';
                dryRunMsg.textContent = `Dry-run rows: ${payload.total || 0} (preview: ${(payload.preview || []).length})`;
                toast('Dry-run complete');
            } catch (err) {
                dryRunMsg.style.color = '#ffb8c7';
                dryRunMsg.textContent = err.message || 'Dry-run failed';
            }
        });

        async function refreshAudit() {
            const list = panel.querySelector('#opsAuditList');
            list.innerHTML = 'Loading...';
            try {
                const payload = await apiJson('/api/superadmin/audit-logs?limit=25');
                const logs = payload.logs || [];
                if (!logs.length) {
                    list.innerHTML = '<div class="list-item"><div class="meta">No audit logs found.</div></div>';
                    return;
                }
                list.innerHTML = logs.map((l) => `
                    <div class="list-item">
                        <div class="name">${escapeHtml(l.action || 'action')}</div>
                        <div class="meta">${escapeHtml(l.actor || '')} · ${escapeHtml(l.target_type || '')} · ${escapeHtml(String(l.target_id || ''))}</div>
                    </div>
                `).join('');
            } catch (_err) {
                list.innerHTML = '<div class="list-item"><div class="meta" style="color:#ffb8c7">Failed to load audit logs.</div></div>';
            }
        }

        panel.querySelector('#opsRefreshAuditBtn').addEventListener('click', refreshAudit);
        refreshAudit();
    }

    initAssignmentPanel();
    initAdminOpsPanel();
    initSuperAdminMenu();
    refreshStaff();
})();
