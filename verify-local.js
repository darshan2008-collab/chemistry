const http = require('http');

function request(path, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 10004,
        path,
        method,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let out = '';
        res.on('data', (d) => {
          out += d;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode, body: out });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const health = await request('/health');
  const apiHealth = await request('/api/health');
  const login = await request('/api/auth/student/login', 'POST', {
    regNo: '927625BAD002',
    password: '927625BAD002',
  });

  console.log('health:', health.status, health.body);
  console.log('apiHealth:', apiHealth.status, apiHealth.body);
  console.log('studentLogin:', login.status, login.body);
})();
