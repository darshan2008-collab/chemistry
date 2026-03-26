const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const rootDir = __dirname;
const envPath = path.join(rootDir, '.env');

function loadEnv(filePath) {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
        if (!line || line.trim().startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
    }
}

function mimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.webp': 'image/webp',
        '.txt': 'text/plain; charset=utf-8',
    };
    return map[ext] || 'application/octet-stream';
}

function safeResolveStatic(urlPath) {
    const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
    const normalized = path.normalize(decodedPath).replace(/^([/\\])+/, '');
    const absPath = path.join(rootDir, normalized || 'login.html');
    if (!absPath.startsWith(rootDir)) return null;
    return absPath;
}

function proxyApiRequest(req, res, apiPort) {
    const targetPath = req.url.replace(/^\/api/, '') || '/';
    const options = {
        hostname: '127.0.0.1',
        port: apiPort,
        path: targetPath,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${apiPort}` },
    };

    const upstream = http.request(options, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
    });

    upstream.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'API unavailable', details: err.code || err.message }));
    });

    req.pipe(upstream);
}

loadEnv(envPath);

const appPort = Number(process.env.APP_PORT || 10004);
const apiPort = Number(process.env.API_PORT || 3000);

const mergedEnv = {
    ...process.env,
    DB_HOST: process.env.DB_HOST_LOCAL || '127.0.0.1',
    DB_PORT: process.env.DB_PORT || '5432',
    UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(rootDir, 'data', 'uploads'),
    STUDENTS_FILE: process.env.STUDENTS_FILE || path.join(rootDir, 'students-db.js'),
};

fs.mkdirSync(mergedEnv.UPLOAD_DIR, { recursive: true });

const apiProcess = spawn(process.execPath, [path.join(rootDir, 'api', 'server.js')], {
    cwd: rootDir,
    env: mergedEnv,
    stdio: 'inherit',
});

apiProcess.on('exit', (code) => {
    console.error(`API exited with code ${code}`);
    process.exit(code || 1);
});

const staticServer = http.createServer((req, res) => {
    if (!req.url) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
    }

    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('ok');
        return;
    }

    if (req.url.startsWith('/api/') || req.url.startsWith('/uploads/')) {
        proxyApiRequest(req, res, apiPort);
        return;
    }

    let filePath = safeResolveStatic(req.url === '/' ? '/login.html' : req.url);
    if (!filePath) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    if (!fs.existsSync(filePath)) {
        const fallback = safeResolveStatic('/login.html');
        if (fallback && fs.existsSync(fallback)) {
            filePath = fallback;
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Server error');
            return;
        }
        res.writeHead(200, {
            'Content-Type': mimeType(filePath),
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
});

staticServer.listen(appPort, '0.0.0.0', () => {
    console.log(`Local web server: http://localhost:${appPort}`);
    console.log(`API proxy target: http://127.0.0.1:${apiPort}`);
});

function shutdown(signal) {
    console.log(`Received ${signal}, shutting down...`);
    staticServer.close(() => {
        if (!apiProcess.killed) apiProcess.kill('SIGTERM');
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
