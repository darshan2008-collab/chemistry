const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const app = express();
const port = Number(process.env.API_PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || (process.platform === 'win32'
  ? path.join(process.cwd(), 'data', 'uploads')
  : '/data/uploads');
const sessionStoreFilePath = process.env.AUTH_SESSION_STORE_FILE || path.join(uploadDir, '.auth-sessions.json');
const gradedReportFilePath = process.env.GRADED_REPORT_FILE || path.join(uploadDir, 'graded-report.xlsx');
const studentsFile = process.env.STUDENTS_FILE || '/app/students-db.js';
const syncStudentsOnStartup = String(process.env.STUDENTS_SYNC_ON_STARTUP || 'true').trim().toLowerCase() !== 'false';
const baselineAssignmentsOnStartup = String(process.env.BASELINE_ASSIGNMENTS_ON_STARTUP || 'false').trim().toLowerCase() !== 'false';
const uhvAssignmentsOnStartup = String(process.env.UHV_ASSIGNMENTS_ON_STARTUP || 'false').trim().toLowerCase() !== 'false';
const resyncToken = process.env.RESYNC_TOKEN || '';
const authPepper = requiredEnv('AUTH_PEPPER');
const sessionTtlHours = Number(process.env.AUTH_SESSION_TTL_HOURS || 24);
const retentionDays = Math.max(Number(process.env.RETENTION_DAYS || 90), 1);
const studentQuotaBytesDefault = Number(process.env.STUDENT_QUOTA_BYTES || 500 * 1024 * 1024);
const passwordHashRounds = Math.max(Number(process.env.PASSWORD_HASH_ROUNDS || 12), 10);

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const allowedStudentUploadMimeTypes = new Set([
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/heic',
  'image/heif'
]);

const allowedStudentUploadExtensions = new Set(['.pdf', '.ppt', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif']);

const allowedStudentPptMimeTypes = new Set([
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const allowedStudentPptExtensions = new Set(['.ppt', '.pptx']);


const staffDefaultEmail = requiredEnv('STAFF_DEFAULT_EMAIL').toLowerCase();
const staffDefaultPassword = requiredEnv('STAFF_DEFAULT_PASSWORD');
const staffDefaultName = process.env.STAFF_DEFAULT_NAME || 'System Admin';
const staffDefaultRole = process.env.STAFF_DEFAULT_ROLE || 'Chemistry Teacher';
const superAdminDefaultEmail = requiredEnv('SUPERADMIN_DEFAULT_EMAIL').toLowerCase();
const superAdminDefaultPassword = requiredEnv('SUPERADMIN_DEFAULT_PASSWORD');
const superAdminDefaultName = process.env.SUPERADMIN_DEFAULT_NAME || 'Unitary X';
const superAdminDefaultRole = process.env.SUPERADMIN_DEFAULT_ROLE || 'Super Admin';

// UHV staff account defaults
const uhvStaffEmail = requiredEnv('UHV_STAFF_EMAIL').toLowerCase();
const uhvStaffPassword = requiredEnv('UHV_STAFF_PASSWORD');
const uhvStaffName = process.env.UHV_STAFF_NAME || 'Vijayakumar';
const uhvStaffRole = process.env.UHV_STAFF_ROLE || 'UHV Teacher';

app.use(express.json({ limit: '1mb' }));

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
        return `/api/files/${encodeURIComponent(path.basename(tail))}`;
      }
    } catch (_err) {
      // Fall through to best-effort normalization below
    }
    return raw;
  }
  if (raw.startsWith('/api/files/')) return raw;
  if (raw.startsWith('/api/uploads/')) {
    return `/api/files/${encodeURIComponent(path.basename(raw))}`;
  }
  if (raw.startsWith('/uploads/')) {
    return `/api/files/${encodeURIComponent(path.basename(raw))}`;
  }
  if (raw.startsWith('uploads/')) {
    return `/api/files/${encodeURIComponent(path.basename(raw))}`;
  }

  // Handle Windows/local absolute paths by taking only file name.
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.includes('\\')) {
    return `/api/files/${encodeURIComponent(path.basename(raw))}`;
  }

  // Handle any path that contains /uploads/ somewhere inside it.
  const marker = '/uploads/';
  const markerIdx = raw.toLowerCase().lastIndexOf(marker);
  if (markerIdx >= 0) {
    const tail = raw.slice(markerIdx + marker.length).replace(/^\/+/, '');
    return `/api/files/${encodeURIComponent(path.basename(tail))}`;
  }

  return `/api/files/${encodeURIComponent(path.basename(raw.replace(/^\/+/, '')))}`;
}

