/* global io */

// ============================================================
// State
// ============================================================
let socket        = null;
let currentState  = {};
let currentPassword = '';
let logsPopulated = false;

// Chart
let chartTimeframe = 'all';
let chartPoints    = [];
let resizeTimer    = null;

// ============================================================
// DOM refs
// ============================================================
const $ = (id) => document.getElementById(id);

const loginScreen   = $('loginScreen');
const loginSub      = $('loginSub');
const loginForm     = $('loginForm');
const loginPassword = $('loginPassword');
const loginError    = $('loginError');
const app           = $('app');
const wsDot         = $('wsDot');
const statusChip    = $('statusChip');
const queuePosition = $('queuePosition');
const etaValue      = $('etaValue');
const etaFinish     = $('etaFinish');
const startBtn      = $('startBtn');
const stopBtn       = $('stopBtn');
const antiAfkToggle = $('antiAfkToggle');
const restartToggle = $('restartToggle');
const playerCol     = $('playerCol');
const healthBar     = $('healthBar');
const hungerBar     = $('hungerBar');
const healthValue   = $('healthValue');
const hungerValue   = $('hungerValue');
const chartSection  = $('chartSection');
const chartTimespan = $('chartTimespan');
const logContainer  = $('logContainer');
const stopDialog    = $('stopDialog');
const toastContainer = $('toastContainer');

// ============================================================
// Login & connection
// ============================================================
function handleLogin(e) {
  e.preventDefault();
  currentPassword = loginPassword.value;
  loginError.textContent = '';
  connect();
  return false;
}
window.handleLogin = handleLogin;

function showApp() {
  loginScreen.hidden = true;
  app.hidden = false;
}

function showLogin(errorMsg) {
  loginSub.textContent = errorMsg ? 'password required' : 'connecting...';
  loginForm.hidden = false;
  loginScreen.hidden = false;
  app.hidden = true;
  if (errorMsg) {
    loginError.textContent = errorMsg;
    loginPassword.focus();
  }
}

function connect() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }

  socket = io({
    auth: { password: currentPassword },
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
  });

  socket.on('connect', () => {
    wsDot.classList.add('connected');
    wsDot.title = 'Connected';
    logsPopulated = false;
    showApp();
  });

  socket.on('disconnect', () => {
    wsDot.classList.remove('connected');
    wsDot.title = 'Disconnected';
  });

  socket.on('connect_error', (err) => {
    wsDot.classList.remove('connected');
    if (err.message === 'Authentication failed') {
      socket.disconnect();
      socket = null;
      showLogin('Incorrect password.');
    }
  });

  socket.on('state', (state) => {
    currentState = state;
    renderState(state);
  });

  socket.on('log', addLogEntry);

  socket.on('queueFinished', () => showToast('Queue finished — connect to play!', 'success'));
  socket.on('stopped',       () => showToast('Queue stopped', 'warning'));
}

// ============================================================
// Render state
// ============================================================
function renderState(state) {
  renderStatus(state.doing);
  renderPosition(state);
  renderETA(state);
  renderButtons(state);
  renderToggles(state);
  renderPlayerStats(state);
  renderChart(state);

  if (state.version) {
    const v = `v${state.version}`;
    $('appVersion').textContent = v;
    $('footerVersion').textContent = `2Bored2Tolerate ${v}`;
  }

  if (state.proxyAddress) {
    $('proxyAddress').textContent = state.proxyAddress;
  }

  if (state.logs && !logsPopulated) {
    logsPopulated = true;
    state.logs.forEach((entry) => addLogEntry(entry, false));
  }
}

function renderStatus(doing) {
  const map = {
    idle:         { text: 'IDLE',           key: 'idle' },
    auth:         { text: 'AUTHENTICATING', key: 'auth' },
    queue:        { text: 'IN QUEUE',       key: 'queue' },
    connected:    { text: 'CONNECTED',      key: 'connected' },
    reconnecting: { text: 'RECONNECTING',   key: 'reconnecting' },
  };
  const s = map[doing] || map.idle;
  statusChip.textContent = s.text;
  statusChip.dataset.status = s.key;
}

function renderPosition(state) {
  const pos = state.queuePlace;
  let text = '—';
  let cls  = '';

  if (pos === 'DONE' || state.connected) {
    text = 'DONE';
    cls  = 'is-connected';
  } else if (pos !== 'None' && pos != null) {
    text = '#' + Number(pos).toLocaleString();
    cls  = 'is-queuing';
  }

  queuePosition.textContent = text;
  queuePosition.className = 'pos-num' + (cls ? ' ' + cls : '');

  document.title = (state.isInQueue && pos !== 'None')
    ? `#${Number(pos).toLocaleString()} · 2B2T Queue`
    : '2Bored2Tolerate';
}

