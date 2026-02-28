// Dashboard Frontend - Socket.IO based real-time updates
/* global io */

// ============================================
// State
// ============================================
let socket = null;
let currentState = {};
let logs = [];
let currentPassword = '';
let authenticated = false;

// ============================================
// DOM Elements
// ============================================
const $ = (sel) => document.querySelector(sel);
const loginOverlay = $('#loginOverlay');
const loginForm = $('#loginForm');
const loginPassword = $('#loginPassword');
const loginError = $('#loginError');
const mainContainer = $('#mainContainer');
const connectionDot = $('#connectionDot');
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const queuePosition = $('#queuePosition');
const etaValue = $('#etaValue');
const etaFinish = $('#etaFinish');
const startBtn = $('#startBtn');
const stopBtn = $('#stopBtn');
const antiAfkToggle = $('#antiAfkToggle');
const restartToggle = $('#restartToggle');
const logContainer = $('#logContainer');
const chartCard = $('#chartCard');
const statsCard = $('#statsCard');
const healthBar = $('#healthBar');
const hungerBar = $('#hungerBar');
const healthValue = $('#healthValue');
const hungerValue = $('#hungerValue');
const chartTimespan = $('#chartTimespan');

// ============================================
// Login / Auth
// ============================================

/** Handle login form submission */
function handleLogin(e) {
  e.preventDefault();
  currentPassword = loginPassword.value;
  connect();
  return false;
}
window.handleLogin = handleLogin;

/** Show the main dashboard, hide login */
function showDashboard() {
  authenticated = true;
  loginOverlay.style.display = 'none';
  mainContainer.style.display = '';
}

/** Show login screen with optional error */
function showLogin(errorMsg) {
  authenticated = false;
  loginOverlay.style.display = 'flex';
  mainContainer.style.display = 'none';
  if (errorMsg) {
    loginError.textContent = errorMsg;
    loginError.style.display = 'block';
    loginPassword.focus();
  }
}

// ============================================
// Socket.IO Connection
// ============================================
function connect() {
  // Disconnect existing socket
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
    connectionDot.classList.add('connected');
    connectionDot.title = 'Connected to server';
    // If we connected successfully, we're authenticated
    showDashboard();
  });

  socket.on('disconnect', () => {
    connectionDot.classList.remove('connected');
    connectionDot.title = 'Disconnected from server';
  });

  socket.on('connect_error', (err) => {
    connectionDot.classList.remove('connected');
    if (err.message === 'Authentication failed') {
      // Password is required and wrong - show login
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      showLogin('Invalid password. Please try again.');
    }
  });

  // Handle state updates
  socket.on('state', (state) => {
    currentState = state;
    updateUI(state);
  });

  // Handle log entries
  socket.on('log', (entry) => {
    addLogEntry(entry);
  });

  // Handle queue finished
  socket.on('queueFinished', () => {
    showToast('Queue finished! Connect to play.', 'success');
  });

  // Handle stopped
  socket.on('stopped', () => {
    showToast('Queue stopped', 'warning');
  });
}

