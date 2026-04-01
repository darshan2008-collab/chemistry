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
            const payload = await apiJson('/api/admin/students/import', {
                method: 'POST',
                body: formData,
            });

            const streamInfo = Object.entries(payload.streams || {})
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');

            msg.style.color = '#9de9ff';
            msg.textContent = `Processed ${payload.total} rows (new: ${payload.inserted}, skipped existing: ${payload.skipped || 0})${streamInfo ? ' · ' + streamInfo : ''}`;
            toast('Student import complete');
            document.getElementById('studentFile').value = '';
        } catch (err) {
            msg.style.color = '#ffb8c7';
            msg.textContent = err.message || 'Import failed';
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

    document.getElementById('refreshBtn').addEventListener('click', refreshStaff);

    document.getElementById('logoutBtn').addEventListener('click', () => {
        sessionStorage.removeItem('chemtest_superadmin');
        sessionStorage.removeItem('chemtest_staff');
        window.location.replace('superadmin-login.html');
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

    let refreshAssignments = () => {};
    let refreshDbStatus = () => {};
    let refreshSubjects = () => {};

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
                                <option value="all">All Sections</option>
                            </select>
                        </div>
                        </div>
                    </div>
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
                <div style="display:grid;gap:10px;margin-bottom:14px;">
                    <div style="font-size:0.78rem;color:var(--muted);font-weight:800;letter-spacing:0.02em;">Subject Setup (Required before final mapping)</div>
                    <div style="display:flex;gap:10px;flex-wrap:wrap;">
                        <input id="assignNewSubjectCode" type="text" placeholder="Subject code (e.g. CHEM101)" style="flex:1;min-width:180px;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:10px 12px;font-size:0.88rem;" />
                        <input id="assignNewSubjectName" type="text" placeholder="Subject name" style="flex:1;min-width:200px;border:1px solid var(--line);border-radius:12px;background:var(--panel-strong);color:var(--text);padding:10px 12px;font-size:0.88rem;" />
                        <button class="btn" type="button" id="assignCreateSubjectBtn">Create Subject</button>
                    </div>
                    <div style="display:flex;gap:10px;flex-wrap:wrap;">
                        <button class="btn" type="button" id="assignSubjectToStaffBtn" style="flex:1;min-width:220px;">Assign Subject to Teacher</button>
                        <button class="btn" type="button" id="assignSubjectToStudentsBtn" style="flex:1;min-width:260px;">Assign Subject to Selected Students</button>
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
        const newSubjectCodeInput = mount.querySelector('#assignNewSubjectCode');
        const newSubjectNameInput = mount.querySelector('#assignNewSubjectName');
        let allStudents = [];

        function extractMetadata(s) {
            if (s && s.stream && s.section) {
                return { dept: s.stream, sec: s.section, streamName: `${s.stream}-${s.section}` };
            }
            const regNo = String(s.reg_no || s || '').trim();
            const match = regNo.match(/([A-Z]+)(\d+)$/i);
            if (!match) return { dept: 'OTHER', sec: 'Unknown', streamName: 'Other' };
            
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

            return { dept: deptLabel, sec: sectionLetter, streamName: `${deptLabel}-${sectionLetter}` };
        }

        function populateFilters() {
            const deptSet = new Set();
            const secSet = new Set();
            allStudents.forEach(s => {
                const { dept, sec } = extractMetadata(s);
                if (dept && dept !== 'OTHER') deptSet.add(dept);
                if (sec && sec !== 'Unknown') secSet.add(sec);
            });
            deptFilter.innerHTML = '<option value="all">All Departments</option>' + 
                Array.from(deptSet).sort().map(d => `<option value="${d}">${d}</option>`).join('');
            sectionFilter.innerHTML = '<option value="all">All Sections</option>' + 
                Array.from(secSet).sort().map(s => `<option value="${s}">${s}</option>`).join('');
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
            const sVal = sectionFilter.value;

            const filtered = allStudents.filter((s) => {
                const { dept, sec } = extractMetadata(s);
                const mQuery = !q || String(s.reg_no || '').toLowerCase().includes(q) || String(s.full_name || '').toLowerCase().includes(q);
                const mDept = dVal === 'all' || dVal === dept;
                const mSec = sVal === 'all' || sVal === sec;
                
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
                html += `<div style="padding:6px 12px; background:var(--bg-1); border-bottom:1px solid var(--line); border-top:1px solid var(--line); font-weight:800; color:var(--accent); font-size:0.7rem; text-transform:uppercase; letter-spacing:0.06em; position:sticky; top:0; z-index:2; margin-top:-1px;">Stream: ${k}</div>`;
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
                populateFilters();
                renderStudentOptions();
                fillSelect(staffSel, staff, 'email', (s) => `${s.email} - ${s.full_name || ''}`);
                fillSelect(subjectSel, subjects, 'id', (s) => `${s.code || ''} - ${s.name || ''}`);
            } catch (err) {
                setMsg(err.message || 'Failed to load dropdown data', true);
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

        mount.querySelector('#assignForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const selectedRegNos = getSelectedStudentRegNos();
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);

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
            const sVal = sectionFilter.value;
            const staffEmail = String(staffSel.value || '').trim();
            const subjectId = Number(subjectSel.value || 0);

            if (!staffEmail || !subjectId) {
                setMsg('Select teacher and subject first', true);
                return;
            }

            const filteredRegNos = allStudents.filter((s) => {
                const { dept, sec } = extractMetadata(s);
                const mQuery = !q || String(s.reg_no || '').toLowerCase().includes(q) || String(s.full_name || '').toLowerCase().includes(q);
                const mDept = dVal === 'all' || dVal === dept;
                const mSec = sVal === 'all' || sVal === sec;
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

        mount.querySelector('#assignCreateSubjectBtn').addEventListener('click', async () => {
            const code = String(newSubjectCodeInput.value || '').trim();
            const name = String(newSubjectNameInput.value || '').trim();
            if (!code || !name) {
                setMsg('Enter subject code and subject name', true);
                return;
            }

            try {
                const payload = await apiJson('/api/admin/subjects', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code, name }),
                });
                setMsg(`Subject ready: ${payload.subject?.code || code}`);
                toast('Subject created/updated');
                newSubjectCodeInput.value = '';
                newSubjectNameInput.value = '';
                await loadOptions();
            } catch (err) {
                setMsg(err.message || 'Failed to create subject', true);
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
            const subjectId = Number(subjectSel.value || 0);
            if (!selectedRegNos.length || !subjectId) {
                setMsg('Select students and subject first', true);
                return;
            }

            try {
                setMsg('Assigning subject to students...', false);
                const result = await apiJson('/api/admin/assign/bulk', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regNos: selectedRegNos, subjectId, mode: 'assign-subject' }),
                });
                setMsg(`Successfully assigned subject to ${result.count} students`);
                toast(`Subject assigned: ${result.count}`);
                await refreshMatrix();
            } catch (err) {
                setMsg(err.message || 'Failed to assign subject to students', true);
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

        refreshDbStatus = async function() {
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

        refreshSubjects = async function() {
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
                list.innerHTML = `<div class="list-item"><div class="meta" style="color:#ffb8c7;">${escapeHtml(err.message || 'Failed to load subjects')}</div></div>`;
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
        refreshDbStatus();
        refreshSubjects();
        refreshAudit();
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
    refreshStaff();
})();
