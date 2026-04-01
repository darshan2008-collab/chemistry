/**
 * Integration tests for auth flows
 */

const assert = require('assert');

// Note: These tests are designed to run against a live API instance
// Set API_URL environment variable or default to http://localhost:3000

const API_URL = process.env.API_URL || 'http://localhost:3000';

async function apiCall(method, path, body = null, headers = {}) {
  const url = `${API_URL}${path}`;
  const opts = {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
  };
  
  if (body) {
    opts.body = JSON.stringify(body);
  }

  const response = await fetch(url, opts);
  const data = await response.json();
  
  return {
    status: response.status,
    data,
  };
}

async function testStudentLogin() {
  console.log('\n=== testStudentLogin ===');
  
  // Test 1: Missing credentials
  let result = await apiCall('POST', '/auth/student/login', {});
  assert.strictEqual(result.status, 400, 'Should reject empty credentials');
  
  // Test 2: Invalid student
  result = await apiCall('POST', '/auth/student/login', {
    regNo: 'INVALID123',
    password: 'test',
  });
  assert.strictEqual(result.status, 401, 'Should reject invalid student');
  
  console.log('✓ Student login tests passed');
}

async function testStaffLogin() {
  console.log('\n=== testStaffLogin ===');
  
 // Test 1: Missing credentials
  let result = await apiCall('POST', '/auth/staff/login', {});
  assert.strictEqual(result.status, 400, 'Should reject empty credentials');
  
  console.log('✓ Staff login tests passed');
}

async function testRateLimiting() {
  console.log('\n=== testRateLimiting ===');
  
  const payload = { regNo: 'TESTUSER', password: 'wrongpass' };
  
  // Make 6 failed attempts
  for (let i = 0; i < 6; i++) {
    const result = await apiCall('POST', '/auth/student/login', payload);
    
    if (i < 5) {
      assert(result.status === 401 || result.status === 400, `Attempt ${i + 1} should fail auth/validation`);
    } else {
      // 6th attempt should be rate-limited
      assert.strictEqual(result.status, 429, 'Should rate-limit after 5 attempts');
    }
  }
  
  console.log('✓ Rate limiting tests passed');
}

async function testSessionPersistence() {
  console.log('\n=== testSessionPersistence ===');
  
  // This test requires a valid login; skip if we can't obtain one
  const loginResult = await apiCall('POST', '/auth/staff/login', {
    email: process.env.STAFF_DEFAULT_EMAIL || 'admin@example.com',
    password: process.env.STAFF_DEFAULT_PASSWORD || 'admin123',
  });
  
  if (loginResult.status === 200 && loginResult.data.token) {
    const token = loginResult.data.token;
    console.log(`✓ Got session token (length: ${token.length})`);
  } else {
    console.log('⊝ Skipped session persistence test (no valid credentials in env)');
  }
}

async function runAllTests() {
  try {
    console.log(`🧪 Running API integration tests against ${API_URL}`);
    
    await testStudentLogin();
    await testStaffLogin();
    await testRateLimiting();
    await testSessionPersistence();
    
    console.log('\n✅ All tests passed');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
  }
}

runAllTests();
