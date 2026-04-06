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

    async function downloadStudentTemplate() {
        const res = await fetch('/api/admin/students/template', {
            method: 'GET',
            headers: authHeaders(),
        });
        if (res.status === 401) {
            handleAuthExpired();
            throw new Error('Unauthorized');
        }
        if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            throw new Error(payload?.error || `Template download failed (${res.status})`);
        }

        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = 'students-import-template.xlsx';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(href);
    }

    async function refreshStaff() {
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
                    <button class="btn ghost staff-remove-btn" data-email="${escapeHtml(s.email)}" data-name="${escapeHtml(s.full_name)}" type="button" ${s.is_active ? '' : 'disabled'} style="padding:6px 10px;font-size:0.85rem;${s.is_active ? '' : 'opacity:0.5;cursor:not-allowed;'}">Remove</button>
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

                if (btn.disabled) {
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

    async function refreshStudents() {
        const list = document.getElementById('studentsList');
        if (!list) return;
        list.innerHTML = 'Loading...';
        try {
            const payload = await apiJson('/api/admin/students');
            const students = payload.students || [];

            if (!students.length) {
                list.innerHTML = '<div class="list-item"><div class="meta">No students found.</div></div>';
                return;
            }

            list.innerHTML = students.map((student) => `
                <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                    <div style="flex:1;min-width:0;">
                        <div class="name">${escapeHtml(student.full_name || '')}</div>
                        <div class="meta">${escapeHtml(student.reg_no || '')} · ${escapeHtml(student.stream || 'Unspecified')} · ${escapeHtml(student.section || 'Unspecified')}</div>
                    </div>
                    <button class="btn ghost student-delete-btn" data-reg-no="${escapeHtml(student.reg_no || '')}" data-name="${escapeHtml(student.full_name || '')}" type="button" style="padding:6px 10px;font-size:0.85rem;border-color:#ffb8c7;color:#ffb8c7;">Delete</button>
                </div>
            `).join('');

            list.querySelectorAll('.student-delete-btn').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const regNo = btn.dataset.regNo;
                    const name = btn.dataset.name || regNo;
                    if (!regNo) return;
                    if (!confirm(`Delete student "${name}" (${regNo}) permanently? This removes assignments, login access, and related records.`)) {
                        return;
                    }
                    try {
                        await apiJson(`/api/admin/students/${encodeURIComponent(regNo)}`, { method: 'DELETE' });
                        toast(`Student "${name}" deleted`);
                        await refreshStudents();
                    } catch (err) {
                        if (String(err?.message || '').toLowerCase().includes('unauthorized')) return;
                        alert(`Error deleting student: ${err.message}`);
                    }
                });
            });
        } catch (err) {
            if (String(err?.message || '').toLowerCase().includes('unauthorized')) return;
            list.innerHTML = '<div class="list-item"><div class="meta" style="color:#ffb8c7">Failed to load student list.</div></div>';
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

    function parseImportStreamSection(input) {
        const raw = String(input || '').trim();
        if (!raw) return { stream: '', section: '' };

        const match = raw.match(/^(.+?)[\s-]+([A-Za-z0-9]+)$/);
        if (!match) {
            return { stream: raw.toUpperCase(), section: '' };
        }

        const stream = String(match[1] || '').trim().toUpperCase();
        const section = String(match[2] || '').trim().toUpperCase();
        if (!stream || !section) {
            return { stream: raw.toUpperCase(), section: '' };
        }
        return { stream, section };
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

        const streamInput = String(document.getElementById('stream').value || '').trim();
        const sectionInput = String(document.getElementById('importSection')?.value || '').trim();
        const parsed = parseImportStreamSection(streamInput);
        const stream = parsed.stream;
        const section = String(sectionInput || parsed.section || '').trim().toUpperCase();
        const file = document.getElementById('studentFile').files?.[0];
        if (!section) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Target Section is required.';
            return;
        }
        if (!file) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Please choose an Excel file.';
            return;
        }

        try {
            const formData = new FormData();
            formData.append('file', file);
            if (stream) formData.append('stream', stream);
            if (section) formData.append('section', section);
            const payload = await apiJson('/api/admin/students/import', {
                method: 'POST',
                body: formData,
            });

            const streamInfo = Object.entries(payload.streams || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            const sectionInfo = Object.entries(payload.sections || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');

            msg.style.color = '#9de9ff';
            msg.textContent = `Processed ${payload.total} rows (new: ${payload.inserted || 0}, updated: ${payload.updated || 0}, unchanged: ${payload.skipped || 0})${streamInfo ? ' · Depts: ' + streamInfo : ''}${sectionInfo ? ' · Sections: ' + sectionInfo : ''}`;
            toast('Student import complete');
            document.getElementById('studentFile').value = '';
            const sectionInputEl = document.getElementById('importSection');
            if (sectionInputEl) sectionInputEl.value = '';
            await refreshStudents();
        } catch (err) {
            msg.style.color = '#ffb8c7';
            msg.textContent = err.message || 'Import failed';
        }
    });

    document.getElementById('manualImportForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = document.getElementById('manualImportMsg');
        if (!msg) return;
        msg.textContent = '';

        const regNoInput = String(document.getElementById('manualRegNo')?.value || '').trim().toUpperCase();
        const fullNameInput = String(document.getElementById('manualFullName')?.value || '').trim();
        const passwordInput = String(document.getElementById('manualPassword')?.value || '');
        const streamInput = String(document.getElementById('manualStream')?.value || '').trim();
        const sectionInput = String(document.getElementById('manualSection')?.value || '').trim();

        const parsed = parseImportStreamSection(streamInput);
        const stream = parsed.stream;
        const section = String(sectionInput || parsed.section || '').trim().toUpperCase();

        if (!regNoInput || !fullNameInput) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Register number and student name are required.';
            return;
        }

        if (!passwordInput || passwordInput.length < 6) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Password is required and must be at least 6 characters.';
            return;
        }

        if (!section) {
            msg.style.color = '#ffb8c7';
            msg.textContent = 'Target Section is required.';
            return;
        }

        try {
            const formData = new FormData();
            if (stream) formData.append('stream', stream);
            formData.append('section', section);
            formData.append('manualStudents', `${regNoInput} | ${fullNameInput} | ${stream || ''} | ${section}`);

            const payload = await apiJson('/api/admin/students/import', {
                method: 'POST',
                body: formData,
            });

            await apiJson(`/api/superadmin/student-passwords/${encodeURIComponent(regNoInput)}/reset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: passwordInput }),
            });

            const streamInfo = Object.entries(payload.streams || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            const sectionInfo = Object.entries(payload.sections || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');

            msg.style.color = '#9de9ff';
            msg.textContent = `Processed ${payload.total} rows (new: ${payload.inserted || 0}, updated: ${payload.updated || 0}, unchanged: ${payload.skipped || 0})${streamInfo ? ' · Depts: ' + streamInfo : ''}${sectionInfo ? ' · Sections: ' + sectionInfo : ''}`;
            toast('Manual students saved');

            const manualRegNoEl = document.getElementById('manualRegNo');
            if (manualRegNoEl) manualRegNoEl.value = '';
            const manualFullNameEl = document.getElementById('manualFullName');
            if (manualFullNameEl) manualFullNameEl.value = '';
            const manualPasswordEl = document.getElementById('manualPassword');
            if (manualPasswordEl) manualPasswordEl.value = '';
            const manualSectionEl = document.getElementById('manualSection');
            if (manualSectionEl) manualSectionEl.value = '';

            await refreshStudents();
        } catch (err) {
            msg.style.color = '#ffb8c7';
            msg.textContent = err.message || 'Manual import failed';
        }
    });

    const downloadTemplateBtn = document.getElementById('downloadTemplateBtn');
    if (downloadTemplateBtn) {
        downloadTemplateBtn.addEventListener('click', async () => {
            const msg = document.getElementById('importMsg');
            try {
                await downloadStudentTemplate();
                if (msg) {
                    msg.style.color = '#9de9ff';
                    msg.textContent = 'Template downloaded';
                }
                toast('Template downloaded');
            } catch (err) {
                if (msg) {
                    msg.style.color = '#ffb8c7';
                    msg.textContent = err.message || 'Failed to download template';
                }
            }
        });
    }

    const refreshStudentsBtn = document.getElementById('refreshStudentsBtn');
    if (refreshStudentsBtn) {
        refreshStudentsBtn.addEventListener('click', () => refreshStudents());
    }

    document.getElementById('refreshBtn').addEventListener('click', refreshStaff);

    document.getElementById('logoutBtn').addEventListener('click', () => {
        sessionStorage.removeItem('chemtest_superadmin');
        sessionStorage.removeItem('chemtest_staff');
        window.location.replace('superadmin-login.html');
    });

    function initSuperAdminMenu() {
        refreshStudents();
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

        function activateMenuTarget(targetKey) {
            if (!targetKey) return;
            showPanel(targetKey);
            if (targetKey === 'assignments' && typeof refreshAssignments === 'function') {
                refreshAssignments();
            }
            if (targetKey === 'operations') {
                if (typeof refreshDbStatus === 'function') refreshDbStatus();
                if (typeof refreshSubjects === 'function') refreshSubjects();
            }
            if (targetKey === 'passwords' && typeof refreshPasswords === 'function') {
                refreshPasswords();
            }
        }

        menuButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                activateMenuTarget(btn.dataset.menuTarget);
            });

            // iOS/Android fallback: ensure touch can switch panels even if click is delayed.
            btn.addEventListener('pointerup', (e) => {
                if (e.pointerType === 'touch') {
                    e.preventDefault();
                    activateMenuTarget(btn.dataset.menuTarget);
                }
            });
        });

        const menuContainer = document.querySelector('.admin-menu');
        if (menuContainer) {
            menuContainer.addEventListener('touchend', (e) => {
                const targetBtn = e.target.closest('.admin-menu-btn');
                if (!targetBtn) return;
                e.preventDefault();
                activateMenuTarget(targetBtn.dataset.menuTarget);
            }, { passive: false });
        }

        window.__openSuperadminPanel = activateMenuTarget;

        // Initialize with first panel
        activateMenuTarget('staff');
    }

    let refreshAssignments = () => { };
    let refreshDbStatus = () => { };
    let refreshSubjects = () => { };
    let refreshPasswords = () => { };

    function initAssignmentPanel() {
        const mount = document.getElementById('assignmentsMount');
        if (!mount) return;

        mount.innerHTML = `
            <div style="margin-bottom:24px;">
                <h2 style="margin-bottom:8px;">Student Control & Teacher Mapping</h2>
                <p style="color:var(--muted);font-size:0.85rem;">Manage batch assignments between students, teachers, and subjects.</p>
            </div>
            
            <div class="grid">
                <section class="card" style="grid-column: 1 / -1;">
                    <div class="head-row">
                        <h3 style="font-size:1rem;margin:0;">1️⃣ Select Students to Assign</h3>
                        <div style="display:flex;gap:8px;">
                            <button class="btn ghost" type="button" id="assignSelectAllBtn">Select All</button>
                            <button class="btn ghost" type="button" id="assignClearAllBtn">Clear Selection</button>
                        </div>
                    </div>
                    
                    <div class="row" style="margin-top:12px;">
                        <div class="col" style="flex:2;">
                            <input id="assignStudentSearch" type="text" placeholder="🔍 Find students by name or reg no..." />
                        </div>
                        <div class="col">
                            <select id="assignDeptFilter" class="input-select" style="width:100%;height:100%;background:var(--panel-strong);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:0 12px;">
                                <option value="all">All Depts</option>
                            </select>
                        </div>
                        <div class="col">
                            <select id="assignSectionFilter" class="input-select" style="width:100%;height:100%;background:var(--panel-strong);border:1px solid var(--line);border-radius:12px;color:var(--text);padding:0 12px;">
                                <option value="" selected disabled>Select Section (A3/A7)</option>
                                <option value="all">◆ All Sections</option>
                                <option value="A3">🔹 A3</option>
                                <option value="A7">🔹 A7</option>
                            </select>
                        </div>
                        </div>
                    </div>
                    <div id="assignStudentList" style="border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);padding:12px 0;max-height:360px;overflow-y:auto;font-size:0.88rem;"></div>
                </section>

            </div>

            <section class="card" style="margin-top:24px;">
                <div class="head-row">
                    <h3 style="font-size:1rem;">Actions</h3>
                </div>
                <div class="row" style="margin-bottom:12px;">
                    <div class="col">
                        <label style="display:block;font-size:0.82rem;color:var(--muted);margin-bottom:6px;">Select Teacher</label>
                        <select id="assignStaff" required style="width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:11px 12px;font-size:0.9rem;"></select>
                    </div>
                    <div class="col">
                        <label style="display:block;font-size:0.82rem;color:var(--muted);margin-bottom:6px;">Select Subject</label>
                        <select id="assignSubject" required style="width:100%;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:11px 12px;font-size:0.9rem;"></select>
                    </div>
                </div>
                <div style="display:grid;gap:10px;margin-bottom:14px;">
                    <div style="display:flex;gap:10px;flex-wrap:wrap;">
                        <button class="btn" type="button" id="assignSubjectToStaffBtn" style="flex:1;min-width:220px;">Assign Subject to Teacher</button>
                        <button class="btn" type="button" id="assignSubjectToStudentsBtn" style="flex:1;min-width:260px;">Assign Subject to Selected Students</button>
                        <button class="btn" type="button" id="unassignSubjectFromStudentsBtn" style="flex:1;min-width:280px;border-color:#ffb8c7;color:#ffb8c7;">Unassign Subject from Selected Students</button>
                    </div>
                </div>
                <form id="assignForm" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
                    <button class="btn primary" type="submit" id="assignSelectedBtn" style="flex:1;min-width:200px;">✓ Assign Selected Students</button>
                    <button class="btn" type="button" id="assignAllFilteredBtn" style="flex:1;min-width:200px;background:var(--accent);color:white;">⚡ Assign All Filtered Students</button>
                    <button class="btn" type="button" id="assignBulkDeleteBtn" style="flex:1;min-width:200px;border-color:#ffb8c7;color:#ffb8c7;">✕ Unassign Selected</button>
                </form>
                <p id="assignMsg" class="msg"></p>
            </section>

            <section class="card" style="margin-top:24px;">
                <div class="head-row">
                    <h3 style="font-size:1rem;">📋 Current Assignments</h3>
                    <div style="display:flex;gap:8px;">
                        <button class="btn ghost" id="assignRefreshBtn" type="button">Refresh</button>
                    </div>
                </div>
                <div id="assignMatrix" class="list"></div>
            </section>
        `;
        const studentList = mount.querySelector('#assignStudentList');
        const studentSearch = mount.querySelector('#assignStudentSearch');
        const deptFilter = mount.querySelector('#assignDeptFilter');
        const sectionFilter = mount.querySelector('#assignSectionFilter');
        const staffSel = mount.querySelector('#assignStaff');
        const subjectSel = mount.querySelector('#assignSubject');
        const msg = mount.querySelector('#assignMsg');
        const matrix = mount.querySelector('#assignMatrix');
        let allStudents = [];

        function extractMetadata(s) {
            if (s && s.stream && s.section) {
                const rawStream = String(s.stream || '').trim().toUpperCase();
                const rawSec = String(s.section || '').trim().toUpperCase();
                const combined = `${rawStream} ${rawSec}`;

                // Support legacy combined formats like "AIDS-A7" or "AIDS-A-A7-C".
                const strictSecMatch = combined.match(/A[37]/);
                const secMatch = rawSec.match(/([A-Z]\d+)$/);
                const sec = strictSecMatch ? strictSecMatch[0] : (secMatch ? secMatch[1] : rawSec);

                let dept = rawStream
                    .replace(/[-_\s]*A[37]\b/g, '')
                    .replace(/[-_\s]+$/, '')
                    .trim();
                if (!dept) {
                    const deptFromSection = rawSec.match(/^([A-Z]+)/);
                    dept = deptFromSection ? deptFromSection[1] : 'OTHER';
                }

                const sectionTag = (dept && sec) ? `${dept}-${sec}` : (sec || 'Unknown');
                return { dept, sec, sectionTag, streamName: sectionTag };
            }
            const regNo = String(s.reg_no || s || '').trim();
            const match = regNo.match(/([A-Z]+)(\d+)$/i);
            if (!match) return { dept: 'OTHER', sec: 'Unknown', sectionTag: 'Unknown', streamName: 'Other' };

            const deptCode = match[1].toUpperCase();
            const rollInt = parseInt(match[2], 10);

            let deptLabel = deptCode;
            let sectionLetter = 'M';

            if (deptCode === 'BAD') {
                deptLabel = 'AIDS';
                if (rollInt <= 60) sectionLetter = 'A';
                else if (rollInt <= 120) sectionLetter = 'B';
                else sectionLetter = 'C';
            } else if (deptCode === 'BAM') {
                deptLabel = 'AIML';
                if (rollInt <= 60) sectionLetter = 'A';
                else if (rollInt <= 120) sectionLetter = 'B';
                else sectionLetter = 'C';
            } else if (deptCode === 'BCS') {
                deptLabel = 'CSE';
                if (rollInt <= 60) sectionLetter = 'A';
                else if (rollInt <= 120) sectionLetter = 'B';
                else if (rollInt <= 180) sectionLetter = 'C';
                else sectionLetter = 'D';
            } else if (deptCode === 'BIT') {
                deptLabel = 'IT';
                if (rollInt <= 60) sectionLetter = 'A';
                else if (rollInt <= 120) sectionLetter = 'B';
                else sectionLetter = 'C';
            } else if (deptCode === 'BSC') {
                deptLabel = 'CSBS';
                if (rollInt <= 60) sectionLetter = 'A';
                else if (rollInt <= 120) sectionLetter = 'B';
                else sectionLetter = 'C';
            } else {
                deptLabel = deptCode;
                sectionLetter = 'A';
            }

            const dept = String(deptLabel || '').trim().toUpperCase();
            const sec = String(sectionLetter || '').trim().toUpperCase();
            const sectionTag = (dept && sec) ? `${dept}-${sec}` : (sec || 'Unknown');
            return { dept, sec, sectionTag, streamName: `${dept}-${sec}` };
        }

        function populateFilters() {
            const deptSet = new Set();
            allStudents.forEach(s => {
                const { dept } = extractMetadata(s);
                if (dept && dept !== 'OTHER') deptSet.add(dept);
            });
            deptFilter.innerHTML = '<option value="all">All Departments</option>' +
                Array.from(deptSet).sort().map(d => `<option value="${d}">${d}</option>`).join('');
        }

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

        function renderStudentOptions() {
            const q = String(studentSearch.value || '').trim().toLowerCase();
            const dVal = deptFilter.value;
            const sVal = String(sectionFilter.value || '').trim().toUpperCase();

            if (!['ALL', 'A3', 'A7'].includes(sVal)) {
                studentList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);">Select Section A3, A7, or All Sections to view students</div>';
                return;
            }

            const filtered = allStudents.filter((s) => {
                const { dept, sec } = extractMetadata(s);
                const mQuery = !q || String(s.reg_no || '').toLowerCase().includes(q) || String(s.full_name || '').toLowerCase().includes(q);
                const mDept = dVal === 'all' || dVal === dept;
                const mSec = sVal === 'ALL' || sVal === sec;

                return mQuery && mDept && mSec;
            });

            if (!filtered.length) {
                studentList.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);">No matching students found</div>';
                return;
            }

            const groups = {};
            filtered.forEach(s => {
                const { streamName } = extractMetadata(s);
                const key = streamName;
                if (!groups[key]) groups[key] = [];
                groups[key].push(s);
            });

            const sortedKeys = Object.keys(groups).sort();

            let html = '';
            sortedKeys.forEach(k => {
                html += `<div style="padding:8px 12px; background:var(--bg-1); border-bottom:1px solid var(--line); border-top:1px solid var(--line); font-weight:800; color:var(--accent); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.06em;">Stream: ${k}</div>`;
                html += groups[k].map(s => {
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
            });
            studentList.innerHTML = html;

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
            const [studentsResult, staffResult, subjectsResult] = await Promise.allSettled([
                apiJson('/api/admin/students'),
                apiJson('/api/admin/staff'),
                apiJson('/api/admin/subjects'),
            ]);

            const students = studentsResult.status === 'fulfilled'
                ? (studentsResult.value.students || []).filter((s) => s.reg_no)
                : [];
            const staff = staffResult.status === 'fulfilled'
                ? (staffResult.value.staff || []).filter((s) => s.email && s.is_active)
                : [];
            const subjects = subjectsResult.status === 'fulfilled'
                ? (subjectsResult.value.subjects || []).filter((s) => s.id && s.is_active)
                : [];

            allStudents = students;
            populateFilters();
            renderStudentOptions();
            fillSelect(staffSel, staff, 'email', (s) => `${s.full_name || s.email || ''}`);
            fillSelect(subjectSel, subjects, 'id', (s) => `${s.name || ''}`);

            const failures = [studentsResult, staffResult, subjectsResult].filter((result) => result.status === 'rejected');
            if (failures.length) {
                const subjectFailure = subjectsResult.status === 'rejected' ? subjectsResult.reason : null;
                setMsg(subjectFailure?.message || 'Some dropdown data could not be loaded. You can still work with the data that did load.', true);
            }
        }

        studentSearch.addEventListener('input', renderStudentOptions);
        deptFilter.addEventListener('change', renderStudentOptions);
        sectionFilter.addEventListener('change', renderStudentOptions);

        async function refreshMatrix() {
            matrix.innerHTML = 'Loading...';
            try {
                const payload = await apiJson('/api/admin/assignments/matrix');
                const assignments = payload.assignments || [];
                if (!assignments.length) {
                    matrix.innerHTML = '<div class="list-item"><div class="meta">No assignments found.</div></div>';
                    return;
                }

                const bySubject = new Map();
                assignments.forEach((a) => {
                    const subjectCode = String(a.subject_code || '').trim() || 'Unspecified Subject';
                    const subjectName = String(a.subject_name || '').trim();
                    const subjectLabel = subjectName ? `${subjectCode} - ${subjectName}` : subjectCode;

                    if (!bySubject.has(subjectLabel)) {
                        bySubject.set(subjectLabel, {
                            students: [],
                            studentSet: new Set(),
                            staffSet: new Set(),
                        });
                    }

                    const entry = bySubject.get(subjectLabel);
                    const regNo = String(a.reg_no || '').trim();
                    const studentLabel = String(a.student_name || regNo || '').trim();
                    const studentKey = regNo || studentLabel;
                    if (studentLabel && !entry.studentSet.has(studentKey)) {
                        entry.studentSet.add(studentKey);
                        entry.students.push(studentLabel);
                    }

                    const staffLabel = String(a.staff_name || a.staff_email || '').trim();
                    if (staffLabel) {
                        entry.staffSet.add(staffLabel);
                    }
                });

                matrix.innerHTML = Array.from(bySubject.entries()).map(([subjectLabel, entry]) => {
                    const studentNames = entry.students
                        .map((name) => escapeHtml(name))
                        .join(', ');
                    const staffNames = Array.from(entry.staffSet)
                        .map((name) => escapeHtml(name))
                        .join(', ');

                    return `
                        <div class="list-item">
                            <div class="name">${escapeHtml(subjectLabel)}</div>
                            <div class="meta">Assigned staff: ${staffNames || 'Not specified'}</div>
                            <div class="meta" style="margin-top:6px;line-height:1.5;">Students: ${studentNames || 'No students assigned'}</div>
                        </div>
                    `;
                }).join('');
            } catch (err) {
                matrix.innerHTML = `<div class="list-item"><div class="meta" style="color:#ffb8c7">${escapeHtml(err.message || 'Failed to load assignment matrix')}</div></div>`;
            }
        }

        mount.querySelector('#assignForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const selectedRegNos = getSelectedStudentRegNos();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);
            const requiredSection = String(sectionFilter.value || '').trim().toUpperCase();

            if (!['ALL', 'A3', 'A7'].includes(requiredSection)) {
                setMsg('Section is compulsory. Please select A3, A7, or All Sections.', true);
                return;
            }

            if (!selectedRegNos.length || !staffEmail || !subjectId) {
                setMsg('Select students, teacher, and subject first', true);
                return;
            }

            try {
                setMsg('Assigning selected students...', false);
                const result = await apiJson('/api/admin/assign/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regNos: selectedRegNos, staffEmail, subjectId, mode: 'assign' }),
                });
                setMsg(`Successfully assigned ${result.count} selected students`);
                toast('Assignment complete');
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Assignment failed', true);
            }
        });

        mount.querySelector('#assignAllFilteredBtn').addEventListener('click', async () => {
            const q = String(studentSearch.value || '').trim().toLowerCase();
            const dVal = deptFilter.value;
            const sVal = String(sectionFilter.value || '').trim().toUpperCase();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);

            if (!['ALL', 'A3', 'A7'].includes(sVal)) {
                setMsg('Section is compulsory. Please select A3, A7, or All Sections.', true);
                return;
            }

            if (!staffEmail || !subjectId) {
                setMsg('Select teacher and subject first', true);
                return;
            }

            const filteredRegNos = allStudents.filter((s) => {
                const { dept, sec } = extractMetadata(s);
                const mQuery = !q || String(s.reg_no || '').toLowerCase().includes(q) || String(s.full_name || '').toLowerCase().includes(q);
                const mDept = dVal === 'all' || dVal === dept;
                const mSec = sVal === 'ALL' || sVal === sec;
                return mQuery && mDept && mSec;
            }).map((s) => s.reg_no);

            if (!filteredRegNos.length) {
                setMsg('No students matching current filters', true);
                return;
            }

            if (!confirm(`Assign ALL ${filteredRegNos.length} students currently shown to ${staffEmail} for this subject?`)) {
                return;
            }

            try {
                setMsg('Bulk assigning...', false);
                const result = await apiJson('/api/admin/assign/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regNos: filteredRegNos, staffEmail, subjectId, mode: 'assign' }),
                });
                setMsg(`Successfully assigned ALL ${result.count} filtered students`);
                toast('Bulk assignment complete');
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Bulk assignment failed', true);
            }
        });

        mount.querySelector('#assignSubjectToStaffBtn').addEventListener('click', async () => {
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);
            if (!staffEmail || !subjectId) {
                setMsg('Select teacher and subject first', true);
                return;
            }

            try {
                await apiJson('/api/admin/assign/staff-subject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ staffEmail, subjectId }),
                });
                setMsg(`Subject assigned to teacher: ${staffEmail}`);
                toast('Teacher-subject mapping saved');
            } catch (err) {
                setMsg(err.message || 'Failed to assign subject to teacher', true);
            }
        });

        mount.querySelector('#assignSubjectToStudentsBtn').addEventListener('click', async () => {
            const selectedRegNos = getSelectedStudentRegNos();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);
            if (!selectedRegNos.length || !subjectId) {
                setMsg('Select students and subject first', true);
                return;
            }
            if (!staffEmail) {
                setMsg('Select staff before assigning subject to students', true);
                return;
            }

            try {
                setMsg('Assigning subject to students...', false);
                const result = await apiJson('/api/admin/assign/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regNos: selectedRegNos, staffEmail, subjectId, mode: 'assign-subject' }),
                });
                setMsg(`Successfully assigned subject and staff to ${result.count} students`);
                toast(`Subject + staff assigned: ${result.count}`);
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Failed to assign subject to students', true);
            }
        });

        mount.querySelector('#unassignSubjectFromStudentsBtn').addEventListener('click', async () => {
            const selectedRegNos = getSelectedStudentRegNos();
            const subjectId = Number(subjectSel.value || 0);
            if (!selectedRegNos.length || !subjectId) {
                setMsg('Select students and subject first', true);
                return;
            }

            if (!confirm(`Unassign this subject from ${selectedRegNos.length} selected student(s)?`)) {
                return;
            }

            try {
                setMsg('Unassigning subject from students...', false);
                const result = await apiJson('/api/admin/assign/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regNos: selectedRegNos, subjectId, mode: 'unassign-subject' }),
                });
                setMsg(`Successfully unassigned subject from ${result.count} students`);
                toast(`Subject unassigned: ${result.count}`);
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Failed to unassign subject from students', true);
            }
        });

        mount.querySelector('#assignBulkDeleteBtn').addEventListener('click', async () => {
            const selectedRegNos = getSelectedStudentRegNos();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);

            if (!selectedRegNos.length || !staffEmail || !subjectId) {
                setMsg('Select at least one student, teacher, and subject', true);
                return;
            }

            if (!confirm(`Unassign ${selectedRegNos.length} student(s) from ${staffEmail}? Records remain, but they won't show in teacher dashboard.`)) {
                return;
            }

            try {
                setMsg('Unassigning students...', false);
                const result = await apiJson('/api/admin/assign/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regNos: selectedRegNos, staffEmail, subjectId, mode: 'unassign' }),
                });
                setMsg(`Successfully unassigned ${result.count} students`);
                toast('Assignments removed');
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Failed to unassign', true);
            }
        });

        mount.querySelector('#assignSelectAllBtn').addEventListener('click', () => {
            const checkboxes = studentList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach((cb) => { cb.checked = true; });
            setMsg(`Selected ${checkboxes.length} students`);
        });

        mount.querySelector('#assignClearAllBtn').addEventListener('click', () => {
            const checkboxes = studentList.querySelectorAll('input[type="checkbox"]');
            checkboxes.forEach((cb) => { cb.checked = false; });
            setMsg('Cleared all selections');
        });

        mount.querySelector('#assignRefreshBtn').addEventListener('click', async () => {
            await loadOptions();
            await refreshMatrix();
        });

        refreshAssignments = async () => {
            await loadOptions();
            await refreshMatrix();
        };

        loadOptions();
        refreshMatrix();
    }

    function initAdminOpsPanel() {
        const mount = document.getElementById('operationsMount');
        if (!mount) return;

        mount.innerHTML = `
            <div class="head-row" style="margin-bottom:20px;">
                <h2>System Control & Subject Manager</h2>
                <div style="display:flex;gap:12px;">
                    <button class="btn ghost" id="opsRefreshDbStatusBtn" type="button">Refresh Health</button>
                    <button class="btn ghost" id="opsRefreshAuditBtn" type="button">Recent Logs</button>
                </div>
            </div>
            
            <section class="card" style="margin-bottom:20px;border-color:var(--accent-3);">
                <div class="head-row" style="margin-bottom:12px;">
                    <h3 style="font-size:1rem;margin:0;">Live Data Integrity</h3>
                    <span id="opsDbStatusTime" style="font-size:0.8rem;color:var(--muted);"></span>
                </div>
                <div id="opsDbStatus" class="list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;"></div>
            </section>

            <section class="card" style="margin-bottom:20px;border-color:var(--accent);">
                <div class="head-row" style="margin-bottom:12px;">
                    <h3 style="font-size:1rem;margin:0;">Live Users On Website</h3>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span id="opsLiveUsersTime" style="font-size:0.8rem;color:var(--muted);"></span>
                        <button class="btn ghost" id="opsRefreshLiveUsersBtn" type="button" style="padding:6px 10px;font-size:0.75rem;">Refresh Users</button>
                    </div>
                </div>
                <div id="opsLiveUsersSummary" class="list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:12px;"></div>
                <div id="opsLiveUsersList" class="list"></div>
            </section>

            <div class="grid">
                <form id="opsStaffActionForm" class="form card" novalidate>
                    <h3>Staff Quick Actions</h3>
                    <label for="opsStaffEmail">Username to Target</label>
                    <input id="opsStaffEmail" type="text" placeholder="e.g. shreekesavan" required />
                    
                    <label for="opsStaffPassword">New Password (Reset Only)</label>
                    <input id="opsStaffPassword" type="password" placeholder="Min 6 chars" />
                    
                    <div class="btn-group">
                        <button class="btn ghost" type="button" id="opsActivateBtn">Activate</button>
                        <button class="btn ghost" type="button" id="opsDeactivateBtn">Disable</button>
                    </div>
                    <button class="btn primary" type="button" id="opsResetPwBtn" style="margin-top:8px;">Update Credentials</button>
                    <p id="opsStaffMsg" class="msg"></p>
                </form>

                <form id="opsSubjectForm" class="form card" novalidate>
                    <h3>Subject Management</h3>
                    <div class="row">
                        <div class="col">
                            <label for="opsSubjectCode">Subject Code</label>
                            <input id="opsSubjectCode" type="text" placeholder="e.g. CHEM202" required />
                        </div>
                        <div class="col">
                            <label for="opsSubjectName">Display Name</label>
                            <input id="opsSubjectName" type="text" placeholder="e.g. Lab Manual" required />
                        </div>
                    </div>
                    <div class="btn-group">
                        <button id="opsSubjectSubmitBtn" class="btn primary" type="submit">Create Subject</button>
                        <button id="opsSubjectCancelBtn" class="btn ghost" type="button" style="display:none;">Reset</button>
                    </div>
                    <p id="opsSubjectMsg" class="msg"></p>
                </form>
            </div>

            <section class="card accounts-list-card" style="margin-top:20px;">
                <div class="head-row">
                    <h3>Active Subject List</h3>
                </div>
                <div id="opsSubjectList" class="list"></div>
            </section>

            <section class="card" style="margin-top:20px;">
                <h3 style="margin-bottom:12px;">Security Audit Trail</h3>
                <div id="opsAuditList" class="list"></div>
            </section>
        `;

        const staffMsg = mount.querySelector('#opsStaffMsg');
        const policyMsg = mount.querySelector('#opsPolicyMsg');
        const dryRunMsg = mount.querySelector('#opsDryRunMsg');
        const subjectMsg = mount.querySelector('#opsSubjectMsg');

        let currentSubjectEditId = null;
        const subjectSubmitBtn = mount.querySelector('#opsSubjectSubmitBtn');
        const subjectCancelBtn = mount.querySelector('#opsSubjectCancelBtn');
        const subjectCodeInput = mount.querySelector('#opsSubjectCode');
        const subjectNameInput = mount.querySelector('#opsSubjectName');

        function formatLastSeenAgo(lastSeenAt) {
            const ts = Number(lastSeenAt || 0);
            if (!ts) return 'unknown';
            const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
            if (diffSec < 60) return `${diffSec}s ago`;
            const diffMin = Math.floor(diffSec / 60);
            if (diffMin < 60) return `${diffMin}m ago`;
            const diffHr = Math.floor(diffMin / 60);
            return `${diffHr}h ago`;
        }

        async function refreshLiveUsers() {
            const summaryEl = mount.querySelector('#opsLiveUsersSummary');
            const listEl = mount.querySelector('#opsLiveUsersList');
            const timeEl = mount.querySelector('#opsLiveUsersTime');
            if (!summaryEl || !listEl || !timeEl) return;

            summaryEl.innerHTML = 'Loading...';
            listEl.innerHTML = '';

            try {
                const payload = await apiJson('/api/superadmin/active-users/live');
                const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
                const now = Date.now();
                const onlineWindowMs = 2 * 60 * 1000;
                const onlineNow = sessions.filter((s) => {
                    const seen = Number(s?.lastSeenAt || 0);
                    return seen > 0 && (now - seen) <= onlineWindowMs;
                });

                const studentCount = onlineNow.filter((s) => String(s.role || '').toLowerCase() === 'student').length;
                const staffCount = onlineNow.filter((s) => String(s.role || '').toLowerCase() === 'staff').length;

                summaryEl.innerHTML = `
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Online Now</div>
                        <div class="meta" style="font-weight:700;color:var(--accent);">${onlineNow.length}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Students</div>
                        <div class="meta" style="font-weight:700;color:var(--text);">${studentCount}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Staff</div>
                        <div class="meta" style="font-weight:700;color:var(--text);">${staffCount}</div>
                    </div>
                `;

                if (!onlineNow.length) {
                    listEl.innerHTML = '<div class="list-item"><div class="meta">No users active in the last 2 minutes.</div></div>';
                } else {
                    listEl.innerHTML = onlineNow
                        .sort((a, b) => Number(b.lastSeenAt || 0) - Number(a.lastSeenAt || 0))
                        .map((s) => {
                            const role = String(s.role || '').toLowerCase() === 'student' ? 'Student' : 'Staff';
                            const identity = role === 'Student'
                                ? (s.regNo || s.name || 'Unknown Student')
                                : (s.email || s.name || 'Unknown Staff');
                            const displayName = s.name && s.name !== identity ? `${s.name}` : '';
                            return `
                                <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                                    <div style="min-width:0;flex:1;">
                                        <div class="name">${escapeHtml(identity)}</div>
                                        <div class="meta">${escapeHtml(role)}${displayName ? ` · ${escapeHtml(displayName)}` : ''}</div>
                                    </div>
                                    <div class="meta" style="white-space:nowrap;">Active ${escapeHtml(formatLastSeenAgo(s.lastSeenAt))}</div>
                                </div>
                            `;
                        }).join('');
                }

                const stamp = payload.serverTime ? new Date(payload.serverTime) : new Date();
                timeEl.textContent = `Updated: ${stamp.toLocaleTimeString()}`;
            } catch (err) {
                summaryEl.innerHTML = '<div class="list-item"><div class="meta" style="color:#ffb8c7;">Failed to load live users.</div></div>';
                listEl.innerHTML = `<div class="list-item"><div class="meta" style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to fetch active users')}</div></div>`;
                timeEl.textContent = '';
            }
        }

        refreshDbStatus = async function () {
            const list = mount.querySelector('#opsDbStatus');
            const timeEl = mount.querySelector('#opsDbStatusTime');
            list.innerHTML = 'Loading...';
            try {
                const payload = await apiJson('/api/superadmin/db-status');
                const c = payload.counts || {};
                const rows = [
                    ['Students', c.students],
                    ['Student Auth', c.studentAuth],
                    ['Staff Accounts', c.staffAccounts],
                    ['Active Staff', c.activeStaff],
                    ['Subjects', c.subjects],
                    ['Submissions', c.submissions],
                    ['Pending Submissions', c.pendingSubmissions],
                    ['Q&A Threads', c.qaThreads],
                    ['Q&A Messages', c.qaMessages],
                ];

                const mismatch = Number(c.students || 0) !== Number(c.studentAuth || 0);
                const syncText = payload.startupStudentSyncEnabled
                    ? 'Startup file sync: ON'
                    : 'Startup file sync: OFF';
                const baselineText = payload.startupBaselineAssignmentsEnabled
                    ? 'Startup baseline assignments: ON'
                    : 'Startup baseline assignments: OFF';

                list.innerHTML = rows.map(([label, value]) => `
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">${escapeHtml(String(label))}</div>
                        <div class="meta" style="font-weight:700;color:var(--text);">${escapeHtml(String(value ?? 0))}</div>
                    </div>
                `).join('') + `
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">DB Ready</div>
                        <div class="meta" style="font-weight:700;color:${payload.dbReady ? '#9de9ff' : '#ffb8c7'};">${payload.dbReady ? 'YES' : 'NO'}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">${escapeHtml(syncText)}</div>
                        <div class="meta" style="font-size:0.75rem;">${escapeHtml(String(payload.studentsSourceFile || ''))}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">${escapeHtml(baselineText)}</div>
                        <div class="meta" style="font-size:0.75rem;">manual assignments only</div>
                    </div>
                    ${mismatch ? '<div class="list-item"><div class="meta" style="color:#ffb8c7;">Warning: students and student_auth counts are different.</div></div>' : ''}
                `;

                const stamp = payload.serverTime ? new Date(payload.serverTime) : new Date();
                timeEl.textContent = `Updated: ${stamp.toLocaleString()}`;
            } catch (err) {
                list.innerHTML = `<div class="list-item"><div class="meta" style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load DB status')}</div></div>`;
                timeEl.textContent = '';
            }
        }

        async function runStaffAction(kind) {
            const email = String(mount.querySelector('#opsStaffEmail').value || '').trim();
            const password = String(mount.querySelector('#opsStaffPassword').value || '').trim();
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

        refreshSubjects = async function () {
            const list = mount.querySelector('#opsSubjectList');
            list.innerHTML = 'Loading...';
            try {
                const payload = await apiJson('/api/admin/subjects');
                const subjects = payload.subjects || [];
                if (!subjects.length) {
                    list.innerHTML = '<div class="list-item"><div class="meta">No subjects created yet.</div></div>';
                    return;
                }

                list.innerHTML = subjects.map((s) => {
                    const isActive = Boolean(s.is_active);
                    return `
                        <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px;background:rgba(255,255,255,0.03);border-radius:14px;margin-bottom:8px;">
                            <div style="min-width:0;flex:1;">
                                <div class="name" style="font-size:0.95rem;">${escapeHtml(s.code || '')} - ${escapeHtml(s.name || '')}</div>
                                <div class="meta" style="color:var(--muted);font-size:0.78rem;">System ID #${s.id} · Status: <span style="color:${isActive ? 'var(--accent)' : 'var(--danger)'};font-weight:800;">${isActive ? 'Active' : 'Archived'}</span></div>
                            </div>
                            <div style="display:flex;gap:8px;">
                                <button class="btn ghost ops-subject-edit" type="button" data-id="${s.id}" data-code="${s.code}" data-name="${s.name}" style="padding:4px 12px;font-size:0.75rem;">Edit</button>
                                <button class="btn ghost ops-subject-toggle" type="button" data-id="${s.id}" data-next="${!isActive}" style="padding:4px 12px;font-size:0.75rem;border-color:${isActive ? 'var(--line)' : 'var(--accent)'};">${isActive ? 'Archive' : 'Restore'}</button>
                            </div>
                        </div>
                    `;
                }).join('');

                list.querySelectorAll('.ops-subject-edit').forEach(btn => {
                    btn.addEventListener('click', () => {
                        currentSubjectEditId = Number(btn.dataset.id);
                        subjectCodeInput.value = btn.dataset.code;
                        subjectNameInput.value = btn.dataset.name;
                        subjectSubmitBtn.textContent = 'Update Subject';
                        subjectCancelBtn.style.display = 'inline-block';
                        subjectCodeInput.focus();
                    });
                });

                list.querySelectorAll('.ops-subject-toggle').forEach((btn) => {
                    btn.addEventListener('click', async () => {
                        const id = Number(btn.dataset.id || 0);
                        const next = String(btn.dataset.next || '') === 'true';
                        if (!id) return;
                        try {
                            await apiJson(`/api/admin/subjects/${id}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ isActive: next }),
                            });
                            subjectMsg.style.color = '#9de9ff';
                            subjectMsg.textContent = `Subject ${next ? 'activated' : 'deactivated'}`;
                            toast(`Subject ${next ? 'activated' : 'deactivated'}`);
                            await refreshSubjects();
                        } catch (err) {
                            subjectMsg.style.color = '#ffb8c7';
                            subjectMsg.textContent = err.message || 'Failed to update subject';
                        }
                    });
                });
            } catch (err) {
                list.innerHTML = `
                    <div class="list-item">
                        <div class="meta" style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load subjects')}</div>
                        <button class="btn ghost" type="button" id="opsSubjectRetryBtn" style="margin-top:8px;padding:6px 10px;">Retry</button>
                    </div>
                `;
                const retryBtn = list.querySelector('#opsSubjectRetryBtn');
                if (retryBtn) {
                    retryBtn.addEventListener('click', () => refreshSubjects());
                }
            }
        }

        mount.querySelector('#opsActivateBtn').addEventListener('click', () => runStaffAction('activate'));
        mount.querySelector('#opsDeactivateBtn').addEventListener('click', () => runStaffAction('deactivate'));
        mount.querySelector('#opsResetPwBtn').addEventListener('click', () => runStaffAction('reset-password'));

        const opsPolicyForm = mount.querySelector('#opsPolicyForm');
        if (opsPolicyForm && policyMsg) {
            opsPolicyForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = String(mount.querySelector('#opsPolicyEmail').value || '').trim();
                const jsonText = String(mount.querySelector('#opsPolicyJson').value || '').trim();
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
        }

        subjectCancelBtn.addEventListener('click', () => {
            currentSubjectEditId = null;
            subjectCodeInput.value = '';
            subjectNameInput.value = '';
            subjectSubmitBtn.textContent = 'Create Subject';
            subjectCancelBtn.style.display = 'none';
        });

        mount.querySelector('#opsSubjectForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const code = String(subjectCodeInput.value || '').trim();
            const name = String(subjectNameInput.value || '').trim();
            if (!code || !name) {
                subjectMsg.style.color = '#ffb8c7';
                subjectMsg.textContent = 'Subject code and subject name are required';
                return;
            }

            try {
                if (currentSubjectEditId) {
                    await apiJson(`/api/admin/subjects/${currentSubjectEditId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code, name }),
                    });
                    subjectMsg.style.color = '#9de9ff';
                    subjectMsg.textContent = `Updated subject: ${code}`;
                    currentSubjectEditId = null;
                    subjectSubmitBtn.textContent = 'Create Subject';
                    subjectCancelBtn.style.display = 'none';
                } else {
                    const payload = await apiJson('/api/admin/subjects', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code, name }),
                    });
                    subjectMsg.style.color = '#9de9ff';
                    subjectMsg.textContent = `Created/Updated subject: ${payload.subject?.code || code}`;
                }
                subjectCodeInput.value = '';
                subjectNameInput.value = '';
                toast('Subject saved');
                await refreshSubjects();
            } catch (err) {
                subjectMsg.style.color = '#ffb8c7';
                subjectMsg.textContent = err.message || 'Failed to save subject';
            }
        });

        const opsDryRunForm = mount.querySelector('#opsDryRunForm');
        if (opsDryRunForm && dryRunMsg) {
            opsDryRunForm.addEventListener('submit', async (e) => {
                e.preventDefault();
                const file = mount.querySelector('#opsDryRunFile').files?.[0];
                if (!file) {
                    dryRunMsg.style.color = '#ffb8c7';
                    dryRunMsg.textContent = 'Choose a file for dry-run';
                    return;
                }
                try {
                    const formData = new FormData();
                    formData.append('file', file);
                    formData.append('dryRun', 'true');
                    const payload = await apiJson('/api/admin/students/import', {
                        method: 'POST',
                        body: formData,
                    });
                    dryRunMsg.style.color = '#9de9ff';
                    dryRunMsg.textContent = `Dry-run rows: ${payload.total || 0} (preview: ${(payload.preview || []).length})`;
                    toast('Dry-run complete');
                } catch (err) {
                    dryRunMsg.style.color = '#ffb8c7';
                    dryRunMsg.textContent = err.message || 'Dry-run failed';
                }
            });
        }

        async function refreshAudit() {
            const list = mount.querySelector('#opsAuditList');
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

        mount.querySelector('#opsRefreshDbStatusBtn').addEventListener('click', refreshDbStatus);
        mount.querySelector('#opsRefreshAuditBtn').addEventListener('click', refreshAudit);
        const refreshLiveUsersBtn = mount.querySelector('#opsRefreshLiveUsersBtn');
        if (refreshLiveUsersBtn) refreshLiveUsersBtn.addEventListener('click', refreshLiveUsers);
        refreshDbStatus();
        refreshSubjects();
        refreshAudit();
        refreshLiveUsers();
        setInterval(() => {
            refreshLiveUsers().catch(() => { });
        }, 10000);
    }

    function initPasswordPanel() {
        const mount = document.getElementById('passwordsMount');
        if (!mount) return;

        mount.innerHTML = `
            <div class="head-row" style="margin-bottom:20px;">
                <h2>Password Management</h2>
                <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
                    <button class="btn ghost" id="pwdRefreshBtn" type="button">Refresh Passwords</button>
                    <span id="pwdUpdatedAt" style="font-size:0.8rem;color:var(--muted);"></span>
                </div>
            </div>

            <section class="card" style="margin-bottom:20px;border-color:var(--accent);">
                <div class="row">
                    <div class="col">
                        <label for="pwdSearch">Search Student</label>
                        <input id="pwdSearch" type="text" placeholder="Enter student name (optional)" />
                    </div>
                    <div class="col">
                        <label for="pwdTargetRegNo">Register Number (Compulsory)</label>
                        <input id="pwdTargetRegNo" type="text" placeholder="Enter register number (required) or choose below" />
                    </div>
                    <div class="col">
                        <label for="pwdNewPassword">New Password</label>
                        <div style="display:flex;gap:8px;align-items:center;">
                            <input id="pwdNewPassword" type="password" placeholder="Min 6 characters" style="flex:1;" />
                            <button class="btn ghost" id="pwdToggleVisibility" type="button" style="padding:8px 12px;min-width:88px;">Show</button>
                        </div>
                    </div>
                </div>
                <div class="btn-group" style="margin-top:12px;">
                    <button class="btn primary" id="pwdSaveBtn" type="button">Set Student Password</button>
                    <button class="btn ghost" id="pwdGenerateBtn" type="button">Generate & Show Temp Password</button>
                    <button class="btn ghost" id="pwdClearBtn" type="button">Clear</button>
                </div>
                <p id="pwdMsg" class="msg"></p>
                <p class="meta" style="margin-top:8px;">Note: existing changed passwords cannot be revealed from secure hashes. Use temporary reset to view a new password.</p>
            </section>

            <section class="card" style="margin-bottom:20px;border-color:var(--accent-3);">
                <div class="head-row" style="margin-bottom:12px;">
                    <h3 style="font-size:1rem;margin:0;">Password Status Summary</h3>
                </div>
                <div id="pwdSummary" class="list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;"></div>
            </section>

            <section class="card">
                <div class="head-row" style="margin-bottom:12px;">
                    <h3 style="font-size:1rem;margin:0;">Student Password Records</h3>
                    <input id="pwdQuickSearch" type="text" placeholder="Search by Name or Register Number" style="max-width:320px;" />
                </div>
                <div id="pwdList" class="list"></div>
            </section>
        `;

        const searchEl = mount.querySelector('#pwdSearch');
        const quickSearchEl = mount.querySelector('#pwdQuickSearch');
        const regNoEl = mount.querySelector('#pwdTargetRegNo');
        const newPasswordEl = mount.querySelector('#pwdNewPassword');
        const toggleVisibilityEl = mount.querySelector('#pwdToggleVisibility');
        const msgEl = mount.querySelector('#pwdMsg');
        const listEl = mount.querySelector('#pwdList');
        const summaryEl = mount.querySelector('#pwdSummary');
        const updatedAtEl = mount.querySelector('#pwdUpdatedAt');

        function setMsg(text, isError = false) {
            msgEl.style.color = isError ? '#ffb8c7' : '#9de9ff';
            msgEl.textContent = text;
        }

        function formatTime(value) {
            if (!value) return 'Unknown';
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
        }

        function generateTempPassword() {
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#';
            let out = '';
            for (let i = 0; i < 10; i += 1) {
                out += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return out;
        }

        async function loadPasswords() {
            const q = String((quickSearchEl?.value || searchEl.value || '')).trim();
            summaryEl.innerHTML = 'Loading...';
            listEl.innerHTML = 'Loading...';
            try {
                const payload = await apiJson(`/api/superadmin/student-passwords${q ? `?q=${encodeURIComponent(q)}` : ''}`);
                const students = payload.students || [];
                const summary = payload.summary || {};

                summaryEl.innerHTML = `
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Total Students</div>
                        <div class="meta" style="font-weight:700;">${summary.total || 0}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Password Changed</div>
                        <div class="meta" style="font-weight:700;color:var(--accent);">${summary.changed || 0}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Still Default</div>
                        <div class="meta" style="font-weight:700;">${summary.default || 0}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Student Changes Logged</div>
                        <div class="meta" style="font-weight:700;">${summary.studentChanges || 0}</div>
                    </div>
                    <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;">
                        <div class="name">Admin Resets Logged</div>
                        <div class="meta" style="font-weight:700;">${summary.adminResets || 0}</div>
                    </div>
                `;

                if (!students.length) {
                    listEl.innerHTML = '<div class="list-item"><div class="meta">No matching student records found.</div></div>';
                } else {
                    listEl.innerHTML = students.map((s) => {
                        const statusLabel = s.password_changed ? 'Changed' : 'Default';
                        const sourceLabel = s.last_source ? String(s.last_source).toUpperCase() : 'SYSTEM';
                        const currentPasswordLabel = s.password_changed
                            ? 'Hidden (secure hash)'
                            : String(s.reg_no || '');
                        return `
                            <div class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
                                <div style="min-width:0;flex:1;">
                                    <div class="name">${escapeHtml(s.reg_no || '')} · ${escapeHtml(s.full_name || '')}</div>
                                    <div class="meta">${escapeHtml(s.stream || 'Unspecified')} · ${escapeHtml(s.section || 'Unspecified')} · Status: ${escapeHtml(statusLabel)} · Last change: ${escapeHtml(formatTime(s.last_changed_at || s.auth_updated_at))}</div>
                                    <div class="meta">Current password: ${escapeHtml(currentPasswordLabel)}</div>
                                    <div class="meta">Last updated by: ${escapeHtml(s.last_changed_by || 'system')} · Source: ${escapeHtml(sourceLabel)} · History: ${escapeHtml(String(s.history_count || 0))}</div>
                                </div>
                                <button class="btn ghost pwd-fill-btn" type="button" data-regno="${escapeHtml(s.reg_no || '')}" data-name="${escapeHtml(s.full_name || '')}" style="padding:6px 10px;font-size:0.82rem;">Edit</button>
                            </div>
                        `;
                    }).join('');

                    listEl.querySelectorAll('.pwd-fill-btn').forEach((btn) => {
                        btn.addEventListener('click', () => {
                            regNoEl.value = btn.dataset.regno || '';
                            newPasswordEl.focus();
                            setMsg(`Ready to update ${btn.dataset.regno || ''}`);
                        });
                    });
                }

                updatedAtEl.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
            } catch (err) {
                summaryEl.innerHTML = '<div class="list-item"><div class="meta" style="color:#ffb8c7;">Failed to load password summary.</div></div>';
                listEl.innerHTML = `<div class="list-item"><div class="meta" style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load password records')}</div></div>`;
                updatedAtEl.textContent = '';
            }
        }

        async function savePassword() {
            const regNo = String(regNoEl.value || '').trim().toUpperCase();
            const password = String(newPasswordEl.value || '');
            if (!regNo || !password) {
                setMsg('Register number is compulsory and new password is required', true);
                return;
            }
            if (password.length < 6) {
                setMsg('Password must be at least 6 characters', true);
                return;
            }

            try {
                setMsg('Updating password...', false);
                await apiJson(`/api/superadmin/student-passwords/${encodeURIComponent(regNo)}/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password }),
                });
                setMsg(`Password updated for ${regNo}`);
                toast('Student password updated');
                newPasswordEl.value = '';
                await loadPasswords();
            } catch (err) {
                setMsg(err.message || 'Failed to update password', true);
            }
        }

        async function generateAndSetTempPassword() {
            const regNo = String(regNoEl.value || '').trim().toUpperCase();
            if (!regNo) {
                setMsg('Register number is compulsory', true);
                return;
            }

            const tempPassword = generateTempPassword();
            try {
                setMsg('Generating temporary password...', false);
                await apiJson(`/api/superadmin/student-passwords/${encodeURIComponent(regNo)}/reset`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: tempPassword }),
                });
                newPasswordEl.value = tempPassword;
                setMsg(`Temporary password for ${regNo}: ${tempPassword}`);
                toast(`Temporary password set for ${regNo}`);
                await loadPasswords();
            } catch (err) {
                setMsg(err.message || 'Failed to generate temporary password', true);
            }
        }

        mount.querySelector('#pwdSaveBtn').addEventListener('click', savePassword);
        mount.querySelector('#pwdGenerateBtn').addEventListener('click', generateAndSetTempPassword);
        if (toggleVisibilityEl) {
            toggleVisibilityEl.addEventListener('click', () => {
                const reveal = newPasswordEl.type === 'password';
                newPasswordEl.type = reveal ? 'text' : 'password';
                toggleVisibilityEl.textContent = reveal ? 'Hide' : 'Show';
            });
        }
        mount.querySelector('#pwdClearBtn').addEventListener('click', () => {
            regNoEl.value = '';
            newPasswordEl.value = '';
            if (toggleVisibilityEl) toggleVisibilityEl.textContent = 'Show';
            newPasswordEl.type = 'password';
            searchEl.value = '';
            if (quickSearchEl) quickSearchEl.value = '';
            setMsg('Cleared password form');
        });
        mount.querySelector('#pwdRefreshBtn').addEventListener('click', loadPasswords);
        searchEl.addEventListener('input', () => {
            if (quickSearchEl) quickSearchEl.value = searchEl.value;
            loadPasswords();
        });
        if (quickSearchEl) {
            quickSearchEl.addEventListener('input', () => {
                searchEl.value = quickSearchEl.value;
                loadPasswords();
            });
        }

        refreshPasswords = loadPasswords;
        loadPasswords();
    }

    initSuperAdminMenu();
    try {
        initAssignmentPanel();
    } catch (err) {
        console.error('Assignments panel init failed:', err);
    }
    try {
        initAdminOpsPanel();
    } catch (err) {
        console.error('Operations panel init failed:', err);
    }
    try {
        initPasswordPanel();
    } catch (err) {
        console.error('Password panel init failed:', err);
    }
    refreshStaff();
})();
