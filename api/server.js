const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.API_PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || '/data/uploads';
const studentsFile = process.env.STUDENTS_FILE || '/app/students-db.js';
const resyncToken = process.env.RESYNC_TOKEN || '';
const authPepper = process.env.AUTH_PEPPER || 'change_this_auth_pepper';
const sessionTtlHours = Number(process.env.AUTH_SESSION_TTL_HOURS || 24);

const staffDefaultEmail = (process.env.STAFF_DEFAULT_EMAIL || 'admin@chemtest.in').trim().toLowerCase();
const staffDefaultPassword = process.env.STAFF_DEFAULT_PASSWORD || 'ChangeThisNow_2026!';
const staffDefaultName = process.env.STAFF_DEFAULT_NAME || 'System Admin';
const staffDefaultRole = process.env.STAFF_DEFAULT_ROLE || 'Chemistry Teacher';

app.use(express.json({ limit: '1mb' }));

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
const sessions = new Map();

fs.mkdirSync(uploadDir, { recursive: true });

const sanitize = (name) =>
  name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 120);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const base = sanitize(path.basename(file.originalname || 'file', ext));
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${base || 'file'}-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    files: 20,
    fileSize: 15 * 1024 * 1024,
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
    if (!regNo || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }

    const result = await pool.query(
      `SELECT s.reg_no, s.full_name, a.password_hash, a.password_changed
       FROM students s
       JOIN student_auth a ON a.reg_no = s.reg_no
       WHERE s.reg_no = $1`,
      [regNo]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const row = result.rows[0];
    if (hashPassword(password) !== row.password_hash) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createSession({ role: 'student', regNo: row.reg_no, name: row.full_name });
    res.json({
      token,
      student: { regNo: row.reg_no, name: row.full_name },
      mustChangePassword: !row.password_changed,
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

    const token = createSession({ role: 'staff', email: row.email, name: row.full_name });
    res.json({ token, staff: { email: row.email, name: row.full_name, role: row.role } });
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
  return {
    id: row.id,
    studentName: row.student_name,
    rollNumber: row.roll_number,
    subject: row.subject || '',
    classroom: row.classroom || '',
    testTitle: row.test_title || '',
    notes: row.notes || '',
    images: Array.isArray(row.images) ? row.images : [],
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
    res.json({ submissions: result.rows.map(normalizeSubmissionRow) });
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

    if (!id || !studentName || !rollNumber || !testTitle) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (rollNumber !== req.auth.regNo) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const submissionValues = [
      id,
      studentName,
      rollNumber,
      String(body.subject || ''),
      String(body.classroom || ''),
      testTitle,
      String(body.notes || ''),
      JSON.stringify(Array.isArray(body.images) ? body.images : []),
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

    res.status(201).json({ submission: normalizeSubmissionRow(result.rows[0]) });
  } catch (err) {
    if (err && err.code === '23505') {
      return res.status(409).json({ error: 'Submission already exists' });
    }
    next(err);
  }
});

app.patch('/submissions/:id', requireAuth('staff'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const editable = {
      studentName: ['student_name', (v) => String(v || '')],
      rollNumber: ['roll_number', (v) => String(v || '')],
      subject: ['subject', (v) => String(v || '')],
      classroom: ['classroom', (v) => String(v || '')],
      testTitle: ['test_title', (v) => String(v || '')],
      notes: ['notes', (v) => String(v || '')],
      images: ['images', (v) => JSON.stringify(Array.isArray(v) ? v : [])],
      fileCount: ['file_count', (v) => Number(v || 0)],
      status: ['status', (v) => String(v || 'pending')],
      marks: ['marks', (v) => (v === null || v === '' || v === undefined ? null : Number(v))],
      totalMarks: ['total_marks', (v) => (v === null || v === '' || v === undefined ? null : Number(v))],
      feedback: ['feedback', (v) => String(v || '')],
      archived: ['archived', (v) => Boolean(v)],
      gradedAt: ['graded_at', (v) => (v ? new Date(v) : null)],
      submittedAt: ['submitted_at', (v) => (v ? new Date(v) : null)],
    };

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

    const result = await pool.query(
      `UPDATE submissions
       SET ${setParts.join(', ')}
       WHERE id = $${params.length}
       RETURNING *`,
      params
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({ submission: normalizeSubmissionRow(result.rows[0]) });
  } catch (err) {
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

app.delete('/submissions/:id', requireAuth('staff'), async (req, res, next) => {
  try {
    const result = await pool.query('DELETE FROM submissions WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/upload', requireAuth('student'), upload.array('files', 20), async (req, res, next) => {
  const files = (req.files || []).map((file) => ({
    originalName: file.originalname,
    name: file.filename,
    url: `/uploads/${file.filename}`,
    size: file.size,
    mimeType: file.mimetype,
  }));

  if (!files.length) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const file of files) {
        await client.query(
          `INSERT INTO uploads (stored_name, original_name, mime_type, size_bytes, file_url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (stored_name)
           DO UPDATE SET original_name = EXCLUDED.original_name,
                         mime_type = EXCLUDED.mime_type,
                         size_bytes = EXCLUDED.size_bytes,
                         file_url = EXCLUDED.file_url`,
          [file.name, file.originalName, file.mimeType, file.size, file.url]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json({ files });
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

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
      const upsertStudent = await client.query(
        `INSERT INTO students (reg_no, full_name)
         VALUES ($1, $2)
         ON CONFLICT (reg_no) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING (xmax = 0) AS inserted`,
        [regNo, fullName]
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

async function seedStaffIfEmpty() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM staff_accounts');
  if (result.rows[0].count > 0) return;

  await pool.query(
    `INSERT INTO staff_accounts (email, full_name, role, password_hash, is_active)
     VALUES ($1, $2, $3, $4, TRUE)`,
    [staffDefaultEmail, staffDefaultName, staffDefaultRole, hashPassword(staffDefaultPassword)]
  );
  console.log(`Seeded default staff account: ${staffDefaultEmail}`);
}

async function seedStudentsIfEmpty() {
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM students');
  if (countResult.rows[0].count > 0) {
    return;
  }

  const result = await syncStudentsFromFile();
  console.log(`Initial student seed completed. Inserted: ${result.inserted}, Updated: ${result.updated}, Total source: ${result.total}`);
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
  await seedStudentsIfEmpty();
  await backfillMissingStudentAuth();
  await seedStaffIfEmpty();
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