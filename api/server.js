const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = Number(process.env.API_PORT || 3000);
const uploadDir = process.env.UPLOAD_DIR || '/data/uploads';
const studentsFile = process.env.STUDENTS_FILE || '/app/students-db.js';
const resyncToken = process.env.RESYNC_TOKEN || '';

const pool = new Pool({
  host: process.env.DB_HOST || 'chemtest-db',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'chemistry',
  user: process.env.DB_USER || 'chemistry_user',
  password: process.env.DB_PASSWORD || 'change_me',
  max: 10,
});

let dbReady = false;

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

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: dbReady ? 'ready' : 'starting' });
  } catch (_err) {
    res.status(500).json({ ok: false, db: 'unavailable' });
  }
});

app.get('/students/count', async (_req, res) => {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM students');
  res.json({ count: result.rows[0].count });
});

app.post('/upload', upload.array('files', 20), async (req, res, next) => {
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

app.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large (max 15MB)' });
  }
  res.status(500).json({ error: 'Upload failed' });
});

function parseStudentsFromFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const match = raw.match(/const\s+STUDENTS_DB\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error('Could not find STUDENTS_DB object in students-db.js');
  }

  const objectLiteral = match[1];
  // Trusted local source file; this converts JS object literal to runtime object.
  return Function(`"use strict"; return (${objectLiteral});`)();
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      reg_no TEXT PRIMARY KEY,
      full_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
}

async function seedStudentsIfEmpty() {
  const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM students');
  if (countResult.rows[0].count > 0) {
    return;
  }

  const result = await syncStudentsFromFile();
  console.log(`Initial student seed completed. Inserted: ${result.inserted}, Updated: ${result.updated}, Total source: ${result.total}`);
}

async function syncStudentsFromFile() {
  const students = parseStudentsFromFile(studentsFile);
  const entries = Object.entries(students);
  if (!entries.length) {
    return { inserted: 0, updated: 0, total: 0 };
  }

  let inserted = 0;
  let updated = 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [regNo, fullName] of entries) {
      const result = await client.query(
        `INSERT INTO students (reg_no, full_name)
         VALUES ($1, $2)
         ON CONFLICT (reg_no) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING (xmax = 0) AS inserted`,
        [regNo, fullName]
      );

      if (result.rows[0].inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }
    await client.query('COMMIT');
    console.log(`Synced ${entries.length} students from ${studentsFile}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    inserted,
    updated,
    total: entries.length,
  };
}

app.post('/students/resync', async (req, res, next) => {
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

async function bootstrap() {
  await ensureSchema();
  await seedStudentsIfEmpty();
  dbReady = true;

  app.listen(port, '0.0.0.0', () => {
    console.log(`Upload API listening on ${port}`);
  });
}

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
