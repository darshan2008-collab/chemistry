const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const app = express();
const port = Number(process.env.API_PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'uploads')
  : '/data/uploads');
const gradedReportFilePath = process.env.GRADED_REPORT_FILE || path.join(uploadDir, 'graded-report.xlsx');
const studentsFile = process.env.STUDENTS_FILE || '/app/students-db.js';
const syncStudentsOnStartup = String(process.env.STUDENTS_SYNC_ON_STARTUP || 'true').trim().toLowerCase() !== 'false';
const resyncToken = process.env.RESYNC_TOKEN || '';
const authPepper = process.env.AUTH_PEPPER || 'change_this_auth_pepper';
const sessionTtlHours = Number(process.env.AUTH_SESSION_TTL_HOURS || 24);

const staffDefaultEmail = (process.env.STAFF_DEFAULT_EMAIL || 'admin@chemtest.in').trim().toLowerCase();
const staffDefaultPassword = process.env.STAFF_DEFAULT_PASSWORD || 'ChangeThisNow_2026!';
const staffDefaultName = process.env.STAFF_DEFAULT_NAME || 'System Admin';
const staffDefaultRole = process.env.STAFF_DEFAULT_ROLE || 'Chemistry Teacher';
const superAdminDefaultEmail = (process.env.SUPERADMIN_DEFAULT_EMAIL || 'unitaryx').trim().toLowerCase();
const superAdminDefaultPassword = process.env.SUPERADMIN_DEFAULT_PASSWORD || 'unitary@10';
const superAdminDefaultName = process.env.SUPERADMIN_DEFAULT_NAME || 'Unitary X';
const superAdminDefaultRole = process.env.SUPERADMIN_DEFAULT_ROLE || 'Super Admin';

app.use(express.json({ limit: '1mb' }));

// ── Serve static files from uploads directory (images, etc.) ────────────
app.use('/uploads', express.static(uploadDir));
app.use('/api/uploads', express.static(uploadDir));

function extractUploadFileName(input) {
  let raw = input;
  if (raw && typeof raw === 'object') {
    raw = raw.url || raw.src || raw.path || raw.name || '';
  }
  raw = String(raw || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:)/i.test(raw)) return raw;

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      raw = parsed.pathname || '';
    } catch (_err) {
      // ignore and continue best effort
    }
  }

  raw = raw.split('?')[0].split('#')[0].replace(/\\/g, '/');

  const markers = ['/api/files/', '/api/uploads/', '/uploads/', 'uploads/'];
  for (const marker of markers) {
    const idx = raw.toLowerCase().lastIndexOf(marker);
    if (idx >= 0) {
      const tail = raw.slice(idx + marker.length).replace(/^\/+/, '');
      return decodeURIComponent(path.basename(tail));
    }
  }

  return decodeURIComponent(path.basename(raw));
}

function toPublicImageUrl(input) {
  const fileName = extractUploadFileName(input);
  if (!fileName) return '';
  if (/^(data:|blob:)/i.test(fileName)) return fileName;
  return `/api/files/${encodeURIComponent(fileName)}`;
}

function normalizeImagesForStorage(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  const normalized = [];
  for (const item of value) {
    const fileName = extractUploadFileName(item);
    if (!fileName || /^(data:|blob:)/i.test(fileName)) continue;
    if (unique.has(fileName)) continue;
    unique.add(fileName);
    normalized.push(fileName);
  }
  return normalized;
}

function normalizeUploadUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (/^(data:|blob:)/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const marker = '/uploads/';
      const idx = parsed.pathname.toLowerCase().lastIndexOf(marker);
      if (idx >= 0) {
        const tail = parsed.pathname.slice(idx + marker.length).replace(/^\/+/, '');
        return `/api/uploads/${tail}`;
      }
    } catch (_err) {
      // Fall through to best-effort normalization below
    }
    return raw;
  }
  if (raw.startsWith('/api/uploads/')) return raw;
  if (raw.startsWith('/uploads/')) return `/api${raw}`;
  if (raw.startsWith('uploads/')) return `/api/${raw}`;

  // Handle Windows/local absolute paths by taking only file name.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.includes('\\')) {
    return `/api/uploads/${path.basename(raw)}`;
  }

  // Handle any path that contains /uploads/ somewhere inside it.
  const marker = '/uploads/';
  const markerIdx = raw.toLowerCase().lastIndexOf(marker);
  if (markerIdx >= 0) {
    const tail = raw.slice(markerIdx + marker.length).replace(/^\/+/, '');
    return `/api/uploads/${tail}`;
  }

  return `/api/uploads/${raw.replace(/^\/+/, '')}`;
}

app.get('/files/:name', async (req, res, next) => {
  const safeName = path.basename(String(req.params.name || ''));
  if (!safeName) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  try {
    const dbResult = await pool.query(
      `SELECT mime_type, original_name, file_data
       FROM uploads
       WHERE stored_name = $1`,
      [safeName]
    );

    if (dbResult.rows.length && dbResult.rows[0].file_data) {
      const row = dbResult.rows[0];
      if (row.mime_type) {
        res.type(row.mime_type);
      }
      if (row.original_name) {
        res.setHeader('Content-Disposition', `inline; filename="${path.basename(String(row.original_name))}"`);
      }
      return res.send(row.file_data);
    }

    const filePath = path.join(uploadDir, safeName);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    return res.sendFile(path.resolve(filePath));
  } catch (err) {
    return next(err);
  }
});

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dbHost = requireEnv('DB_HOST');
const dbPort = Number(requireEnv('DB_PORT'));
const dbName = requireEnv('DB_NAME');
const dbUser = requireEnv('DB_USER');
const dbPassword = requireEnv('DB_PASSWORD');