app.get('/files/:name', async (req, res, next) => {
  const safeName = path.basename(String(req.params.name || ''));
  if (!safeName) {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  try {
    const dbResult = await pool.query(
      `SELECT stored_name, mime_type, original_name, file_data, owner_reg_no, subject_id, upload_kind
       FROM uploads
       WHERE stored_name = $1`,
      [safeName]
    );

    if (dbResult.rows.length) {
      const row = dbResult.rows[0];

      if (row.file_data) {
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
    }
    return res.status(404).json({ error: 'File not found' });
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
let sessionStoreWriteTimer = null;

fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(path.dirname(gradedReportFilePath), { recursive: true });

function flushSessionsToDisk() {
  const now = Date.now();
  const rows = [];
  for (const [token, session] of sessions.entries()) {
    if (!token || !session || Number(session.expiresAt || 0) <= now) continue;
    rows.push({ token, ...session });
  }

  const payload = {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    sessions: rows,
  };

  const targetDir = path.dirname(sessionStoreFilePath);
  fs.mkdirSync(targetDir, { recursive: true });
  const tmpPath = `${sessionStoreFilePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), 'utf8');
  fs.renameSync(tmpPath, sessionStoreFilePath);
}

function scheduleSessionsFlush() {
  if (sessionStoreWriteTimer) return;
  sessionStoreWriteTimer = setTimeout(() => {
    sessionStoreWriteTimer = null;
    try {
      flushSessionsToDisk();
    } catch (_err) {
      // Best effort persistence; runtime auth should not fail due to local disk write errors.
    }
  }, 250);
  if (typeof sessionStoreWriteTimer.unref === 'function') {
    sessionStoreWriteTimer.unref();
  }
}

function loadSessionsFromDisk() {
  try {
    if (!fs.existsSync(sessionStoreFilePath)) return;
    const raw = fs.readFileSync(sessionStoreFilePath, 'utf8');
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    for (const item of entries) {
      const token = String(item?.token || '').trim();
      const expiresAt = Number(item?.expiresAt || 0);
      if (!token || expiresAt <= now) continue;
      const restored = { ...item, expiresAt };
      delete restored.token;
      sessions.set(token, restored);
    }
  } catch (_err) {
    // Corrupt session snapshots should not block startup.
  }
}

loadSessionsFromDisk();

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

function sanitizePathSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function writeFileToStorage(relativeFolder, storedName, buffer) {
  const safeFolder = String(relativeFolder || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const baseDir = path.resolve(uploadDir);
  const absoluteFolder = path.resolve(baseDir, safeFolder);
  if (!absoluteFolder.startsWith(baseDir)) {
    throw new Error('Invalid storage folder');
  }
  fs.mkdirSync(absoluteFolder, { recursive: true });
  const absolutePath = path.join(absoluteFolder, path.basename(storedName));
  fs.writeFileSync(absolutePath, buffer);
  return absolutePath;
}

function toUploadsPublicUrl(relativeFolder, storedName) {
  const fileName = encodeURIComponent(path.basename(String(storedName || 'file')));
  return `/api/files/${fileName}`;
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

function listFilesRecursively(baseDir) {
  const rows = [];
  if (!fs.existsSync(baseDir)) return rows;
  const stack = [baseDir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_err) {
      continue;
    }
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      rows.push(absolutePath);
    }
  }
  return rows;
}

function isInternalTokenAuthorized(req) {
  const provided = String(req.header('x-resync-token') || '').trim();
  if (!resyncToken) return false;
  return provided === resyncToken;
}

async function cleanupOrphanedUploadFiles() {
  const now = Date.now();
  const minAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const keepNames = new Set();
  const dbRows = await pool.query('SELECT stored_name FROM uploads WHERE stored_name IS NOT NULL');
  for (const row of dbRows.rows) {
    const name = path.basename(String(row?.stored_name || ''));
    if (name) keepNames.add(name);
  }

  const scannedFiles = listFilesRecursively(uploadDir);
  let deleted = 0;
  const deletedFiles = [];

  for (const filePath of scannedFiles) {
    const fileName = path.basename(filePath);
    if (fileName === path.basename(sessionStoreFilePath)) continue;
    if (keepNames.has(fileName)) continue;
    let stat = null;
    try {
      stat = fs.statSync(filePath);
    } catch (_err) {
      continue;
    }
    if (!stat || !stat.isFile()) continue;
    if ((now - Number(stat.mtimeMs || 0)) < minAgeMs) continue;
    try {
      fs.unlinkSync(filePath);
      deleted += 1;
      if (deletedFiles.length < 100) {
        deletedFiles.push(path.relative(uploadDir, filePath).replace(/\\/g, '/'));
      }
    } catch (_err) {
      // Continue cleanup even if one file cannot be deleted.
    }
  }

  return {
    scanned: scannedFiles.length,
    referenced: keepNames.size,
    deleted,
    retentionDays,
    deletedFiles,
  };
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

const materialUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
  },
});

function hashPasswordLegacy(value) {
  return crypto.createHash('sha256').update(`${String(value)}:${authPepper}`).digest('hex');
}

function isBcryptHash(hashValue) {
  return /^\$2[aby]\$\d{2}\$/.test(String(hashValue || ''));
}

function hashPassword(value) {
  return bcrypt.hashSync(`${String(value)}:${authPepper}`, passwordHashRounds);
}

function verifyPassword(value, passwordHash) {
  const input = `${String(value)}:${authPepper}`;
  if (isBcryptHash(passwordHash)) {
    return bcrypt.compareSync(input, String(passwordHash || ''));
  }
  return hashPasswordLegacy(value) === String(passwordHash || '');
}

function createSession(payload) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + (Math.max(sessionTtlHours, 1) * 60 * 60 * 1000);
  sessions.set(token, { ...payload, expiresAt });
  scheduleSessionsFlush();
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
    scheduleSessionsFlush();
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

function normalizeRegNo(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeStaffEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSubjectCode(value) {
  return String(value || '').trim().toUpperCase();
}

function defaultPermissionsForRole(roleName) {
  const role = String(roleName || '').trim().toLowerCase();
  if (role === 'super admin' || role === 'superadmin') {
    return {
      manageStaff: true,
      manageSubjects: true,
      manageAssignments: true,
      manageDatabase: true,
      viewAuditLogs: true,
      manageFeatureFlags: true,
      sendAnnouncements: true,
      uploadMaterials: true,
    };
  }
  return {
    manageStaff: false,
    manageSubjects: false,
    manageAssignments: false,
    manageDatabase: false,
    viewAuditLogs: false,
    manageFeatureFlags: false,
    sendAnnouncements: true,
    uploadMaterials: true,
  };
}

async function getStaffPermissions(email, roleName) {
  const normalizedEmail = normalizeStaffEmail(email);
  const result = await pool.query(
    `SELECT permissions_json
     FROM role_policies
     WHERE staff_email = $1`,
    [normalizedEmail]
  );
  const defaults = defaultPermissionsForRole(roleName);
  if (!result.rows.length || !result.rows[0].permissions_json) {
    return defaults;
  }
  return { ...defaults, ...result.rows[0].permissions_json };
}

async function hasPermission(session, permissionKey) {
  if (!session || session.role !== 'staff') return false;
  if (isSuperAdminSession(session)) return true;
  const perms = await getStaffPermissions(session.email, session.staffRole || session.roleName);
  return Boolean(perms?.[permissionKey]);
}

async function writeAuditLog({ actor, action, targetType, targetId, beforeJson = null, afterJson = null }) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (actor, action, target_type, target_id, before_json, after_json)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        String(actor || ''),
        String(action || ''),
        String(targetType || ''),
        targetId === undefined || targetId === null ? null : String(targetId),
        beforeJson ? JSON.stringify(beforeJson) : null,
        afterJson ? JSON.stringify(afterJson) : null,
      ]
    );
  } catch (err) {
    console.warn('[AUDIT] Failed to write audit log:', err.message);
  }
}

async function getDefaultSubjectId() {
  const result = await pool.query(`SELECT id FROM subjects WHERE code = 'CHEMISTRY' LIMIT 1`);
  if (!result.rows.length) throw new Error('Default subject CHEMISTRY not found');
  return Number(result.rows[0].id);
}

async function ensureStudentAssignedToSubject(regNo, subjectId) {
  const result = await pool.query(
    `SELECT 1
     FROM student_subject_assignments
     WHERE reg_no = $1 AND subject_id = $2 AND is_active = TRUE
     LIMIT 1`,
    [regNo, subjectId]
  );
  return result.rows.length > 0;
}

async function ensureStaffAssignedToSubject(staffEmail, subjectId) {
  const result = await pool.query(
    `SELECT 1
     FROM staff_subject_assignments
     WHERE staff_email = $1 AND subject_id = $2 AND is_active = TRUE
     LIMIT 1`,
    [staffEmail, subjectId]
  );
  return result.rows.length > 0;
}

async function ensureStaffMappedToStudentForSubject(staffEmail, regNo, subjectId) {
  const result = await pool.query(
    `SELECT 1
     FROM student_staff_subject_assignments
     WHERE staff_email = $1 AND reg_no = $2 AND subject_id = $3 AND is_active = TRUE
     LIMIT 1`,
    [staffEmail, regNo, subjectId]
  );
  return result.rows.length > 0;
}

async function getSubjectCodeById(subjectId) {
  const result = await pool.query(
    `SELECT code
     FROM subjects
     WHERE id = $1
     LIMIT 1`,
    [subjectId]
  );
  return String(result.rows[0]?.code || '').trim().toUpperCase();
}

async function getStudentUsedBytes(regNo) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used
     FROM uploads
     WHERE owner_reg_no = $1`,
    [regNo]
  );
  return Number(result.rows[0]?.used || 0);
}

async function upsertStudentQuota(regNo) {
  const usedBytes = await getStudentUsedBytes(regNo);
  const quotaBytes = Math.max(studentQuotaBytesDefault, 1);
  await pool.query(
    `INSERT INTO student_storage_quotas (reg_no, quota_bytes, used_bytes, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (reg_no)
     DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes,
                   used_bytes = EXCLUDED.used_bytes,
                   updated_at = NOW()`,
    [regNo, quotaBytes, usedBytes]
  );
  return { quotaBytes, usedBytes, remainingBytes: Math.max(quotaBytes - usedBytes, 0) };
}

function getLiveSessionsSnapshot() {
  const now = Date.now();
  const rows = [];
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) continue;
    rows.push({
      token,
      role: session.role,
      regNo: session.regNo || null,
      email: session.email || null,
      name: session.name || null,
      expiresAt: session.expiresAt,
      ttlMs: Math.max(session.expiresAt - now, 0),
    });
  }
  return rows;
}

const backupTables = [
  'subjects',
  'staff_accounts',
  'students',
  'student_auth',
  'staff_subject_assignments',
  'student_subject_assignments',
  'student_staff_subject_assignments',
  'broadcast_messages',
  'student_message_reads',
  'qa_threads',
  'qa_messages',
  'submissions',
  'official_materials',
  'student_storage_quotas',
];

async function readTableForBackup(tableName) {
  const result = await pool.query(`SELECT * FROM ${tableName}`);
  return result.rows;
}

async function restoreTableRows(client, tableName, rows) {
  if (!Array.isArray(rows) || !rows.length) return;
  const columns = Object.keys(rows[0]);
  for (const row of rows) {
    const values = columns.map((col) => row[col]);
    const placeholders = values.map((_, idx) => `$${idx + 1}`).join(', ');
    const cols = columns.join(', ');
    await client.query(`INSERT INTO ${tableName} (${cols}) VALUES (${placeholders})`, values);
  }
}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) {
    scheduleSessionsFlush();
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
    } else if (!verifyPassword(passwordTrimmed, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    } else if (!isBcryptHash(row.password_hash)) {
      await pool.query(
        `UPDATE student_auth
         SET password_hash = $1, updated_at = NOW()
         WHERE reg_no = $2`,
        [hashPassword(passwordTrimmed), rowRegNo]
      );
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
    if (!verifyPassword(password, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!isBcryptHash(row.password_hash)) {
      await pool.query(
        `UPDATE staff_accounts
         SET password_hash = $1, updated_at = NOW()
         WHERE email = $2`,
        [hashPassword(password), row.email]
      );
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

app.get('/admin/students', requireSuperAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT reg_no, full_name, stream, section, created_at
       FROM students
       ORDER BY reg_no ASC`
    );
    res.json({ students: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/role-policies', requireSuperAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT staff_email, permissions_json, created_at, updated_at
       FROM role_policies
       ORDER BY staff_email ASC`
    );
    res.json({ policies: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/role-policies/:email', requireSuperAdmin, async (req, res, next) => {
  try {
    const email = normalizeStaffEmail(req.params.email);
    const permissions = req.body?.permissions || {};
    if (!email || typeof permissions !== 'object' || Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Invalid policy payload' });
    }

    const result = await pool.query(
      `INSERT INTO role_policies (staff_email, permissions_json)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (staff_email)
       DO UPDATE SET permissions_json = EXCLUDED.permissions_json,
                     updated_at = NOW()
       RETURNING staff_email, permissions_json, created_at, updated_at`,
      [email, JSON.stringify(permissions)]
    );

    await writeAuditLog({
      actor: req.auth?.email || 'superadmin',
      action: 'role_policy.upsert',
      targetType: 'role_policy',
      targetId: email,
      afterJson: result.rows[0],
    });

    res.json({ ok: true, policy: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/superadmin/audit-logs', requireSuperAdmin, async (req, res, next) => {
  try {
    const actor = String(req.query?.actor || '').trim();
    const action = String(req.query?.action || '').trim();
    const targetType = String(req.query?.targetType || '').trim();
    const limit = Math.min(1000, Math.max(1, Number(req.query?.limit || 100)));
    const format = String(req.query?.format || '').trim().toLowerCase();

    const params = [];
    const where = ['1=1'];
    if (actor) {
      params.push(actor);
      where.push(`actor = $${params.length}`);
    }
    if (action) {
      params.push(action);
      where.push(`action = $${params.length}`);
    }
    if (targetType) {
      params.push(targetType);
      where.push(`target_type = $${params.length}`);
    }
    params.push(limit);

    const result = await pool.query(
      `SELECT *
       FROM audit_logs
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );

    if (format === 'csv') {
      const header = 'id,actor,action,target_type,target_id,created_at';
      const rows = result.rows.map((r) => [
        r.id,
        JSON.stringify(r.actor || ''),
        JSON.stringify(r.action || ''),
        JSON.stringify(r.target_type || ''),
        JSON.stringify(r.target_id || ''),
        JSON.stringify(r.created_at || ''),
      ].join(','));
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      return res.send([header, ...rows].join('\n'));
    }

    res.json({ logs: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/superadmin/db-status', requireSuperAdmin, async (_req, res, next) => {
  try {
    const [
      students,
      studentAuth,
      staffAccounts,
      activeStaff,
      subjects,
      submissions,
      pendingSubmissions,
      qaThreads,
      qaMessages,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM students'),
      pool.query('SELECT COUNT(*)::int AS count FROM student_auth'),
      pool.query('SELECT COUNT(*)::int AS count FROM staff_accounts'),
      pool.query('SELECT COUNT(*)::int AS count FROM staff_accounts WHERE is_active = TRUE'),
      pool.query('SELECT COUNT(*)::int AS count FROM subjects'),
      pool.query('SELECT COUNT(*)::int AS count FROM submissions'),
      pool.query(`SELECT COUNT(*)::int AS count FROM submissions WHERE status = 'pending'`),
      pool.query('SELECT COUNT(*)::int AS count FROM qa_threads'),
      pool.query('SELECT COUNT(*)::int AS count FROM qa_messages'),
    ]);

    res.json({
      ok: true,
      dbReady,
      startupStudentSyncEnabled: syncStudentsOnStartup,
      startupBaselineAssignmentsEnabled: baselineAssignmentsOnStartup,
      studentsSourceFile: studentsFile,
      counts: {
        students: students.rows[0].count,
        studentAuth: studentAuth.rows[0].count,
        staffAccounts: staffAccounts.rows[0].count,
        activeStaff: activeStaff.rows[0].count,
        subjects: subjects.rows[0].count,
        submissions: submissions.rows[0].count,
        pendingSubmissions: pendingSubmissions.rows[0].count,
        qaThreads: qaThreads.rows[0].count,
        qaMessages: qaMessages.rows[0].count,
      },
      serverTime: new Date().toISOString(),
    });
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

    await writeAuditLog({
      actor: req.auth?.email || req.auth?.name || 'superadmin',
      action: 'staff.upsert',
      targetType: 'staff',
      targetId: result.rows[0]?.email,
      afterJson: result.rows[0],
    });

    res.json({ ok: true, staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.patch('/admin/staff/:email/reset-password', requireSuperAdmin, async (req, res, next) => {
  try {
    const email = normalizeStaffEmail(req.params.email);
    const newPassword = String(req.body?.password || '').trim();
    if (!email || newPassword.length < 6) {
      return res.status(400).json({ error: 'Valid email and password are required' });
    }

    const result = await pool.query(
      `UPDATE staff_accounts
       SET password_hash = $1, updated_at = NOW()
       WHERE email = $2
       RETURNING email, full_name, role, is_active, created_at, updated_at`,
      [hashPassword(newPassword), email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff not found' });

    await writeAuditLog({
      actor: req.auth?.email || 'superadmin',
      action: 'staff.reset_password',
      targetType: 'staff',
      targetId: email,
    });

    res.json({ ok: true, staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff/:email/activate', requireSuperAdmin, async (req, res, next) => {
  try {
    const email = normalizeStaffEmail(req.params.email);
    if (!email) return res.status(400).json({ error: 'Invalid email' });
    const result = await pool.query(
      `UPDATE staff_accounts
       SET is_active = TRUE, updated_at = NOW()
       WHERE email = $1
       RETURNING email, full_name, role, is_active, created_at, updated_at`,
      [email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff not found' });

    await writeAuditLog({
      actor: req.auth?.email || 'superadmin',
      action: 'staff.activate',
      targetType: 'staff',
      targetId: email,
      afterJson: result.rows[0],
    });

    res.json({ ok: true, staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/staff/:email/deactivate', requireSuperAdmin, async (req, res, next) => {
  try {
    const email = normalizeStaffEmail(req.params.email);
    if (!email) return res.status(400).json({ error: 'Invalid email' });
    const result = await pool.query(
      `UPDATE staff_accounts
       SET is_active = FALSE, updated_at = NOW()
       WHERE email = $1
       RETURNING email, full_name, role, is_active, created_at, updated_at`,
      [email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff not found' });

    await writeAuditLog({
      actor: req.auth?.email || 'superadmin',
      action: 'staff.deactivate',
      targetType: 'staff',
      targetId: email,
      afterJson: result.rows[0],
    });

    res.json({ ok: true, staff: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.delete('/admin/staff/:email', requireSuperAdmin, async (req, res, next) => {
  try {
    const email = normalizeStaffEmail(req.params.email);
    if (!email) return res.status(400).json({ error: 'Invalid email' });
    if (email === normalizeStaffEmail(req.auth?.email || '')) {
      return res.status(400).json({ error: 'You cannot delete your own account' });
    }

    const result = await pool.query(
      `DELETE FROM staff_accounts
       WHERE email = $1
       RETURNING email, full_name, role, is_active, created_at, updated_at`,
      [email]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Staff not found' });

    await writeAuditLog({
      actor: req.auth?.email || 'superadmin',
      action: 'staff.delete',
      targetType: 'staff',
      targetId: email,
      beforeJson: result.rows[0],
    });

    res.json({ ok: true, deleted: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/subjects', requireSuperAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, code, name, is_active, created_at, updated_at
       FROM subjects
       ORDER BY is_active DESC, code ASC`
    );
    res.json({ subjects: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/subjects', requireSuperAdmin, async (req, res, next) => {
  try {
    const code = normalizeSubjectCode(req.body?.code);
    const name = String(req.body?.name || '').trim();
    if (!code || !name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      `INSERT INTO subjects (code, name, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (code)
       DO UPDATE SET name = EXCLUDED.name,
                     is_active = TRUE,
                     updated_at = NOW()
       RETURNING id, code, name, is_active, created_at, updated_at`,
      [code, name]
    );

    res.json({ ok: true, subject: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.patch('/admin/subjects/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid subject id' });
    }

    const updates = [];
    const params = [];

    if (req.body?.name !== undefined) {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Invalid subject name' });
      params.push(name);
      updates.push(`name = $${params.length}`);
    }

    if (req.body?.code !== undefined) {
      const code = normalizeSubjectCode(req.body?.code);
      if (!code) return res.status(400).json({ error: 'Invalid subject code' });
      params.push(code);
      updates.push(`code = $${params.length}`);
    }

    if (req.body?.isActive !== undefined) {
      params.push(Boolean(req.body?.isActive));
      updates.push(`is_active = $${params.length}`);
    }

    if (!updates.length) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    updates.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE subjects
       SET ${updates.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, code, name, is_active, created_at, updated_at`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    res.json({ ok: true, subject: result.rows[0] });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Subject code already exists' });
    }
    next(err);
  }
});

app.delete('/admin/subjects/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid subject id' });
    }

    const result = await pool.query(
      `UPDATE subjects
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1
       RETURNING id, code, name, is_active, created_at, updated_at`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Subject not found' });
    }

    res.json({ ok: true, subject: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.post('/admin/assign/staff-subject', requireSuperAdmin, async (req, res, next) => {
  try {
    const staffEmail = normalizeStaffEmail(req.body?.staffEmail);
    const subjectId = Number(req.body?.subjectId);
    if (!staffEmail || !Number.isFinite(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const activeCheck = await pool.query(
      `SELECT
         EXISTS(SELECT 1 FROM staff_accounts WHERE email = $1 AND is_active = TRUE) AS has_staff,
         EXISTS(SELECT 1 FROM subjects WHERE id = $2 AND is_active = TRUE) AS has_subject`,
      [staffEmail, subjectId]
    );
    const hasStaff = Boolean(activeCheck.rows?.[0]?.has_staff);
    const hasSubject = Boolean(activeCheck.rows?.[0]?.has_subject);
    if (!hasStaff) return res.status(400).json({ error: 'Staff account is missing or inactive' });
    if (!hasSubject) return res.status(400).json({ error: 'Subject is missing or inactive' });

    const result = await pool.query(
      `INSERT INTO staff_subject_assignments (staff_email, subject_id, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (staff_email, subject_id)
       DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING id, staff_email, subject_id, is_active, created_at, updated_at`,
      [staffEmail, subjectId]
    );

    res.json({ ok: true, assignment: result.rows[0] });
  } catch (err) {
    if (err && err.code === '23503') {
      return res.status(400).json({ error: 'Invalid staffEmail or subjectId' });
    }
    next(err);
  }
});

app.post('/admin/assign/student-subject', requireSuperAdmin, async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.body?.regNo);
    const subjectId = Number(req.body?.subjectId);
    if (!regNo || !Number.isFinite(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const activeSubject = await pool.query(
      `SELECT 1 FROM subjects WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [subjectId]
    );
    if (!activeSubject.rows.length) {
      return res.status(400).json({ error: 'Subject is missing or inactive' });
    }

    const result = await pool.query(
      `INSERT INTO student_subject_assignments (reg_no, subject_id, is_active)
       VALUES ($1, $2, TRUE)
       ON CONFLICT (reg_no, subject_id)
       DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING id, reg_no, subject_id, is_active, created_at, updated_at`,
      [regNo, subjectId]
    );

    res.json({ ok: true, assignment: result.rows[0] });
  } catch (err) {
    if (err && err.code === '23503') {
      return res.status(400).json({ error: 'Invalid regNo or subjectId' });
    }
    next(err);
  }
});

app.post('/admin/assign/student-staff-subject', requireSuperAdmin, async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.body?.regNo);
    const staffEmail = normalizeStaffEmail(req.body?.staffEmail);
    const subjectId = Number(req.body?.subjectId);
    if (!regNo || !staffEmail || !Number.isFinite(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const activeSubject = await pool.query(
      `SELECT 1 FROM subjects WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [subjectId]
    );
    if (!activeSubject.rows.length) {
      return res.status(400).json({ error: 'Subject is missing or inactive' });
    }

    const canStaffTakeSubject = await ensureStaffAssignedToSubject(staffEmail, subjectId);
    if (!canStaffTakeSubject) {
      return res.status(409).json({ error: 'Staff is not assigned to this subject' });
    }

    const canStudentTakeSubject = await ensureStudentAssignedToSubject(regNo, subjectId);
    if (!canStudentTakeSubject) {
      return res.status(409).json({ error: 'Student is not assigned to this subject' });
    }

    const result = await pool.query(
      `INSERT INTO student_staff_subject_assignments (reg_no, staff_email, subject_id, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (reg_no, staff_email, subject_id)
       DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING id, reg_no, staff_email, subject_id, is_active, created_at, updated_at`,
      [regNo, staffEmail, subjectId]
    );

    res.json({ ok: true, assignment: result.rows[0] });
  } catch (err) {
    if (err && err.code === '23503') {
      return res.status(400).json({ error: 'Invalid regNo, staffEmail or subjectId' });
    }
    next(err);
  }
});

app.post('/admin/assign/bulk', requireSuperAdmin, async (req, res, next) => {
  try {
    const regNos = Array.isArray(req.body?.regNos) ? req.body.regNos.map(normalizeRegNo).filter(Boolean) : [];
    const staffEmail = normalizeStaffEmail(req.body?.staffEmail);
    const subjectId = Number(req.body?.subjectId);
    const mode = String(req.body?.mode || 'assign').toLowerCase(); // 'assign' or 'unassign'

    if (!regNos.length || !staffEmail || !Number.isFinite(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'Missing required fields (regNos, staffEmail, subjectId)' });
    }

    const activeCheck = await pool.query(
      `SELECT
         EXISTS(SELECT 1 FROM staff_accounts WHERE email = $1 AND is_active = TRUE) AS has_staff,
         EXISTS(SELECT 1 FROM subjects WHERE id = $2 AND is_active = TRUE) AS has_subject`,
      [staffEmail, subjectId]
    );
    if (!activeCheck.rows?.[0]?.has_staff) return res.status(400).json({ error: 'Staff account is missing or inactive' });
    if (!activeCheck.rows?.[0]?.has_subject) return res.status(400).json({ error: 'Subject is missing or inactive' });

    if (mode === 'assign') {
      // 1. Ensure students are assigned to the subject first
      await pool.query(
        `INSERT INTO student_subject_assignments (reg_no, subject_id, is_active)
         SELECT unnest($1::text[]), $2, TRUE
         ON CONFLICT (reg_no, subject_id) DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
        [regNos, subjectId]
      );

      // 2. Ensure staff is assigned to the subject
      await pool.query(
        `INSERT INTO staff_subject_assignments (staff_email, subject_id, is_active)
         VALUES ($1, $2, TRUE)
         ON CONFLICT (staff_email, subject_id) DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
        [staffEmail, subjectId]
      );

      // 3. Perform bulk staff-student mapping
      const result = await pool.query(
        `INSERT INTO student_staff_subject_assignments (reg_no, staff_email, subject_id, is_active)
         SELECT unnest($1::text[]), $2, $3, TRUE
         ON CONFLICT (reg_no, staff_email, subject_id)
         DO UPDATE SET is_active = TRUE, updated_at = NOW()
         RETURNING id`,
        [regNos, staffEmail, subjectId]
      );
      res.json({ ok: true, count: result.rowCount });
    } else if (mode === 'assign-subject') {
      const result = await pool.query(
        `INSERT INTO student_subject_assignments (reg_no, subject_id, is_active)
         SELECT unnest($1::text[]), $2, TRUE
         ON CONFLICT (reg_no, subject_id) DO UPDATE SET is_active = TRUE, updated_at = NOW()
         RETURNING id`,
        [regNos, subjectId]
      );
      res.json({ ok: true, count: result.rowCount });
    } else {
      const result = await pool.query(
        `UPDATE student_staff_subject_assignments
         SET is_active = FALSE, updated_at = NOW()
         WHERE reg_no = ANY($1::text[]) AND staff_email = $2 AND subject_id = $3
         RETURNING id`,
        [regNos, staffEmail, subjectId]
      );
      res.json({ ok: true, count: result.rowCount });
    }
  } catch (err) {
    next(err);
  }
});

app.delete('/admin/assign/student-staff-subject', requireSuperAdmin, async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.body?.regNo || req.query?.regNo);
    const staffEmail = normalizeStaffEmail(req.body?.staffEmail || req.query?.staffEmail);
    const subjectId = Number(req.body?.subjectId || req.query?.subjectId);
    if (!regNo || !staffEmail || !Number.isFinite(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await pool.query(
      `UPDATE student_staff_subject_assignments
       SET is_active = FALSE, updated_at = NOW()
       WHERE reg_no = $1 AND staff_email = $2 AND subject_id = $3
       RETURNING id, reg_no, staff_email, subject_id, is_active, created_at, updated_at`,
      [regNo, staffEmail, subjectId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    res.json({ ok: true, assignment: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/admin/assignments/matrix', requireSuperAdmin, async (req, res, next) => {
  try {
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const staffEmail = req.query?.staffEmail ? normalizeStaffEmail(req.query.staffEmail) : '';
    const regNo = req.query?.regNo ? normalizeRegNo(req.query.regNo) : '';

    const params = [];
    const where = ['a.is_active = TRUE'];

    if (Number.isFinite(subjectId) && subjectId > 0) {
      params.push(subjectId);
      where.push(`a.subject_id = $${params.length}`);
    }
    if (staffEmail) {
      params.push(staffEmail);
      where.push(`a.staff_email = $${params.length}`);
    }
    if (regNo) {
      params.push(regNo);
      where.push(`a.reg_no = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT a.id,
              a.reg_no,
              s.full_name AS student_name,
              a.staff_email,
              st.full_name AS staff_name,
              a.subject_id,
              sub.code AS subject_code,
              sub.name AS subject_name,
              a.is_active,
              a.created_at,
              a.updated_at
       FROM student_staff_subject_assignments a
       JOIN students s ON s.reg_no = a.reg_no
       JOIN staff_accounts st ON st.email = a.staff_email
       JOIN subjects sub ON sub.id = a.subject_id
       WHERE ${where.join(' AND ')}
       ORDER BY sub.code ASC, a.staff_email ASC, a.reg_no ASC`,
      params
    );

    res.json({ assignments: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/subjects', requireAuth('staff'), async (req, res, next) => {
  try {
    const email = normalizeStaffEmail(req.auth.email);
    const result = await pool.query(
      `SELECT s.id, s.code, s.name
       FROM staff_subject_assignments a
       JOIN subjects s ON s.id = a.subject_id
       WHERE a.staff_email = $1 AND a.is_active = TRUE AND s.is_active = TRUE
       ORDER BY s.code ASC`,
      [email]
    );
    res.json({ subjects: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/student/subjects', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const result = await pool.query(
      `SELECT s.id, s.code, s.name
       FROM student_subject_assignments a
       JOIN subjects s ON s.id = a.subject_id
       WHERE a.reg_no = $1 AND a.is_active = TRUE AND s.is_active = TRUE
       ORDER BY s.code ASC`,
      [regNo]
    );
    res.json({ subjects: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/student/staff', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const params = [regNo];
    const where = [
      'a.reg_no = $1',
      'a.is_active = TRUE',
      'st.is_active = TRUE',
    ];

    if (Number.isFinite(subjectId) && subjectId > 0) {
      params.push(subjectId);
      where.push(`a.subject_id = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT DISTINCT st.email, st.full_name, st.role, a.subject_id
       FROM student_staff_subject_assignments a
       JOIN staff_accounts st ON st.email = a.staff_email
       WHERE ${where.join(' AND ')}
       ORDER BY st.full_name ASC, st.email ASC`,
      params
    );

    res.json({ staff: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/students', requireAuth('staff'), async (req, res, next) => {
  try {
    const subjectId = Number(req.query?.subjectId);
    const email = normalizeStaffEmail(req.auth.email);
    if (!Number.isFinite(subjectId) || subjectId <= 0) {
      return res.status(400).json({ error: 'subjectId is required' });
    }

    const isSA = isSuperAdminSession(req.auth);
    if (!isSA) {
      const canAccessSubject = await ensureStaffAssignedToSubject(email, subjectId);
      if (!canAccessSubject) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    let result;
    if (isSA) {
      // Super Admins see everyone assigned to this subject
      result = await pool.query(
        `SELECT s.reg_no, s.full_name, s.stream, s.section
         FROM students s
         JOIN student_subject_assignments ssa ON ssa.reg_no = s.reg_no
         WHERE ssa.subject_id = $1 AND ssa.is_active = TRUE
         ORDER BY s.reg_no ASC`,
        [subjectId]
      );
    } else {
      // Regular staff see only their assigned students
      result = await pool.query(
        `SELECT s.reg_no, s.full_name, s.stream, s.section
         FROM student_staff_subject_assignments a
         JOIN students s ON s.reg_no = a.reg_no
         WHERE a.staff_email = $1
           AND a.subject_id = $2
           AND a.is_active = TRUE
         ORDER BY s.reg_no ASC`,
        [email, subjectId]
      );
    }
    res.json({ students: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/staff/materials', requireAuth('staff'), materialUpload.single('file'), async (req, res, next) => {
  try {
    const subjectId = Number(req.body?.subjectId);
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const staffEmail = normalizeStaffEmail(req.auth.email);
    const { file } = req;

    if (!Number.isFinite(subjectId) || subjectId <= 0 || !title || !file) {
      return res.status(400).json({ error: 'subjectId, title and file are required' });
    }

    const canAccessSubject = await ensureStaffAssignedToSubject(staffEmail, subjectId);
    if (!canAccessSubject) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const subjectCode = (await getSubjectCodeById(subjectId)) || `subject-${subjectId}`;
    const folderPath = [
      'staff',
      sanitizePathSegment(staffEmail),
      'subjects',
      sanitizePathSegment(subjectCode),
      'materials',
    ].join('/');
    const storedName = createStoredUploadName(file.originalname);
    const fileUrl = toUploadsPublicUrl(folderPath, storedName);
    writeFileToStorage(folderPath, storedName, file.buffer);

    const result = await pool.query(
      `INSERT INTO official_materials (
         subject_id, staff_email, title, description,
         file_name, file_url, folder_path, mime_type, size_bytes, file_data, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
       RETURNING id, subject_id, staff_email, title, description, file_name, file_url, folder_path, mime_type, size_bytes, is_active, created_at, updated_at`,
      [subjectId, staffEmail, title, description || null, file.originalname, fileUrl, folderPath, file.mimetype, file.size, file.buffer]
    );

    res.status(201).json({ ok: true, material: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/materials', requireAuth('staff'), async (req, res, next) => {
  try {
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const staffEmail = normalizeStaffEmail(req.auth.email);
    const params = [staffEmail];
    const where = ['staff_email = $1'];
    if (Number.isFinite(subjectId) && subjectId > 0) {
      const canAccessSubject = await ensureStaffAssignedToSubject(staffEmail, subjectId);
      if (!canAccessSubject) return res.status(403).json({ error: 'Forbidden' });
      params.push(subjectId);
      where.push(`subject_id = $${params.length}`);
    }
    const result = await pool.query(
      `SELECT id, subject_id, staff_email, title, description, file_name, file_url, folder_path, mime_type, size_bytes, is_active, created_at, updated_at
       FROM official_materials
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC`,
      params
    );
    res.json({ materials: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/student/materials', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const params = [regNo];
    const where = [
      `m.is_active = TRUE`,
      `EXISTS (
        SELECT 1
        FROM student_subject_assignments ssa
        WHERE ssa.reg_no = $1
          AND ssa.subject_id = m.subject_id
          AND ssa.is_active = TRUE
      )`,
    ];
    if (Number.isFinite(subjectId) && subjectId > 0) {
      params.push(subjectId);
      where.push(`m.subject_id = $${params.length}`);
    }
    const result = await pool.query(
      `SELECT m.id, m.subject_id, sub.code AS subject_code, sub.name AS subject_name,
              m.title, m.description, m.file_name, m.file_url, m.folder_path, m.mime_type, m.size_bytes, m.created_at
       FROM official_materials m
       JOIN subjects sub ON sub.id = m.subject_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC`,
      params
    );
    res.json({ materials: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/materials/:id/file', requireAuth(['staff', 'student']), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid material id' });

    const result = await pool.query(
      `SELECT * FROM official_materials WHERE id = $1 AND is_active = TRUE`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Material not found' });
    const material = result.rows[0];

    if (req.auth.role === 'staff') {
      const canAccess = await ensureStaffAssignedToSubject(normalizeStaffEmail(req.auth.email), Number(material.subject_id));
      if (!canAccess) return res.status(403).json({ error: 'Forbidden' });
    } else {
      const canAccess = await ensureStudentAssignedToSubject(normalizeRegNo(req.auth.regNo), Number(material.subject_id));
      if (!canAccess) return res.status(403).json({ error: 'Forbidden' });
    }

    if (material.mime_type) res.type(material.mime_type);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(String(material.file_name || 'material'))}"`);
    return res.send(material.file_data);
  } catch (err) {
    next(err);
  }
});

app.patch('/staff/materials/:id', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const title = req.body?.title;
    const description = req.body?.description;
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid material id' });

    const base = await pool.query('SELECT id, subject_id, staff_email FROM official_materials WHERE id = $1', [id]);
    if (!base.rows.length) return res.status(404).json({ error: 'Material not found' });
    const material = base.rows[0];
    if (normalizeStaffEmail(material.staff_email) !== normalizeStaffEmail(req.auth.email)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updates = [];
    const params = [];
    if (title !== undefined) {
      const normalized = String(title || '').trim();
      if (!normalized) return res.status(400).json({ error: 'Invalid title' });
      params.push(normalized);
      updates.push(`title = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(String(description || '').trim() || null);
      updates.push(`description = $${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });
    updates.push('updated_at = NOW()');
    params.push(id);

    const result = await pool.query(
      `UPDATE official_materials
       SET ${updates.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, subject_id, staff_email, title, description, file_name, mime_type, size_bytes, is_active, created_at, updated_at`,
      params
    );

    res.json({ ok: true, material: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.delete('/staff/materials/:id', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid material id' });

    const result = await pool.query(
      `UPDATE official_materials
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND staff_email = $2
       RETURNING id`,
      [id, normalizeStaffEmail(req.auth.email)]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Material not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/staff/messages/broadcast', requireAuth('staff'), async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim();
    const message = String(req.body?.message || '').trim();
    const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : null;
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    if (!title || !message) return res.status(400).json({ error: 'Missing required fields' });

    const result = await pool.query(
      `INSERT INTO broadcast_messages (created_by_staff_email, title, message, is_active, starts_at, expires_at)
       VALUES ($1, $2, $3, TRUE, $4, $5)
       RETURNING *`,
      [normalizeStaffEmail(req.auth.email), title, message, startsAt, expiresAt]
    );
    res.status(201).json({ ok: true, message: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/messages/broadcast', requireAuth('staff'), async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT *
       FROM broadcast_messages
       WHERE created_by_staff_email = $1
       ORDER BY created_at DESC`,
      [normalizeStaffEmail(req.auth.email)]
    );
    res.json({ messages: result.rows });
  } catch (err) {
    next(err);
  }
});

app.patch('/staff/messages/broadcast/:id', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid message id' });

    const updates = [];
    const params = [];
    if (req.body?.title !== undefined) {
      const title = String(req.body?.title || '').trim();
      if (!title) return res.status(400).json({ error: 'Invalid title' });
      params.push(title);
      updates.push(`title = $${params.length}`);
    }
    if (req.body?.message !== undefined) {
      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ error: 'Invalid message' });
      params.push(message);
      updates.push(`message = $${params.length}`);
    }
    if (req.body?.isActive !== undefined) {
      params.push(Boolean(req.body?.isActive));
      updates.push(`is_active = $${params.length}`);
    }
    if (!updates.length) return res.status(400).json({ error: 'No updatable fields provided' });
    updates.push('updated_at = NOW()');
    params.push(id, normalizeStaffEmail(req.auth.email));

    const result = await pool.query(
      `UPDATE broadcast_messages
       SET ${updates.join(', ')}
       WHERE id = $${params.length - 1} AND created_by_staff_email = $${params.length}
       RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ ok: true, message: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.delete('/staff/messages/broadcast/:id', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid message id' });
    const result = await pool.query(
      `UPDATE broadcast_messages
       SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND created_by_staff_email = $2
       RETURNING id`,
      [id, normalizeStaffEmail(req.auth.email)]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Message not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/student/messages/broadcast', requireAuth('student'), async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, message, starts_at, expires_at, created_at, updated_at
       FROM broadcast_messages
       WHERE is_active = TRUE
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (expires_at IS NULL OR expires_at >= NOW())
       ORDER BY created_at DESC`
    );
    res.json({ messages: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/staff/messages/announcement', requireAuth('staff'), async (req, res, next) => {
  try {
    if (!(await hasPermission(req.auth, 'sendAnnouncements'))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const title = String(req.body?.title || '').trim();
    const message = String(req.body?.message || '').trim();
    const channelType = String(req.body?.channelType || 'global').trim().toLowerCase();
    const subjectId = req.body?.subjectId ? Number(req.body.subjectId) : null;
    const classroom = String(req.body?.classroom || '').trim().toUpperCase() || null;
    const targetRegNo = normalizeRegNo(req.body?.targetRegNo || '') || null;
    const startsAt = req.body?.startsAt ? new Date(req.body.startsAt) : null;
    const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
    const priority = String(req.body?.priority || 'normal').trim().toLowerCase();

    if (!title || !message) return res.status(400).json({ error: 'Missing required fields' });

    const result = await pool.query(
      `INSERT INTO broadcast_messages (
         created_by_staff_email, title, message, is_active,
         starts_at, expires_at, channel_type, subject_id, classroom, target_reg_no, priority
       ) VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        normalizeStaffEmail(req.auth.email),
        title,
        message,
        startsAt,
        expiresAt,
        channelType,
        Number.isFinite(subjectId) && subjectId > 0 ? subjectId : null,
        classroom,
        targetRegNo,
        priority,
      ]
    );

    await writeAuditLog({
      actor: req.auth.email,
      action: 'announcement.create',
      targetType: 'broadcast_message',
      targetId: result.rows[0]?.id,
      afterJson: result.rows[0],
    });

    res.status(201).json({ ok: true, announcement: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/student/messages/announcements', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const classRoom = String(req.query?.classroom || '').trim().toUpperCase();
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;

    const params = [regNo, classRoom || null, Number.isFinite(subjectId) ? subjectId : null];
    const result = await pool.query(
      `SELECT m.id,
              m.title,
              m.message,
              m.channel_type,
              m.subject_id,
              m.classroom,
              m.target_reg_no,
              m.priority,
              m.starts_at,
              m.expires_at,
              m.created_at,
              (r.message_id IS NOT NULL) AS is_read,
              r.read_at
       FROM broadcast_messages m
       LEFT JOIN student_message_reads r ON r.message_id = m.id AND r.reg_no = $1
       WHERE m.is_active = TRUE
         AND (m.starts_at IS NULL OR m.starts_at <= NOW())
         AND (m.expires_at IS NULL OR m.expires_at >= NOW())
         AND (
           m.channel_type = 'global'
           OR (m.channel_type = 'student' AND m.target_reg_no = $1)
           OR (m.channel_type = 'class' AND m.classroom IS NOT NULL AND m.classroom = (SELECT section FROM students WHERE reg_no = $1 LIMIT 1))
           OR (m.channel_type = 'subject' AND m.subject_id IS NOT NULL AND EXISTS (SELECT 1 FROM student_subject_assignments ssa WHERE ssa.reg_no = $1 AND ssa.subject_id = m.subject_id AND ssa.is_active = TRUE))
         ) AND (COALESCE($2, '') = '' OR m.classroom = $2)
           AND (COALESCE($3, 0) = 0 OR m.subject_id = $3)
       ORDER BY m.priority DESC, m.created_at DESC`,
      params
    );
    res.json({ announcements: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/student/messages/:id/read', requireAuth('student'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const regNo = normalizeRegNo(req.auth.regNo);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid message id' });

    await pool.query(
      `INSERT INTO student_message_reads (message_id, reg_no, read_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (message_id, reg_no)
       DO UPDATE SET read_at = EXCLUDED.read_at`,
      [id, regNo]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/messages/broadcast/:id/read-receipts', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid message id' });

    const owner = await pool.query(
      `SELECT id FROM broadcast_messages WHERE id = $1 AND created_by_staff_email = $2`,
      [id, normalizeStaffEmail(req.auth.email)]
    );
    if (!owner.rows.length) return res.status(404).json({ error: 'Message not found' });

    const receipts = await pool.query(
      `SELECT reg_no, read_at
       FROM student_message_reads
       WHERE message_id = $1
       ORDER BY read_at DESC`,
      [id]
    );
    res.json({ receipts: receipts.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/staff/messages/emergency', requireAuth('staff'), async (req, res, next) => {
  try {
    const title = String(req.body?.title || '').trim() || 'Emergency Notice';
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const result = await pool.query(
      `INSERT INTO broadcast_messages (
         created_by_staff_email, title, message, is_active, channel_type, priority
       ) VALUES ($1, $2, $3, TRUE, 'global', 'emergency')
       RETURNING *`,
      [normalizeStaffEmail(req.auth.email), title, message]
    );
    res.status(201).json({ ok: true, banner: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/student/messages/emergency', requireAuth('student'), async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, title, message, created_at
       FROM broadcast_messages
       WHERE is_active = TRUE
         AND priority = 'emergency'
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (expires_at IS NULL OR expires_at >= NOW())
       ORDER BY created_at DESC`
    );
    res.json({ banners: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/student/qa/threads', requireAuth('student'), async (req, res, next) => {
  try {
    const subjectId = Number(req.body?.subjectId);
    const staffEmail = normalizeStaffEmail(req.body?.staffEmail);
    const title = String(req.body?.title || '').trim();
    const message = String(req.body?.message || '').trim();
    const regNo = normalizeRegNo(req.auth.regNo);

    if (!Number.isFinite(subjectId) || subjectId <= 0 || !staffEmail || !title || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const canTalk = await ensureStaffMappedToStudentForSubject(staffEmail, regNo, subjectId);
    if (!canTalk) return res.status(403).json({ error: 'Forbidden' });

    const thread = await pool.query(
      `INSERT INTO qa_threads (subject_id, staff_email, reg_no, title, is_open)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING *`,
      [subjectId, staffEmail, regNo, title]
    );

    const threadId = thread.rows[0].id;
    await pool.query(
      `INSERT INTO qa_messages (thread_id, sender_role, sender_id, message)
       VALUES ($1, 'student', $2, $3)`,
      [threadId, regNo, message]
    );

    res.status(201).json({ ok: true, thread: thread.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/student/qa/threads', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const result = await pool.query(
      `SELECT *
       FROM qa_threads
       WHERE reg_no = $1
       ORDER BY updated_at DESC`,
      [regNo]
    );
    res.json({ threads: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/student/qa/threads/:id/messages', requireAuth('student'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const regNo = normalizeRegNo(req.auth.regNo);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid thread id' });

    const thread = await pool.query('SELECT id FROM qa_threads WHERE id = $1 AND reg_no = $2', [id, regNo]);
    if (!thread.rows.length) return res.status(404).json({ error: 'Thread not found' });

    const messages = await pool.query(
      `SELECT id, sender_role, sender_id, message, created_at
       FROM qa_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [id]
    );
    res.json({ messages: messages.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/qa/threads', requireAuth('staff'), async (req, res, next) => {
  try {
    const staffEmail = normalizeStaffEmail(req.auth.email);
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const params = [staffEmail];
    const where = ['staff_email = $1'];
    if (Number.isFinite(subjectId) && subjectId > 0) {
      params.push(subjectId);
      where.push(`subject_id = $${params.length}`);
    }
    const result = await pool.query(
      `SELECT *
       FROM qa_threads
       WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC`,
      params
    );
    res.json({ threads: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/qa/threads/:id/messages', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const staffEmail = normalizeStaffEmail(req.auth.email);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid thread id' });

    const thread = await pool.query('SELECT id FROM qa_threads WHERE id = $1 AND staff_email = $2', [id, staffEmail]);
    if (!thread.rows.length) return res.status(404).json({ error: 'Thread not found' });

    const messages = await pool.query(
      `SELECT id, sender_role, sender_id, message, created_at
       FROM qa_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC`,
      [id]
    );
    res.json({ messages: messages.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/staff/qa/threads/:id/reply', requireAuth('staff'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const message = String(req.body?.message || '').trim();
    const closeThread = Boolean(req.body?.closeThread);
    const staffEmail = normalizeStaffEmail(req.auth.email);
    if (!Number.isFinite(id) || id <= 0 || !message) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const threadRes = await pool.query('SELECT * FROM qa_threads WHERE id = $1 AND staff_email = $2', [id, staffEmail]);
    if (!threadRes.rows.length) return res.status(404).json({ error: 'Thread not found' });

    await pool.query(
      `INSERT INTO qa_messages (thread_id, sender_role, sender_id, message)
       VALUES ($1, 'staff', $2, $3)`,
      [id, staffEmail, message]
    );

    if (closeThread) {
      await pool.query('UPDATE qa_threads SET is_open = FALSE, updated_at = NOW() WHERE id = $1', [id]);
    } else {
      await pool.query('UPDATE qa_threads SET updated_at = NOW() WHERE id = $1', [id]);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.get('/superadmin/active-users/live', requireSuperAdmin, async (_req, res) => {
  const live = getLiveSessionsSnapshot();
  const summary = {
    total: live.length,
    students: live.filter((s) => s.role === 'student').length,
    staff: live.filter((s) => s.role === 'staff').length,
  };
  res.json({ summary, sessions: live });
});

app.post('/superadmin/active-users/force-logout', requireSuperAdmin, async (req, res) => {
  const token = String(req.body?.token || '').trim();
  const userIdentifier = String(req.body?.userIdentifier || '').trim().toLowerCase();
  if (!token && !userIdentifier) {
    return res.status(400).json({ error: 'token or userIdentifier is required' });
  }

  let revoked = 0;
  for (const [sessionToken, session] of sessions.entries()) {
    if (token && sessionToken === token) {
      sessions.delete(sessionToken);
      revoked += 1;
      continue;
    }
    if (userIdentifier) {
      const regNo = String(session?.regNo || '').toLowerCase();
      const email = String(session?.email || '').toLowerCase();
      if (regNo === userIdentifier || email === userIdentifier) {
        sessions.delete(sessionToken);
        revoked += 1;
      }
    }
  }

  if (revoked > 0) {
    scheduleSessionsFlush();
  }

  res.json({ ok: true, revoked });
});

app.post('/superadmin/database/backup', requireSuperAdmin, async (req, res, next) => {
  try {
    const payload = { generatedAt: new Date().toISOString(), tables: {} };
    for (const tableName of backupTables) {
      payload.tables[tableName] = await readTableForBackup(tableName);
    }

    const json = JSON.stringify(payload);
    const buffer = Buffer.from(json, 'utf8');
    const checksum = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = `chemistry-backup-${Date.now()}.json`;

    const result = await pool.query(
      `INSERT INTO system_backups (file_name, file_size, checksum, storage_path, created_by, file_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, file_name, file_size, checksum, created_at`,
      [fileName, buffer.length, checksum, 'database', normalizeStaffEmail(req.auth.email), buffer]
    );

    res.json({ ok: true, backup: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

app.get('/superadmin/database/backup/:id/download', requireSuperAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Invalid backup id' });

    const result = await pool.query(
      `SELECT file_name, file_data
       FROM system_backups
       WHERE id = $1`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Backup not found' });

    const row = result.rows[0];
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(String(row.file_name || 'backup.json'))}"`);
    return res.send(row.file_data);
  } catch (err) {
    next(err);
  }
});

app.post('/superadmin/database/restore', requireSuperAdmin, async (req, res, next) => {
  try {
    const backupId = Number(req.body?.backupId);
    const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
    if (!Number.isFinite(backupId) || backupId <= 0) {
      return res.status(400).json({ error: 'backupId is required' });
    }
    if (confirmation !== 'RESTORE DATABASE') {
      return res.status(400).json({ error: 'Invalid confirmation phrase' });
    }

    const backupResult = await pool.query('SELECT file_data FROM system_backups WHERE id = $1', [backupId]);
    if (!backupResult.rows.length) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    const payload = JSON.parse(Buffer.from(backupResult.rows[0].file_data).toString('utf8'));
    const tables = payload?.tables || {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE TABLE qa_messages, qa_threads, student_message_reads, student_staff_subject_assignments, student_subject_assignments, staff_subject_assignments, submissions, official_materials, broadcast_messages, student_storage_quotas, student_auth, students, subjects RESTART IDENTITY CASCADE');
      await restoreTableRows(client, 'subjects', tables.subjects || []);
      await restoreTableRows(client, 'students', tables.students || []);
      await restoreTableRows(client, 'student_auth', tables.student_auth || []);
      await restoreTableRows(client, 'staff_subject_assignments', tables.staff_subject_assignments || []);
      await restoreTableRows(client, 'student_subject_assignments', tables.student_subject_assignments || []);
      await restoreTableRows(client, 'student_staff_subject_assignments', tables.student_staff_subject_assignments || []);
      await restoreTableRows(client, 'broadcast_messages', tables.broadcast_messages || []);
      await restoreTableRows(client, 'student_message_reads', tables.student_message_reads || []);
      await restoreTableRows(client, 'qa_threads', tables.qa_threads || []);
      await restoreTableRows(client, 'qa_messages', tables.qa_messages || []);
      await restoreTableRows(client, 'submissions', tables.submissions || []);
      await restoreTableRows(client, 'official_materials', tables.official_materials || []);
      await restoreTableRows(client, 'student_storage_quotas', tables.student_storage_quotas || []);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ ok: true, restoredBackupId: backupId });
  } catch (err) {
    next(err);
  }
});

app.post('/superadmin/database/wipe', requireSuperAdmin, async (req, res, next) => {
  try {
    const confirmation = String(req.body?.confirmation || '').trim().toUpperCase();
    if (confirmation !== 'WIPE DATABASE') {
      return res.status(400).json({ error: 'Invalid confirmation phrase' });
    }

    await pool.query('TRUNCATE TABLE qa_messages, qa_threads, student_message_reads, student_staff_subject_assignments, student_subject_assignments, staff_subject_assignments, submissions, official_materials, broadcast_messages, student_storage_quotas, student_auth, students, subjects RESTART IDENTITY CASCADE');
    await ensureDefaultSubject();
    await syncStudentsOnApiStartup();
    await backfillMissingStudentAuth();
    await enforceDefaultPasswordForFirstLoginAccounts();

    res.json({ ok: true, message: 'Database wiped and baseline data restored' });
  } catch (err) {
    next(err);
  }
});

app.get('/superadmin/analytics/overview', requireSuperAdmin, async (_req, res, next) => {
  try {
    const [students, staff, subjects, submissions, pending, marks] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM students'),
      pool.query('SELECT COUNT(*)::int AS count FROM staff_accounts WHERE is_active = TRUE'),
      pool.query('SELECT COUNT(*)::int AS count FROM subjects WHERE is_active = TRUE'),
      pool.query('SELECT COUNT(*)::int AS count FROM submissions'),
      pool.query(`SELECT COUNT(*)::int AS count FROM submissions WHERE status = 'pending'`),
      pool.query('SELECT AVG(marks)::numeric(10,2) AS avg_mark FROM submissions WHERE marks IS NOT NULL'),
    ]);

    res.json({
      students: students.rows[0].count,
      activeStaff: staff.rows[0].count,
      activeSubjects: subjects.rows[0].count,
      submissions: submissions.rows[0].count,
      pendingSubmissions: pending.rows[0].count,
      averageMark: marks.rows[0].avg_mark === null ? null : Number(marks.rows[0].avg_mark),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/superadmin/workload/staff-subject', requireSuperAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT ssa.staff_email,
              st.full_name AS staff_name,
              ssa.subject_id,
              sub.code AS subject_code,
              sub.name AS subject_name,
              COUNT(DISTINCT sssa.reg_no)::int AS assigned_students,
              COUNT(DISTINCT su.id)::int AS submission_count
       FROM staff_subject_assignments ssa
       JOIN staff_accounts st ON st.email = ssa.staff_email
       JOIN subjects sub ON sub.id = ssa.subject_id
       LEFT JOIN student_staff_subject_assignments sssa
              ON sssa.staff_email = ssa.staff_email
             AND sssa.subject_id = ssa.subject_id
             AND sssa.is_active = TRUE
       LEFT JOIN submissions su
              ON su.roll_number = sssa.reg_no
             AND su.subject_id = ssa.subject_id
       WHERE ssa.is_active = TRUE
       GROUP BY ssa.staff_email, st.full_name, ssa.subject_id, sub.code, sub.name
       ORDER BY sub.code ASC, ssa.staff_email ASC`
    );
    res.json({ workload: result.rows });
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

function buildStudentImportTemplateBuffer() {
  const workbook = XLSX.utils.book_new();

  const templateRows = [
    {
      'Register Number': '927625BAD001',
      'Student Name': 'Example Student',
      Stream: 'CSE',
      Section: 'A7',
    },
    {
      'Register Number': '',
      'Student Name': '',
      Stream: '',
      Section: '',
    },
  ];

  const instructionsRows = [
    {
      Field: 'Register Number',
      Required: 'Yes',
      Notes: 'Unique value. Existing register numbers are skipped and never overwritten.',
    },
    {
      Field: 'Student Name',
      Required: 'Yes',
      Notes: 'Full student name.',
    },
    {
      Field: 'Stream',
      Required: 'No',
      Notes: 'Optional. Can be provided in file or as default in UI.',
    },
    {
      Field: 'Section',
      Required: 'No',
      Notes: 'Optional. Values like A3/A7 are recommended.',
    },
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(templateRows), 'Students Template');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(instructionsRows), 'Instructions');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function inferStudentMetadata(regNo) {
  const code = String(regNo || '').trim().toUpperCase();
  const deptCode = code.slice(6, 9);
  const rollId = code.slice(-3);
  const rollInt = parseInt(rollId, 10) || 0;

  let stream = 'OTHER';
  let section = 'Unknown';

  if (deptCode === 'BAD') {
    stream = 'AIDS';
    // Mapping sections based on roll numbers if multiple sections exist
    if (rollInt <= 60) section = 'A7';
    else if (rollInt <= 120) section = 'A7-B';
    else section = 'A7-C';
  } else if (deptCode === 'BAM') {
    stream = 'AIDS-M';
    section = 'A7';
  } else if (deptCode === 'BCS') {
    stream = 'CSE';
    if (rollInt <= 60) section = 'A3';
    else if (rollInt <= 120) section = 'A2';
    else section = 'A1'; // Just guessing based on user's mention of a1, a2
  } else if (deptCode === 'BIT') {
    stream = 'IT';
    section = 'A3';
  } else if (deptCode === 'BSC') {
    stream = 'CSBS';
    section = 'A3';
  }

  // If user specifically wants "AIDS-A" as department, we can format it
  const deptLabel = {
    'AIDS': 'AIDS',
    'AIDS-M': 'AIDS-M',
    'CSE': 'CSE',
    'IT': 'IT',
    'CSBS': 'CSBS',
    'OTHER': 'OTHER'
  }[stream] || stream;

  // Let's use the user's requested format "AIDS-A" for the department filter
  // We'll append the section characteristic if needed, but for now 
  // let's follow their example: AIDS-A
  const resultStream = (stream === 'AIDS' || stream === 'CSE') ? `${deptLabel}-A` : deptLabel;

  return { stream: resultStream, section };
}

function inferSectionFromRegNo(regNo) {
  return inferStudentMetadata(regNo).section;
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

app.get('/admin/students/template', requireSuperAdmin, async (_req, res, next) => {
  try {
    const buffer = buildStudentImportTemplateBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="students-import-template.xlsx"');
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
});

app.post('/admin/students/import', requireSuperAdmin, excelUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Excel file is required' });
    }

    const fallbackStream = String(req.body?.stream || '').trim();
    const fallbackSection = String(req.body?.section || '').trim().toUpperCase();
    const dryRun = String(req.body?.dryRun || '').toLowerCase() === 'true';
    const rows = parseStudentsFromWorkbook(req.file.buffer);
    if (!rows.length) {
      return res.status(400).json({ error: 'No valid student rows found in file' });
    }

    if (dryRun) {
      const preview = rows.slice(0, 20).map((row) => ({
        regNo: row.regNo,
        fullName: row.fullName,
        stream: row.stream || fallbackStream || null,
        section: row.section || fallbackSection || inferSectionFromRegNo(row.regNo) || null,
      }));
      return res.json({
        ok: true,
        dryRun: true,
        total: rows.length,
        preview,
      });
    }

    let inserted = 0;
    let skipped = 0;
    const streamCount = {};

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const row of rows) {
        const stream = row.stream || fallbackStream;
        const section = row.section || fallbackSection || inferSectionFromRegNo(row.regNo);
        const insertStudent = await client.query(
          `INSERT INTO students (reg_no, full_name, stream, section)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (reg_no) DO NOTHING
           RETURNING reg_no`,
          [row.regNo, row.fullName, stream || null, section || null]
        );

        const wasInserted = insertStudent.rows.length > 0;
        if (wasInserted) {
          inserted += 1;
          await client.query(
            `INSERT INTO student_auth (reg_no, password_hash, password_changed)
             VALUES ($1, $2, FALSE)
             ON CONFLICT (reg_no) DO NOTHING`,
            [row.regNo, hashPassword(row.regNo)]
          );
        } else {
          skipped += 1;
        }

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
      updated: 0,
      skipped,
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

app.get('/student/storage/quota', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const quota = await upsertStudentQuota(regNo);
    const usagePercent = quota.quotaBytes > 0
      ? Math.min(100, Math.round((quota.usedBytes / quota.quotaBytes) * 100))
      : 0;
    res.json({
      regNo,
      usedBytes: quota.usedBytes,
      remainingBytes: quota.remainingBytes,
      totalBytes: quota.quotaBytes,
      usagePercent,
    });
  } catch (err) {
    next(err);
  }
});

// ── Subjects list (student + staff) ──────────────────────────────────────────
app.get('/subjects', requireAuth(['staff', 'student']), async (req, res, next) => {
  try {
    let result;
    if (req.auth.role === 'student') {
      result = await pool.query(
        `SELECT s.id, s.code, s.name 
         FROM subjects s
         JOIN student_subject_assignments ssa ON ssa.subject_id = s.id
         WHERE ssa.reg_no = $1 AND ssa.is_active = TRUE AND s.is_active = TRUE
         ORDER BY s.name ASC`,
        [req.auth.regNo]
      );
    } else {
      result = await pool.query(
        `SELECT id, code, name FROM subjects WHERE is_active = TRUE ORDER BY name ASC`
      );
    }
    res.json({ subjects: result.rows.map(r => ({ id: Number(r.id), code: r.code, name: r.name })) });
  } catch (err) {
    next(err);
  }
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
    subjectId: row.subject_id === null || row.subject_id === undefined ? null : Number(row.subject_id),
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
    const subjectIdQuery = req.query.subjectId ? Number(req.query.subjectId) : null;
    const includeArchived = String(req.query.includeArchived || 'true').toLowerCase() === 'true';
    const status = String(req.query.status || '').trim();
    const streamQuery = String(req.query.stream || '').trim();
    const sectionQuery = String(req.query.section || '').trim();

    const where = [];
    const params = [];

    if (req.auth.role === 'student') {
      params.push(req.auth.regNo);
      where.push(`submissions.roll_number = $${params.length}`);
      where.push('submissions.archived = FALSE');

      if (Number.isFinite(subjectIdQuery) && subjectIdQuery > 0) {
        const canAccessSubject = await ensureStudentAssignedToSubject(req.auth.regNo, subjectIdQuery);
        if (!canAccessSubject) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    } else {
      const staffEmail = normalizeStaffEmail(req.auth.email);
      const isSA = isSuperAdminSession(req.auth);

      if (rollNumberQuery) {
        params.push(rollNumberQuery);
        where.push(`submissions.roll_number = $${params.length}`);
      }

      if (!isSA) {
        if (Number.isFinite(subjectIdQuery) && subjectIdQuery > 0) {
          const canAccessSubject = await ensureStaffAssignedToSubject(staffEmail, subjectIdQuery);
          if (!canAccessSubject) {
            return res.status(403).json({ error: 'Forbidden' });
          }
        }

        params.push(staffEmail);
        where.push(
          `EXISTS (
            SELECT 1
            FROM staff_subject_assignments ssa
            WHERE ssa.staff_email = $${params.length}
              AND ssa.subject_id = submissions.subject_id
              AND ssa.is_active = TRUE
          )`
        );

        params.push(staffEmail);
        where.push(
          `EXISTS (
            SELECT 1
            FROM student_staff_subject_assignments sssa
            WHERE sssa.staff_email = $${params.length}
              AND sssa.reg_no = submissions.roll_number
              AND sssa.subject_id = submissions.subject_id
              AND sssa.is_active = TRUE
          )`
        );
      }

      if (streamQuery && streamQuery !== 'all') {
        params.push(streamQuery);
        where.push(`EXISTS (SELECT 1 FROM students s WHERE s.reg_no = submissions.roll_number AND s.stream = $${params.length})`);
      }
      if (sectionQuery && sectionQuery !== 'all') {
        params.push(sectionQuery);
        where.push(`EXISTS (SELECT 1 FROM students s WHERE s.reg_no = submissions.roll_number AND s.section = $${params.length})`);
      }

      if (!includeArchived) {
        where.push('submissions.archived = FALSE');
      }
    }

    if (Number.isFinite(subjectIdQuery) && subjectIdQuery > 0) {
      params.push(subjectIdQuery);
      where.push(`submissions.subject_id = $${params.length}`);
    }

    if (status) {
      params.push(status);
      where.push(`submissions.status = $${params.length}`);
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

app.get('/staff/submissions', requireAuth('staff'), async (req, res, next) => {
  try {
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const status = String(req.query.status || '').trim();
    const staffEmail = normalizeStaffEmail(req.auth.email);

    const params = [staffEmail, staffEmail];
    const where = [
      `EXISTS (
         SELECT 1
         FROM staff_subject_assignments ssa
         WHERE ssa.staff_email = $1
           AND ssa.subject_id = submissions.subject_id
           AND ssa.is_active = TRUE
       )`,
      `EXISTS (
         SELECT 1
         FROM student_staff_subject_assignments sssa
         WHERE sssa.staff_email = $2
           AND sssa.reg_no = submissions.roll_number
           AND sssa.subject_id = submissions.subject_id
           AND sssa.is_active = TRUE
       )`,
    ];

    if (Number.isFinite(subjectId) && subjectId > 0) {
      const canAccessSubject = await ensureStaffAssignedToSubject(staffEmail, subjectId);
      if (!canAccessSubject) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      params.push(subjectId);
      where.push(`subject_id = $${params.length}`);
    }

    if (status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT *
       FROM submissions
       WHERE ${where.join(' AND ')}
       ORDER BY submitted_at DESC`,
      params
    );
    res.json({ submissions: result.rows.map(normalizeSubmissionRow) });
  } catch (err) {
    next(err);
  }
});

app.get('/student/tests', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;

    if (Number.isFinite(subjectId) && subjectId > 0) {
      const canAccessSubject = await ensureStudentAssignedToSubject(regNo, subjectId);
      if (!canAccessSubject) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const params = [regNo];
    const where = ['roll_number = $1'];
    if (Number.isFinite(subjectId) && subjectId > 0) {
      params.push(subjectId);
      where.push(`subject_id = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT *
       FROM submissions
       WHERE ${where.join(' AND ')}
       ORDER BY submitted_at DESC`,
      params
    );
    res.json({ tests: result.rows.map(normalizeSubmissionRow) });
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

    if (req.auth.role === 'staff') {
      const staffEmail = normalizeStaffEmail(req.auth.email);
      const subjectId = Number.isFinite(submission.subjectId) && submission.subjectId > 0
        ? submission.subjectId
        : await getDefaultSubjectId();

      const canAccessSubject = await ensureStaffAssignedToSubject(staffEmail, subjectId);
      const canAccessStudent = await ensureStaffMappedToStudentForSubject(staffEmail, submission.rollNumber, subjectId);
      if (!canAccessSubject || !canAccessStudent) {
        return res.status(403).json({ error: 'Forbidden' });
      }
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
    const requestedSubjectId = Number(body.subjectId);
    const subjectId = Number.isFinite(requestedSubjectId) && requestedSubjectId > 0
      ? requestedSubjectId
      : await getDefaultSubjectId();

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

    const canSubmit = await ensureStudentAssignedToSubject(req.auth.regNo, subjectId);
    if (!canSubmit) {
      return res.status(403).json({ error: 'Student is not assigned to this subject' });
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
      subjectId,
    ];

    const result = await pool.query(
      `INSERT INTO submissions (
        id, student_name, roll_number, subject, classroom, test_title, notes,
        images, file_count, status, marks, total_marks, feedback, archived,
        submitted_at, graded_at, subject_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8::jsonb, $9, $10, $11, $12, $13, $14,
        $15, $16, $17
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
    } else if (req.auth.role === 'staff' && !isSuperAdminSession(req.auth)) {
      params.push(normalizeStaffEmail(req.auth.email));
      whereClause += ` AND EXISTS (
        SELECT 1 FROM student_staff_subject_assignments sssa
        WHERE sssa.staff_email = $${params.length}
          AND sssa.reg_no = submissions.roll_number
          AND sssa.subject_id = submissions.subject_id
          AND sssa.is_active = TRUE
      )`;
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

  const regNo = normalizeRegNo(req.auth.regNo);
  const requestedSubjectId = Number(req.body?.subjectId);
  const subjectCode = Number.isFinite(requestedSubjectId) && requestedSubjectId > 0
    ? ((await getSubjectCodeById(requestedSubjectId)) || `subject-${requestedSubjectId}`)
    : 'general';
  const baseFolder = [
    'students',
    sanitizePathSegment(regNo),
    'submissions',
    sanitizePathSegment(subjectCode),
  ].join('/');

  const files = (req.files || []).map((file) => {
    const storedName = createStoredUploadName(file.originalname);
    return {
      storedName,
      originalName: file.originalname,
      url: toUploadsPublicUrl(baseFolder, storedName),
      folderPath: baseFolder,
      size: file.size,
      mimeType: file.mimetype,
      ext: path.extname(file.originalname || '').toLowerCase(),
      data: file.buffer,
      uploadKind: 'submission',
      subjectId: Number.isFinite(requestedSubjectId) && requestedSubjectId > 0 ? requestedSubjectId : null,
    };
  });

  if (!files.length) {
    console.error('[UPLOAD] ERROR: No files provided in request');
    return res.status(400).json({ error: 'No files uploaded' });
  }

  for (const file of files) {
    const mimeOk = allowedStudentUploadMimeTypes.has(String(file.mimeType || '').toLowerCase());
    const extOk = allowedStudentUploadExtensions.has(String(file.ext || '').toLowerCase());
    if (!mimeOk || !extOk) {
      return res.status(400).json({
        error: `File type not allowed: ${file.originalName}`,
      });
    }
  }

  try {
    const currentQuota = await upsertStudentQuota(regNo);
    const requestedBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if ((currentQuota.usedBytes + requestedBytes) > currentQuota.quotaBytes) {
      return res.status(409).json({
        error: 'Student storage quota exceeded',
        quota: {
          usedBytes: currentQuota.usedBytes,
          requestedBytes,
          remainingBytes: currentQuota.remainingBytes,
          totalBytes: currentQuota.quotaBytes,
        },
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of files) {
        writeFileToStorage(file.folderPath, file.storedName, file.data);
        await client.query(
          `INSERT INTO uploads (stored_name, original_name, mime_type, size_bytes, file_url, folder_path, file_data, owner_reg_no, upload_kind, subject_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (stored_name)
           DO UPDATE SET original_name = EXCLUDED.original_name,
                         mime_type = EXCLUDED.mime_type,
                         size_bytes = EXCLUDED.size_bytes,
                         file_url = EXCLUDED.file_url,
                         folder_path = EXCLUDED.folder_path,
                         file_data = EXCLUDED.file_data,
                         owner_reg_no = EXCLUDED.owner_reg_no,
                         upload_kind = EXCLUDED.upload_kind,
                         subject_id = EXCLUDED.subject_id`,
          [file.storedName, file.originalName, file.mimeType, file.size, file.url, file.folderPath, file.data, regNo, file.uploadKind, file.subjectId]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const updatedQuota = await upsertStudentQuota(regNo);

    console.log('[UPLOAD] SUCCESS: Saved', files.length, 'files to database');
    const responseFiles = files.map((file) => ({
      name: file.storedName,
      originalName: file.originalName,
      url: file.url,
      folderPath: file.folderPath,
      size: file.size,
      mimeType: file.mimeType,
    }));
    res.json({
      files: responseFiles,
      quota: {
        usedBytes: updatedQuota.usedBytes,
        remainingBytes: updatedQuota.remainingBytes,
        totalBytes: updatedQuota.quotaBytes,
      },
    });
  } catch (err) {
    console.error('[UPLOAD] DATABASE ERROR:', err.message);
    next(err);
  }
});

app.post('/student/ppts', requireAuth('student'), materialUpload.single('file'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const subjectId = Number(req.body?.subjectId);
    const rawTitle = String(req.body?.title || '').trim();
    const file = req.file;

    if (!Number.isFinite(subjectId) || subjectId <= 0 || !file) {
      return res.status(400).json({ error: 'subjectId and PPT file are required' });
    }

    const canSubmit = await ensureStudentAssignedToSubject(regNo, subjectId);
    if (!canSubmit) {
      return res.status(403).json({ error: 'Student is not assigned to this subject' });
    }

    const ext = path.extname(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const extOk = allowedStudentPptExtensions.has(ext);
    const mimeOk = allowedStudentPptMimeTypes.has(mime);
    if (!extOk || !mimeOk) {
      return res.status(400).json({ error: 'Only .ppt or .pptx files are allowed' });
    }

    const subjectCode = (await getSubjectCodeById(subjectId)) || `subject-${subjectId}`;
    const storedName = createStoredUploadName(file.originalname);
    const folderPath = [
      'students',
      sanitizePathSegment(regNo),
      'presentations',
      sanitizePathSegment(subjectCode),
    ].join('/');
    const fileUrl = toUploadsPublicUrl(folderPath, storedName);

    const currentQuota = await upsertStudentQuota(regNo);
    const requestedBytes = Number(file.size || 0);
    if ((currentQuota.usedBytes + requestedBytes) > currentQuota.quotaBytes) {
      return res.status(409).json({
        error: 'Student storage quota exceeded',
        quota: {
          usedBytes: currentQuota.usedBytes,
          requestedBytes,
          remainingBytes: currentQuota.remainingBytes,
          totalBytes: currentQuota.quotaBytes,
        },
      });
    }

    writeFileToStorage(folderPath, storedName, file.buffer);

    await pool.query(
      `INSERT INTO uploads (stored_name, original_name, mime_type, size_bytes, file_url, folder_path, file_data, owner_reg_no, upload_kind, subject_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'student_ppt', $9)
       ON CONFLICT (stored_name)
       DO UPDATE SET original_name = EXCLUDED.original_name,
                     mime_type = EXCLUDED.mime_type,
                     size_bytes = EXCLUDED.size_bytes,
                     file_url = EXCLUDED.file_url,
                     folder_path = EXCLUDED.folder_path,
                     file_data = EXCLUDED.file_data,
                     owner_reg_no = EXCLUDED.owner_reg_no,
                     upload_kind = EXCLUDED.upload_kind,
                     subject_id = EXCLUDED.subject_id`,
      [storedName, file.originalname, file.mimetype, file.size, fileUrl, folderPath, file.buffer, regNo, subjectId]
    );

    const updatedQuota = await upsertStudentQuota(regNo);
    const title = rawTitle || path.parse(file.originalname || 'Presentation').name;

    res.status(201).json({
      ok: true,
      ppt: {
        title,
        storedName,
        originalName: file.originalname,
        fileUrl,
        subjectId,
        sizeBytes: Number(file.size || 0),
      },
      quota: {
        usedBytes: updatedQuota.usedBytes,
        remainingBytes: updatedQuota.remainingBytes,
        totalBytes: updatedQuota.quotaBytes,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/student/ppts', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const params = [regNo];
    const where = [
      'u.owner_reg_no = $1',
      `u.upload_kind = 'student_ppt'`,
    ];

    if (Number.isFinite(subjectId) && subjectId > 0) {
      const canAccessSubject = await ensureStudentAssignedToSubject(regNo, subjectId);
      if (!canAccessSubject) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      params.push(subjectId);
      where.push(`u.subject_id = $${params.length}`);
    }

    const result = await pool.query(
      `SELECT u.stored_name, u.original_name, u.file_url, u.size_bytes, u.created_at,
              u.subject_id, sub.code AS subject_code, sub.name AS subject_name
       FROM uploads u
       LEFT JOIN subjects sub ON sub.id = u.subject_id
       WHERE ${where.join(' AND ')}
       ORDER BY u.created_at DESC`,
      params
    );

    res.json({ ppts: result.rows });
  } catch (err) {
    next(err);
  }
});

app.get('/staff/student-ppts', requireAuth('staff'), async (req, res, next) => {
  try {
    const staffEmail = normalizeStaffEmail(req.auth.email);
    const subjectId = req.query?.subjectId ? Number(req.query.subjectId) : null;
    const isSA = isSuperAdminSession(req.auth);

    const params = [];
    const where = [`u.upload_kind = 'student_ppt'`];

    if (Number.isFinite(subjectId) && subjectId > 0) {
      if (!isSA) {
        const canAccessSubject = await ensureStaffAssignedToSubject(staffEmail, subjectId);
        if (!canAccessSubject) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
      params.push(subjectId);
      where.push(`u.subject_id = $${params.length}`);
    }

    if (!isSA) {
      params.push(staffEmail);
      where.push(
        `EXISTS (
          SELECT 1
          FROM staff_subject_assignments ssa
          WHERE ssa.staff_email = $${params.length}
            AND ssa.subject_id = u.subject_id
            AND ssa.is_active = TRUE
        )`
      );

      params.push(staffEmail);
      where.push(
        `EXISTS (
          SELECT 1
          FROM student_staff_subject_assignments sssa
          WHERE sssa.staff_email = $${params.length}
            AND sssa.reg_no = u.owner_reg_no
            AND sssa.subject_id = u.subject_id
            AND sssa.is_active = TRUE
        )`
      );
    }

    const result = await pool.query(
      `SELECT u.stored_name, u.original_name, u.file_url, u.size_bytes, u.created_at,
              u.owner_reg_no, s.full_name AS student_name,
              u.subject_id, sub.code AS subject_code, sub.name AS subject_name
       FROM uploads u
       LEFT JOIN students s ON s.reg_no = u.owner_reg_no
       LEFT JOIN subjects sub ON sub.id = u.subject_id
       WHERE ${where.join(' AND ')}
       ORDER BY u.created_at DESC
       LIMIT 500`,
      params
    );

    res.json({ ppts: result.rows });
  } catch (err) {
    next(err);
  }
});

app.post('/student/notes', requireAuth('student'), upload.array('files', 20), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const files = (req.files || []).map((file) => {
      const storedName = createStoredUploadName(file.originalname);
      const folderPath = [
        'students',
        sanitizePathSegment(regNo),
        'personal-notes',
      ].join('/');
      return {
        storedName,
        originalName: file.originalname,
        url: toUploadsPublicUrl(folderPath, storedName),
        folderPath,
        size: file.size,
        mimeType: file.mimetype,
        ext: path.extname(file.originalname || '').toLowerCase(),
        data: file.buffer,
      };
    });

    if (!files.length) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    for (const file of files) {
      const mimeOk = allowedStudentUploadMimeTypes.has(String(file.mimeType || '').toLowerCase());
      const extOk = allowedStudentUploadExtensions.has(String(file.ext || '').toLowerCase());
      if (!mimeOk || !extOk) {
        return res.status(400).json({ error: `File type not allowed: ${file.originalName}` });
      }
    }

    const currentQuota = await upsertStudentQuota(regNo);
    const requestedBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    if ((currentQuota.usedBytes + requestedBytes) > currentQuota.quotaBytes) {
      return res.status(409).json({
        error: 'Student storage quota exceeded',
        quota: {
          usedBytes: currentQuota.usedBytes,
          requestedBytes,
          remainingBytes: currentQuota.remainingBytes,
          totalBytes: currentQuota.quotaBytes,
        },
      });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of files) {
        writeFileToStorage(file.folderPath, file.storedName, file.data);
        await client.query(
          `INSERT INTO uploads (stored_name, original_name, mime_type, size_bytes, file_url, folder_path, file_data, owner_reg_no, upload_kind, subject_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'personal_note', NULL)
           ON CONFLICT (stored_name)
           DO UPDATE SET original_name = EXCLUDED.original_name,
                         mime_type = EXCLUDED.mime_type,
                         size_bytes = EXCLUDED.size_bytes,
                         file_url = EXCLUDED.file_url,
                         folder_path = EXCLUDED.folder_path,
                         file_data = EXCLUDED.file_data,
                         owner_reg_no = EXCLUDED.owner_reg_no,
                         upload_kind = EXCLUDED.upload_kind,
                         subject_id = EXCLUDED.subject_id`,
          [file.storedName, file.originalName, file.mimeType, file.size, file.url, file.folderPath, file.data, regNo]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    const updatedQuota = await upsertStudentQuota(regNo);
    res.status(201).json({
      ok: true,
      files: files.map((file) => ({
        name: file.storedName,
        originalName: file.originalName,
        url: file.url,
        folderPath: file.folderPath,
        size: file.size,
        mimeType: file.mimeType,
      })),
      quota: {
        usedBytes: updatedQuota.usedBytes,
        remainingBytes: updatedQuota.remainingBytes,
        totalBytes: updatedQuota.quotaBytes,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.get('/student/notes', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const result = await pool.query(
      `SELECT stored_name, original_name, mime_type, size_bytes, file_url, folder_path, created_at
       FROM uploads
       WHERE owner_reg_no = $1
         AND upload_kind = 'personal_note'
       ORDER BY created_at DESC`,
      [regNo]
    );
    const quota = await upsertStudentQuota(regNo);
    res.json({
      notes: result.rows,
      quota: {
        usedBytes: quota.usedBytes,
        remainingBytes: quota.remainingBytes,
        totalBytes: quota.quotaBytes,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/student/notes/:storedName', requireAuth('student'), async (req, res, next) => {
  try {
    const regNo = normalizeRegNo(req.auth.regNo);
    const storedName = path.basename(String(req.params?.storedName || ''));
    if (!storedName) {
      return res.status(400).json({ error: 'Invalid file id' });
    }

    const result = await pool.query(
      `DELETE FROM uploads
       WHERE stored_name = $1
         AND owner_reg_no = $2
         AND upload_kind = 'personal_note'
       RETURNING stored_name, folder_path`,
      [storedName, regNo]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Note not found' });
    }

    const folderPath = String(result.rows[0].folder_path || '').replace(/\\/g, '/');
    const absolutePath = path.join(uploadDir, folderPath, storedName);
    try {
      if (fs.existsSync(absolutePath)) {
        fs.unlinkSync(absolutePath);
      }
    } catch (_err) {
      // Best effort cleanup.
    }

    const quota = await upsertStudentQuota(regNo);
    res.json({
      ok: true,
      quota: {
        usedBytes: quota.usedBytes,
        remainingBytes: quota.remainingBytes,
        totalBytes: quota.quotaBytes,
      },
    });
  } catch (err) {
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
    CREATE TABLE IF NOT EXISTS role_policies (
      staff_email TEXT PRIMARY KEY REFERENCES staff_accounts(email) ON DELETE CASCADE,
      permissions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      before_json JSONB,
      after_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS subjects (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff_subject_assignments (
      id BIGSERIAL PRIMARY KEY,
      staff_email TEXT NOT NULL REFERENCES staff_accounts(email) ON DELETE CASCADE,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(staff_email, subject_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_subject_assignments (
      id BIGSERIAL PRIMARY KEY,
      reg_no TEXT NOT NULL REFERENCES students(reg_no) ON DELETE CASCADE,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(reg_no, subject_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_staff_subject_assignments (
      id BIGSERIAL PRIMARY KEY,
      reg_no TEXT NOT NULL REFERENCES students(reg_no) ON DELETE CASCADE,
      staff_email TEXT NOT NULL REFERENCES staff_accounts(email) ON DELETE CASCADE,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(reg_no, staff_email, subject_id)
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_staff_subject_assignments_subject ON staff_subject_assignments(subject_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_student_subject_assignments_subject ON student_subject_assignments(subject_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_student_staff_subject_assignments_subject ON student_staff_subject_assignments(subject_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_student_staff_subject_assignments_staff ON student_staff_subject_assignments(staff_email)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS uploads (
      id BIGSERIAL PRIMARY KEY,
      stored_name TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT,
      size_bytes BIGINT,
      file_url TEXT NOT NULL,
      file_data BYTEA,
      owner_reg_no TEXT REFERENCES students(reg_no) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS file_data BYTEA');
  await pool.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS owner_reg_no TEXT');
  await pool.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS folder_path TEXT');
  await pool.query("ALTER TABLE uploads ADD COLUMN IF NOT EXISTS upload_kind TEXT NOT NULL DEFAULT 'submission'");
  await pool.query('ALTER TABLE uploads ADD COLUMN IF NOT EXISTS subject_id BIGINT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_uploads_owner_reg_no ON uploads(owner_reg_no)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_uploads_upload_kind ON uploads(upload_kind)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id TEXT PRIMARY KEY,
      student_name TEXT NOT NULL,
      roll_number TEXT NOT NULL,
      subject_id BIGINT REFERENCES subjects(id) ON DELETE SET NULL,
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

  await pool.query('ALTER TABLE submissions ADD COLUMN IF NOT EXISTS subject_id BIGINT');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_submissions_subject_id ON submissions(subject_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_storage_quotas (
      reg_no TEXT PRIMARY KEY REFERENCES students(reg_no) ON DELETE CASCADE,
      quota_bytes BIGINT NOT NULL DEFAULT 524288000,
      used_bytes BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS official_materials (
      id BIGSERIAL PRIMARY KEY,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      staff_email TEXT NOT NULL REFERENCES staff_accounts(email) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      file_name TEXT NOT NULL,
      file_url TEXT,
      folder_path TEXT,
      mime_type TEXT,
      size_bytes BIGINT,
      file_data BYTEA,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE official_materials ADD COLUMN IF NOT EXISTS file_url TEXT');
  await pool.query('ALTER TABLE official_materials ADD COLUMN IF NOT EXISTS folder_path TEXT');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS broadcast_messages (
      id BIGSERIAL PRIMARY KEY,
      created_by_staff_email TEXT NOT NULL REFERENCES staff_accounts(email) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      starts_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query("ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'global'");
  await pool.query('ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS subject_id BIGINT');
  await pool.query('ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS classroom TEXT');
  await pool.query('ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS target_reg_no TEXT');
  await pool.query("ALTER TABLE broadcast_messages ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_broadcast_messages_channel_type ON broadcast_messages(channel_type)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_broadcast_messages_target_reg_no ON broadcast_messages(target_reg_no)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_message_reads (
      message_id BIGINT NOT NULL REFERENCES broadcast_messages(id) ON DELETE CASCADE,
      reg_no TEXT NOT NULL REFERENCES students(reg_no) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, reg_no)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qa_threads (
      id BIGSERIAL PRIMARY KEY,
      subject_id BIGINT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      staff_email TEXT NOT NULL REFERENCES staff_accounts(email) ON DELETE CASCADE,
      reg_no TEXT NOT NULL REFERENCES students(reg_no) ON DELETE CASCADE,
      title TEXT NOT NULL,
      is_open BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS qa_messages (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES qa_threads(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query('CREATE INDEX IF NOT EXISTS idx_qa_threads_staff_email ON qa_threads(staff_email)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_qa_threads_reg_no ON qa_threads(reg_no)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_qa_messages_thread_id ON qa_messages(thread_id)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS system_backups (
      id BIGSERIAL PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_size BIGINT,
      checksum TEXT,
      storage_path TEXT,
      created_by TEXT,
      file_data BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      restore_tested_at TIMESTAMPTZ
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
      const { stream, section } = inferStudentMetadata(regNo);
      const upsertStudent = await client.query(
        `INSERT INTO students (reg_no, full_name, stream, section)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (reg_no)
         DO UPDATE SET full_name = EXCLUDED.full_name,
                       stream = COALESCE(students.stream, EXCLUDED.stream),
                       section = COALESCE(students.section, EXCLUDED.section)
         RETURNING (xmax = 0) AS inserted`,
        [regNo, fullName, stream, section]
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
                   is_active = COALESCE(staff_accounts.is_active, EXCLUDED.is_active),
                   updated_at = NOW()`,
    [staffDefaultEmail, staffDefaultName, staffDefaultRole, hashPassword(staffDefaultPassword)]
  );
  console.log(`Upserted default staff account (preserved password if exists): ${staffDefaultEmail}`);
}

async function upsertUHVStaffAccount() {
  await pool.query(
    `INSERT INTO staff_accounts (email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (email)
     DO UPDATE SET full_name = EXCLUDED.full_name,
                   role = EXCLUDED.role,
                   is_active = COALESCE(staff_accounts.is_active, EXCLUDED.is_active),
                   updated_at = NOW()`,
    [uhvStaffEmail, uhvStaffName, uhvStaffRole, hashPassword(uhvStaffPassword)]
  );
  console.log(`Upserted UHV staff account (preserved password if exists): ${uhvStaffEmail}`);
}

async function upsertDefaultSuperAdminAccount() {
  await pool.query(
    `INSERT INTO staff_accounts (email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (email)
     DO UPDATE SET full_name = EXCLUDED.full_name,
                   role = EXCLUDED.role,
                   is_active = COALESCE(staff_accounts.is_active, EXCLUDED.is_active),
                   updated_at = NOW()`,
    [superAdminDefaultEmail, superAdminDefaultName, superAdminDefaultRole, hashPassword(superAdminDefaultPassword)]
  );
  console.log(`Upserted default super admin account (preserved password if exists): ${superAdminDefaultEmail}`);
}

async function ensureDefaultSubject() {
  await pool.query(
    `INSERT INTO subjects (code, name, is_active)
     VALUES ('CHEMISTRY', 'Chemistry', TRUE)
     ON CONFLICT (code)
     DO UPDATE SET name = EXCLUDED.name,
                   is_active = COALESCE(subjects.is_active, EXCLUDED.is_active),
                   updated_at = NOW()`
  );
  // Ensure UHV subject exists
  await pool.query(
    `INSERT INTO subjects (code, name, is_active)
     VALUES ('UHV', 'Universal Human Values', TRUE)
     ON CONFLICT (code)
     DO UPDATE SET name = EXCLUDED.name,
                   is_active = COALESCE(subjects.is_active, EXCLUDED.is_active),
                   updated_at = NOW()`
  );
}

async function backfillSubmissionSubjectId() {
  const defaultSubjectId = await getDefaultSubjectId();
  await pool.query(
    `UPDATE submissions
     SET subject_id = $1
     WHERE subject_id IS NULL`,
    [defaultSubjectId]
  );
}

async function getSubjectIdByCode(code) {
  const result = await pool.query(`SELECT id FROM subjects WHERE code = $1 LIMIT 1`, [normalizeSubjectCode(code)]);
  if (!result.rows.length) throw new Error(`Subject ${code} not found`);
  return Number(result.rows[0].id);
}

async function ensureBaselineAssignments() {
  const defaultSubjectId = await getDefaultSubjectId();

  await pool.query(
    `INSERT INTO student_subject_assignments (reg_no, subject_id, is_active)
     SELECT s.reg_no, $1, TRUE
     FROM students s
     ON CONFLICT (reg_no, subject_id)
     DO NOTHING`,
    [defaultSubjectId]
  );

  await pool.query(
    `INSERT INTO staff_subject_assignments (staff_email, subject_id, is_active)
     SELECT st.email, $1, TRUE
     FROM staff_accounts st
     WHERE st.is_active = TRUE
     ON CONFLICT (staff_email, subject_id)
     DO NOTHING`,
    [defaultSubjectId]
  );

  await pool.query(
    `INSERT INTO student_staff_subject_assignments (reg_no, staff_email, subject_id, is_active)
     SELECT s.reg_no, st.email, $1, TRUE
     FROM students s
     JOIN staff_accounts st ON st.is_active = TRUE
     ON CONFLICT (reg_no, staff_email, subject_id)
     DO NOTHING`,
    [defaultSubjectId]
  );
}

async function ensureUHVAssignments() {
  let uhvSubjectId;
  try {
    uhvSubjectId = await getSubjectIdByCode('UHV');
  } catch (_err) {
    console.warn('[UHV] UHV subject not found, skipping UHV assignments');
    return;
  }

  // Assign all students to UHV subject
  await pool.query(
    `INSERT INTO student_subject_assignments (reg_no, subject_id, is_active)
     SELECT s.reg_no, $1, TRUE
     FROM students s
     ON CONFLICT (reg_no, subject_id)
     DO NOTHING`,
    [uhvSubjectId]
  );

  // Assign UHV teacher to UHV subject
  await pool.query(
    `INSERT INTO staff_subject_assignments (staff_email, subject_id, is_active)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (staff_email, subject_id)
     DO NOTHING`,
    [uhvStaffEmail, uhvSubjectId]
  );

  // Map all students to UHV teacher for UHV subject
  await pool.query(
    `INSERT INTO student_staff_subject_assignments (reg_no, staff_email, subject_id, is_active)
     SELECT s.reg_no, $1, $2, TRUE
     FROM students s
     ON CONFLICT (reg_no, staff_email, subject_id)
     DO NOTHING`,
    [uhvStaffEmail, uhvSubjectId]
  );

  console.log(`[UHV] UHV subject assignments ensured for all students → ${uhvStaffEmail}`);
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

async function backfillStudentMetadataFromRegNo() {
  await pool.query(
    `UPDATE students
     SET stream = CASE
           WHEN reg_no LIKE '%BAD%' THEN 'AIDS-A'
           WHEN reg_no LIKE '%BAM%' THEN 'AIDS-M'
           WHEN reg_no LIKE '%BCS%' THEN 'CSE-A'
           WHEN reg_no LIKE '%BIT%' THEN 'IT'
           WHEN reg_no LIKE '%BSC%' THEN 'CSBS'
           ELSE stream
         END,
         section = CASE
           WHEN reg_no LIKE '%BAD%' OR reg_no LIKE '%BAM%' THEN 'A7'
           WHEN reg_no LIKE '%BCS%' OR reg_no LIKE '%BIT%' OR reg_no LIKE '%BSC%' THEN 'A3'
           ELSE section
         END
     WHERE stream IS NULL OR section IS NULL OR BTRIM(COALESCE(section, '')) = ''`
  );
}

async function syncAllStudentQuotas() {
  await pool.query(
    `INSERT INTO student_storage_quotas (reg_no, quota_bytes, used_bytes, updated_at)
     SELECT s.reg_no,
            $1,
            COALESCE(u.used_bytes, 0),
            NOW()
     FROM students s
     LEFT JOIN (
       SELECT owner_reg_no AS reg_no, COALESCE(SUM(size_bytes), 0)::bigint AS used_bytes
       FROM uploads
       WHERE owner_reg_no IS NOT NULL
       GROUP BY owner_reg_no
     ) u ON u.reg_no = s.reg_no
     ON CONFLICT (reg_no)
     DO UPDATE SET quota_bytes = EXCLUDED.quota_bytes,
                   used_bytes = EXCLUDED.used_bytes,
                   updated_at = NOW()`,
    [Math.max(studentQuotaBytesDefault, 1)]
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
  await ensureDefaultSubject();
  await syncStudentsOnApiStartup();
  await backfillStudentMetadataFromRegNo();
  await backfillMissingStudentAuth();
  await enforceDefaultPasswordForFirstLoginAccounts();
  await upsertDefaultStaffAccount();
  await upsertUHVStaffAccount();
  await upsertDefaultSuperAdminAccount();
  await backfillSubmissionSubjectId();
  if (baselineAssignmentsOnStartup) {
    await ensureBaselineAssignments();
    console.log('Startup baseline assignments are enabled (BASELINE_ASSIGNMENTS_ON_STARTUP=true)');
  } else {
    console.log('Startup baseline assignments are disabled (BASELINE_ASSIGNMENTS_ON_STARTUP=false)');
  }
  if (uhvAssignmentsOnStartup) {
    await ensureUHVAssignments();
    console.log('Startup UHV assignments are enabled (UHV_ASSIGNMENTS_ON_STARTUP=true)');
  } else {
    console.log('Startup UHV assignments are disabled (UHV_ASSIGNMENTS_ON_STARTUP=false)');
  }
  await syncAllStudentQuotas();
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

app.post('/internal/cleanup/uploads', async (req, res, next) => {
  try {
    if (!isInternalTokenAuthorized(req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await cleanupOrphanedUploadFiles();
    res.json({ ok: true, ...result, at: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});