function renderETA(state) {
  etaValue.textContent = state.eta || '—';
  if (state.finTime && state.finTime !== 'Never') {
    try {
      const t = new Date(state.finTime);
      etaFinish.textContent = 'done ~' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { etaFinish.textContent = ''; }
  } else {
    etaFinish.textContent = '';
  }
}

function renderButtons(state) {
  startBtn.disabled = !!state.isInQueue;
  stopBtn.disabled  = !state.isInQueue;
}

function renderToggles(state) {
  antiAfkToggle.checked = state.antiAfkActive || false;
  restartToggle.checked = state.restartQueue   || false;
}

function renderPlayerStats(state) {
  if (state.connected && state.health != null) {
    const hp = Math.ceil(state.health / 2);
    const fd = Math.floor((state.food || 0) / 2);
    healthBar.style.width = `${(hp / 10) * 100}%`;
    hungerBar.style.width = `${(fd / 10) * 100}%`;
    healthValue.textContent = hp === 0 ? 'dead'  : `${hp}/10`;
    hungerValue.textContent = fd === 0 ? 'starv' : `${fd}/10`;
    playerCol.hidden = false;
  } else {
    playerCol.hidden = true;
  }
}

function renderChart(state) {
  if (!state.queueHistory || state.queueHistory.length < 2) return;
  chartSection.hidden = false;
  const filtered = filterHistory(state.queueHistory, chartTimeframe);
  drawChart(filtered);
  updateChartSpan(filtered, chartTimeframe);
}

// ============================================================
// Commands
// ============================================================
function sendCommand(cmd) {
  if (!socket?.connected) {
    showToast('Not connected to server', 'error');
    return;
  }
  socket.emit(cmd);
}
window.sendCommand = sendCommand;

function handleStop() {
  stopDialog.hidden = false;
}
window.handleStop = handleStop;

function cancelStop() {
  stopDialog.hidden = true;
}
window.cancelStop = cancelStop;

function confirmStop() {
  stopDialog.hidden = true;
  sendCommand('stop');
}
window.confirmStop = confirmStop;

// Close dialog when clicking the backdrop
stopDialog.addEventListener('click', (e) => {
  if (e.target === stopDialog) cancelStop();
});

// ============================================================
// Log
// ============================================================
function addLogEntry(entry, scroll = true) {
  const empty = logContainer.querySelector('.log-empty');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = `log-line ${entry.level || 'info'}`;

  const ts = document.createElement('span');
  ts.className = 'log-ts';
  ts.textContent = new Date(entry.time).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });

  const msg = document.createElement('span');
  msg.className = 'log-msg';
  msg.textContent = entry.message;

  row.append(ts, msg);
  logContainer.appendChild(row);

  while (logContainer.children.length > 200) {
    logContainer.removeChild(logContainer.firstChild);
  }

  if (scroll) logContainer.scrollTop = logContainer.scrollHeight;
}

function clearLogs() {
  logContainer.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'log-empty';
  empty.textContent = 'Log cleared.';
  logContainer.appendChild(empty);
}
window.clearLogs = clearLogs;

// ============================================================
// Chart
// ============================================================
function filterHistory(history, tf) {
  if (!tf || tf === 'all') return history;
  const windowMs = { '15m': 15 * 60000, '30m': 30 * 60000, '1h': 60 * 60000 }[tf];
  if (!windowMs) return history;
  return history.filter((p) => p.time >= Date.now() - windowMs);
}

function setChartTimeframe(tf) {
  chartTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach((b) => {
    b.classList.toggle('tf-active', b.dataset.tf === tf);
  });
  if (currentState.queueHistory) {
    const filtered = filterHistory(currentState.queueHistory, tf);
    drawChart(filtered);
    updateChartSpan(filtered, tf);
  }
}
window.setChartTimeframe = setChartTimeframe;

function updateChartSpan(history, tf) {
  if (!chartTimespan) return;
  const label = { '15m': 'last 15m', '30m': 'last 30m', '1h': 'last 1h' }[tf] || '';

  if (history.length < 2) {
    chartTimespan.textContent = label ? `${label} · no data` : '';
    return;
  }

  const dur  = history[history.length - 1].time - history[0].time;
  const s    = Math.floor(dur / 1000);
  const h    = Math.floor(s / 3600);
  const m    = Math.floor((s % 3600) / 60);
  const dStr = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;

  const fmt   = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const range = `${fmt(history[0].time)} – ${fmt(history[history.length - 1].time)} (${dStr})`;
  chartTimespan.textContent = label ? `${label} · ${range}` : range;
}