if (!Number.isFinite(dbPort) || dbPort <= 0) {
  throw new Error('Invalid DB_PORT. It must be a positive number.');
}

const pool = new Pool({
  host: dbHost,
  port: dbPort,
  database: dbName,
  user: dbUser,
  password: dbPassword,
  max: 10,
});

let dbReady = false;
let excelRebuildInProgress = false;
const sessions = new Map();

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(path.dirname(gradedReportFilePath), { recursive: true });

const sanitize = (name) =>
  name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);

function createStoredUploadName(originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  const base = sanitize(path.basename(originalName || 'file', ext));
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${base || 'file'}-${unique}${ext}`;
}

function cleanupUploadDiskCopies(fileNames) {
  for (const rawName of fileNames || []) {
    const safeName = path.basename(String(rawName || ''));
    if (!safeName) continue;
    const filePath = path.join(uploadDir, safeName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (_err) {
      // Best effort: uploads are persisted in DB; disk cleanup failure should not fail request.
    }
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 20,
    fileSize: 15 * 1024 * 1024,
  },
});

const excelUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: 10 * 1024 * 1024,
  },
});

function hashPassword(value) {
  return crypto.createHash('sha256').update(`${String(value)}:${authPepper}`).digest('hex');
}

function createSession(payload) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (Math.max(sessionTtlHours, 1) * 60 * 60 * 1000);
  sessions.set(token, { ...payload, expiresAt });
  return token;
}

function getSessionFromRequest(req) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function requireAuth(roles) {
  const allowedRoles = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    const session = getSessionFromRequest(req);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (allowedRoles.length && !allowedRoles.includes(session.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.auth = session;
    next();
  };
}

function isSuperAdminSession(session) {
  const roleRaw = String(session?.staffRole || session?.roleName || '').toLowerCase();
  return roleRaw === 'super admin' || roleRaw === 'superadmin';
}

function requireSuperAdmin(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (session.role !== 'staff' || !isSuperAdminSession(session)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  req.auth = session;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
}, 60 * 1000).unref();

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: dbReady ? 'ready' : 'starting' });
  } catch (_err) {
    res.status(500).json({ ok: false, db: 'unavailable' });
  }
});

app.post('/auth/student/login', async (req, res, next) => {
  try {
    const regNo = String(req.body?.regNo || '').trim().toUpperCase();
    const password = String(req.body?.password || '');
    const passwordTrimmed = password.trim();
    if (!regNo || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const result = await pool.query(
      `SELECT BTRIM(s.reg_no) AS reg_no, s.full_name, a.password_hash, a.password_changed
       FROM students s
       JOIN student_auth a ON UPPER(BTRIM(a.reg_no)) = UPPER(BTRIM(s.reg_no))
       WHERE UPPER(BTRIM(s.reg_no)) = UPPER(BTRIM($1))
       LIMIT 1`,
      [regNo]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const row = result.rows[0];
    const rowRegNo = String(row.reg_no || '').trim().toUpperCase();
    const passwordChanged = Boolean(row.password_changed);

    // First login rule: before password is changed, default password is register number.
    if (!passwordChanged) {
      if (passwordTrimmed.toUpperCase() !== rowRegNo) {
        return res.status(401).json({ error: 'Use register number as password for first login' });
      }
    } else if (hashPassword(passwordTrimmed) !== row.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSession({ role: 'student', regNo: rowRegNo, name: row.full_name });
    res.json({
      token,
      student: { regNo: rowRegNo, name: row.full_name },
      mustChangePassword: !passwordChanged,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/auth/student/password', requireAuth('student'), async (req, res, next) => {
  try {
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await pool.query(
      `UPDATE student_auth
       SET password_hash = $1, password_changed = TRUE, updated_at = NOW()
       WHERE reg_no = $2`,
      [hashPassword(newPassword), req.auth.regNo]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/auth/staff/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const result = await pool.query(
      `SELECT email, full_name, role, password_hash
       FROM staff_accounts
       WHERE email = $1 AND is_active = TRUE`,
      [email]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const row = result.rows[0];
    if (hashPassword(password) !== row.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSession({ role: 'staff', staffRole: row.role, roleName: row.role, email: row.email, name: row.full_name });
    res.json({ token, staff: { email: row.email, name: row.full_name, role: row.role } });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/staff', requireSuperAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT email, full_name, role, is_active, created_at, updated_at
       FROM staff_accounts
       ORDER BY created_at DESC, email ASC`
    );
    res.json({ staff: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff', requireSuperAdmin, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const fullName = String(req.body?.fullName || '').trim();
    const role = String(req.body?.role || 'Chemistry Teacher').trim() || 'Chemistry Teacher';
    const password = String(req.body?.password || '');

    if (!email || !fullName || !password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const result = await pool.query(
      `INSERT INTO staff_accounts (email, full_name, role, password_hash, is_active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (email)
       DO UPDATE SET full_name = EXCLUDED.full_name,
                     role = EXCLUDED.role,
                     password_hash = EXCLUDED.password_hash,
                     is_active = TRUE,
                     updated_at = NOW()
       RETURNING email, full_name, role, is_active, created_at, updated_at`,
      [email, fullName, role, hashPassword(password)]
    );

    res.json({ ok: true, staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

function getExcelField(row, candidates) {
  const normalizedCandidates = candidates.map((c) => c.toLowerCase());
  for (const [key, value] of Object.entries(row || {})) {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedCandidates.includes(normalizedKey)) return value;
  }
  return '';
}

function parseStudentsFromWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) return [];
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const students = [];
  for (const row of rows) {
    const regNo = String(
      getExcelField(row, ['regno', 'registernumber', 'registerno', 'rollno', 'rollnumber'])
    ).trim().toUpperCase();
    const fullName = String(
      getExcelField(row, ['fullname', 'studentname', 'name'])
    ).trim();
    const stream = String(
      getExcelField(row, ['stream', 'department', 'class', 'branch'])
    ).trim();
    const section = String(
      getExcelField(row, ['section', 'sec'])
    ).trim().toUpperCase();

    if (!regNo || !fullName) continue;
    students.push({ regNo, fullName, stream, section });
  }

  return students;
}

function inferSectionFromRegNo(regNo) {
  const code = String(regNo || '').toUpperCase();
  if (code.includes('BAD') || code.includes('BAM')) return 'A7';
  if (code.includes('BCS') || code.includes('BIT') || code.includes('BSC')) return 'A3';
  return '';
}

async function rebuildGradedReportWorkbook() {
  // Prevent concurrent rebuilds
  if (excelRebuildInProgress) {
    console.warn('[EXCEL-REBUILD] Build already in progress, skipping concurrent request');
    return null;
  }
  excelRebuildInProgress = true;

  try {
    console.log('[EXCEL-REBUILD] Starting graded report rebuild...');

    let sourceOrderMap = new Map();
    try {
      const sourceStudents = parseStudentsFromFile(studentsFile);
      sourceOrderMap = new Map(Object.keys(sourceStudents).map((regNo, index) => [String(regNo).toUpperCase(), index]));
    } catch (_err) {
      console.warn('[EXCEL-REBUILD] Could not parse source students file, using default order');
      sourceOrderMap = new Map();
    }

    const studentsResult = await pool.query(
      `SELECT reg_no,
              full_name,
              COALESCE(NULLIF(TRIM(section), ''), 'Unspecified Section') AS section
       FROM students
       ORDER BY reg_no ASC`
    );
    console.log(`[EXCEL-REBUILD] Found ${studentsResult.rows.length} students`);

    const submissionsResult = await pool.query(
      `SELECT sub.student_name,
              sub.roll_number,
              sub.test_title,
              sub.subject,
              sub.classroom,
              sub.status,
              sub.marks,
              sub.total_marks,
              sub.submitted_at,
              sub.graded_at,
              COALESCE(NULLIF(TRIM(s.section), ''), NULLIF(TRIM(sub.classroom), ''), 'Unspecified Section') AS section
       FROM submissions sub
       LEFT JOIN students s ON s.reg_no = sub.roll_number
       ORDER BY sub.roll_number ASC, COALESCE(sub.graded_at, sub.submitted_at) DESC`
    );
    console.log(`[EXCEL-REBUILD] Found ${submissionsResult.rows.length} submissions`);

    const submissionsByRoll = new Map();
    for (const sub of submissionsResult.rows) {
      const regNo = String(sub.roll_number || '').toUpperCase();
      if (!regNo) continue;
      if (!submissionsByRoll.has(regNo)) submissionsByRoll.set(regNo, []);
      submissionsByRoll.get(regNo).push(sub);
    }

    const orderedStudents = [...studentsResult.rows].sort((a, b) => {
      const aKey = String(a.reg_no || '').toUpperCase();
      const bKey = String(b.reg_no || '').toUpperCase();
      const aOrder = sourceOrderMap.has(aKey) ? sourceOrderMap.get(aKey) : Number.MAX_SAFE_INTEGER;
      const bOrder = sourceOrderMap.has(bKey) ? sourceOrderMap.get(bKey) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return aKey.localeCompare(bKey);
    });

    const rows = [];
    for (const student of orderedStudents) {
      const regNo = String(student.reg_no || '').toUpperCase();
      const latestSubmission = (submissionsByRoll.get(regNo) || [])[0] || null;

      rows.push({
        Name: student.full_name || '',
        'Register Number': student.reg_no || '',
        Topic: latestSubmission?.test_title || '',
        Section: latestSubmission?.section || student.section || 'Unspecified Section',
        Status: latestSubmission?.status || 'not submitted',
        'Obtain Mark': latestSubmission && latestSubmission.marks !== null ? Number(latestSubmission.marks) : '',
        'Total Marks': latestSubmission && latestSubmission.total_marks !== null ? Number(latestSubmission.total_marks) : '',
      });
    }

    const sanitizeSheetName = (value) =>
      String(value || 'Sheet')
        .replace(/[\\/*?:\[\]]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 31) || 'Sheet';

    const reportColumns = [
      { header: 'Name', key: 'Name' },
      { header: 'Register Number', key: 'Register Number' },
      { header: 'Topic', key: 'Topic' },
      { header: 'Section', key: 'Section' },
      { header: 'Status', key: 'Status' },
      { header: 'Obtain Mark', key: 'Obtain Mark' },
      { header: 'Total Marks', key: 'Total Marks' },
    ];

    // Create fresh workbook
    const workbook = new ExcelJS.Workbook();
    workbook.properties.date1904 = false;

    const addFormattedSheet = (sheetName, sheetRows) => {
      // Prevent duplicate sheet names
      if (workbook.getWorksheet(sheetName)) {
        workbook.removeWorksheet(sheetName);
      }

      const worksheet = workbook.addWorksheet(sheetName);
      worksheet.columns = reportColumns;

      // Add data rows
      if (sheetRows && sheetRows.length > 0) {
        worksheet.addRows(sheetRows);
      }

      // Format header row
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF0F0F0' }
      };

      // Auto-fit column widths based on content
      for (let colIndex = 0; colIndex < reportColumns.length; colIndex++) {
        const column = worksheet.columns[colIndex];
        const header = column.header || '';
        let maxLength = String(header).length;

        // Check all cells in column for max width
        for (let rowNum = 2; rowNum <= sheetRows.length + 1; rowNum++) {
          const cell = worksheet.getCell(rowNum, colIndex + 1);
          const cellValue = cell.value == null ? '' : String(cell.value);
          maxLength = Math.max(maxLength, cellValue.length);
        }

        // Set column width (min 12, max 50)
        column.width = Math.min(50, Math.max(12, maxLength + 2));
      }

      console.log(`[EXCEL-REBUILD] Added sheet: ${sheetName} with ${sheetRows.length} rows`);
    };

    // Add All Students sheet
    addFormattedSheet('All Students', rows);

    // Group by Section for section-wise sheets
    const grouped = new Map();
    for (const row of rows) {
      const key = String(row.Section || 'Unspecified Section');
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }

    const usedNames = new Set(['All Students']);

    // Add section-wise sheets (Section A3, Section A7, etc.)
    for (const [section, groupRows] of grouped.entries()) {
      const baseName = sanitizeSheetName(`Section ${section}`);
      let sheetName = baseName;
      let suffix = 1;
      while (usedNames.has(sheetName)) {
        const suffixText = ` (${suffix})`;
        sheetName = `${baseName.slice(0, Math.max(1, 31 - suffixText.length))}${suffixText}`;
        suffix += 1;
      }
      usedNames.add(sheetName);

      addFormattedSheet(sheetName, groupRows);
    }

    // Add explicit class-wise sheets (A7, A3, etc.) for easy reference
    const sectionGroups = new Map();
    for (const row of rows) {
      const sectionKey = String(row.Section || 'Unspecified Section').toUpperCase();
      if (!sectionGroups.has(sectionKey)) sectionGroups.set(sectionKey, []);
      sectionGroups.get(sectionKey).push(row);
    }

    // Ensure default sections exist (even if empty)
    const defaultSections = ['A7', 'A3'];
    for (const section of defaultSections) {
      if (!sectionGroups.has(section)) sectionGroups.set(section, []);
    }

    // Add class-wise sheets
    for (const [section, sectionRows] of sectionGroups.entries()) {
      const baseName = sanitizeSheetName(section);
      let sheetName = baseName;
      let suffix = 1;
      while (usedNames.has(sheetName)) {
        const suffixText = ` (${suffix})`;
        sheetName = `${baseName.slice(0, Math.max(1, 31 - suffixText.length))}${suffixText}`;
        suffix += 1;
      }
      usedNames.add(sheetName);

      addFormattedSheet(sheetName, sectionRows);
    }

    // Ensure upload directory exists
    fs.mkdirSync(path.dirname(gradedReportFilePath), { recursive: true });

    // Write workbook to file
    console.log(`[EXCEL-REBUILD] Writing Excel file to: ${gradedReportFilePath}`);
    await workbook.xlsx.writeFile(gradedReportFilePath);

    // Verify file was written
    if (!fs.existsSync(gradedReportFilePath)) {
      throw new Error(`Excel file was not created at: ${gradedReportFilePath}`);
    }

    const fileStats = fs.statSync(gradedReportFilePath);
    console.log(`[EXCEL-REBUILD] ✓ Successfully wrote ${fileStats.size} bytes to ${gradedReportFilePath}`);

    return {
      rows: rows.length,
      filePath: gradedReportFilePath,
      worksheets: workbook.worksheets.length,
      fileSize: fileStats.size,
    };
  } catch (err) {
    console.error('[EXCEL-REBUILD] ✗ Error rebuilding Excel workbook:', err.message || err);
    throw err;
  } finally {
    excelRebuildInProgress = false;
  }
}

app.post('/admin/students/import', requireSuperAdmin, excelUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Excel file is required' });
    }

    const fallbackStream = String(req.body?.stream || '').trim();
    const fallbackSection = String(req.body?.section || '').trim().toUpperCase();
    const rows = parseStudentsFromWorkbook(req.file.buffer);
    if (!rows.length) {
      return res.status(400).json({ error: 'No valid student rows found in file' });
    }

    let inserted = 0;
    let updated = 0;
    const streamCount = {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const stream = row.stream || fallbackStream;
        const section = row.section || fallbackSection || inferSectionFromRegNo(row.regNo);
        const upsertStudent = await client.query(
          `INSERT INTO students (reg_no, full_name, stream, section)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (reg_no)
           DO UPDATE SET full_name = EXCLUDED.full_name,
                         stream = EXCLUDED.stream,
                         section = EXCLUDED.section
           RETURNING (xmax = 0) AS inserted`,
          [row.regNo, row.fullName, stream || null, section || null]
        );

        await client.query(
          `INSERT INTO student_auth (reg_no, password_hash, password_changed)
           VALUES ($1, $2, FALSE)
           ON CONFLICT (reg_no) DO NOTHING`,
          [row.regNo, hashPassword(row.regNo)]
        );

        if (upsertStudent.rows[0].inserted) inserted += 1;
        else updated += 1;

        const key = stream || 'Unspecified';
        streamCount[key] = (streamCount[key] || 0) + 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({
      ok: true,
      total: rows.length,
      inserted,
      updated,
      streams: streamCount,
    });
  } catch (err) {
    next(err);
  }
});

app.post('/auth/staff/password', requireAuth('staff'), async (req, res, next) => {
  try {
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    await pool.query(
      `UPDATE staff_accounts
       SET password_hash = $1, updated_at = NOW()
       WHERE email = $2`,
      [hashPassword(newPassword), req.auth.email]
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/students/count', requireAuth(['staff', 'student']), async (_req, res) => {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM students');
  res.json({ count: result.rows[0].count });
});

function normalizeSubmissionRow(row) {
  let images = [];
  try {
    if (typeof row.images === 'string') {
      images = JSON.parse(row.images || '[]');
    } else if (Array.isArray(row.images)) {
      images = row.images;
    }
  } catch (e) {
    console.error('[NORMALIZE] Failed to parse images:', e.message, 'raw:', row.images);
  }

  const normalizedImages = images
    .map((item) => toPublicImageUrl(item))
    .filter(Boolean);
  images = normalizedImages;

  return {
    id: row.id,
    studentName: row.student_name,
    rollNumber: row.roll_number,
    subject: row.subject || '',
    classroom: row.classroom || '',
    testTitle: row.test_title || '',
    notes: row.notes || '',
    images: images,
    fileCount: Number(row.file_count || 0),
    status: row.status || 'pending',
    marks: row.marks === null ? null : Number(row.marks),
    totalMarks: row.total_marks === null ? null : Number(row.total_marks),
    feedback: row.feedback || '',
    archived: Boolean(row.archived),
    submittedAt: row.submitted_at,
    gradedAt: row.graded_at,
  };
}

app.get('/submissions', requireAuth(['staff', 'student']), async (req, res, next) => {
  try {
    const rollNumberQuery = String(req.query.rollNumber || '').trim();
    const includeArchived = String(req.query.includeArchived || 'true').toLowerCase() === 'true';
    const status = String(req.query.status || '').trim();

    const where = [];
    const params = [];

    if (req.auth.role === 'student') {
      params.push(req.auth.regNo);
      where.push(`roll_number = $${params.length}`);
      where.push('archived = FALSE');
    } else {
      if (rollNumberQuery) {
        params.push(rollNumberQuery);
        where.push(`roll_number = $${params.length}`);
      }
      if (!includeArchived) {
        where.push('archived = FALSE');
      }
    }

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const query = `
      SELECT *
      FROM submissions
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY submitted_at DESC
    `;

    const result = await pool.query(query, params);
    const normalized = result.rows.map(normalizeSubmissionRow);
    console.log('[GET-SUBMISSIONS] Retrieved', normalized.length, 'submissions');
    normalized.forEach((s, i) => {
      console.log(`[GET-SUBMISSIONS] Submission ${i + 1} (${s.id}): images=${s.images ? s.images.length : 0}`);
    });
    res.json({ submissions: normalized });
  } catch (err) {
    next(err);
  }
});

app.get('/submissions/:id', requireAuth(['staff', 'student']), async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM submissions WHERE id = $1', [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = normalizeSubmissionRow(result.rows[0]);
    if (req.auth.role === 'student' && submission.rollNumber !== req.auth.regNo) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({ submission });
  } catch (err) {
    next(err);
  }
});

app.post('/submissions', requireAuth('student'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const id = String(body.id || '').trim();
    const studentName = String(body.studentName || '').trim();
    const rollNumber = String(body.rollNumber || '').trim();
    const testTitle = String(body.testTitle || '').trim();

    console.log('[SUBMISSION-CREATE] Received submission:', { id, studentName, rollNumber, testTitle });
    console.log('[SUBMISSION-CREATE] Images count:', Array.isArray(body.images) ? body.images.length : 'not-array');
    console.log('[SUBMISSION-CREATE] Images data:', body.images);

    if (!id || !studentName || !rollNumber || !testTitle) {
      console.error('[SUBMISSION-CREATE] Missing required fields');
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (rollNumber !== req.auth.regNo) {
      console.error('[SUBMISSION-CREATE] Forbidden: role mismatch');
      return res.status(403).json({ error: 'Forbidden' });
    }

    const imagesJson = JSON.stringify(normalizeImagesForStorage(body.images));
    console.log('[SUBMISSION-CREATE] Stringified images JSON:', imagesJson);

    const submissionValues = [
      id,
      studentName,
      rollNumber,
      String(body.subject || ''),
      String(body.classroom || ''),
      testTitle,
      String(body.notes || ''),
      imagesJson,
      Number(body.fileCount || 0),
      String(body.status || 'pending'),
      body.marks === null || body.marks === undefined || body.marks === '' ? null : Number(body.marks),
      body.totalMarks === null || body.totalMarks === undefined || body.totalMarks === '' ? null : Number(body.totalMarks),
      String(body.feedback || ''),
      Boolean(body.archived),
      body.submittedAt ? new Date(body.submittedAt) : new Date(),
      body.gradedAt ? new Date(body.gradedAt) : null,
    ];

    const result = await pool.query(
      `INSERT INTO submissions (
        id, student_name, roll_number, subject, classroom, test_title, notes,
        images, file_count, status, marks, total_marks, feedback, archived,
        submitted_at, graded_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8::jsonb, $9, $10, $11, $12, $13, $14,
        $15, $16
      ) RETURNING *`,
      submissionValues
    );

    const normalized = normalizeSubmissionRow(result.rows[0]);
    console.log('[SUBMISSION-CREATE] ✓ Saved! DB row images:', result.rows[0].images);
    console.log('[SUBMISSION-CREATE] ✓ Normalized images:', normalized.images);
    res.status(201).json({ submission: normalized });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Submission already exists' });
    }
    next(err);
  }
});

app.patch('/submissions/:id', requireAuth(['staff', 'student']), async (req, res, next) => {
  try {
    const body = req.body || {};
    const editable = {
      studentName: ['student_name', (v) => String(v || '')],
      rollNumber: ['roll_number', (v) => String(v || '')],
      subject: ['subject', (v) => String(v || '')],
      classroom: ['classroom', (v) => String(v || '')],
      testTitle: ['test_title', (v) => String(v || '')],
      notes: ['notes', (v) => String(v || '')],
      images: ['images', (v) => JSON.stringify(normalizeImagesForStorage(v))],
      fileCount: ['file_count', (v) => Number(v || 0)],
      status: ['status', (v) => String(v || 'pending')],
      marks: ['marks', (v) => (v === null || v === '' || v === undefined ? null : Number(v))],
      totalMarks: ['total_marks', (v) => (v === null || v === '' || v === undefined ? null : Number(v))],
      feedback: ['feedback', (v) => String(v || '')],
      archived: ['archived', (v) => Boolean(v)],
      gradedAt: ['graded_at', (v) => (v ? new Date(v) : null)],
      submittedAt: ['submitted_at', (v) => (v ? new Date(v) : null)],
    };

    if (req.auth.role === 'student') {
      const allowedForStudent = new Set(['testTitle', 'notes', 'images', 'fileCount']);
      const disallowed = Object.keys(body).filter((key) => !allowedForStudent.has(key));
      if (disallowed.length) {
        return res.status(403).json({ error: `Students cannot update: ${disallowed.join(', ')}` });
      }

      const existing = await pool.query(
        'SELECT id, roll_number, status FROM submissions WHERE id = $1',
        [req.params.id]
      );
      if (!existing.rows.length) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      if (existing.rows[0].roll_number !== req.auth.regNo) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (existing.rows[0].status !== 'pending') {
        return res.status(400).json({ error: 'Only pending submissions can be edited' });
      }
    }

    const setParts = [];
    const params = [];
    Object.keys(editable).forEach((key) => {
      if (!(key in body)) return;
      const [column, normalize] = editable[key];
      params.push(normalize(body[key]));
      if (column === 'images') {
        setParts.push(`${column} = $${params.length}::jsonb`);
      } else {
        setParts.push(`${column} = $${params.length}`);
      }
    });

    if (!setParts.length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    setParts.push('updated_at = NOW()');
    params.push(req.params.id);
    let whereClause = `id = $${params.length}`;
    if (req.auth.role === 'student') {
      params.push(req.auth.regNo);
      whereClause += ` AND roll_number = $${params.length} AND status = 'pending'`;
    }

    const result = await pool.query(
      `UPDATE submissions
       SET ${setParts.join(', ')}
       WHERE ${whereClause}
       RETURNING *`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    const submission = normalizeSubmissionRow(result.rows[0]);
    const reportSensitiveKeys = new Set(['studentName', 'rollNumber', 'testTitle', 'subject', 'classroom', 'status', 'marks', 'totalMarks', 'feedback', 'fileCount', 'submittedAt', 'gradedAt', 'archived']);
    const shouldRefreshReport = req.auth.role === 'staff' && Object.keys(body).some((key) => reportSensitiveKeys.has(key));

    let reportSync = null;
    if (shouldRefreshReport) {
      try {
        console.log('[PATCH-SUBMISSION] Triggering report rebuild after submission update');
        reportSync = await rebuildGradedReportWorkbook();
        console.log('[PATCH-SUBMISSION] Report rebuild result:', reportSync);
      } catch (rebuildErr) {
        console.error('[PATCH-SUBMISSION] Warning: Report rebuild failed (but submission was saved):', rebuildErr.message);
        reportSync = { error: rebuildErr.message };
      }
    }

    res.json({ submission, reportSync });
  } catch (err) {
    next(err);
  }
});

app.get('/reports/graded.xlsx', requireAuth('staff'), async (_req, res, next) => {
  try {
    console.log('[REPORT-DOWNLOAD] Requesting graded report download');
    const result = await rebuildGradedReportWorkbook();

    if (!fs.existsSync(gradedReportFilePath)) {
      console.error('[REPORT-DOWNLOAD] Excel file does not exist at:', gradedReportFilePath);
      return res.status(500).json({ error: 'Failed to generate report file' });
    }

    const fileStats = fs.statSync(gradedReportFilePath);
    console.log(`[REPORT-DOWNLOAD] Sending report (${fileStats.size} bytes), rebuild result:`, result);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="graded-report.xlsx"');
    res.download(gradedReportFilePath, 'graded-report.xlsx');
  } catch (err) {
    console.error('[REPORT-DOWNLOAD] Error:', err.message || err);
    next(err);
  }
});

app.get('/reports/students-list.xlsx', requireAuth('staff'), async (_req, res, next) => {
  try {
    const studentsListPath = path.resolve(uploadDir, 'students-list.xlsx');
    console.log('[DEBUG] Students list path:', studentsListPath);
    console.log('[DEBUG] File exists:', fs.existsSync(studentsListPath));

    if (!fs.existsSync(studentsListPath)) {
      return res.status(404).json({ error: 'Students list not found. Generate it first from Tracker tab.' });
    }
    res.download(studentsListPath, 'students-list.xlsx');
  } catch (err) {
    console.error('[ERROR] Download students-list:', err);
    next(err);
  }
});

app.post('/submissions/archive-all', requireAuth('staff'), async (_req, res, next) => {
  try {
    const result = await pool.query(
      'UPDATE submissions SET archived = TRUE, updated_at = NOW() WHERE archived = FALSE RETURNING id'
    );
    res.json({ ok: true, archived: result.rowCount || 0 });
  } catch (err) {
    next(err);
  }
});

app.delete('/submissions/:id', requireAuth(['staff', 'student']), async (req, res, next) => {
  try {
    let result;
    if (req.auth.role === 'student') {
      result = await pool.query(
        `DELETE FROM submissions
         WHERE id = $1 AND roll_number = $2 AND status = 'pending'
         RETURNING id`,
        [req.params.id, req.auth.regNo]
      );
    } else {
      result = await pool.query('DELETE FROM submissions WHERE id = $1 RETURNING id', [req.params.id]);
    }

    if (!result.rows.length) {
      if (req.auth.role === 'student') {
        return res.status(404).json({ error: 'Submission not found or cannot be deleted' });
      }
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (req.auth.role === 'staff') {
      try {
        console.log('[DELETE-SUBMISSION] Triggering report rebuild after submission deletion');
        await rebuildGradedReportWorkbook();
        console.log('[DELETE-SUBMISSION] Report rebuild successful');
      } catch (rebuildErr) {
        console.error('[DELETE-SUBMISSION] Warning: Report rebuild failed (but submission was deleted):', rebuildErr.message);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/upload', requireAuth('student'), upload.array('files', 20), async (req, res, next) => {
  console.log('[UPLOAD] Starting file upload...');
  console.log('[UPLOAD] Files received:', (req.files || []).length);
  console.log('[UPLOAD] Upload dir:', uploadDir);
  console.log('[UPLOAD] First file:', req.files?.[0] ? { name: req.files[0].originalname, size: req.files[0].size, mime: req.files[0].mimetype } : 'none');

  const files = (req.files || []).map((file) => ({
    storedName: createStoredUploadName(file.originalname),
    originalName: file.originalname,
    url: '',
    size: file.size,
    mimeType: file.mimetype,
    data: file.buffer,
  }));

  for (const file of files) {
    file.url = toPublicImageUrl(file.storedName);
  }

  if (!files.length) {
    console.error('[UPLOAD] ERROR: No files provided in request');
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of files) {
        await client.query(
          `INSERT INTO uploads (stored_name, original_name, mime_type, size_bytes, file_url, file_data)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (stored_name)
           DO UPDATE SET original_name = EXCLUDED.original_name,
                         mime_type = EXCLUDED.mime_type,
                         size_bytes = EXCLUDED.size_bytes,
                         file_url = EXCLUDED.file_url,
                         file_data = EXCLUDED.file_data`,
          [file.storedName, file.originalName, file.mimeType, file.size, file.url, file.data]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    cleanupUploadDiskCopies(files.map((file) => file.storedName));

    console.log('[UPLOAD] SUCCESS: Saved', files.length, 'files to database');
    const responseFiles = files.map((file) => ({
      name: file.storedName,
      originalName: file.originalName,
      url: file.url,
      size: file.size,
      mimeType: file.mimeType,
    }));
    res.json({ files: responseFiles });
  } catch (err) {
    console.error('[UPLOAD] DATABASE ERROR:', err.message);
    next(err);
  }
});

function parseStudentsFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/const\s+STUDENTS_DB\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error('Could not find STUDENTS_DB object in students-db.js');
  }

  const objectLiteral = match[1];
  return Function(`"use strict"; return (${objectLiteral});`)();
}

async function ensureSchema() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      reg_no TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      stream TEXT,
      section TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS stream TEXT');
  await pool.query('ALTER TABLE students ADD COLUMN IF NOT EXISTS section TEXT');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_auth (
      reg_no TEXT PRIMARY KEY REFERENCES students(reg_no) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      password_changed BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_accounts (
      email TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploads (
      id BIGSERIAL PRIMARY KEY,
      stored_name TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes BIGINT,
      file_url TEXT NOT NULL,
      file_data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS file_data BYTEA');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      roll_number TEXT NOT NULL,
      subject TEXT,
      classroom TEXT,
      test_title TEXT NOT NULL,
      notes TEXT,
      images JSONB NOT NULL DEFAULT '[]'::jsonb,
      file_count INT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      marks NUMERIC,
      total_marks NUMERIC,
      feedback TEXT,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      graded_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_submissions_roll_number ON submissions (roll_number)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions (submitted_at DESC)');
}

async function syncStudentsFromFile() {
  const students = parseStudentsFromFile(studentsFile);
  const entries = Object.entries(students);
  if (!entries.length) return { inserted: 0, updated: 0, total: 0 };

  let inserted = 0;
  let updated = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [regNo, fullName] of entries) {
      const section = inferSectionFromRegNo(regNo) || null;
      const upsertStudent = await client.query(
        `INSERT INTO students (reg_no, full_name, stream, section)
         VALUES ($1, $2, NULL, $3)
         ON CONFLICT (reg_no)
         DO UPDATE SET full_name = EXCLUDED.full_name,
                       section = COALESCE(students.section, EXCLUDED.section)
         RETURNING (xmax = 0) AS inserted`,
        [regNo, fullName, section]
      );

      await client.query(
        `INSERT INTO student_auth (reg_no, password_hash, password_changed)
         VALUES ($1, $2, FALSE)
         ON CONFLICT (reg_no) DO NOTHING`,
        [regNo, hashPassword(regNo)]
      );

      if (upsertStudent.rows[0].inserted) inserted += 1;
      else updated += 1;
    }
    await client.query('COMMIT');
    console.log(`Synced ${entries.length} students from ${studentsFile}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { inserted, updated, total: entries.length };
}

async function upsertDefaultStaffAccount() {
  await pool.query(
    `INSERT INTO staff_accounts (email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (email)
     DO UPDATE SET full_name = EXCLUDED.full_name,
                   role = EXCLUDED.role,
                   password_hash = EXCLUDED.password_hash,
                   is_active = TRUE,
                   updated_at = NOW()`,
    [staffDefaultEmail, staffDefaultName, staffDefaultRole, hashPassword(staffDefaultPassword)]
  );
  console.log(`Upserted default staff account: ${staffDefaultEmail}`);
}

async function upsertDefaultSuperAdminAccount() {
  await pool.query(
    `INSERT INTO staff_accounts (email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (email)
     DO UPDATE SET full_name = EXCLUDED.full_name,
                   role = EXCLUDED.role,
                   password_hash = EXCLUDED.password_hash,
                   is_active = TRUE,
                   updated_at = NOW()`,
    [superAdminDefaultEmail, superAdminDefaultName, superAdminDefaultRole, hashPassword(superAdminDefaultPassword)]
  );
  console.log(`Upserted default super admin account: ${superAdminDefaultEmail}`);
}

async function seedStudentsIfEmpty() {
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM students');
  if (countResult.rows[0].count > 0) {
    return;
  }

  const result = await syncStudentsFromFile();
  console.log(`Initial student seed completed. Inserted: ${result.inserted}, Updated: ${result.updated}, Total source: ${result.total}`);
}

async function syncStudentsOnApiStartup() {
  if (!syncStudentsOnStartup) {
    console.log('Startup student sync is disabled (STUDENTS_SYNC_ON_STARTUP=false)');
    return;
  }

  const result = await syncStudentsFromFile();
  console.log(`Startup student sync completed. Inserted: ${result.inserted}, Updated: ${result.updated}, Total source: ${result.total}`);
}

async function backfillMissingStudentAuth() {
  const result = await pool.query(
    `INSERT INTO student_auth (reg_no, password_hash, password_changed)
     SELECT s.reg_no, encode(digest(s.reg_no || ':' || $1, 'sha256'), 'hex'), FALSE
     FROM students s
     LEFT JOIN student_auth a ON a.reg_no = s.reg_no
     WHERE a.reg_no IS NULL`,
    [authPepper]
  );

  if (result.rowCount > 0) {
    console.log(`Backfilled ${result.rowCount} missing student_auth rows`);
  }
}

async function enforceDefaultPasswordForFirstLoginAccounts() {
  const result = await pool.query(
    `UPDATE student_auth a
     SET password_hash = encode(digest(a.reg_no || ':' || $1, 'sha256'), 'hex'),
         updated_at = NOW()
     WHERE a.password_changed = FALSE`,
    [authPepper]
  );

  if (result.rowCount > 0) {
    console.log(`Enforced default password (reg_no) for ${result.rowCount} first-login student accounts`);
  }
}

async function backfillStudentSectionFromRegNo() {
  await pool.query(
    `UPDATE students
     SET section = CASE
       WHEN reg_no LIKE '%BAD%' OR reg_no LIKE '%BAM%' THEN 'A7'
       WHEN reg_no LIKE '%BCS%' OR reg_no LIKE '%BIT%' OR reg_no LIKE '%BSC%' THEN 'A3'
       ELSE section
     END
     WHERE section IS NULL OR BTRIM(section) = ''`
  );
}

app.post('/students/resync', requireAuth('staff'), async (req, res, next) => {
  try {
    if (resyncToken) {
      const provided = req.header('x-resync-token') || '';
      if (provided !== resyncToken) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const result = await syncStudentsFromFile();
    res.json({
      ok: true,
      message: 'Students re-sync completed without deleting existing rows',
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 15MB)' });
  }
  console.error('API error:', err);
  res.status(500).json({ error: 'Server error' });
});

async function bootstrap() {
  await ensureSchema();
  await syncStudentsOnApiStartup();
  await backfillStudentSectionFromRegNo();
  await backfillMissingStudentAuth();
  await enforceDefaultPasswordForFirstLoginAccounts();
  await upsertDefaultStaffAccount();
  await upsertDefaultSuperAdminAccount();
  dbReady = true;

  app.listen(port, '0.0.0.0', () => {
    console.log(`API listening on ${port}`);
  });
}

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});