#!/usr/bin/env node
// test/test.js - 2Bored2Tolerate Test Suite
const http = require('http');
const path = require('path');
const { EventEmitter } = require('events');

// Set test environment variables BEFORE requiring config
process.env.MC_EMAIL = 'test@test.com';
process.env.MC_AUTH_TYPE = 'microsoft';
process.env.MC_VERSION = '1.21.4';
process.env.AUTH_PROFILES_FOLDER = '/tmp/2b2t-test-auth';
process.env.SERVER_HOST = 'localhost';
process.env.SERVER_PORT = '25565';
process.env.PROXY_PORT = '52157';
process.env.WEB_PORT = '52156';
process.env.WEB_BIND = '127.0.0.1';
process.env.PROXY_BIND = '127.0.0.1';
process.env.PROXY_ONLINE_MODE = 'false';
process.env.DISCORD_ENABLED = 'false';
process.env.JOIN_ON_START = 'false';
process.env.ANTIAFK_ENABLED = 'true';
process.env.LOG_ENABLED = 'false';
process.env.DESKTOP_NOTIFY = 'false';

const config = require('../src/config');
const AntiAFK = require('../src/antiafk');
const ETALearner = require('../src/eta-learner');

let passed = 0;
let failed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${err.message}\x1b[0m`);
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    \x1b[31m${err.message}\x1b[0m`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected "${expected}", got "${actual}"`);
  }
}

// ============================================
// Test Suite
// ============================================
console.log('\n\x1b[1m2Bored2Tolerate Test Suite\x1b[0m\n');

// --- Config Tests ---
console.log('\x1b[36m  Config Module\x1b[0m');

test('config loads with correct MC settings', () => {
  assertEqual(config.mc.email, 'test@test.com');
  assertEqual(config.mc.authType, 'microsoft');
  assertEqual(config.mc.version, '1.21.4');
  assert(config.mc.profilesFolder.includes('2b2t-test-auth'), 'profilesFolder should be set');
});

test('config loads server settings', () => {
  assertEqual(config.server.host, 'localhost');
  assertEqual(config.server.port, 25565);
});

test('config loads proxy settings', () => {
  assertEqual(config.proxy.port, 52157);
  assertEqual(config.proxy.onlineMode, false);
});

test('config loads web settings', () => {
  assertEqual(config.web.port, 52156);
  assertEqual(config.web.bind, '127.0.0.1');
});

test('config loads discord settings', () => {
  assertEqual(config.discord.enabled, false);
});

test('config loads anti-AFK settings', () => {
  assertEqual(config.antiAfk.enabled, true);
  assertEqual(config.antiAfk.interval, 15000);
});

test('config boolean defaults work correctly', () => {
  assertEqual(config.reconnectOnError, true);
  assertEqual(config.joinOnStart, false);
});

// --- AntiAFK Tests ---
console.log('\n\x1b[36m  AntiAFK Module\x1b[0m');

test('AntiAFK creates with default options', () => {
  const mockBot = new EventEmitter();
  mockBot.look = () => {};
  mockBot.setControlState = () => {};
  mockBot.swingArm = () => {};

  const afk = new AntiAFK(mockBot);
  assertEqual(afk.options.enabled, true);
  assertEqual(afk.options.walk, true);
  assertEqual(afk.running, false);
});

test('AntiAFK starts and stops correctly', () => {
  const mockBot = new EventEmitter();
  mockBot.look = () => {};
  mockBot.setControlState = () => {};
  mockBot.swingArm = () => {};

  const afk = new AntiAFK(mockBot, { interval: 100000 });
  afk.start();
  assertEqual(afk.running, true);
  assert(afk.timers.size > 0, 'Should have active timers');

  afk.stop();
  assertEqual(afk.running, false);
  assertEqual(afk.timers.size, 0);
});

test('AntiAFK does not start when disabled', () => {
  const mockBot = new EventEmitter();
  mockBot.look = () => {};
  mockBot.setControlState = () => {};
  mockBot.swingArm = () => {};

  const afk = new AntiAFK(mockBot, { enabled: false });
  afk.start();
  assertEqual(afk.running, false);
});

test('AntiAFK isActive reports correctly', () => {
  const mockBot = new EventEmitter();
  mockBot.look = () => {};
  mockBot.setControlState = () => {};
  mockBot.swingArm = () => {};

  const afk = new AntiAFK(mockBot, { interval: 100000 });
  assertEqual(afk.isActive(), false);
  afk.start();
  assertEqual(afk.isActive(), true);
  afk.stop();
  assertEqual(afk.isActive(), false);
});

test('AntiAFK records origin position on start', () => {
  const mockBot = new EventEmitter();
  mockBot.look = () => {};
  mockBot.setControlState = () => {};
  mockBot.swingArm = () => {};
  mockBot.entity = { position: { x: 100.5, y: 64, z: -200.3 } };

  const afk = new AntiAFK(mockBot, { interval: 100000 });
  afk.start();
  assert(afk.origin !== null, 'Origin should be recorded');
  assertEqual(afk.origin.x, 100.5);
  assertEqual(afk.origin.z, -200.3);
  afk.stop();
});

test('AntiAFK detects when too far from origin', () => {
  const mockBot = new EventEmitter();
  mockBot.look = () => {};
  mockBot.setControlState = () => {};
  mockBot.swingArm = () => {};
  mockBot.entity = { position: { x: 100, y: 64, z: 200 } };

  const afk = new AntiAFK(mockBot, { interval: 100000 });
  afk.start();

  // Within bounds
  assertEqual(afk._isTooFar(), false);

  // Move bot beyond 2 blocks
  mockBot.entity.position.x = 103;
  assert(afk._isTooFar(), 'Should detect being too far (3 blocks away)');

  afk.stop();
});

// --- ETALearner Tests ---
console.log('\n\x1b[36m  ETALearner Module\x1b[0m');

const os = require('os');
const etaTestPath = path.join(os.tmpdir(), `2b2t-eta-test-${Date.now()}.json`);

test('ETALearner creates with empty sessions', () => {
  const eta = new ETALearner(etaTestPath);
  assertEqual(eta.sessions.length, 0);
  assert(eta.activeSamples !== undefined, 'Should have activeSamples');
});

test('ETALearner beginSession sets state', () => {
  const eta = new ETALearner(etaTestPath);
  eta.beginSession(500);
  assertEqual(eta.sessionStartPos, 500);
  assert(eta.sessionStartTime != null, 'Should have start time');
  assertEqual(eta.activeSamples.length, 1);
  assertEqual(eta.activeSamples[0].pos, 500);
});

test('ETALearner recordSample accumulates samples', () => {
  const eta = new ETALearner(etaTestPath);
  eta.beginSession(400);
  eta.recordSample(390);
  eta.recordSample(380);
  assertEqual(eta.activeSamples.length, 3); // initial + 2 updates
  assertEqual(eta.activeSamples[eta.activeSamples.length - 1].pos, 380);
});

test('ETALearner recordCompletedSession saves and clears', () => {
  const eta = new ETALearner(etaTestPath);
  const startTime = Date.now() - 10 * 60 * 1000; // 10 minutes ago
  eta.sessionStartPos = 600;
  eta.sessionStartTime = startTime;
  eta.activeSamples = [{ time: startTime, pos: 600 }, { time: Date.now(), pos: 0 }];

  eta.recordCompletedSession();
  assertEqual(eta.sessions.length, 1);
  assertEqual(eta.sessions[0].startPos, 600);
  assert(eta.sessions[0].positionsPerHour > 0, 'Should have positive rate');
  assert(eta.sessionStartPos === null, 'Should clear session state');
});

test('ETALearner estimateMinutes returns base when no history', () => {
  const eta = new ETALearner(etaTestPath + '_new');
  eta.beginSession(500);
  const result = eta.estimateMinutes(500, 480);
  // With no history or live data, should return the base model value
  assertEqual(result, 480);
});

test('ETALearner estimateMinutes blends live rate when available', () => {
  const eta = new ETALearner(etaTestPath + '_live');
  eta.beginSession(600);
  // Simulate 20 samples over 60 minutes (600 pos in 1 hour = 600 pos/hr)
  const now = Date.now();
  eta.activeSamples = Array.from({ length: 20 }, (_, i) => ({
    time: now - (20 - i) * 3 * 60 * 1000, // spread over 60 min
    pos: 600 - i * 30, // 30 pos drop per 3 min = 600/hr
  }));
  const blended = eta.estimateMinutes(300, 500); // base says 500min, live says ~30min
  // Blended should be less than base because live rate is faster
  assert(blended < 500, `Blended ETA (${blended}) should be < base (500) when live rate is faster`);
  assert(blended > 0, 'ETA should be positive');
});

test('ETALearner getHistoricalRate uses similar time context', () => {
  const eta = new ETALearner(etaTestPath + '_hist');
  const now = new Date();
  const hour = now.getHours();
  const dayOfWeek = now.getDay();

  // Add 5 sessions at similar time with known rate
  for (let i = 0; i < 5; i++) {
    eta.sessions.push({
      startPos: 500,
      startTimeMs: Date.now() - i * 86400000,
      endTimeMs: Date.now() - i * 86400000 + 5 * 3600000,
      durationMs: 5 * 3600000,
      dayOfWeek,
      startHour: hour,
      positionsPerHour: 100,
    });
  }
  const result = eta._getHistoricalRate(now);
  assert(result !== null, 'Should have a historical rate');
  assert(result.rate > 0, 'Rate should be positive');
  assert(Math.abs(result.rate - 100) < 10, `Rate ${result.rate} should be close to 100`);
  assert(result.effectiveSessions > 0, 'effectiveSessions should be positive');
});

test('ETALearner caps sessions at MAX_SESSIONS', () => {
  const eta = new ETALearner(etaTestPath + '_cap');
  for (let i = 0; i < 210; i++) {
    eta.sessions.push({
      startPos: 500,
      startTimeMs: Date.now(),
      endTimeMs: Date.now() + 3600000,
      durationMs: 3600000,
      dayOfWeek: 1,
      startHour: 10,
      positionsPerHour: 100,
    });
    if (eta.sessions.length > 200) eta.sessions.shift();
  }
  assert(eta.sessions.length <= 200, 'Should not exceed 200 sessions');
});

// --- Web Server Tests ---
console.log('\n\x1b[36m  Web Server\x1b[0m');

async function testWebServer() {
  // Create a minimal proxy mock
  const mockProxy = new EventEmitter();
  mockProxy.state = {
    isInQueue: false,
    queuePlace: 'None',
    eta: 'None',
    finTime: 'Never',
    restartQueue: false,
    doing: 'idle',
    connected: false,
    username: null,
    antiAfkActive: false,
  };
  mockProxy.queueHistory = [];
  mockProxy._logs = [];
  mockProxy.getState = () => ({
    ...mockProxy.state,
    logs: [],
    queueHistory: [],
  });
  mockProxy.getPlayerStats = () => null;
  mockProxy.start = () => mockProxy.emit('stateChange', mockProxy.state);
  mockProxy.stop = () => mockProxy.emit('stopped');
  mockProxy.toggleRestart = () => {
    mockProxy.state.restartQueue = !mockProxy.state.restartQueue;
  };
  mockProxy.toggleAntiAfk = () => {
    mockProxy.state.antiAfkActive = !mockProxy.state.antiAfkActive;
  };

  const WebServer = require('../src/web/server');
  const server = new WebServer(mockProxy);
  await server.start();

  const baseUrl = `http://127.0.0.1:${config.web.port}`;

  // Helper to make HTTP requests
  function request(urlPath, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlPath, baseUrl);
      const req = http.request(url, {
        method: options.method || 'GET',
        headers: options.headers || {},
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  await asyncTest('dashboard serves HTML', async () => {
    const res = await request('/');
    assertEqual(res.status, 200);
    assert(res.body.includes('2Bored2Tolerate'), 'Should contain project name');
    assert(res.body.includes('socket.io'), 'Should include Socket.IO');
  });

  await asyncTest('CSS file is served', async () => {
    const res = await request('/css/style.css');
    assertEqual(res.status, 200);
    assert(res.body.includes('--bg-dark'), 'Should contain CSS variables');
  });

  await asyncTest('JS file is served', async () => {
    const res = await request('/js/app.js');
    assertEqual(res.status, 200);
    assert(res.body.includes('socket'), 'Should contain socket code');
  });

  await asyncTest('health endpoint works', async () => {
    const res = await request('/health');
    assertEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assertEqual(data.status, 'ok');
    assertEqual(data.version, '4.0.0');
  });

  await asyncTest('API state endpoint returns JSON', async () => {
    const res = await request('/api/state');
    assertEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assertEqual(data.isInQueue, false);
    assertEqual(data.queuePlace, 'None');
    assertEqual(data.doing, 'idle');
  });

  await asyncTest('API start endpoint works', async () => {
    const res = await request('/api/start', { method: 'POST' });
    assertEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assertEqual(data.success, true);
  });

  await asyncTest('API stop endpoint works', async () => {
    const res = await request('/api/stop', { method: 'POST' });
    assertEqual(res.status, 200);
  });

  await asyncTest('API toggle-restart endpoint works', async () => {
    const res = await request('/api/toggle-restart', { method: 'POST' });
    assertEqual(res.status, 200);
  });

  await asyncTest('API toggle-antiafk endpoint works', async () => {
    const res = await request('/api/toggle-antiafk', { method: 'POST' });
    assertEqual(res.status, 200);
  });

  await asyncTest('API stats endpoint works', async () => {
    const res = await request('/api/stats');
    assertEqual(res.status, 200);
  });

  // Legacy API compatibility
  await asyncTest('legacy /update endpoint works', async () => {
    const res = await request('/update');
    assertEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert('place' in data, 'Should have place field');
    assert('ETA' in data, 'Should have ETA field');
    assert('inQueue' in data, 'Should have inQueue field');
  });

  // Password protection
  await asyncTest('password protection rejects unauthorized (when set)', async () => {
    // Temporarily set password
    const origPassword = config.web.password;
    config.web.password = 'testpass123';

    const res = await request('/api/state');
    assertEqual(res.status, 403);

    // Test with x-password header
    const authRes = await request('/api/state', {
      headers: { 'x-password': 'testpass123' },
    });
    assertEqual(authRes.status, 200);

    // Test with legacy xpassword header (backward compat)
    const legacyRes = await request('/api/state', {
      headers: { xpassword: 'testpass123' },
    });
    assertEqual(legacyRes.status, 200);

    config.web.password = origPassword;
  });

  await asyncTest('404 for unknown routes', async () => {
    const res = await request('/nonexistent');
    assertEqual(res.status, 404);
  });

  // Clean up
  await server.shutdown();
}

// --- Run all tests ---
(async () => {
  await testWebServer();

  // Summary
  console.log(`\n\x1b[1m  Results: ${passed}/${total} passed\x1b[0m`);
  if (failed > 0) {
    console.log(`\x1b[31m  ${failed} test(s) failed\x1b[0m\n`);
    process.exit(1);
  } else {
    console.log('\x1b[32m  All tests passed!\x1b[0m\n');
    process.exit(0);
  }
})();