function drawChart(history) {
  const canvas = $('queueChart');
  if (!canvas) return;

  const ctx  = canvas.getContext('2d');
  const dpr  = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();

  canvas.width        = rect.width * dpr;
  canvas.height       = 100 * dpr;
  canvas.style.width  = `${rect.width}px`;
  canvas.style.height = '100px';

  const W   = canvas.width;
  const H   = canvas.height;
  const pad = { t: 10 * dpr, r: 10 * dpr, b: 22 * dpr, l: 44 * dpr };
  const pW  = W - pad.l - pad.r;
  const pH  = H - pad.t - pad.b;

  ctx.clearRect(0, 0, W, H);

  if (history.length < 2) {
    chartPoints = [];
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = `${12 * dpr}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no data for this timeframe', W / 2, H / 2);
    return;
  }

  const positions = history.map((p) => p.position);
  const maxPos    = Math.max(...positions) * 1.1 || 1;

  // Grid lines + Y labels
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth   = dpr;
  ctx.fillStyle   = 'rgba(255,255,255,0.22)';
  ctx.font        = `${9 * dpr}px monospace`;
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 3; i++) {
    const y   = pad.t + (pH / 3) * i;
    const val = Math.round(maxPos * (1 - i / 3));

    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();

    ctx.fillText(
      val >= 1000 ? `${(val / 1000).toFixed(1)}k` : String(val),
      pad.l - 5 * dpr,
      y
    );
  }

  // Compute and store points for hover
  chartPoints = history.map((point, i) => ({
    x: pad.l + (i / (history.length - 1)) * pW,
    y: pad.t + (1 - point.position / maxPos) * pH,
    point,
  }));

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = '#4ade80';
  ctx.lineWidth   = 1.5 * dpr;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  chartPoints.forEach(({ x, y }, i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.stroke();

  // Draw fill as a separate path (avoids reusing stroke path)
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + pH);
  grad.addColorStop(0, 'rgba(74,222,128,0.10)');
  grad.addColorStop(1, 'rgba(74,222,128,0)');

  ctx.beginPath();
  chartPoints.forEach(({ x, y }, i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
  ctx.lineTo(chartPoints[chartPoints.length - 1].x, pad.t + pH);
  ctx.lineTo(chartPoints[0].x, pad.t + pH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // End-point dot
  const last = chartPoints[chartPoints.length - 1];
  ctx.beginPath();
  ctx.arc(last.x, last.y, 3.5 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = '#4ade80';
  ctx.fill();
}

// ============================================================
// Chart hover tooltip
// ============================================================
function setupChartHover() {
  const canvas  = $('queueChart');
  const tooltip = $('chartTooltip');
  if (!canvas || !tooltip) return;

  canvas.addEventListener('mousemove', (e) => {
    if (chartPoints.length < 2) return;

    const rect   = canvas.getBoundingClientRect();
    const dpr    = window.devicePixelRatio || 1;
    const mouseX = (e.clientX - rect.left) * dpr;

    let nearest = chartPoints[0];
    let minDist = Infinity;
    for (const cp of chartPoints) {
      const d = Math.abs(cp.x - mouseX);
      if (d < minDist) { minDist = d; nearest = cp; }
    }

    const cssX       = nearest.x / dpr;
    const clampedX   = Math.max(40, Math.min(rect.width - 40, cssX));
    tooltip.style.left = `${clampedX}px`;

    // Build tooltip content safely (no innerHTML)
    const posSpan = document.createElement('span');
    posSpan.className   = 'chart-tip-pos';
    posSpan.textContent = `#${Number(nearest.point.position).toLocaleString()}`;

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'chart-tip-time';
    timeSpan.textContent = new Date(nearest.point.time).toLocaleTimeString([], {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    tooltip.replaceChildren(posSpan, timeSpan);
    tooltip.classList.add('visible');
  });

  canvas.addEventListener('mouseleave', () => tooltip.classList.remove('visible'));
}

// ============================================================
// Toasts
// ============================================================
function showToast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className   = `toast ${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toast-out 0.18s ease forwards';
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, 3000);
}

// ============================================================
// Proxy address — click to copy
// ============================================================
const proxyAddrEl = $('proxyAddress');
if (proxyAddrEl) {
  proxyAddrEl.addEventListener('click', () => {
    navigator.clipboard?.writeText(proxyAddrEl.textContent).then(() => {
      showToast('Address copied', 'success');
    }).catch(() => {});
  });
}

// ============================================================
// Init
// ============================================================
connect();
setupChartHover();

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentState.queueHistory?.length > 1) {
      const filtered = filterHistory(currentState.queueHistory, chartTimeframe);
      drawChart(filtered);
    }
  }, 120);
});