// ============================================
// UI Updates
// ============================================
function updateUI(state) {
  // Status
  updateStatus(state.doing);

  // Queue position
  queuePosition.textContent = state.queuePlace === 'None' ? 'None' : `#${state.queuePlace}`;
  if (state.queuePlace === 'DONE') {
    queuePosition.textContent = 'DONE';
    queuePosition.style.color = '#00ff88';
  } else if (state.queuePlace !== 'None') {
    queuePosition.style.color = '#00ff88';
  } else {
    queuePosition.style.color = '#94a3b8';
  }

  // ETA
  etaValue.textContent = state.eta || 'None';
  if (state.finTime && state.finTime !== 'Never') {
    try {
      const finDate = new Date(state.finTime);
      etaFinish.textContent = `~${finDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      etaFinish.textContent = '';
    }
  } else {
    etaFinish.textContent = '';
  }

  // Title
  if (state.isInQueue && state.queuePlace !== 'None') {
    document.title = `#${state.queuePlace} - 2Bored2Tolerate`;
  } else {
    document.title = '2Bored2Tolerate';
  }

  // Toggles
  antiAfkToggle.checked = state.antiAfkActive || false;
  restartToggle.checked = state.restartQueue || false;

  // Buttons
  updateButtons(state);

  // Player stats
  if (state.connected && state.health != null) {
    statsCard.style.display = '';
    const hp = Math.ceil(state.health / 2);
    const food = Math.floor((state.food || 0) / 2);
    healthBar.style.width = `${(hp / 10) * 100}%`;
    hungerBar.style.width = `${(food / 10) * 100}%`;
    healthValue.textContent = hp === 0 ? 'DEAD' : `${hp}/10`;
    hungerValue.textContent = food === 0 ? 'STARVING' : `${food}/10`;
  } else {
    statsCard.style.display = 'none';
  }

  // Queue chart
  if (state.queueHistory && state.queueHistory.length > 1) {
    chartCard.style.display = '';
    drawChart(state.queueHistory);
    updateChartTimespan(state.queueHistory);
  }

  // Version
  if (state.version) {
    const ver = `v${state.version}`;
    const appVerEl = document.getElementById('appVersion');
    const footerVerEl = document.getElementById('footerVersion');
    if (appVerEl) appVerEl.textContent = ver;
    if (footerVerEl) footerVerEl.textContent = `2Bored2Tolerate ${ver}`;
  }

  // Proxy address for connection guide
  if (state.proxyAddress) {
    const addrEl = document.getElementById('proxyAddress');
    if (addrEl) addrEl.textContent = state.proxyAddress;
  }

  // Populate logs if provided
  if (state.logs && logs.length === 0) {
    state.logs.forEach((entry) => addLogEntry(entry, false));
  }
}

function updateStatus(doing) {
  const statusMap = {
    idle: { text: 'Idle', class: 'idle' },
    auth: { text: 'Authenticating', class: 'auth' },
    queue: { text: 'In Queue', class: 'queuing' },
    connected: { text: 'Connected', class: 'connected' },
    reconnecting: { text: 'Reconnecting', class: 'reconnecting' },
  };

  const info = statusMap[doing] || statusMap.idle;
  statusText.textContent = info.text;
  statusDot.className = `status-dot ${info.class}`;
}

function updateButtons(state) {
  if (state.isInQueue) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

// ============================================
// Commands
// ============================================
function sendCommand(cmd) {
  if (!socket?.connected) {
    showToast('Not connected to server', 'error');
    return;
  }

  if (cmd === 'stop') {
    if (!confirm('Are you sure you want to stop queueing?')) return;
  }

  socket.emit(cmd);
}

// Make sendCommand available globally for onclick handlers
window.sendCommand = sendCommand;

// ============================================
// Activity Log
// ============================================
function addLogEntry(entry, scroll = true) {
  logs.push(entry);
  if (logs.length > 200) logs.shift();

  // Remove empty state message
  const empty = logContainer.querySelector('.log-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `log-entry ${entry.level || 'info'}`;

  const time = new Date(entry.time);
  const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  div.innerHTML = `
    <span class="log-time">${timeStr}</span>
    <span class="log-message">${escapeHtml(entry.message)}</span>
  `;

  logContainer.appendChild(div);

  // Limit DOM nodes
  while (logContainer.children.length > 200) {
    logContainer.removeChild(logContainer.firstChild);
  }

  if (scroll) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

function clearLogs() {
  logs = [];
  logContainer.innerHTML = '<div class="log-empty">Log cleared.</div>';
}

// Make clearLogs available globally
window.clearLogs = clearLogs;

// ============================================
// Chart Time Period
// ============================================
function updateChartTimespan(history) {
  if (!chartTimespan || history.length < 2) {
    if (chartTimespan) chartTimespan.textContent = '';
    return;
  }

  const firstTime = history[0].time;
  const lastTime = history[history.length - 1].time;
  const durationMs = lastTime - firstTime;

  // Format duration
  const totalSec = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);

  let durationStr;
  if (hours > 0) {
    durationStr = `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    durationStr = `${minutes}m`;
  } else {
    durationStr = `${totalSec}s`;
  }

  // Format time range
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  chartTimespan.textContent = `${fmt(firstTime)} - ${fmt(lastTime)} (${durationStr})`;
}

// ============================================
// Queue Chart (Canvas)
// ============================================
function drawChart(history) {
  const canvas = document.getElementById('queueChart');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * 2; // Retina
  canvas.height = 240; // Retina
  canvas.style.width = rect.width + 'px';
  canvas.style.height = '120px';

  const w = canvas.width;
  const h = canvas.height;
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  // Clear
  ctx.clearRect(0, 0, w, h);

  if (history.length < 2) return;

  const positions = history.map((h) => h.position);
  let maxPos = Math.max(...positions) * 1.1;
  if (maxPos === 0) maxPos = 1;
  const minPos = 0;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.top + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(w - padding.right, y);
    ctx.stroke();

    // Labels
    const val = Math.round(maxPos - (maxPos / 4) * i);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '18px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(val.toString(), padding.left - 8, y + 5);
  }

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  history.forEach((point, i) => {
    const x = padding.left + (i / (history.length - 1)) * plotW;
    const y = padding.top + (1 - (point.position - minPos) / (maxPos - minPos)) * plotH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Gradient fill under line
  const gradient = ctx.createLinearGradient(0, padding.top, 0, h - padding.bottom);
  gradient.addColorStop(0, 'rgba(0,255,136,0.15)');
  gradient.addColorStop(1, 'rgba(0,255,136,0)');

  ctx.lineTo(w - padding.right, h - padding.bottom);
  ctx.lineTo(padding.left, h - padding.bottom);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // Current position dot
  if (history.length > 0) {
    const last = history[history.length - 1];
    const x = w - padding.right;
    const y = padding.top + (1 - (last.position - minPos) / (maxPos - minPos)) * plotH;

    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,255,136,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

// ============================================
// Utilities
// ============================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ============================================
// Initialize
// ============================================
// Try connecting without password first.
// If the server requires a password, it will reject and we'll show the login screen.
connect();

// Resize chart on window resize
window.addEventListener('resize', () => {
  if (currentState.queueHistory?.length > 1) {
    drawChart(currentState.queueHistory);
  }
});
