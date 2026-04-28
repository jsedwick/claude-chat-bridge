// State
let currentSessionId = null;
const streamingSessions = new Set(); // track which sessions are actively streaming
// When the user returns to a still-streaming session, switchSession() takes over
// rendering via a fresh reconnect subscription. The originating sendMessage()'s
// processEvent is silenced for any session in this set so it doesn't double-render.
const hijackedStreams = new Set();
// Per-session AbortController for an in-flight replaySessionStream(). Used so
// switchSession() can cancel a stale replay (whose closure-held assistantEl
// would point at the cleared DOM after restoreMessages) before starting a
// fresh one.
const activeReplayControllers = new Map();
// Monotonic counter incremented on every switchSession() call. Lets post-await
// code bail when a newer switch has superseded it — prevents concurrent
// switchSession() calls from racing each other's restoreMessages/render steps
// (symptoms: dropped tool indicators, double messages, output that only
// reappears after refresh).
let switchSessionSeq = 0;
// Per-session token for restoreMessages(). Two concurrent restoreMessages()
// calls for the same session both clear the DOM at the top, then both render
// loops appendChild into messagesEl — producing duplicate messages. The
// currentSessionId/switchSessionSeq guards don't catch this because
// currentSessionId stays the same across rapid same-session clicks. This
// token lets a newer call invalidate any older in-flight call.
const restoreMessageTokens = new Map();
const sessionInputDrafts = new Map(); // preserve input text per session
const pendingMessages = new Map(); // queued messages per session (sent when stream completes)
let currentMode = (() => {
  const saved = localStorage.getItem('chat-bridge-mode');
  return (saved === 'work' || saved === 'personal') ? saved : 'work';
})();
let pendingPermissionId = null;
let permissionPollInterval = null;
const permissionQueue = []; // queue for parallel permission requests
let pendingPermissionSessionId = null; // which session the current permission dialog is for
const permissionBlockedSessions = new Set(); // sessions waiting on permission approval
let versionData = null; // cached version check data
let serverPollingActive = false; // prevent duplicate health-check polls

// Resilient fetch with timeout, response validation, and optional retry
async function fetchWithRetry(url, options = {}, { timeout = 10000, retries = 0, backoff = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoff * Math.pow(2, attempt)));
      }
    }
  }
  throw lastError;
}

// Message history (server-backed)
async function restoreMessages(sessionId, sessionMeta, opts = {}) {
  // upToLastUser: stop rendering after the latest user message. Used when the
  // session is still streaming and a live reconnect will render the in-progress
  // assistant turn — avoids double-rendering text/tools that were flushed to
  // persistence at tool_use boundaries.
  const { upToLastUser = false } = opts;
  // Claim the restoreMessages token for this session. A newer call will
  // overwrite it and cause our isStale() checks to return true, so we bail
  // at the next await without running our render loop on top of the newer
  // call's DOM (the double-messages bug's surviving mechanism).
  const myToken = Symbol(sessionId);
  restoreMessageTokens.set(sessionId, myToken);
  // Bail if the caller's session is no longer the one being viewed OR a newer
  // restoreMessages() for this same session has superseded us. Both checks
  // are needed: currentSessionId catches cross-session switches;
  // restoreMessageTokens catches rapid same-session clicks.
  const isStale = () => currentSessionId !== sessionId || restoreMessageTokens.get(sessionId) !== myToken;
  clearMessages();
  try {
    const res = await fetchWithRetry(`/api/sessions/${sessionId}/messages`, {}, { retries: 1 });
    if (isStale()) return;
    const messages = await res.json();
    if (isStale()) return;
    let renderLimit = messages.length;
    if (upToLastUser) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { renderLimit = i + 1; break; }
      }
    }
    for (let i = 0; i < renderLimit; i++) {
      const msg = messages[i];
      if (msg.role === 'user') {
        addUserMessage(msg.content);
      } else if (msg.role === 'assistant') {
        const el = createAssistantMessage();
        el.innerHTML = renderMarkdown(msg.content);
        ensureCopyButton(el);
      } else if (msg.role === 'tool') {
        try {
          const tool = JSON.parse(msg.content);
          addToolIndicator(tool.name, tool.id || 'restored-' + Math.random(), tool.input);
        } catch {
          addToolIndicator(msg.content, 'restored-' + Math.random());
        }
      } else if (msg.role === 'tool_result') {
        try {
          const result = JSON.parse(msg.content);
          addToolOutput(result.tool_use_id, result.content);
        } catch {}
      } else if (msg.role === 'usage') {
        addUsageInfo(msg.content);
      }
    }
    // Show fork-point divider and mark the fork-point message if this is a forked session
    if (sessionMeta?.forkedFrom) {
      addForkDivider(
        sessionMeta.forkedFrom.sessionName,
        sessionMeta.forkedFrom.sessionId,
        sessionMeta.forkedFrom.parentWorkingDir,
        sessionMeta.workingDir,
        sessionMeta.forkedFrom.messageIndex,
      );
      markForkPointMessage(sessionMeta.forkedFrom.messageIndex);
    }
    // Add fork badges to messages that have been forked from
    try {
      const forkRes = await fetchWithRetry(`/api/sessions/${sessionId}/forks`);
      if (isStale()) return;
      const forkPoints = await forkRes.json();
      if (isStale()) return;
      addForkBadges(forkPoints);
    } catch {}
    scrollToBottomForce();
  } catch (err) {
    console.error('Failed to load messages:', err);
  }
}

// DOM elements
const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const inputArea = document.getElementById('input-area');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const chatTitle = document.getElementById('chat-title');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const sessionListEl = document.getElementById('session-list');

const modelSelect = document.getElementById('model-select');
const sidebarDirPicker = document.getElementById('sidebar-dir-picker');
const sidebarDirBtn = document.querySelector('.btn-sidebar-dir');
const newChatBtn = document.getElementById('new-chat-btn');
let selectedNewChatDir = '';

// App title
function getAppTitle() {
  return localStorage.getItem('chat-bridge-app-title') || 'Claude Chat Bridge';
}
chatTitle.textContent = getAppTitle();
document.title = getAppTitle();

// Restore saved model
const savedModel = localStorage.getItem('chat-bridge-model') || 'opus';
modelSelect.value = savedModel;

function saveModel(value) {
  localStorage.setItem('chat-bridge-model', value);
  // Persist to current session
  if (currentSessionId) {
    fetchWithRetry(`/api/sessions/${currentSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: value }),
    }).catch(() => {});
  }
}

function getSelectedModel() {
  return modelSelect.value;
}

// Mode management — mode is per-client state persisted in localStorage. The
// bridge no longer maintains a server-wide mode; every mode-aware request
// passes mode explicitly (in the create body or as ?mode=).
async function setMode(mode) {
  if (mode === currentMode) return;
  document.querySelectorAll('.mode-tab').forEach(t => t.classList.add('switching'));
  sessionListEl.innerHTML = '<div class="sidebar-loading">Loading sessions…</div>';
  try {
    currentMode = mode;
    localStorage.setItem('chat-bridge-mode', mode);
    updateModeTabsUI(mode);

    // Deselect current chat if it doesn't belong to this mode
    if (currentSessionId) {
      try {
        const s = await (await fetchWithRetry(`/api/sessions/${currentSessionId}`)).json();
        if ((s.mode || 'work') !== mode) {
          currentSessionId = null;
          chatTitle.textContent = getAppTitle();
          currentWorkingDir = '';
          welcomeEl.style.display = '';
          inputArea.style.display = 'none';
          document.querySelector('.dir-picker-wrapper').style.display = 'none';
          document.getElementById('session-details-panel').style.display = 'none';
          clearMessages();
        }
      } catch {}
    }

    // Reload sidebar and welcome screen with filtered sessions/topics
    await Promise.all([loadSessions(), loadWelcomeSessions()]);
    // Reset topics loaded flags so they re-fetch for the new mode
    ['welcome-topics', 'kb-welcome-topics'].forEach(id => {
      const el = document.getElementById(id);
      if (el) delete el.dataset.loaded;
    });
    // If topics tab is currently active, reload immediately
    const activeTopicsTab = document.querySelector('.welcome-tab.active[data-tab="topics"], .welcome-tab.active[data-tab="kb-topics"]');
    if (activeTopicsTab) loadWelcomeTopics();
  } catch (err) {
    console.error('Failed to switch mode:', err);
  } finally {
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('switching'));
  }
}

function updateModeTabsUI(mode) {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
}

// Session metadata
let currentWorkingDir = '';
let currentForkDepth = 0;
let currentSessionCreated = '';
let currentClosedAt = '';
const dirPicker = document.getElementById('dir-picker');

// Shared directory browser renderer
async function renderDirRoots(container, onSelect) {
  container.innerHTML = '<div class="dir-browser-loading">Loading...</div>';
  container.style.display = 'block';

  try {
    const res = await fetchWithRetry('/api/sessions/dirs/roots');
    const roots = await res.json();

    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'dir-browser-header';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'dir-browser-path';
    pathLabel.textContent = 'Allowed Directories';
    header.appendChild(pathLabel);
    container.appendChild(header);

    // Show last-used directory at the top if available
    const lastDir = localStorage.getItem('chat-bridge-last-dir');
    if (lastDir) {
      const lastDirName = lastDir.split('/').filter(Boolean).pop();
      const recentSection = document.createElement('div');
      recentSection.className = 'dir-browser-recent';
      const recentLabel = document.createElement('div');
      recentLabel.className = 'dir-browser-recent-label';
      recentLabel.textContent = 'Recent';
      recentSection.appendChild(recentLabel);
      const recentItem = document.createElement('button');
      recentItem.className = 'dir-picker-item dir-picker-item-recent';
      recentItem.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>' + lastDirName + '</span>';
      recentItem.title = lastDir;
      recentItem.onclick = (e) => { e.stopPropagation(); renderDirBrowser(container, lastDir, onSelect); };
      recentSection.appendChild(recentItem);
      container.appendChild(recentSection);
    }

    if (roots.length > 0) {
      const list = document.createElement('div');
      list.className = 'dir-browser-list';
      for (const root of roots) {
        const item = document.createElement('button');
        item.className = 'dir-picker-item';
        item.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>' + root.name + '</span>';
        item.onclick = (e) => { e.stopPropagation(); renderDirBrowser(container, root.path, onSelect); };
        list.appendChild(item);
      }
      container.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'dir-browser-empty';
      empty.textContent = 'No allowed paths configured';
      container.appendChild(empty);
    }
  } catch (err) {
    container.innerHTML = '<div class="dir-browser-empty">Failed to load allowed directories</div>';
  }
}

async function renderDirBrowser(container, startPath, onSelect, opts = {}) {
  container.innerHTML = '<div class="dir-browser-loading">Loading...</div>';
  container.style.display = 'block';
  const unrestricted = opts.unrestricted || false;

  try {
    let url = `/api/sessions/dirs/browse?path=${encodeURIComponent(startPath)}`;
    if (unrestricted) url += '&unrestricted=1';
    const res = await fetch(url);
    if (res.status === 403) {
      // Path is outside allowed directories — show roots instead
      return renderDirRoots(container, onSelect);
    }
    const data = await res.json();

    container.innerHTML = '';

    // Breadcrumb / current path header
    const header = document.createElement('div');
    header.className = 'dir-browser-header';

    if (data.parent) {
      const backBtn = document.createElement('button');
      backBtn.className = 'dir-browser-back';
      backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
      backBtn.title = 'Go up';
      backBtn.onclick = (e) => { e.stopPropagation(); renderDirBrowser(container, data.parent, onSelect, opts); };
      header.appendChild(backBtn);
    } else if (!unrestricted) {
      // At the top of an allowed path — add back button to return to roots
      const backBtn = document.createElement('button');
      backBtn.className = 'dir-browser-back';
      backBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
      backBtn.title = 'Back to allowed directories';
      backBtn.onclick = (e) => { e.stopPropagation(); renderDirRoots(container, onSelect); };
      header.appendChild(backBtn);
    }

    const pathLabel = document.createElement('span');
    pathLabel.className = 'dir-browser-path';
    pathLabel.textContent = data.path;
    pathLabel.title = data.path;
    header.appendChild(pathLabel);

    container.appendChild(header);

    // Select current directory button
    const selectBtn = document.createElement('button');
    selectBtn.className = 'dir-browser-select';
    selectBtn.textContent = 'Select this directory';
    selectBtn.onclick = (e) => { e.stopPropagation(); onSelect(data.path); };
    container.appendChild(selectBtn);

    // Child directories
    if (data.children.length > 0) {
      const list = document.createElement('div');
      list.className = 'dir-browser-list';
      for (const child of data.children) {
        const item = document.createElement('button');
        item.className = 'dir-picker-item';
        item.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg><span>' + child.name + '</span>';
        item.onclick = (e) => { e.stopPropagation(); renderDirBrowser(container, child.path, onSelect, opts); };
        list.appendChild(item);
      }
      container.appendChild(list);
    } else {
      const empty = document.createElement('div');
      empty.className = 'dir-browser-empty';
      empty.textContent = 'No subdirectories';
      container.appendChild(empty);
    }
  } catch (err) {
    container.innerHTML = '<div class="dir-browser-empty">Failed to load directory</div>';
  }
}

function toggleSidebarDirPicker() {
  const isOpen = sidebarDirPicker.style.display !== 'none';
  if (isOpen) { sidebarDirPicker.style.display = 'none'; return; }
  const onSelect = (dirPath) => {
    sidebarDirPicker.style.display = 'none';
    selectedNewChatDir = dirPath;
    sidebarDirBtn.classList.add('selected');
    sidebarDirBtn.title = dirPath;
    newChatBtn.disabled = false;
    localStorage.setItem('chat-bridge-last-dir', dirPath);
  };
  if (selectedNewChatDir) {
    renderDirBrowser(sidebarDirPicker, selectedNewChatDir, onSelect);
  } else {
    renderDirRoots(sidebarDirPicker, onSelect);
  }
}

function toggleDirPicker() {
  if (!currentSessionId) return;
  const isOpen = dirPicker.style.display !== 'none';
  if (isOpen) { dirPicker.style.display = 'none'; return; }
  const onSelect = async (dirPath) => {
    dirPicker.style.display = 'none';
    if (dirPath === currentWorkingDir) return;
    localStorage.setItem('chat-bridge-last-dir', dirPath);
    const visibleCount = messagesEl.querySelectorAll('.message-user, .message-assistant').length;
    if (visibleCount === 0) {
      // Empty session — no transcript to preserve. Just PATCH the cwd in place.
      try {
        await fetchWithRetry(`/api/sessions/${currentSessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workingDir: dirPath }),
        });
        currentWorkingDir = dirPath;
      } catch (err) {
        console.error('Failed to update working directory:', err);
      }
      return;
    }
    // Non-empty session — fork so the parent session stays coherent for its
    // original directory and the child owns the new one. Transcript carries
    // forward via --fork-session; the next Claude subprocess spawns with the
    // new cwd (src/services/claude-runner.ts uses session.workingDir).
    try {
      const res = await fetch(`/api/sessions/${currentSessionId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIndex: visibleCount - 1, workingDir: dirPath }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert('Fork into directory failed: ' + (err.error || 'Unknown error'));
        return;
      }
      const forkedSession = await res.json();
      await switchSession(forkedSession.id);
    } catch (err) {
      console.error('Fork-into-dir failed:', err);
      alert('Fork into directory failed: ' + err.message);
    }
  };
  if (currentWorkingDir) {
    renderDirBrowser(dirPicker, currentWorkingDir, onSelect);
  } else {
    renderDirRoots(dirPicker, onSelect);
  }
}

// Close dir pickers on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.dir-picker-wrapper')) {
    dirPicker.style.display = 'none';
  }
  if (!e.target.closest('.sidebar-dir-wrapper')) {
    sidebarDirPicker.style.display = 'none';
  }
});

// Track which sessions are actively working (polled from backend)
let activeSessionIds = new Set();
// Track active Agent (subagent) tool calls for in-chat indicators
let pendingAgentToolIds = new Set();

// Apply saved theme and tool visibility before first paint
(function() {
  const saved = localStorage.getItem('chat-bridge-theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  if (localStorage.getItem('chat-bridge-hide-tools') === 'true') {
    document.documentElement.setAttribute('data-hide-tools', 'true');
  }
})();

// Initialize — mode is restored from localStorage at script-init time (see
// `currentMode` declaration). Page load no longer touches any server-side
// mode state, so opening a second tab can't flip the first tab's mode.
(async () => {
  updateModeTabsUI(currentMode);
  await loadBridgePaths();
  loadSessions();
  startActiveSessionPolling();
  checkVersionOnStartup();
})();

// Check for CLI version change on page load (non-blocking)
async function checkVersionOnStartup() {
  try {
    const res = await fetchWithRetry('/api/settings/version');
    const data = await res.json();
    versionData = data;
    if (data.updateAvailable || data.versionChanged) {
      showVersionBanner(data);
    }
  } catch {}
}

function showVersionBanner(data) {
  // Don't show if already dismissed this session
  if (document.getElementById('version-banner')) return;

  const messages = document.getElementById('messages');
  const banner = document.createElement('div');
  banner.id = 'version-banner';
  banner.className = 'version-banner';

  const label = (data.versionChanged && data.updateAvailable)
    ? 'Claude CLI updated — newer version available'
    : data.updateAvailable
      ? 'Claude CLI update available'
      : 'Claude CLI updated';

  banner.innerHTML = `
    <a class="version-banner-link" onclick="showSettingsSection('updates'); switchView('settings')">${label}</a>
    <button class="version-banner-dismiss" onclick="dismissVersionBanner()" aria-label="Dismiss">&times;</button>
  `;

  const container = messages.closest('.messages-container') || messages;
  container.parentNode.insertBefore(banner, container);
}

async function dismissVersionBanner() {
  const banner = document.getElementById('version-banner');
  if (banner) banner.remove();
  // Acknowledge current version so it doesn't show again next load
  if (versionData?.currentVersion) {
    try {
      await fetchWithRetry('/api/settings/version/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: versionData.currentVersion }),
      });
    } catch {}
  }
}

// Poll for active (working) sessions to show pulse indicator
function startActiveSessionPolling() {
  async function poll() {
    try {
      const res = await fetchWithRetry('/api/sessions/active', {}, { timeout: 5000 });
      const ids = await res.json();
      const newSet = new Set(ids);
      // Only update DOM if the set changed
      if (ids.length !== activeSessionIds.size || ids.some(id => !activeSessionIds.has(id))) {
        activeSessionIds = newSet;
        document.querySelectorAll('.session-item').forEach(el => {
          const sessionId = el.getAttribute('onclick')?.match(/switchSession\('([^']+)'\)/)?.[1];
          if (sessionId) {
            el.classList.toggle('working', activeSessionIds.has(sessionId));
          }
        });
      }
    } catch {} // polling — silently skip failed ticks
  }
  poll();
  setInterval(poll, 2000);
}

// Sidebar toggle
function toggleSidebar() {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('active');
}

// Action menu commands
const ACTION_MENU_ITEMS = [
  { label: 'Attach Image', icon: 'image', action: 'image' },
  { label: 'Voice Dictation', icon: 'mic', action: 'voice', desktopOnly: true },
  { divider: true },
  { label: 'Workflow', icon: 'play', command: '/vault:workflow', flyout: 'workflows' },
  { label: 'Close Session', icon: 'check-circle', command: '/vault:close', flyout: 'close' },
  { divider: true },
  { label: 'Tasks', icon: 'check-square', command: '/vault:tasks', flyout: 'tasks' },
  { label: 'Issue', icon: 'alert-triangle', command: '/vault:issue', flyout: 'issues' },
];

const ACTION_ICONS = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  'check-square': '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  'alert-triangle': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
};

async function fetchFlyoutData(type) {
  if (type === 'tasks' || type === 'close') return null; // Static flyouts, no API needed
  try {
    const res = await fetchWithRetry(`/api/vault/${type}?mode=${currentMode}`);
    return await res.json();
  } catch { return []; }
}

function buildActionMenu() {
  const menu = document.getElementById('action-menu');
  const isMobile = window.matchMedia('(max-width: 480px)').matches;
  menu.innerHTML = ACTION_MENU_ITEMS.filter(item => {
    if (item.desktopOnly && isMobile) return false;
    if (item.action === 'voice' && !(window.SpeechRecognition || window.webkitSpeechRecognition)) return false;
    return true;
  }).map(item => {
    if (item.divider) return '<div class="action-menu-divider"></div>';
    const iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[item.icon]}</svg>`;
    if (item.action === 'image') {
      return `<button class="action-menu-item" onclick="triggerImageAttach()">${iconSvg}<span>${item.label}</span></button>`;
    }
    if (item.action === 'voice') {
      return `<button class="action-menu-item" id="voice-dictation-btn" onclick="toggleVoiceDictation()">${iconSvg}<span>${item.label}</span></button>`;
    }
    if (item.flyout) {
      const chevron = '<svg class="flyout-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
      return `<div class="action-menu-item-flyout" data-flyout="${item.flyout}" data-command="${item.command}">
        <button class="action-menu-item" onclick="handleFlyoutClick(event, '${item.command}')">${iconSvg}<span>${item.label}</span>${chevron}</button>
        <div class="flyout-menu" id="flyout-${item.flyout}"></div>
      </div>`;
    }
    return `<button class="action-menu-item" onclick="fireCommand('${item.command}')">${iconSvg}<span>${item.label}</span></button>`;
  }).join('');

  // Attach hover/touch listeners for flyout items
  menu.querySelectorAll('.action-menu-item-flyout').forEach(el => {
    const flyoutType = el.dataset.flyout;
    let enterTimeout;
    let leaveTimeout;

    el.addEventListener('mouseenter', () => {
      clearTimeout(leaveTimeout);
      enterTimeout = setTimeout(() => showFlyout(el, flyoutType), 150);
    });
    el.addEventListener('mouseleave', () => {
      clearTimeout(enterTimeout);
      leaveTimeout = setTimeout(() => hideFlyout(el), 100);
    });
  });
}

function flyoutCategoryStorageKey(type) {
  return `chat-bridge-flyout-expanded-${type}`;
}

function getExpandedFlyoutCategories(type) {
  try {
    const raw = localStorage.getItem(flyoutCategoryStorageKey(type));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function toggleFlyoutCategory(headerEl, type) {
  const group = headerEl.closest('.flyout-group');
  if (!group) return;
  const cat = headerEl.dataset.category;
  const nowCollapsed = group.classList.toggle('collapsed');
  headerEl.setAttribute('aria-expanded', String(!nowCollapsed));
  const expanded = getExpandedFlyoutCategories(type);
  if (nowCollapsed) {
    expanded.delete(cat);
  } else {
    expanded.add(cat);
  }
  try {
    localStorage.setItem(flyoutCategoryStorageKey(type), JSON.stringify([...expanded]));
  } catch {}
}

async function showFlyout(wrapperEl, type) {
  const data = await fetchFlyoutData(type);

  const flyoutMenu = wrapperEl.querySelector('.flyout-menu');
  const command = wrapperEl.dataset.command;

  // Static flyout for close — "No Git" option
  if (type === 'close') {
    flyoutMenu.innerHTML = `<button class="flyout-item" onclick="fireCommand('/vault:close-no-git')">
      <span class="flyout-item-label">Close (No Git)</span>
      <span class="flyout-item-desc">Skip git operations</span>
    </button>`;
    wrapperEl.classList.add('flyout-open');
    return;
  }

  // Static flyout for tasks — single "All Tasks" option
  if (type === 'tasks') {
    flyoutMenu.innerHTML = `<button class="flyout-item" onclick="fireCommand('/vault:all-tasks')">
      <span class="flyout-item-label">All Tasks</span>
      <span class="flyout-item-desc">Work + Personal combined</span>
    </button>`;
    wrapperEl.classList.add('flyout-open');
    return;
  }

  // Default list rendering for workflows/issues (workflows support category grouping)
  const items = data;
  if (!items || items.length === 0) {
    flyoutMenu.innerHTML = '<div class="flyout-empty">None available</div>';
  } else {
    const hasCategories = items.some(item => item.category);
    if (hasCategories) {
      // Group by category — uncategorized items first, then alphabetical categories
      const groups = {};
      for (const item of items) {
        const cat = item.category || '';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(item);
      }
      const sortedKeys = Object.keys(groups).sort((a, b) => {
        if (!a) return -1;
        if (!b) return 1;
        return a.localeCompare(b);
      });
      const expanded = getExpandedFlyoutCategories(type);
      flyoutMenu.innerHTML = sortedKeys.map(cat => {
        const buttons = groups[cat].map(item => {
          const label = (item.slug.includes('/') ? item.slug.split('/').pop() : item.slug).replace(/-/g, ' ');
          const subtitle = item.description || '';
          return `<button class="flyout-item" onclick="fireCommand('${command} ${item.slug}')">
            <span class="flyout-item-label">${label}</span>
            ${subtitle ? `<span class="flyout-item-desc">${subtitle}</span>` : ''}
          </button>`;
        }).join('');
        if (!cat) return buttons;
        const isExpanded = expanded.has(cat);
        const collapsedCls = isExpanded ? '' : ' collapsed';
        const catAttr = cat.replace(/"/g, '&quot;');
        return `<div class="flyout-group${collapsedCls}">
          <button type="button" class="flyout-group-header" onclick="toggleFlyoutCategory(this, '${type}')" data-category="${catAttr}" aria-expanded="${isExpanded}">
            <span class="flyout-group-chevron" aria-hidden="true">▸</span>
            <span class="flyout-group-label">${cat.replace(/-/g, ' ')}</span>
          </button>
          <div class="flyout-group-body">${buttons}</div>
        </div>`;
      }).join('');
    } else {
      flyoutMenu.innerHTML = items.map(item => {
        const slug = item.slug;
        const label = slug.replace(/-/g, ' ');
        const subtitle = item.description || (item.priority ? `${item.priority} priority` : '');
        return `<button class="flyout-item" onclick="fireCommand('${command} ${slug}')">
          <span class="flyout-item-label">${label}</span>
          ${subtitle ? `<span class="flyout-item-desc">${subtitle}</span>` : ''}
        </button>`;
      }).join('');
    }
  }

  wrapperEl.classList.add('flyout-open');
}

function hideFlyout(wrapperEl) {
  wrapperEl.classList.remove('flyout-open');
}

function handleFlyoutClick(event, command) {
  // On touch devices, first tap opens the flyout; second fires the base command
  event.stopPropagation();
  const wrapper = event.target.closest('.action-menu-item-flyout');
  if (!wrapper) return;

  // If flyout is already open (touch device second tap), fire base command
  if (wrapper.classList.contains('flyout-open')) {
    fireCommand(command);
    return;
  }

  // First tap on touch — open flyout
  // Close any other open flyouts first
  document.querySelectorAll('.action-menu-item-flyout.flyout-open').forEach(el => {
    el.classList.remove('flyout-open');
  });
  showFlyout(wrapper, wrapper.dataset.flyout);
}

function toggleActionMenu() {
  const menu = document.getElementById('action-menu');
  const btn = document.querySelector('.btn-attach');
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  btn.classList.toggle('active', !isOpen);
  // Close any open flyouts when toggling menu
  if (isOpen) {
    document.querySelectorAll('.flyout-open').forEach(el => el.classList.remove('flyout-open'));
  }
}

function closeActionMenu() {
  const menu = document.getElementById('action-menu');
  const btn = document.querySelector('.btn-attach');
  menu.style.display = 'none';
  btn.classList.remove('active');
  document.querySelectorAll('.flyout-open').forEach(el => el.classList.remove('flyout-open'));
}

function triggerImageAttach() {
  closeActionMenu();
  document.getElementById('image-input').click();
}

// Voice dictation via Web Speech API
let voiceRecognition = null;
let voiceIsListening = false;
let voiceMicStream = null; // Hold mic stream to persist permission

function toggleVoiceDictation() {
  closeActionMenu();
  if (voiceIsListening) {
    stopVoiceDictation();
  } else {
    startVoiceDictation();
  }
}

async function startVoiceDictation() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  // Stop any active TTS — iOS won't share audio hardware between speech output and mic input
  stopSpeaking();
  // Fully release iOS audio element so the mic can take over
  if (ttsIOSAudioEl) {
    ttsIOSAudioEl.pause();
    ttsIOSAudioEl.src = '';
    ttsIOSAudioEl.load();
    ttsIOSAudioEl = null;
  }

  // Acquire mic permission once and hold the stream to avoid re-prompting
  if (!voiceMicStream) {
    try {
      voiceMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Microphone permission denied:', err);
      return;
    }
  }

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.continuous = true;
  voiceRecognition.interimResults = true;
  voiceRecognition.lang = 'en-US';

  voiceRecognition.onstart = () => {
    voiceIsListening = true;
    showVoiceIndicator();
  };

  voiceRecognition.onresult = (event) => {
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        // Commit each final chunk immediately to the input
        appendToInput(transcript);
      } else {
        interimTranscript = transcript;
      }
    }
    updateVoicePreview(interimTranscript);
  };

  voiceRecognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    console.warn('Speech recognition error:', event.error);
    stopVoiceDictation();
  };

  voiceRecognition.onend = () => {
    // Browser stops recognition on silence timeout — restart if still listening
    if (voiceIsListening) {
      try { voiceRecognition.start(); } catch {}
    }
  };

  voiceRecognition.start();
}

function stopVoiceDictation() {
  voiceIsListening = false;
  if (voiceRecognition) {
    voiceRecognition.onend = null;
    voiceRecognition.stop();
    voiceRecognition = null;
  }
  hideVoiceIndicator();
  messageInput.focus();
}

// ── TTS Speaking Face ──────────────────────────────────────────────────
let ttsFaceEnabled = localStorage.getItem('chat-bridge-tts-face') !== 'false'; // on by default
let ttsFaceAudioCtx = null;
let ttsFaceAnalyser = null;
let ttsFaceSource = null; // current MediaElementSource
let ttsFaceSourceEl = null; // the audio element currently connected
let ttsFaceAnimFrame = null;
let ttsFaceSilenceTimer = null;
let ttsFaceActivity = 'idle'; // idle | thinking | tool-working
let ttsFaceResponseActive = false; // true while AI is responding
const TTS_FACE_SILENCE_DELAY = 2000; // ms of silence before fade-out
const TTS_FACE_SMOOTHING = 0.35; // analyser smoothing

// ── Face response lifecycle ──
// Face appears when user sends a message and stays visible for the entire
// response, showing different expressions for thinking / tool use / speaking.
// It fades out only after the response completes (and TTS finishes if active).

function ttsFaceResponseStart() {
  if (!ttsFaceEnabled || !ttsAutoSpeak) return;
  ttsFaceResponseActive = true;
  ttsFaceActivity = 'idle';
  const overlay = document.getElementById('tts-face-overlay');
  if (!overlay) return;
  clearTimeout(ttsFaceSilenceTimer);
  ttsFaceSilenceTimer = null;
  overlay.classList.remove('thinking', 'tool-working', 'speaking');
  overlay.classList.add('visible');
  ttsFaceResetMouth();
}

function ttsFaceResponseEnd() {
  ttsFaceResponseActive = false;
  ttsFaceActivity = 'idle';
  const overlay = document.getElementById('tts-face-overlay');
  if (!overlay) return;
  overlay.classList.remove('thinking', 'tool-working');
  // If TTS is still speaking, let ttsFaceHide handle final removal
  if (overlay.classList.contains('speaking')) return;
  ttsFaceScheduleFadeOut();
}

// ── Face activity states (thinking, tool-working) ──

function ttsFaceSetActivity(activity) {
  if (!ttsFaceEnabled || !ttsAutoSpeak) return;
  if (activity === ttsFaceActivity) return;
  const overlay = document.getElementById('tts-face-overlay');
  if (!overlay) return;
  ttsFaceActivity = activity;
  overlay.classList.remove('thinking', 'tool-working');
  if (activity !== 'idle') {
    overlay.classList.add(activity);
    if (!overlay.classList.contains('speaking')) {
      ttsFaceSetStaticMouth(activity);
    }
  } else if (!overlay.classList.contains('speaking')) {
    ttsFaceResetMouth();
  }
}

function ttsFaceSetStaticMouth(state) {
  const darkMouth = document.getElementById('tts-face-mouth');
  const darkAbove = document.getElementById('tts-face-mouth-above');
  const darkBelow = document.getElementById('tts-face-mouth-below');
  const lightMouth = document.getElementById('tts-face-mouth-light');
  const lightAbove = document.getElementById('tts-face-mouth-light-above');
  const lightBelow = document.getElementById('tts-face-mouth-light-below');
  if (state === 'thinking') {
    if (darkMouth) darkMouth.setAttribute('d', 'M76 148 Q100 152, 124 148');
    if (darkAbove) darkAbove.setAttribute('d', 'M76 145 Q100 149, 124 145');
    if (darkBelow) darkBelow.setAttribute('d', 'M76 151 Q100 155, 124 151');
    if (lightMouth) lightMouth.setAttribute('d', 'M76 148 Q100 152, 124 148');
    if (lightAbove) lightAbove.setAttribute('d', 'M76 145 Q100 149, 124 145');
    if (lightBelow) lightBelow.setAttribute('d', 'M76 151 Q100 155, 124 151');
  } else if (state === 'tool-working') {
    if (darkMouth) darkMouth.setAttribute('d', 'M74 148 Q100 158, 126 148');
    if (darkAbove) darkAbove.setAttribute('d', 'M74 145 Q100 155, 126 145');
    if (darkBelow) darkBelow.setAttribute('d', 'M74 151 Q100 161, 126 151');
    if (lightMouth) lightMouth.setAttribute('d', 'M74 148 Q100 158, 126 148');
    if (lightAbove) lightAbove.setAttribute('d', 'M74 145 Q100 155, 126 145');
    if (lightBelow) lightBelow.setAttribute('d', 'M74 151 Q100 161, 126 151');
  }
}

function ttsFaceResetMouth() {
  const darkMouth = document.getElementById('tts-face-mouth');
  const darkAbove = document.getElementById('tts-face-mouth-above');
  const darkBelow = document.getElementById('tts-face-mouth-below');
  const lightMouth = document.getElementById('tts-face-mouth-light');
  const lightAbove = document.getElementById('tts-face-mouth-light-above');
  const lightBelow = document.getElementById('tts-face-mouth-light-below');
  if (darkMouth) darkMouth.setAttribute('d', 'M72 148 Q100 163, 128 148');
  if (darkAbove) darkAbove.setAttribute('d', 'M72 145 Q100 160, 128 145');
  if (darkBelow) darkBelow.setAttribute('d', 'M72 151 Q100 166, 128 151');
  if (lightMouth) lightMouth.setAttribute('d', 'M72 148 Q100 163, 128 148');
  if (lightAbove) lightAbove.setAttribute('d', 'M72 145 Q100 160, 128 145');
  if (lightBelow) lightBelow.setAttribute('d', 'M72 151 Q100 166, 128 151');
}

function ttsFaceScheduleFadeOut() {
  clearTimeout(ttsFaceSilenceTimer);
  ttsFaceSilenceTimer = setTimeout(() => {
    const overlay = document.getElementById('tts-face-overlay');
    if (overlay && !ttsFaceResponseActive && ttsFaceActivity === 'idle' && !overlay.classList.contains('speaking')) {
      overlay.classList.remove('visible');
      ttsFaceStopAnalysis();
      ttsFaceResetMouth();
    }
  }, 800);
}

// ── Face speaking state (TTS audio) ──

function ttsFaceShow() {
  if (!ttsFaceEnabled || !ttsAutoSpeak) return;
  const overlay = document.getElementById('tts-face-overlay');
  if (!overlay) return;
  clearTimeout(ttsFaceSilenceTimer);
  ttsFaceSilenceTimer = null;
  overlay.classList.add('visible', 'speaking');
}

function ttsFaceHide() {
  const overlay = document.getElementById('tts-face-overlay');
  if (!overlay || !overlay.classList.contains('speaking')) return;
  overlay.classList.remove('speaking');
  // If still in an activity state, restore that expression
  if (ttsFaceActivity !== 'idle') {
    ttsFaceSetStaticMouth(ttsFaceActivity);
    ttsFaceStopAnalysis();
    return;
  }
  // If response is still active, stay visible with neutral expression
  if (ttsFaceResponseActive) {
    ttsFaceResetMouth();
    ttsFaceStopAnalysis();
    return;
  }
  // Response over, no activity — fade out
  clearTimeout(ttsFaceSilenceTimer);
  ttsFaceSilenceTimer = setTimeout(() => {
    if (ttsFaceActivity === 'idle' && !ttsFaceResponseActive) {
      overlay.classList.remove('visible');
      ttsFaceResetMouth();
    }
    ttsFaceStopAnalysis();
  }, TTS_FACE_SILENCE_DELAY);
}

function ttsFaceHideImmediate() {
  clearTimeout(ttsFaceSilenceTimer);
  ttsFaceSilenceTimer = null;
  const overlay = document.getElementById('tts-face-overlay');
  if (overlay) {
    overlay.classList.remove('speaking');
    if (ttsFaceActivity !== 'idle') {
      ttsFaceSetStaticMouth(ttsFaceActivity);
    } else if (ttsFaceResponseActive) {
      ttsFaceResetMouth();
    } else {
      overlay.classList.remove('visible');
      ttsFaceResetMouth();
    }
  }
  ttsFaceStopAnalysis();
}

function ttsFaceConnectAudio(audioEl) {
  if (!ttsFaceEnabled || !ttsAutoSpeak || !audioEl) return;
  // On iOS, MediaElementSource reroutes audio through AudioContext which may
  // not have a user-gesture unlock — fall back to browser-style sine animation
  if (isIOS) {
    ttsFaceBrowserStart();
    return;
  }
  // Lazy-init AudioContext
  if (!ttsFaceAudioCtx) {
    try {
      ttsFaceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      ttsFaceAnalyser = ttsFaceAudioCtx.createAnalyser();
      ttsFaceAnalyser.fftSize = 256;
      ttsFaceAnalyser.smoothingTimeConstant = TTS_FACE_SMOOTHING;
      ttsFaceAnalyser.connect(ttsFaceAudioCtx.destination);
    } catch (e) {
      console.warn('[Face] AudioContext init failed, using fallback animation:', e);
      ttsFaceBrowserStart();
      return;
    }
  }
  if (ttsFaceAudioCtx.state === 'suspended') {
    ttsFaceAudioCtx.resume();
  }
  // Only create a new source if this is a different element
  if (ttsFaceSourceEl !== audioEl) {
    // Don't disconnect old source — MediaElementSource is permanent per element
    try {
      ttsFaceSource = ttsFaceAudioCtx.createMediaElementSource(audioEl);
      ttsFaceSource.connect(ttsFaceAnalyser);
      ttsFaceSourceEl = audioEl;
    } catch (e) {
      // Already connected (InvalidStateError) — reuse existing source
      console.log('[Face] audio element already connected, reusing');
    }
  }
  ttsFaceShow();
  ttsFaceStartAnalysis();
}

function ttsFaceStartAnalysis() {
  if (ttsFaceAnimFrame) return; // already running
  const darkMouth = document.getElementById('tts-face-mouth');
  const lightMouth = document.getElementById('tts-face-mouth-light');
  if (!ttsFaceAnalyser) return;
  if (!darkMouth && !lightMouth) return;

  const darkAbove = document.getElementById('tts-face-mouth-above');
  const darkBelow = document.getElementById('tts-face-mouth-below');
  const lightAbove = document.getElementById('tts-face-mouth-light-above');
  const lightBelow = document.getElementById('tts-face-mouth-light-below');
  const dataArray = new Uint8Array(ttsFaceAnalyser.frequencyBinCount);

  function animate() {
    ttsFaceAnimFrame = requestAnimationFrame(animate);
    ttsFaceAnalyser.getByteFrequencyData(dataArray);

    // Average amplitude across lower frequencies (voice range ~80-400Hz)
    const voiceBins = Math.min(32, dataArray.length);
    let sum = 0;
    for (let i = 0; i < voiceBins; i++) sum += dataArray[i];
    const avg = sum / voiceBins / 255; // 0..1

    const openAmount = Math.pow(avg, 0.6) * 20; // 0..~20px vertical displacement

    if (darkMouth) darkMouth.setAttribute('d', `M72 148 Q100 ${163 + openAmount}, 128 148`);
    if (darkAbove) darkAbove.setAttribute('d', `M72 145 Q100 ${160 + openAmount}, 128 145`);
    if (darkBelow) darkBelow.setAttribute('d', `M72 151 Q100 ${166 + openAmount}, 128 151`);
    if (lightMouth) lightMouth.setAttribute('d', `M72 148 Q100 ${163 + openAmount}, 128 148`);
    if (lightAbove) lightAbove.setAttribute('d', `M72 145 Q100 ${160 + openAmount}, 128 145`);
    if (lightBelow) lightBelow.setAttribute('d', `M72 151 Q100 ${166 + openAmount}, 128 151`);
  }
  animate();
}

function ttsFaceStopAnalysis() {
  if (ttsFaceAnimFrame) {
    cancelAnimationFrame(ttsFaceAnimFrame);
    ttsFaceAnimFrame = null;
  }
  // Mouth shape is managed by callers (ttsFaceResetMouth / ttsFaceSetStaticMouth)
}

function ttsFacePauseMouth() {
  // Pause speaking animation but keep face visible with current activity expression
  const overlay = document.getElementById('tts-face-overlay');
  if (overlay) overlay.classList.remove('speaking');
  ttsFaceStopAnalysis();
  clearInterval(ttsFaceBrowserInterval);
  ttsFaceBrowserInterval = null;
  if (ttsFaceActivity !== 'idle') {
    ttsFaceSetStaticMouth(ttsFaceActivity);
  } else {
    ttsFaceResetMouth();
  }
}

// For browser TTS (speechSynthesis) — no Audio element to analyze,
// so we fake it using utterance boundary events + timer-based open/close
let ttsFaceBrowserInterval = null;

function ttsFaceBrowserStart() {
  if (!ttsFaceEnabled || !ttsAutoSpeak) return;
  if (ttsFaceBrowserInterval) return; // already running
  ttsFaceShow();
  // Animate mouth with pseudo-random movement since we can't analyze audio
  const darkMouth = document.getElementById('tts-face-mouth');
  const darkAbove = document.getElementById('tts-face-mouth-above');
  const darkBelow = document.getElementById('tts-face-mouth-below');
  const lightMouth = document.getElementById('tts-face-mouth-light');
  const lightAbove = document.getElementById('tts-face-mouth-light-above');
  const lightBelow = document.getElementById('tts-face-mouth-light-below');
  if (!darkMouth && !lightMouth) return;
  let phase = 0;
  ttsFaceBrowserInterval = setInterval(() => {
    phase += 0.3;
    // Combine two sine waves for more natural-looking movement
    const open = Math.abs(Math.sin(phase) * 0.7 + Math.sin(phase * 2.3) * 0.3);
    const openAmount = open * 16;
    if (darkMouth) darkMouth.setAttribute('d', `M72 148 Q100 ${163 + openAmount}, 128 148`);
    if (darkAbove) darkAbove.setAttribute('d', `M72 145 Q100 ${160 + openAmount}, 128 145`);
    if (darkBelow) darkBelow.setAttribute('d', `M72 151 Q100 ${166 + openAmount}, 128 151`);
    if (lightMouth) lightMouth.setAttribute('d', `M72 148 Q100 ${163 + openAmount}, 128 148`);
    if (lightAbove) lightAbove.setAttribute('d', `M72 145 Q100 ${160 + openAmount}, 128 145`);
    if (lightBelow) lightBelow.setAttribute('d', `M72 151 Q100 ${166 + openAmount}, 128 151`);
  }, 50); // 20fps is enough for the sine-wave approach
}

function ttsFaceBrowserStop() {
  clearInterval(ttsFaceBrowserInterval);
  ttsFaceBrowserInterval = null;
  ttsFaceHide();
}

// ── Text-to-Speech (TTS) ──────────────────────────────────────────────
let ttsAutoSpeak = localStorage.getItem('chat-bridge-tts-auto') === 'true';
let ttsCurrentUtterance = null;
let ttsSpeakingEl = null; // the assistant message element currently being spoken
let ttsKeepAlive = null; // Chrome workaround interval
let ttsAudioEl = null; // Audio element for Google Cloud TTS playback
let ttsGoogleVoicesCache = null; // cached Google Cloud voice list
let ttsProvider = localStorage.getItem('chat-bridge-tts-provider') || 'browser'; // 'browser' or 'google-cloud'

// Streaming TTS state — progressive sentence-by-sentence playback during response streaming
// Queue items: { text, audioPromise?, controller? } — audioPromise/controller present iff prefetched
let ttsStreamQueue = [];
let ttsStreamRawText = '';      // accumulated raw markdown from text deltas
let ttsStreamSentCount = 0;     // number of sentences already queued from accumulated text
let ttsStreamActive = false;    // is streaming TTS currently accepting new text
let ttsStreamConsuming = false; // is the consumer currently playing audio
let ttsStreamDone = false;      // has flush been called (no more sentences coming)
let ttsStreamStarted = false;   // was streaming TTS activated for current response
const TTS_PREFETCH_CAP = 3;     // max concurrent Google Cloud synthesis fetches
let ttsInFlightPrefetches = 0;

function getTTSVoice() {
  const saved = localStorage.getItem('chat-bridge-tts-voice');
  if (!saved) return null; // null = system default (lets iOS use Ava/whatever is set in Accessibility)
  const voices = speechSynthesis.getVoices();
  // Match by voiceURI first (unique key), fall back to name
  return voices.find(v => (v.voiceURI || v.name) === saved) || voices.find(v => v.name === saved) || null;
}

function stripForTTS(text) {
  // Remove code blocks
  let clean = text.replace(/```[\s\S]*?```/g, '(code block omitted)');
  // Strip backticks from inline code but keep the text (e.g. `foo` → foo)
  clean = clean.replace(/`([^`]+)`/g, '$1');
  // Remove markdown images
  clean = clean.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Remove markdown links but keep text
  clean = clean.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Convert list items to sentences (add period before each bullet/number so TTS pauses)
  clean = clean.replace(/\n\s*[-*+]\s+/g, '.\n');
  clean = clean.replace(/\n\s*(\d+)[.)]\s+/g, '. $1: ');
  // Convert HTML tags to readable form BEFORE markdown formatting removal (which strips '>')
  // e.g. <ol> → "ol tag", </ol> → "", <br> → "br tag"
  clean = clean.replace(/<\/\w+>/g, '');
  clean = clean.replace(/<(\w+)(\s[^>]*)?\/?>/g, '$1 tag ');
  clean = clean.replace(/<[^>]*>/g, ''); // catch-all for comments, doctype, etc.
  // Remove markdown formatting
  clean = clean.replace(/[*_~#>]+/g, '');
  // Collapse whitespace
  clean = clean.replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  // Clean up double periods from list conversion
  clean = clean.replace(/\.{2,}/g, '.').replace(/^\.\s*/, '');
  return clean;
}

// Detect iOS Safari (pause/resume workaround breaks speech on iOS)
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// iOS requires a user gesture to unlock speechSynthesis and Audio playback.
// We prime both during the send-message tap so auto-speak works when the response arrives.
// For HTMLAudioElement, iOS requires the *same element* to be reused after the gesture unlock.
let ttsIOSAudioEl = null; // persistent Audio element unlocked by user gesture
function unlockTTSForIOS() {
  if (!isIOS) return;
  // Prime speechSynthesis — must be a non-empty string; iOS ignores empty utterances
  if (window.speechSynthesis) {
    const silent = new SpeechSynthesisUtterance(' ');
    silent.volume = 0.01;
    silent.rate = 10;
    speechSynthesis.speak(silent);
  }
  // Create & unlock a persistent Audio element — reused for all Google Cloud TTS playback
  if (!ttsIOSAudioEl) {
    ttsIOSAudioEl = new Audio();
    ttsIOSAudioEl.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    ttsIOSAudioEl.play().catch(() => {});
  }
}

function speakText(text, messageEl) {
  const clean = stripForTTS(text);
  if (!clean) { console.warn('[TTS] nothing to speak after stripping'); return; }

  // Route to Google Cloud TTS if configured, with fallback to browser
  if (ttsProvider === 'google-cloud') {
    speakTextGoogleCloud(clean, messageEl);
    return;
  }

  speakTextBrowser(clean, messageEl);
}

// Google Cloud TTS playback via server proxy
let ttsGoogleCancelled = false;

async function speakTextGoogleCloud(clean, messageEl) {
  // Stop any current playback
  stopSpeaking();
  ttsGoogleCancelled = false;

  ttsSpeakingEl = messageEl;
  if (messageEl) messageEl.classList.add('tts-speaking');

  const voiceName = localStorage.getItem('chat-bridge-tts-google-voice') || '';
  const rate = parseFloat(localStorage.getItem('chat-bridge-tts-rate') || '1.0');

  // Split into chunks under 5000 chars at sentence boundaries
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > 4500) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  console.log('[TTS:Google] speaking', chunks.length, 'chunks, voice:', voiceName || 'default');

  let i = 0;
  async function speakNextChunk() {
    if (ttsGoogleCancelled || i >= chunks.length) {
      if (!ttsGoogleCancelled) onSpeakEnd();
      return;
    }

    try {
      const resp = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: chunks[i],
          voiceName: voiceName || undefined,
          speakingRate: rate,
        }),
      });

      if (ttsGoogleCancelled) return;

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        console.warn('[TTS:Google] API error, falling back to browser TTS:', err.error || resp.statusText);
        // Fall back to browser TTS for this and remaining chunks
        const remaining = chunks.slice(i).join(' ');
        speakTextBrowser(remaining, messageEl);
        return;
      }

      const data = await resp.json();
      // On iOS, reuse the gesture-unlocked Audio element; elsewhere create fresh
      const audio = ttsIOSAudioEl || new Audio();
      audio.src = 'data:audio/mp3;base64,' + data.audioContent;
      audio.load(); // iOS needs explicit load() after src change for onended to fire
      ttsAudioEl = audio;
      audio.playbackRate = 1.0; // rate is already applied server-side
      audio.onended = () => { if (ttsAudioEl === audio && !ttsGoogleCancelled) { i++; speakNextChunk(); } };
      audio.onerror = (e) => {
        if (ttsAudioEl !== audio || ttsGoogleCancelled) return;
        console.warn('[TTS:Google] Audio playback error:', e);
        onSpeakEnd();
      };
      ttsFaceConnectAudio(audio);
      audio.play();
    } catch (err) {
      if (ttsGoogleCancelled) return;
      console.warn('[TTS:Google] Network error, falling back to browser TTS:', err);
      const remaining = chunks.slice(i).join(' ');
      speakTextBrowser(remaining, messageEl);
    }
  }

  speakNextChunk();
}

// Browser Web Speech API playback (original implementation)
function speakTextBrowser(clean, messageEl) {
  if (!window.speechSynthesis) { console.warn('[TTS] speechSynthesis not available'); return; }

  // Clean up previous playback state
  clearInterval(ttsKeepAlive);
  ttsKeepAlive = null;
  if (ttsSpeakingEl) {
    ttsSpeakingEl.classList.remove('tts-speaking');
    ttsSpeakingEl = null;
  }
  ttsCurrentUtterance = null;

  // Split into chunks at sentence boundaries (utterance length limits vary by browser)
  const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    if ((current + s).length > 200) {
      if (current) chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  console.log('[TTS] speaking', chunks.length, 'chunks, voice:', getTTSVoice()?.name);

  ttsSpeakingEl = messageEl;
  if (messageEl) messageEl.classList.add('tts-speaking');
  ttsFaceBrowserStart();

  const voice = getTTSVoice();
  const rate = parseFloat(localStorage.getItem('chat-bridge-tts-rate') || '1.0');

  let i = 0;
  function speakNext() {
    if (i >= chunks.length) {
      clearInterval(ttsKeepAlive);
      onSpeakEnd();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[i]);
    utterance.lang = 'en-US';
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onend = () => { if (ttsCurrentUtterance !== utterance) return; i++; speakNext(); };
    utterance.onerror = (e) => {
      if (ttsCurrentUtterance !== utterance) return;
      clearInterval(ttsKeepAlive);
      if (e.error !== 'canceled') console.warn('TTS error:', e.error);
      onSpeakEnd();
    };
    ttsCurrentUtterance = utterance;
    speechSynthesis.speak(utterance);
  }

  // Chrome pauses speech after ~15s; periodic pause/resume keeps it alive.
  // Skip on iOS — pause()/resume() kills speech permanently on iOS Safari.
  if (!isIOS) {
    ttsKeepAlive = setInterval(() => {
      if (speechSynthesis.speaking) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 10000);
  }

  // On iOS, cancel must happen before speak but needs a microtask break
  // to avoid consuming the user gesture. On other browsers, cancel synchronously.
  if (isIOS && (speechSynthesis.speaking || speechSynthesis.pending)) {
    speechSynthesis.cancel();
    setTimeout(speakNext, 50);
  } else {
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speakNext();
  }
}

function stopSpeaking() {
  ttsGoogleCancelled = true;
  // Reset streaming TTS state
  ttsStreamReset();
  ttsStreamDone = true; // prevent consumer from calling onSpeakEnd again
  clearInterval(ttsKeepAlive);
  ttsKeepAlive = null;
  if (window.speechSynthesis && (speechSynthesis.speaking || speechSynthesis.pending)) {
    speechSynthesis.cancel();
  }
  // Stop Google Cloud TTS audio playback
  if (ttsAudioEl) {
    ttsAudioEl.pause();
    if (ttsAudioEl !== ttsIOSAudioEl) {
      ttsAudioEl.src = '';
    }
    ttsAudioEl = null;
  }
  ttsFaceHideImmediate();
  ttsFaceBrowserStop();
  onSpeakEnd();
}

function onSpeakEnd() {
  if (ttsSpeakingEl) {
    ttsSpeakingEl.classList.remove('tts-speaking');
    ttsSpeakingEl = null;
  }
  ttsCurrentUtterance = null;
  updateTTSToggleBtn();
  ttsFaceBrowserStop();
  ttsFaceHide();
}

function toggleAutoSpeak() {
  ttsAutoSpeak = !ttsAutoSpeak;
  localStorage.setItem('chat-bridge-tts-auto', ttsAutoSpeak);
  updateTTSToggleBtn();
  if (!ttsAutoSpeak) {
    // Toggling off mid-speech: stop audio and hide face immediately
    stopSpeaking();
    ttsFaceActivity = 'idle';
    ttsFaceResponseActive = false;
    ttsFaceHideImmediate();
  } else if (streamingSessions.has(currentSessionId)) {
    // Toggling on mid-response: restore face and allow new text to be spoken
    ttsFaceResponseStart();
    ttsStreamStarted = false; // next text delta will call ttsStreamStart
  }
}

function updateTTSToggleBtn() {
  const btn = document.getElementById('tts-toggle-btn');
  if (!btn) return;
  btn.classList.toggle('active', ttsAutoSpeak);
  btn.title = ttsAutoSpeak ? 'Auto-speak ON (click to disable)' : 'Auto-speak OFF (click to enable)';
}

function speakAssistantMessage(el) {
  // If already speaking this message, stop instead
  const isSpeaking = (window.speechSynthesis && speechSynthesis.speaking) || (ttsAudioEl && !ttsAudioEl.paused);
  if (ttsSpeakingEl === el && isSpeaking) {
    stopSpeaking();
    return;
  }
  const text = extractTextForTTS(el);
  speakText(text, el);
}

function extractTextForTTS(el) {
  const clone = el.cloneNode(true);
  // Remove UI chrome
  const actionsBtn = clone.querySelector('.btn-msg-actions');
  if (actionsBtn) actionsBtn.remove();
  const actionsMenu = clone.querySelector('.msg-action-menu');
  if (actionsMenu) actionsMenu.remove();
  // Replace code blocks with a brief placeholder
  clone.querySelectorAll('.code-block-wrapper').forEach(wrapper => {
    const placeholder = document.createTextNode(' (code block omitted) ');
    wrapper.replaceWith(placeholder);
  });
  // Also strip any bare <pre>/<code> not in wrappers (streaming blocks, etc.)
  clone.querySelectorAll('pre').forEach(pre => {
    const placeholder = document.createTextNode(' (code omitted) ');
    pre.replaceWith(placeholder);
  });
  // Unwrap inline <code> — keep the text, just remove the element wrapper
  clone.querySelectorAll('code').forEach(c => c.replaceWith(c.textContent));
  // Add periods after list items so TTS pauses between them;
  // for ordered lists, prepend the item number so it's spoken aloud
  clone.querySelectorAll('ol').forEach(ol => {
    Array.from(ol.querySelectorAll(':scope > li')).forEach((li, i) => {
      li.prepend(document.createTextNode(`${i + 1}: `));
      if (!/[.!?]\s*$/.test(li.textContent)) {
        li.appendChild(document.createTextNode('.'));
      }
    });
  });
  clone.querySelectorAll('ul > li').forEach(li => {
    if (!/[.!?]\s*$/.test(li.textContent)) {
      li.appendChild(document.createTextNode('.'));
    }
  });
  return clone.innerText;
}

// === Streaming TTS: progressive sentence-by-sentence playback during response streaming ===

function ttsStreamReset() {
  // Abort any in-flight synthesis prefetches so their fetches don't leak or try to play
  for (const item of ttsStreamQueue) {
    if (item && item.controller) {
      try { item.controller.abort(); } catch (_) { /* already aborted */ }
    }
  }
  ttsStreamQueue = [];
  ttsStreamRawText = '';
  ttsStreamSentCount = 0;
  ttsStreamActive = false;
  ttsStreamConsuming = false;
  ttsStreamDone = false;
  ttsInFlightPrefetches = 0;
}

function ttsStreamEnqueue(sentence) {
  const item = { text: sentence };
  // Prefetch synthesis for Google Cloud so audio is (usually) ready by the time it pops
  if (ttsProvider === 'google-cloud') {
    ttsStreamStartPrefetch(item);
  }
  ttsStreamQueue.push(item);
}

function ttsStreamStartPrefetch(item) {
  if (ttsInFlightPrefetches >= TTS_PREFETCH_CAP) return; // cap reached; consumer will kick off later
  if (item.audioPromise) return;                         // already prefetching
  const controller = new AbortController();
  item.controller = controller;
  ttsInFlightPrefetches++;
  item.audioPromise = ttsFetchSynthesis(item.text, controller.signal).finally(() => {
    ttsInFlightPrefetches--;
    ttsStreamMaybePrefetchNext();
  });
}

function ttsStreamMaybePrefetchNext() {
  if (ttsInFlightPrefetches >= TTS_PREFETCH_CAP) return;
  const next = ttsStreamQueue.find((it) => it && !it.audioPromise);
  if (next && ttsProvider === 'google-cloud') ttsStreamStartPrefetch(next);
}

async function ttsFetchSynthesis(text, signal) {
  const voiceName = localStorage.getItem('chat-bridge-tts-google-voice') || '';
  const rate = parseFloat(localStorage.getItem('chat-bridge-tts-rate') || '1.0');
  const resp = await fetch('/api/tts/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voiceName: voiceName || undefined, speakingRate: rate }),
    signal,
  });
  if (!resp.ok) throw new Error('synthesize ' + resp.status);
  const data = await resp.json();
  return data.audioContent; // base64 MP3
}

function ttsStreamStart(messageEl) {
  // Stop any existing playback FIRST (stopSpeaking calls ttsStreamReset internally)
  stopSpeaking();
  // Now set up fresh streaming TTS state
  ttsStreamReset();
  ttsStreamActive = true;
  ttsStreamStarted = true;
  ttsGoogleCancelled = false;
  // Set up speaking indicators
  ttsSpeakingEl = messageEl;
  if (messageEl) messageEl.classList.add('tts-speaking');
  // Start face animation for browser TTS (Google Cloud hooks in per-chunk via ttsFaceConnectAudio)
  if (ttsProvider !== 'google-cloud') ttsFaceBrowserStart();
  // Start Chrome keepalive for browser TTS
  if (ttsProvider !== 'google-cloud' && !isIOS) {
    ttsKeepAlive = setInterval(() => {
      if (speechSynthesis.speaking) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, 10000);
  }
  console.log('[TTS:Stream] started progressive playback');
}

function ttsStreamAppend(delta) {
  if (!ttsStreamActive) return;
  ttsStreamRawText += delta;

  // Don't process while inside an unclosed code block — content would be spoken as text
  // and sentence count would shift when the block closes, causing skipped sentences
  const fences = ttsStreamRawText.match(/```/g);
  if (fences && fences.length % 2 !== 0) return;

  const clean = stripForTTS(ttsStreamRawText);
  // Only extract COMPLETE sentences (with terminal punctuation)
  const completeSentences = clean.match(/[^.!?]+[.!?]+/g) || [];

  // Queue any new complete sentences
  while (ttsStreamSentCount < completeSentences.length) {
    const sentence = completeSentences[ttsStreamSentCount].trim();
    if (sentence) {
      ttsStreamEnqueue(sentence);
      console.log('[TTS:Stream] queued sentence', ttsStreamSentCount, `(${sentence.length} chars)`);
    }
    ttsStreamSentCount++;
  }

  // Start consumer if not already running
  if (ttsStreamQueue.length > 0 && !ttsStreamConsuming) {
    ttsStreamConsumeNext();
  }
}

function ttsStreamFlush() {
  if (!ttsStreamActive && !ttsStreamStarted) return;
  if (ttsStreamDone) return; // already flushed or stopped

  const clean = stripForTTS(ttsStreamRawText);
  // Include the final fragment (no terminal punctuation)
  const allSentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];

  while (ttsStreamSentCount < allSentences.length) {
    const sentence = allSentences[ttsStreamSentCount].trim();
    if (sentence) {
      ttsStreamEnqueue(sentence);
      console.log('[TTS:Stream] flush queued sentence', ttsStreamSentCount, `(${sentence.length} chars)`);
    }
    ttsStreamSentCount++;
  }

  ttsStreamDone = true;
  ttsStreamActive = false;
  console.log('[TTS:Stream] flushed, queue:', ttsStreamQueue.length, 'consuming:', ttsStreamConsuming);

  // Start consumer if not already running
  if (ttsStreamQueue.length > 0 && !ttsStreamConsuming) {
    ttsStreamConsumeNext();
  } else if (ttsStreamQueue.length === 0 && !ttsStreamConsuming) {
    onSpeakEnd();
  }
}

function ttsStreamToolUse() {
  // Text buffer was cleared by tool_use — reset tracking
  // Already-queued sentences continue playing
  ttsStreamRawText = '';
  ttsStreamSentCount = 0;
}

async function ttsStreamConsumeNext() {
  if (ttsGoogleCancelled) {
    ttsStreamConsuming = false;
    return;
  }

  if (ttsStreamQueue.length === 0) {
    ttsStreamConsuming = false;
    if (ttsStreamDone) {
      console.log('[TTS:Stream] playback complete');
      onSpeakEnd();
    } else {
      // Queue drained but more text may come — pause mouth, keep face visible
      ttsFacePauseMouth();
    }
    return;
  }

  ttsStreamConsuming = true;
  const item = ttsStreamQueue.shift();
  // Shifting opened a slot — prefetch the next unprefetched item if we're on Google Cloud
  ttsStreamMaybePrefetchNext();

  if (item.audioPromise) {
    // Prefetched (Google Cloud): await the in-flight fetch (usually already resolved) then play
    await ttsStreamPlayPrefetched(item);
  } else if (ttsProvider === 'google-cloud') {
    // Not prefetched — provider switched browser→google-cloud mid-stream. Fall back to inline synth.
    await ttsStreamSpeakGoogle(item.text);
  } else {
    // Restart mouth animation for this sentence (may have been paused between batches)
    if (!ttsFaceBrowserInterval) ttsFaceBrowserStart();
    await ttsStreamSpeakBrowser(item.text);
  }

  // Continue to next sentence
  ttsStreamConsumeNext();
}

function ttsStreamPlayPrefetched(item) {
  return new Promise(async (resolve) => {
    if (ttsGoogleCancelled) { resolve(); return; }
    try {
      const audioContent = await item.audioPromise;
      if (ttsGoogleCancelled) { resolve(); return; }
      const audio = ttsIOSAudioEl || new Audio();
      audio.src = 'data:audio/mp3;base64,' + audioContent;
      audio.load();
      ttsAudioEl = audio;
      audio.playbackRate = 1.0;
      audio.onended = () => resolve();
      audio.onerror = (e) => {
        console.warn('[TTS:Stream] Audio playback error:', e);
        resolve();
      };
      ttsFaceConnectAudio(audio);
      audio.play().catch(() => resolve());
    } catch (err) {
      if (err && err.name === 'AbortError') { resolve(); return; }
      console.warn('[TTS:Stream] Prefetch failed, falling back to browser:', err);
      await ttsStreamSpeakBrowser(item.text);
      resolve();
    }
  });
}

function ttsStreamSpeakGoogle(text) {
  return new Promise(async (resolve) => {
    if (ttsGoogleCancelled) { resolve(); return; }

    const voiceName = localStorage.getItem('chat-bridge-tts-google-voice') || '';
    const rate = parseFloat(localStorage.getItem('chat-bridge-tts-rate') || '1.0');

    try {
      const resp = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voiceName: voiceName || undefined,
          speakingRate: rate,
        }),
      });

      if (ttsGoogleCancelled) { resolve(); return; }

      if (!resp.ok) {
        console.warn('[TTS:Stream] Google API error, falling back to browser');
        await ttsStreamSpeakBrowser(text);
        resolve();
        return;
      }

      const data = await resp.json();
      const audio = ttsIOSAudioEl || new Audio();
      audio.src = 'data:audio/mp3;base64,' + data.audioContent;
      audio.load();
      ttsAudioEl = audio;
      audio.playbackRate = 1.0;
      audio.onended = () => resolve();
      audio.onerror = (e) => {
        console.warn('[TTS:Stream] Audio playback error:', e);
        resolve();
      };
      ttsFaceConnectAudio(audio);
      audio.play().catch(() => resolve());
    } catch (err) {
      console.warn('[TTS:Stream] Network error:', err);
      resolve();
    }
  });
}

function ttsStreamSpeakBrowser(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }

    const voice = getTTSVoice();
    const rate = parseFloat(localStorage.getItem('chat-bridge-tts-rate') || '1.0');

    // Split into sub-chunks if needed (browser utterance limit ~200 chars)
    const subSentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
    const chunks = [];
    let current = '';
    for (const s of subSentences) {
      if ((current + s).length > 200) {
        if (current) chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());

    let i = 0;
    function speakNextChunk() {
      if (i >= chunks.length) { resolve(); return; }
      const utterance = new SpeechSynthesisUtterance(chunks[i]);
      utterance.lang = 'en-US';
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onend = () => { i++; speakNextChunk(); };
      utterance.onerror = (e) => {
        if (e.error !== 'canceled') console.warn('[TTS:Stream] Browser error:', e.error);
        resolve();
      };
      ttsCurrentUtterance = utterance;
      speechSynthesis.speak(utterance);
    }

    if (isIOS && (speechSynthesis.speaking || speechSynthesis.pending)) {
      speechSynthesis.cancel();
      setTimeout(speakNextChunk, 50);
    } else {
      speakNextChunk();
    }
  });
}

// Preload voices (some browsers load async)
if (window.speechSynthesis) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => {
    speechSynthesis.getVoices();
    // Re-render voice picker if settings panel is showing Voice
    const container = document.getElementById('settings-content');
    if (container && activeSettingsSection === 'voice') renderVoiceSettings(container);
  };
}

function appendToInput(text) {
  if (!text) return;
  const existing = messageInput.value;
  const separator = existing && !existing.endsWith(' ') && !existing.endsWith('\n') ? ' ' : '';
  messageInput.value = existing + separator + text;
  messageInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function setAttachButtonVoiceMode(listening) {
  const btn = document.querySelector('.btn-attach');
  if (listening) {
    btn.classList.add('voice-active');
    btn.setAttribute('aria-label', 'Stop dictation');
    btn.onclick = (e) => { e.stopPropagation(); stopVoiceDictation(); };
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
      <line x1="4" y1="4" x2="20" y2="20"/>
    </svg>`;
  } else {
    btn.classList.remove('voice-active');
    btn.setAttribute('aria-label', 'Actions menu');
    btn.onclick = null; // long-press handler manages tap vs hold
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>`;
  }
}

function showVoiceIndicator() {
  setAttachButtonVoiceMode(true);
  let indicator = document.getElementById('voice-indicator');
  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'voice-indicator';
    indicator.innerHTML = `
      <div class="voice-indicator-content">
        <span class="voice-pulse"></span>
        <span class="voice-label">Listening...</span>
        <span class="voice-preview"></span>
      </div>
    `;
    document.querySelector('.input-wrapper').appendChild(indicator);
  }
  indicator.style.display = 'flex';
}

function hideVoiceIndicator() {
  setAttachButtonVoiceMode(false);
  const indicator = document.getElementById('voice-indicator');
  if (indicator) indicator.style.display = 'none';
}

function updateVoicePreview(interim) {
  const preview = document.querySelector('.voice-preview');
  if (preview) {
    preview.textContent = interim || '';
  }
}

function fireCommand(command) {
  closeActionMenu();
  if (!currentSessionId) return;
  messageInput.value = command;
  sendMessage();
}

// Close action menu when clicking outside
document.addEventListener('click', (e) => {
  const wrapper = e.target.closest('.action-menu-wrapper');
  if (!wrapper) closeActionMenu();
});

// Build menu immediately (script loads after DOM)
buildActionMenu();
loadWelcomeSessions();

// Long-press on + button triggers voice dictation directly
(function initAttachButtonLongPress() {
  const btn = document.querySelector('.btn-attach');
  let longPressTimer = null;
  let didLongPress = false;

  function hasSpeechRecognition() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  // On iOS, skip long-press dictation — native keyboard dictation is more reliable.
  // Just use normal click for the action menu.
  if (isIOS) {
    btn.addEventListener('click', () => {
      if (!voiceIsListening) toggleActionMenu();
    });
  } else {
    btn.addEventListener('pointerdown', (e) => {
      if (voiceIsListening) return; // already listening — let click handler stop it
      didLongPress = false;
      longPressTimer = setTimeout(() => {
        didLongPress = true;
        if (hasSpeechRecognition()) {
          closeActionMenu();
          startVoiceDictation();
        }
      }, 400);
    });

    btn.addEventListener('pointerup', (e) => {
      clearTimeout(longPressTimer);
      if (e.button !== 0) return; // right-click handled by contextmenu — don't toggle menu
      if (!didLongPress && !voiceIsListening) {
        toggleActionMenu();
      }
    });

    // Swallow the synthetic click that desktop touch devices may fire after pointerup
    btn.addEventListener('click', (e) => {
      if (didLongPress) {
        didLongPress = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    });

    btn.addEventListener('pointercancel', () => {
      clearTimeout(longPressTimer);
      didLongPress = false;
    });

    // Right-click: start dictation on desktop
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (didLongPress) return; // long-press already handled it
      if (hasSpeechRecognition() && !voiceIsListening) {
        closeActionMenu();
        startVoiceDictation();
      }
    });
  }
})();

function switchWelcomeTab(tab) {
  const welcome = document.getElementById('welcome');
  welcome.querySelectorAll('.welcome-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.getElementById('welcome-sessions').style.display = tab === 'sessions' ? '' : 'none';
  document.getElementById('welcome-sessions').classList.toggle('active', tab === 'sessions');
  document.getElementById('welcome-topics').style.display = tab === 'topics' ? '' : 'none';
  document.getElementById('welcome-topics').classList.toggle('active', tab === 'topics');
  if (tab === 'topics' && !document.getElementById('welcome-topics').dataset.loaded) {
    loadWelcomeTopics();
  }
}

function switchKbWelcomeTab(tab) {
  const kbWelcome = document.getElementById('kb-welcome');
  kbWelcome.querySelectorAll('.welcome-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'kb-' + tab));
  document.getElementById('kb-welcome-sessions').style.display = tab === 'sessions' ? '' : 'none';
  document.getElementById('kb-welcome-sessions').classList.toggle('active', tab === 'sessions');
  document.getElementById('kb-welcome-topics').style.display = tab === 'topics' ? '' : 'none';
  document.getElementById('kb-welcome-topics').classList.toggle('active', tab === 'topics');
  if (tab === 'topics' && !document.getElementById('kb-welcome-topics').dataset.loaded) {
    loadWelcomeTopics();
  }
}

async function loadWelcomeSessions() {
  const containers = [
    document.getElementById('welcome-sessions'),
    document.getElementById('kb-welcome-sessions'),
  ].filter(Boolean);
  if (containers.length === 0) return;
  containers.forEach(c => {
    if (!c.children.length) c.innerHTML = '<div class="welcome-loading">Loading sessions…</div>';
  });
  try {
    const res = await fetchWithRetry(`/api/vault/sessions?mode=${currentMode}&currentDir=${encodeURIComponent(currentWorkingDir)}`, {}, { retries: 1 });
    const data = await res.json();
    const groups = data && data.groups;
    if (!groups || groups.length === 0) {
      containers.forEach(c => c.innerHTML = '');
      return;
    }
    const html = `<h3 class="welcome-sessions-title">Recent Sessions</h3>` +
      groups.map(group => {
        const header = `<div class="welcome-group-header">${escapeHtml(group.dirLabel)}${group.current ? ' <span class="welcome-group-current">(current)</span>' : ''}</div>`;
        const items = group.sessions.map(s => {
          return `<button class="welcome-session-item" onclick="openSessionInKb('${s.vaultPath.replace(/'/g, "\\'")}')">
            <span class="welcome-session-name">${escapeHtml(s.name)}</span>
            <span class="welcome-session-date">${s.date}</span>
          </button>`;
        }).join('');
        return header + items;
      }).join('');
    containers.forEach(c => c.innerHTML = html);
  } catch {
    containers.forEach(c => c.innerHTML = '');
  }
}

async function loadWelcomeTopics() {
  const containers = [
    document.getElementById('welcome-topics'),
    document.getElementById('kb-welcome-topics'),
  ].filter(Boolean);
  if (containers.length === 0) return;
  containers.forEach(c => {
    if (!c.children.length || !c.dataset.loaded) c.innerHTML = '<div class="welcome-loading">Loading topics…</div>';
  });
  try {
    const res = await fetchWithRetry(`/api/vault/topics?mode=${currentMode}`, {}, { retries: 1 });
    const data = await res.json();
    const topics = data && data.topics;
    if (!topics || topics.length === 0) {
      containers.forEach(c => { c.innerHTML = '<p class="welcome-hint">No topics found.</p>'; });
      return;
    }
    const html = `<h3 class="welcome-sessions-title">Recent Topics</h3>` +
      topics.map(t => {
        return `<button class="welcome-session-item" onclick="openSessionInKb('${t.vaultPath.replace(/'/g, "\\'")}')">
          <span class="welcome-session-name">${escapeHtml(t.name.replace(/-/g, ' '))}</span>
          <span class="welcome-session-date">${t.modified}</span>
        </button>`;
      }).join('');
    containers.forEach(c => { c.innerHTML = html; c.dataset.loaded = '1'; });
  } catch {
    containers.forEach(c => { c.innerHTML = ''; });
  }
}

function openSessionInKb(vaultPath) {
  kbPendingNavigation = vaultPath;
  switchView('kb');
  loadKbFile(vaultPath);
}

// Auto-resize textarea
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// Keyboard handling
// ============================================================================
// @-mention picker — restricts to allowed paths from MCP settings (mirrors
// the directory picker's allowlist) and supports a `@vault:` namespace that
// searches all vaults of the current mode. Selected items are inserted as
// literal `@<absolute-path>` tokens that the spawned `claude -p` expands
// natively at the CLI layer (verified to work with --add-dir injected by
// claude-runner).
// ============================================================================
const mentionState = {
  open: false,
  start: -1,
  query: '',           // full token after '@' (may include 'vault:' prefix)
  strippedQuery: '',   // query with 'vault:' prefix removed when in vault mode
  vaultMode: false,
  scopedDir: null,     // absolute dir path when user has Tab-descended into a directory
  scopedLabel: null,   // short breadcrumb label for scopedDir
  results: [],
  selectedIdx: 0,
  fetchSeq: 0,
  popoverEl: null,
};
const MENTION_FETCH_DEBOUNCE_MS = 150;
let mentionFetchTimer = null;

function ensureMentionPopover() {
  if (mentionState.popoverEl) return mentionState.popoverEl;
  const el = document.createElement('div');
  el.id = 'mention-popover';
  el.className = 'mention-popover';
  el.style.display = 'none';
  document.body.appendChild(el);
  mentionState.popoverEl = el;
  return el;
}

function closeMentionPopover() {
  mentionState.open = false;
  mentionState.results = [];
  mentionState.selectedIdx = 0;
  mentionState.scopedDir = null;
  mentionState.scopedLabel = null;
  mentionState.strippedQuery = '';
  mentionState.fetchSeq++;
  if (mentionFetchTimer) { clearTimeout(mentionFetchTimer); mentionFetchTimer = null; }
  if (mentionState.popoverEl) mentionState.popoverEl.style.display = 'none';
}

function detectMentionToken() {
  const v = messageInput.value;
  const cursor = messageInput.selectionStart;
  let i = cursor - 1;
  while (i >= 0) {
    const ch = v[i];
    if (ch === '@') {
      if (i === 0 || /\s/.test(v[i - 1])) {
        const tail = v.slice(i + 1, cursor);
        if (!/\s/.test(tail)) return { start: i, query: tail };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

function escapeMentionHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function scrollSelectedMentionIntoView(el, selectedIdx) {
  const item = el.querySelector(`.mention-item[data-idx="${selectedIdx}"]`);
  if (!item) return;
  requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
}

function positionMentionPopover() {
  const rect = messageInput.getBoundingClientRect();
  const el = mentionState.popoverEl;
  el.style.left = `${rect.left}px`;
  el.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  el.style.width = `${Math.min(Math.max(rect.width, 320), 520)}px`;
}

function renderMentionPopover() {
  const el = ensureMentionPopover();
  const breadcrumb = mentionState.scopedDir
    ? `<div class="mention-breadcrumb"><span class="mention-breadcrumb-arrow">↳</span><span class="mention-breadcrumb-path">${escapeMentionHtml(mentionState.scopedLabel || mentionState.scopedDir)}</span><span class="mention-breadcrumb-hint">Backspace to exit</span></div>`
    : '';
  if (!mentionState.results.length) {
    el.innerHTML = breadcrumb + '<div class="mention-empty">No matches</div>';
  } else {
    const items = mentionState.results.map((r, idx) => {
      const cls = idx === mentionState.selectedIdx ? 'mention-item selected' : 'mention-item';
      const icon = r.isDirectory ? '📁' : '📄';
      const vault = r.vault ? `<span class="mention-vault">${escapeMentionHtml(r.vault)}</span>` : '';
      return `<div class="${cls}" data-idx="${idx}"><span class="mention-icon">${icon}</span><span class="mention-name">${escapeMentionHtml(r.name)}</span>${vault}<span class="mention-path">${escapeMentionHtml(r.path)}</span></div>`;
    }).join('');
    el.innerHTML = breadcrumb + items;
    el.querySelectorAll('.mention-item').forEach(itemEl => {
      itemEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyMentionSelection(parseInt(itemEl.getAttribute('data-idx'), 10));
      });
    });
  }
  positionMentionPopover();
  el.style.display = 'block';
  scrollSelectedMentionIntoView(el, mentionState.selectedIdx);
}

async function fetchMentionResults(query, vaultMode) {
  const seq = ++mentionState.fetchSeq;
  const endpoint = vaultMode ? '/api/sessions/dirs/vault-search' : '/api/sessions/dirs/search';
  const params = new URLSearchParams({ q: query, limit: '20' });
  if (vaultMode) params.set('mode', currentMode);
  if (mentionState.scopedDir) params.set('scope', mentionState.scopedDir);
  try {
    const r = await fetch(`${endpoint}?${params.toString()}`);
    if (seq !== mentionState.fetchSeq) return;
    if (!r.ok) {
      if (r.status === 403) {
        // Scope rejected (allowed paths may have shifted) — drop it and retry once.
        mentionState.scopedDir = null;
        mentionState.scopedLabel = null;
        fetchMentionResults(query, vaultMode);
      }
      return;
    }
    const results = await r.json();
    mentionState.results = results;
    mentionState.selectedIdx = 0;
    renderMentionPopover();
  } catch {}
}

function scheduleMentionFetch(query, vaultMode) {
  if (mentionFetchTimer) clearTimeout(mentionFetchTimer);
  mentionFetchTimer = setTimeout(() => fetchMentionResults(query, vaultMode), MENTION_FETCH_DEBOUNCE_MS);
}

function applyMentionSelection(idx) {
  if (idx < 0 || idx >= mentionState.results.length) return;
  const chosen = mentionState.results[idx];
  const v = messageInput.value;
  const cursor = messageInput.selectionStart;
  const before = v.slice(0, mentionState.start);
  const after = v.slice(cursor);
  const insertion = `@${chosen.path} `;
  messageInput.value = before + insertion + after;
  const newCursor = before.length + insertion.length;
  messageInput.setSelectionRange(newCursor, newCursor);
  closeMentionPopover();
  messageInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function updateMentionPicker() {
  const tok = detectMentionToken();
  if (!tok) {
    closeMentionPopover();
    return;
  }
  const vaultMode = tok.query.startsWith('vault:');
  const query = vaultMode ? tok.query.slice('vault:'.length) : tok.query;
  // Switching between vault-mode and regular mode invalidates any scope the user
  // had established in the other namespace — its allowed-path validation differs.
  if (mentionState.open && mentionState.vaultMode !== vaultMode && mentionState.scopedDir) {
    mentionState.scopedDir = null;
    mentionState.scopedLabel = null;
  }
  mentionState.open = true;
  mentionState.start = tok.start;
  mentionState.query = tok.query;
  mentionState.strippedQuery = query;
  mentionState.vaultMode = vaultMode;
  scheduleMentionFetch(query, vaultMode);
}

function buildScopedLabel(absPath) {
  const parts = String(absPath).replace(/\/+$/, '').split('/').filter(Boolean);
  const tail = parts.slice(-3).join('/');
  return (parts.length > 3 ? '…/' : '/') + tail + '/';
}

function descendIntoDirectory(idx) {
  if (idx < 0 || idx >= mentionState.results.length) return false;
  const chosen = mentionState.results[idx];
  if (!chosen || !chosen.isDirectory) return false;
  // Clear the typed query text from the input, keeping '@' (and 'vault:' if in vault mode).
  const prefixLen = 1 + (mentionState.vaultMode ? 'vault:'.length : 0);
  const queryStart = mentionState.start + prefixLen;
  const v = messageInput.value;
  const cursor = messageInput.selectionStart;
  messageInput.value = v.slice(0, queryStart) + v.slice(cursor);
  messageInput.setSelectionRange(queryStart, queryStart);
  mentionState.scopedDir = chosen.path;
  mentionState.scopedLabel = buildScopedLabel(chosen.path);
  mentionState.query = mentionState.vaultMode ? 'vault:' : '';
  mentionState.strippedQuery = '';
  mentionState.selectedIdx = 0;
  // Fetch scoped-and-empty so the popover shows the contents of the chosen directory.
  scheduleMentionFetch('', mentionState.vaultMode);
  return true;
}

function handleMentionKeydown(e) {
  if (!mentionState.open) return false;
  if (e.key === 'ArrowDown' && mentionState.results.length) {
    e.preventDefault();
    mentionState.selectedIdx = (mentionState.selectedIdx + 1) % mentionState.results.length;
    renderMentionPopover();
    return true;
  }
  if (e.key === 'ArrowUp' && mentionState.results.length) {
    e.preventDefault();
    mentionState.selectedIdx = (mentionState.selectedIdx - 1 + mentionState.results.length) % mentionState.results.length;
    renderMentionPopover();
    return true;
  }
  // Tab on a directory → descend into it; on anything else → pick and close.
  if (e.key === 'Tab' && !e.shiftKey && mentionState.results.length) {
    const chosen = mentionState.results[mentionState.selectedIdx];
    if (chosen && chosen.isDirectory) {
      e.preventDefault();
      descendIntoDirectory(mentionState.selectedIdx);
      return true;
    }
    e.preventDefault();
    applyMentionSelection(mentionState.selectedIdx);
    return true;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && mentionState.results.length) {
    e.preventDefault();
    applyMentionSelection(mentionState.selectedIdx);
    return true;
  }
  // Backspace at an empty scoped query exits the scope but preserves the '@' token.
  if (e.key === 'Backspace' && mentionState.scopedDir && mentionState.strippedQuery === '') {
    e.preventDefault();
    mentionState.scopedDir = null;
    mentionState.scopedLabel = null;
    mentionState.selectedIdx = 0;
    scheduleMentionFetch(mentionState.strippedQuery, mentionState.vaultMode);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMentionPopover();
    return true;
  }
  return false;
}

messageInput.addEventListener('input', updateMentionPicker);
messageInput.addEventListener('blur', () => setTimeout(closeMentionPopover, 120));
window.addEventListener('resize', () => { if (mentionState.open) positionMentionPopover(); });

function handleKeydown(e) {
  if (handleMentionKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// Sessions
async function loadSessions() {
  // Show loading if sidebar is empty
  if (!sessionListEl.children.length) {
    sessionListEl.innerHTML = '<div class="sidebar-loading">Loading sessions…</div>';
  }
  try {
    const [activeRes, archivedRes, trashedRes] = await Promise.all([
      fetchWithRetry(`/api/sessions?mode=${currentMode}`, {}, { retries: 2 }),
      fetchWithRetry(`/api/sessions?mode=${currentMode}&archived=true`, {}, { retries: 2 }),
      fetchWithRetry(`/api/sessions?mode=${currentMode}&trashed=true`, {}, { retries: 2 }),
    ]);
    const activeSessions = await activeRes.json();
    const allSessions = await archivedRes.json();
    const archivedSessions = allSessions.filter(s => s.archived);
    const trashedSessions = await trashedRes.json();
    renderSessionList(activeSessions);
    renderArchiveList(archivedSessions);
    renderTrashList(trashedSessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
    // Keep existing content if available, otherwise show error
    if (!sessionListEl.querySelector('.session-item')) {
      sessionListEl.innerHTML = '<div class="sidebar-loading">Failed to load sessions</div>';
    }
  }
}

function renderSessionItem(s, isArchived, { forkDepth = 0, isLastFork = false, forkCount = 0, isTrashed = false } = {}) {
  const isFork = forkDepth > 0;
  let actions;
  if (isTrashed) {
    actions = `<div class="session-item-actions">
         <button class="session-item-action" onclick="event.stopPropagation(); restoreSessionItem('${s.id}')" title="Restore">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
         </button>
         <button class="session-item-action session-item-action-danger" onclick="event.stopPropagation(); permanentlyDeleteSessionItem('${s.id}')" title="Delete permanently">&times;</button>
       </div>`;
  } else if (isArchived) {
    actions = `<div class="session-item-actions">
         <button class="session-item-action" onclick="event.stopPropagation(); unarchiveSessionItem('${s.id}')" title="Unarchive">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
         </button>
         <button class="session-item-action session-item-action-danger" onclick="event.stopPropagation(); deleteSessionItem('${s.id}')" title="Delete">&times;</button>
       </div>`;
  } else {
    actions = `<div class="session-item-actions">
         <button class="session-item-action" onclick="event.stopPropagation(); archiveSessionItem('${s.id}')" title="Archive">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
         </button>
         <button class="session-item-action session-item-action-danger" onclick="event.stopPropagation(); deleteSessionItem('${s.id}')" title="Delete">&times;</button>
       </div>`;
  }

  const forkBadge = forkCount > 0
    ? `<span class="session-fork-badge" title="${forkCount} fork${forkCount > 1 ? 's' : ''}"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="3" r="1"/><circle cx="6" cy="21" r="1"/><circle cx="18" cy="21" r="1"/><path d="M12 4v6m0 0c-3.5 0-6 4-6 10m6-10c3.5 0 6 4 6 10"/></svg>${forkCount}</span>`
    : '';

  const forkClasses = isFork ? `session-item-fork${isLastFork ? ' session-item-fork-last' : ''}` : '';
  const indentStyle = forkDepth > 0 ? ` style="margin-left:${forkDepth * 20}px"` : '';

  return `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''} ${isArchived ? 'archived' : ''} ${isTrashed ? 'trashed' : ''} ${s.closedAt ? 'closed' : ''} ${activeSessionIds.has(s.id) ? 'working' : ''} ${forkClasses}"
         onclick="switchSession('${s.id}')"${indentStyle}>
      ${isFork ? '<span class="session-fork-branch"></span>' : ''}
      ${actions}
      <div class="session-item-name" ondblclick="event.stopPropagation(); renameSession('${s.id}', this)">${permissionBlockedSessions.has(s.id) ? '<span class="session-blocked-badge" title="Waiting for permission">!</span>' : ''}${s.closedAt ? `<span class="session-closed-badge" title="Session closed"${permissionBlockedSessions.has(s.id) ? ' style="display:none"' : ''}>&#10003;</span>` : s.usedCodeFile ? `<span class="session-code-badge" title="Code changes made"${permissionBlockedSessions.has(s.id) ? ' style="display:none"' : ''}>&lt;/&gt;</span>` : s.usedAgent ? `<span class="session-agent-badge" title="Used subagents"${permissionBlockedSessions.has(s.id) ? ' style="display:none"' : ''}>&#9889;</span>` : s.usedVaultDoc ? `<span class="session-doc-badge" title="Vault document edited"${permissionBlockedSessions.has(s.id) ? ' style="display:none"' : ''}>&#9998;</span>` : ''}${forkBadge}${escapeHtml(s.name)}</div>
      ${s.lastMessage ? `<div class="session-item-preview">${escapeHtml(s.lastMessage)}</div>` : ''}
      <div class="session-item-meta">
        <span>${s.messageCount} msgs</span>
        ${s.workingDir ? `<span class="session-item-dir">${s.workingDir.split('/').pop()}</span>` : ''}
        <span>${formatTime(s.lastActivity)}</span>
      </div>
    </div>`;
}

function buildForkTree(sessions) {
  const sessionIds = new Set(sessions.map(s => s.id));
  const forksByParent = new Map();
  const forkIds = new Set();
  for (const s of sessions) {
    if (s.forkedFrom?.sessionId && sessionIds.has(s.forkedFrom.sessionId)) {
      const parentId = s.forkedFrom.sessionId;
      if (!forksByParent.has(parentId)) forksByParent.set(parentId, []);
      forksByParent.get(parentId).push(s);
      forkIds.add(s.id);
    }
    // Orphaned forks (parent deleted/archived) render at top level naturally
  }
  return { forksByParent, forkIds };
}

function renderForkChildren(html, parentId, isArchived, forksByParent, depth, { isTrashed = false } = {}) {
  const forks = forksByParent.get(parentId) || [];
  forks.forEach((fork, i) => {
    const childForks = forksByParent.get(fork.id) || [];
    const isLastInGroup = i === forks.length - 1;
    html.push(renderSessionItem(fork, isArchived, {
      forkDepth: depth,
      isLastFork: isLastInGroup,
      forkCount: childForks.length,
      isTrashed,
    }));
    // Recurse into nested forks at the same depth (they visually chain downward)
    if (childForks.length > 0) {
      renderForkChildren(html, fork.id, isArchived, forksByParent, depth + 1, { isTrashed });
    }
  });
}

function renderSessionList(sessions) {
  const { forksByParent, forkIds } = buildForkTree(sessions);
  const html = [];
  for (const s of sessions) {
    if (forkIds.has(s.id)) continue;
    const forks = forksByParent.get(s.id) || [];
    html.push(renderSessionItem(s, false, { forkCount: forks.length }));
    renderForkChildren(html, s.id, false, forksByParent, 1);
  }
  sessionListEl.innerHTML = html.join('');
}

function renderArchiveList(sessions) {
  const countEl = document.getElementById('archive-count');
  const listEl = document.getElementById('archive-list');
  countEl.textContent = sessions.length;
  if (!sessions.length) {
    listEl.innerHTML = '<div class="archive-empty">No archived sessions</div>';
    return;
  }
  const { forksByParent, forkIds } = buildForkTree(sessions);
  const html = [];
  for (const s of sessions) {
    if (forkIds.has(s.id)) continue;
    const forks = forksByParent.get(s.id) || [];
    html.push(renderSessionItem(s, true, { forkCount: forks.length }));
    renderForkChildren(html, s.id, true, forksByParent, 1);
  }
  listEl.innerHTML = html.join('');
}

function toggleArchiveSection() {
  const listEl = document.getElementById('archive-list');
  const chevron = document.querySelector('.archive-chevron');
  const isOpen = listEl.style.display !== 'none';
  listEl.style.display = isOpen ? 'none' : 'block';
  chevron.classList.toggle('expanded', !isOpen);
}

async function archiveSessionItem(id) {
  try {
    await fetchWithRetry(`/api/sessions/${id}/archive`, { method: 'POST' });
    if (currentSessionId === id) {
      currentSessionId = null;
      chatTitle.textContent = getAppTitle();
      currentWorkingDir = '';
      currentSessionCreated = '';
      currentClosedAt = '';
      welcomeEl.style.display = '';
      inputArea.style.display = 'none';
      document.querySelector('.dir-picker-wrapper').style.display = 'none';
      document.getElementById('session-details-panel').style.display = 'none';
      clearMessages();
    }
    loadSessions();
  } catch (err) {
    console.error('Failed to archive session:', err);
  }
}

async function unarchiveSessionItem(id) {
  try {
    await fetchWithRetry(`/api/sessions/${id}/unarchive`, { method: 'POST' });
    loadSessions();
  } catch (err) {
    console.error('Failed to unarchive session:', err);
  }
}

function renderTrashList(sessions) {
  const countEl = document.getElementById('trash-count');
  const listEl = document.getElementById('trash-list');
  countEl.textContent = sessions.length;
  if (!sessions.length) {
    listEl.innerHTML = '<div class="trash-empty">No deleted sessions</div>';
    return;
  }
  const { forksByParent, forkIds } = buildForkTree(sessions);
  const html = [];
  for (const s of sessions) {
    if (forkIds.has(s.id)) continue;
    const forks = forksByParent.get(s.id) || [];
    html.push(renderSessionItem(s, false, { forkCount: forks.length, isTrashed: true }));
    renderForkChildren(html, s.id, false, forksByParent, 1, { isTrashed: true });
  }
  listEl.innerHTML = html.join('');
}

function toggleTrashSection() {
  const listEl = document.getElementById('trash-list');
  const chevron = document.querySelector('.trash-chevron');
  const isOpen = listEl.style.display !== 'none';
  listEl.style.display = isOpen ? 'none' : 'block';
  chevron.classList.toggle('expanded', !isOpen);
}

async function restoreSessionItem(id) {
  try {
    await fetchWithRetry(`/api/sessions/${id}/restore`, { method: 'POST' });
    loadSessions();
  } catch (err) {
    console.error('Failed to restore session:', err);
  }
}

async function permanentlyDeleteSessionItem(id) {
  if (!confirm('Permanently delete this session? This cannot be undone.')) return;
  try {
    await fetchWithRetry(`/api/sessions/${id}?permanent=true`, { method: 'DELETE' });
    sessionInputDrafts.delete(id);
    if (currentSessionId === id) {
      currentSessionId = null;
      chatTitle.textContent = getAppTitle();
      currentWorkingDir = '';
      currentSessionCreated = '';
      currentClosedAt = '';
      welcomeEl.style.display = '';
      inputArea.style.display = 'none';
      document.querySelector('.dir-picker-wrapper').style.display = 'none';
      document.getElementById('session-details-panel').style.display = 'none';
      clearMessages();
    }
    loadSessions();
  } catch (err) {
    console.error('Failed to permanently delete session:', err);
  }
}

// Rename via header title double-click
function renameCurrentSession() {
  if (!currentSessionId) {
    renameAppTitle();
    return;
  }
  startEditing(currentSessionId, chatTitle);
}

// App persona modal
async function renameAppTitle() {
  const overlay = document.getElementById('persona-overlay');
  const titleInput = document.getElementById('persona-title-input');
  const textarea = document.getElementById('persona-textarea');

  // Populate title
  titleInput.value = getAppTitle();

  // Fetch persona from server
  try {
    const res = await fetchWithRetry('/api/settings/persona');
    const data = await res.json();
    textarea.value = data.persona || '';
  } catch {
    textarea.value = '';
  }

  overlay.style.display = '';
  overlay.onclick = (e) => { if (e.target === overlay) closePersonaModal(); };
  titleInput.focus();
  titleInput.select();
}

function closePersonaModal() {
  document.getElementById('persona-overlay').style.display = 'none';
}

async function savePersonaModal() {
  const titleInput = document.getElementById('persona-title-input');
  const textarea = document.getElementById('persona-textarea');

  // Save title
  const title = titleInput.value.trim() || 'Claude Chat Bridge';
  localStorage.setItem('chat-bridge-app-title', title);
  chatTitle.textContent = title;
  document.title = title;

  // Save persona to server
  try {
    await fetchWithRetry('/api/settings/persona', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: textarea.value }),
    });
  } catch (err) {
    console.error('Failed to save persona:', err);
  }

  closePersonaModal();
}

// Rename via sidebar double-click
function renameSession(id, el) {
  startEditing(id, el);
}

// Shared rename logic
function startEditing(id, el) {
  const originalText = el.textContent;
  el.contentEditable = true;
  el.classList.add('editing');
  el.focus();
  // Select all text
  const range = document.createRange();
  range.selectNodeContents(el);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  async function finish() {
    el.contentEditable = false;
    el.classList.remove('editing');
    const name = el.textContent.trim();
    if (!name) {
      el.textContent = originalText;
      return;
    }
    if (name === originalText) return;
    try {
      await fetchWithRetry(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      chatTitle.textContent = name;
      loadSessions();
    } catch (err) {
      console.error('Failed to rename session:', err);
      el.textContent = originalText;
    }
  }

  el.onblur = finish;
  el.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.contentEditable = false; el.classList.remove('editing'); el.textContent = originalText; }
  };
}

// Title dropdown menu
function showTitleMenu(event) {
  // If no session, open persona modal (same as old double-click behavior)
  if (!currentSessionId) {
    renameAppTitle();
    return;
  }
  // If currently editing, don't show menu
  if (chatTitle.contentEditable === 'true') return;

  event.stopPropagation();
  const menu = document.getElementById('title-menu');
  if (menu.style.display !== 'none') {
    menu.style.display = 'none';
    return;
  }
  const detailsPanel = document.getElementById('session-details-panel');
  const detailsLabel = document.getElementById('title-menu-details-label');
  if (detailsLabel) {
    detailsLabel.textContent = detailsPanel && detailsPanel.style.display !== 'none'
      ? 'Hide Session Details'
      : 'View Session Details';
  }
  menu.style.display = 'block';

  // Close on outside click
  function closeMenu(e) {
    if (!menu.contains(e.target) && e.target !== chatTitle) {
      menu.style.display = 'none';
      document.removeEventListener('click', closeMenu);
    }
  }
  setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

function titleMenuRename() {
  document.getElementById('title-menu').style.display = 'none';
  renameCurrentSession();
}

function toggleSessionDetails() {
  document.getElementById('title-menu').style.display = 'none';
  const panel = document.getElementById('session-details-panel');
  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  buildSessionFileList();
}

function buildSessionFileList() {
  const vaultDocs = new Map(); // path -> type info
  const codeFiles = new Map();

  // Reset sections
  document.querySelectorAll('.session-details-section').forEach(s => s.classList.remove('expanded'));

  // Scan stored messages for tool calls
  if (!currentSessionId) return;

  fetchWithRetry(`/api/sessions/${currentSessionId}/messages`)
    .then(r => r.json())
    .then(msgs => {
      for (const msg of msgs) {
        if (msg.role !== 'tool') continue;
        try {
          const tool = JSON.parse(msg.content);
          const name = tool.name || '';

          // close_session Phase 2 creates the session document directly
          if (name.includes('close_session') && tool.input?.session_data?.sessionFile) {
            const fp = tool.input.session_data.sessionFile;
            if (!vaultDocs.has(fp)) {
              vaultDocs.set(fp, { strategy: 'session-close' });
            }
            continue;
          }

          if (!tool.input?.file_path) continue;
          const fp = tool.input.file_path;
          if (name.includes('update_document')) {
            if (!vaultDocs.has(fp)) {
              vaultDocs.set(fp, { strategy: tool.input.strategy || 'unknown' });
            }
          } else if (name.includes('code_file') || name === 'Edit' || name === 'Write') {
            if (!codeFiles.has(fp)) {
              codeFiles.set(fp, { operation: tool.input.operation || 'edit' });
            }
          }
        } catch {}
      }

      renderFileList('vault-docs-list', 'vault-docs-count', vaultDocs);
      renderFileList('code-files-list', 'code-files-count', codeFiles);

      // Auto-expand sections that have content
      document.querySelectorAll('.session-details-section').forEach(section => {
        const list = section.querySelector('.session-details-list');
        if (list && list.children.length > 0) {
          section.classList.add('expanded');
        }
      });

      // Load handoff notes for closed sessions
      loadHandoffNotes();
    })
    .catch(err => console.error('Failed to load session files:', err));
}

function renderFileList(listId, countId, fileMap) {
  const listEl = document.getElementById(listId);
  const countEl = document.getElementById(countId);
  countEl.textContent = `(${fileMap.size})`;

  if (fileMap.size === 0) {
    listEl.innerHTML = '<div class="session-details-empty">No files edited</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const [filePath] of fileMap) {
    const item = document.createElement('div');
    item.className = 'session-file-item';
    item.dataset.filePath = filePath;
    const shortPath = filePath.split('/').slice(-2).join('/');
    const header = document.createElement('div');
    header.className = 'session-file-header';
    header.innerHTML = `
      <span class="session-file-chevron">&#9654;</span>
      <span class="session-file-name">${escapeHtml(shortPath)}</span>
    `;
    header.onclick = (e) => { e.stopPropagation(); toggleFileDiff(item, filePath); };
    item.appendChild(header);
    const diffDiv = document.createElement('div');
    diffDiv.className = 'session-file-diff';
    item.appendChild(diffDiv);
    listEl.appendChild(item);
  }
}

async function toggleFileDiff(itemEl, filePath) {
  const diffEl = itemEl.querySelector('.session-file-diff');
  if (itemEl.classList.contains('diff-open')) {
    itemEl.classList.remove('diff-open');
    return;
  }

  // Check if already loaded
  if (diffEl.dataset.loaded) {
    itemEl.classList.add('diff-open');
    return;
  }

  diffEl.innerHTML = '<div class="session-details-loading">Loading diff...</div>';
  itemEl.classList.add('diff-open');

  try {
    const res = await fetchWithRetry(`/api/sessions/${currentSessionId}/file-diff?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.diff) {
      diffEl.innerHTML = `<pre class="tool-diff">${renderDiffBlock(data.diff)}</pre>`;
    } else {
      diffEl.innerHTML = `<div class="session-details-empty">${escapeHtml(data.message || 'No diff available')}</div>`;
    }
    diffEl.dataset.loaded = '1';
  } catch (err) {
    diffEl.innerHTML = '<div class="session-details-empty">Failed to load diff</div>';
  }
}

// Handoff notes display/editing
async function loadHandoffNotes() {
  const section = document.getElementById('handoff-section');
  const display = document.getElementById('handoff-display');
  const editor = document.getElementById('handoff-editor');

  // Hide by default
  section.style.display = 'none';
  editor.style.display = 'none';

  if (!currentClosedAt || !currentSessionId) return;

  try {
    const res = await fetchWithRetry(`/api/sessions/${currentSessionId}/handoff`);
    const data = await res.json();
    if (!data.handoff) return;

    display.innerHTML = escapeHtml(data.handoff).replace(/\n/g, '<br>');
    document.getElementById('handoff-textarea').value = data.handoff;
    section.style.display = '';
    section.classList.add('expanded');
  } catch {}
}

function toggleHandoffEdit() {
  const display = document.getElementById('handoff-display');
  const editor = document.getElementById('handoff-editor');
  const btn = document.getElementById('handoff-edit-btn');

  if (editor.style.display === 'none') {
    display.style.display = 'none';
    editor.style.display = '';
    btn.textContent = 'Cancel';
    document.getElementById('handoff-textarea').focus();
  } else {
    cancelHandoffEdit();
  }
}

function cancelHandoffEdit() {
  const display = document.getElementById('handoff-display');
  const editor = document.getElementById('handoff-editor');
  const btn = document.getElementById('handoff-edit-btn');

  editor.style.display = 'none';
  display.style.display = '';
  btn.textContent = 'Edit';
  // Reset textarea to current display content (innerText preserves <br> → \n)
  document.getElementById('handoff-textarea').value = display.innerText;
}

async function saveHandoff() {
  const textarea = document.getElementById('handoff-textarea');
  const handoff = textarea.value.trim();
  if (!currentSessionId) return;

  try {
    const res = await fetchWithRetry(`/api/sessions/${currentSessionId}/handoff`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handoff }),
    });

    const display = document.getElementById('handoff-display');
    display.innerHTML = escapeHtml(handoff).replace(/\n/g, '<br>');
    cancelHandoffEdit();
  } catch (err) {
    console.error('Failed to save handoff:', err);
  }
}

async function createNewSession() {
  if (!selectedNewChatDir) return;
  try {
    const res = await fetchWithRetry('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: selectedNewChatDir, model: getSelectedModel(), mode: currentMode }),
    });
    const session = await res.json();

    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    currentWorkingDir = session.workingDir || '';
    currentSessionCreated = session.created || '';
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    document.querySelector('.dir-picker-wrapper').style.display = '';
    document.getElementById('session-details-panel').style.display = 'none';
    clearMessages();
    loadSessions();
    // Reset sidebar dir picker for next time
    selectedNewChatDir = '';
    sidebarDirBtn.classList.remove('selected');
    sidebarDirBtn.title = '';
    newChatBtn.disabled = true;
    if (sidebar.classList.contains('open')) toggleSidebar();

    // Auto-send /vault:work or /vault:personal based on active mode tab
    const modeCommand = currentMode === 'personal' ? '/vault:personal' : '/vault:work';
    messageInput.value = modeCommand;
    sendMessage();
  } catch (err) {
    console.error('Failed to create session:', err);
  }
}

async function switchSession(id) {
  // Bump the switch counter so any in-flight switchSession() call from a
  // previous click bails at its next await instead of clobbering this one's
  // DOM with stale data. Without this, rapid A→B→A clicks can leave the
  // rendered view out of sync with currentSessionId (missing tool indicators,
  // duplicate messages, stream output that only reappears after refresh).
  const seq = ++switchSessionSeq;
  const stale = () => seq !== switchSessionSeq;
  // Stop any active TTS playback and force-hide face regardless of response state
  stopSpeaking();
  ttsFaceActivity = 'idle';
  ttsFaceResponseActive = false;
  ttsFaceHideImmediate();
  // Save current input draft before switching
  if (currentSessionId) {
    sessionInputDrafts.set(currentSessionId, messageInput.value);
  }
  currentSessionId = id;
  // Restore target session's draft
  messageInput.value = sessionInputDrafts.get(id) || '';
  messageInput.style.height = 'auto';
  const res = await fetchWithRetry(`/api/sessions/${id}`);
  if (stale()) return;
  const session = await res.json();
  if (stale()) return;
  chatTitle.textContent = session.name;
  currentWorkingDir = session.workingDir || '';
  currentForkDepth = session.forkDepth || 0;
  currentSessionCreated = session.created || '';
  currentClosedAt = session.closedAt || '';
  // Hide details panel when switching sessions
  document.getElementById('session-details-panel').style.display = 'none';
  // Restore session-specific model selection
  if (session.model) {
    modelSelect.value = session.model;
    localStorage.setItem('chat-bridge-model', session.model);
  }
  welcomeEl.style.display = 'none';
  inputArea.style.display = 'block';
  document.querySelector('.dir-picker-wrapper').style.display = '';
  const isStreamingOnEntry = streamingSessions.has(id);
  // Hijack BEFORE the await so the originating sendMessage()'s processEvent
  // stops rendering live events into the DOM while restoreMessages is in flight
  // (otherwise those same events get re-rendered by replaySessionStream from
  // the server buffer, producing duplicates).
  if (isStreamingOnEntry) hijackedStreams.add(id);
  await restoreMessages(id, session, { upToLastUser: isStreamingOnEntry });
  if (stale()) return;
  // Re-render queued message indicator (if any) — restoreMessages only renders
  // server-persisted messages; the queued one lives client-side until drained.
  if (pendingMessages.has(id)) {
    const queued = pendingMessages.get(id);
    renderQueuedMessage(id, queued.text, queued.attachments);
  }
  loadSessions();
  // Show correct button state for this session
  if (isStreamingOnEntry) {
    // Take over rendering via a fresh reconnect subscription so any content
    // that streamed while away is replayed, and live events continue to render.
    addTypingIndicator();
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'flex';
    messageInput.placeholder = 'Queue a message...';
    // Fire-and-forget — replaySessionStream runs until the server signals done
    // or the user switches away again. Not awaited so switchSession can return.
    replaySessionStream(id);
  } else {
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    messageInput.placeholder = 'Type a message...';
  }
  if (sidebar.classList.contains('open')) toggleSidebar();
  messageInput.focus();
  // Immediately check for pending permission on this session (don't wait for 2s poll)
  if (!pendingPermissionId && permissionBlockedSessions.has(id)) {
    try {
      const permRes = await fetchWithRetry(`/api/permissions/pending/${id}`);
      const pending = await permRes.json();
      if (pending && pending.id) {
        showPermissionDialog(pending.id, pending.toolName, pending.toolInput);
      }
    } catch (err) {
      console.error('[permission] immediate check failed:', err);
    }
  }
}

async function deleteSessionItem(id) {
  try {
    await fetchWithRetry(`/api/sessions/${id}`, { method: 'DELETE' });
    sessionInputDrafts.delete(id);
    if (currentSessionId === id) {
      currentSessionId = null;
      chatTitle.textContent = getAppTitle();
      currentWorkingDir = '';
      currentSessionCreated = '';
      currentClosedAt = '';
      welcomeEl.style.display = '';
      inputArea.style.display = 'none';
      document.querySelector('.dir-picker-wrapper').style.display = 'none';
      document.getElementById('session-details-panel').style.display = 'none';
      clearMessages();
    }
    loadSessions();
  } catch (err) {
    console.error('Failed to delete session:', err);
  }
}

// Messages
function clearMessages() {
  // Preserve the welcome element (it lives inside messagesEl)
  const welcome = welcomeEl.parentNode === messagesEl ? welcomeEl : null;
  messagesEl.innerHTML = '';
  if (welcome) messagesEl.appendChild(welcome);
}

function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'message message-user';
  el.textContent = text;
  ensureCopyButton(el);
  messagesEl.appendChild(el);
  scrollToBottomForce();
}

function addInfoMessage(text) {
  const el = document.createElement('div');
  el.className = 'message message-error';
  el.style.background = 'rgba(74, 158, 255, 0.1)';
  el.style.border = '1px solid rgba(74, 158, 255, 0.3)';
  el.style.color = 'var(--text-secondary)';
  el.textContent = text;
  messagesEl.appendChild(el);
}

// Render the user bubble + info bubble for a queued message. The bubbles carry
// data-queued-session attrs so cancel/drain can find them later (e.g. after a
// session-switch restoreMessages, which only renders server-persisted messages).
function renderQueuedMessage(sessionId, text, attachments) {
  const userEl = document.createElement('div');
  userEl.className = 'message message-user message-queued';
  userEl.dataset.queuedSession = sessionId;
  userEl.textContent = text;
  ensureCopyButton(userEl);
  messagesEl.appendChild(userEl);

  if (attachments && attachments.length) {
    const attachEl = document.createElement('div');
    attachEl.className = 'message message-error message-queued-attach';
    attachEl.dataset.queuedSession = sessionId;
    attachEl.style.background = 'rgba(74, 158, 255, 0.1)';
    attachEl.style.border = '1px solid rgba(74, 158, 255, 0.3)';
    attachEl.style.color = 'var(--text-secondary)';
    attachEl.textContent = `${attachments.length} image(s) attached`;
    messagesEl.appendChild(attachEl);
  }

  const infoEl = document.createElement('div');
  infoEl.className = 'message message-error message-queued-info';
  infoEl.dataset.queuedSession = sessionId;
  infoEl.style.background = 'rgba(74, 158, 255, 0.1)';
  infoEl.style.border = '1px solid rgba(74, 158, 255, 0.3)';
  infoEl.style.color = 'var(--text-secondary)';
  const textSpan = document.createElement('span');
  textSpan.textContent = '⏳ Message queued — will send when current response completes';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-cancel-queued';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => cancelQueuedMessage(sessionId));
  infoEl.appendChild(textSpan);
  infoEl.appendChild(document.createTextNode(' '));
  infoEl.appendChild(cancelBtn);
  messagesEl.appendChild(infoEl);
  scrollToBottomForce();
}

// Remove a queued message from the pending map and update the visible bubbles
// (only if the user is currently viewing the owning session — otherwise the
// bubbles aren't in the DOM and there's nothing to update).
function cancelQueuedMessage(sessionId) {
  if (!pendingMessages.has(sessionId)) return;
  pendingMessages.delete(sessionId);
  if (currentSessionId !== sessionId) return;
  messagesEl.querySelectorAll(
    `.message-queued[data-queued-session="${sessionId}"]`
  ).forEach(el => {
    el.classList.remove('message-queued');
    el.classList.add('message-cancelled');
  });
  messagesEl.querySelectorAll(
    `.message-queued-attach[data-queued-session="${sessionId}"]`
  ).forEach(el => el.remove());
  messagesEl.querySelectorAll(
    `.message-queued-info[data-queued-session="${sessionId}"]`
  ).forEach(el => {
    el.textContent = '✕ Message cancelled';
    el.classList.remove('message-queued-info');
    el.style.background = 'rgba(120, 120, 120, 0.08)';
    el.style.border = '1px solid rgba(120, 120, 120, 0.25)';
  });
}

// Drain transition: queued message is about to actually send. Strip the queued
// styling on the user bubble (it's now a real sent message) and remove the
// transient info/attachment bubbles.
function clearQueuedDecorations(sessionId) {
  if (currentSessionId !== sessionId) return;
  messagesEl.querySelectorAll(
    `.message-queued[data-queued-session="${sessionId}"]`
  ).forEach(el => {
    el.classList.remove('message-queued');
    delete el.dataset.queuedSession;
  });
  messagesEl.querySelectorAll(
    `.message-queued-info[data-queued-session="${sessionId}"], .message-queued-attach[data-queued-session="${sessionId}"]`
  ).forEach(el => el.remove());
}

// Background drain: send a queued message for a session the user is no longer
// viewing. Bypasses messageInput / currentSessionId (which now belong to a
// different session) and lets server-side persistence + replaySessionStream
// handle UI restoration if/when the user switches back.
async function drainQueuedMessage(sessionId, text, attachments) {
  streamingSessions.add(sessionId);
  try {
    const res = await fetch(`/api/chat/${sessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text || 'Please analyze the attached image(s).',
        model: getSelectedModel(),
        attachments,
      }),
    });
    if (!res.ok) {
      console.error(`drainQueuedMessage POST failed for ${sessionId}: HTTP ${res.status}`);
      return;
    }
    // Drain the SSE stream so the connection completes cleanly. processEvent
    // is a minimal stub — server-side persistence is independent of what we
    // render here, and switchSession's replaySessionStream picks up live state
    // when the user returns to this session.
    await readSSEStream(res, (type, data) => {
      if (type === 'permission_request') {
        updateSessionBlockedBadge(sessionId, true);
      }
    });
  } catch (err) {
    console.error(`drainQueuedMessage error for ${sessionId}:`, err);
  } finally {
    streamingSessions.delete(sessionId);
    updateSessionBlockedBadge(sessionId, false);
    // Recursively drain any further queued message for this background session.
    const queued = pendingMessages.get(sessionId);
    if (queued) {
      pendingMessages.delete(sessionId);
      await new Promise(r => setTimeout(r, 500));
      if (currentSessionId === sessionId) {
        clearQueuedDecorations(sessionId);
        messageInput.value = queued.text;
        if (queued.attachments) pendingAttachments.push(...queued.attachments);
        sendMessage(true);
      } else {
        drainQueuedMessage(sessionId, queued.text, queued.attachments);
      }
    }
    loadSessions();
  }
}

function addServerDisconnectedMessage() {
  if (document.getElementById('server-disconnected-msg')) return;
  const el = document.createElement('div');
  el.id = 'server-disconnected-msg';
  el.className = 'message message-error';
  el.style.background = 'rgba(255, 165, 0, 0.1)';
  el.style.border = '1px solid rgba(255, 165, 0, 0.35)';
  el.style.color = 'var(--text-secondary)';
  el.textContent = '⚠️ Server disconnected — the bridge may be restarting. Waiting for it to come back…';
  messagesEl.appendChild(el);
  scrollToBottom();
  startServerRecoveryPolling(el);
}

function startServerRecoveryPolling(disconnectedEl) {
  if (serverPollingActive) return;
  serverPollingActive = true;
  const interval = setInterval(async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        clearInterval(interval);
        serverPollingActive = false;
        const resolveServerDown = (el) => {
          el.style.background = 'rgba(74, 200, 74, 0.1)';
          el.style.border = '1px solid rgba(74, 200, 74, 0.35)';
          el.textContent = '✓ Server is back online — you can continue chatting';
          setTimeout(() => el.remove(), 5000);
        };
        resolveServerDown(disconnectedEl);
        // Also resolve any visible message from a session switch (different element, same id)
        const current = document.getElementById('server-disconnected-msg');
        if (current && current !== disconnectedEl) resolveServerDown(current);
      }
    } catch {
      // still down, keep polling
    }
  }, 3000);
}

/* ===== Server Heartbeat ===== */
// Periodically pings /api/health so we detect restarts even when idle (no active SSE stream).
// Skips checks while recovery polling is already active or the tab is hidden.
(function initServerHeartbeat() {
  let consecutiveFails = 0;
  const INTERVAL = 15000; // 15 seconds
  const FAIL_THRESHOLD = 2; // require 2 consecutive failures to avoid false positives

  setInterval(async () => {
    if (serverPollingActive || document.hidden) return;
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
      if (res.ok) { consecutiveFails = 0; return; }
      consecutiveFails++;
    } catch {
      consecutiveFails++;
    }
    if (consecutiveFails >= FAIL_THRESHOLD) {
      consecutiveFails = 0;
      addServerDisconnectedMessage();
    }
  }, INTERVAL);
})();

function addForkDivider(parentName, parentId, parentWorkingDir, workingDir, messageIndex) {
  const el = document.createElement('div');
  el.className = 'fork-divider';
  const inner = document.createElement('div');
  inner.className = 'fork-divider-inner';
  const label = document.createElement('span');
  label.className = 'fork-divider-label';
  // Build via DOM to avoid XSS from user-editable session names
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>';
  label.appendChild(svg);
  label.appendChild(document.createTextNode(' Forked from '));
  const strong = document.createElement('strong');
  strong.textContent = parentName;
  label.appendChild(strong);
  if (parentId) {
    label.style.cursor = 'pointer';
    label.title = 'Click to open parent session';
    label.onclick = () => switchSession(parentId);
  }
  inner.appendChild(label);
  // If the fork changed working directory, show the transition so the agent's
  // next turn has explicit signal that prior file paths belong to the parent.
  if (parentWorkingDir && workingDir && parentWorkingDir !== workingDir) {
    const cwdLine = document.createElement('span');
    cwdLine.className = 'fork-divider-cwd';
    cwdLine.textContent = parentWorkingDir + ' → ' + workingDir;
    cwdLine.title = 'Working directory changed at fork point';
    inner.appendChild(cwdLine);
  }
  el.appendChild(inner);
  // Place the divider immediately after the fork-point message so it renders
  // at the fork boundary even when post-fork messages are already present
  // (e.g. on page refresh). With no next message (fresh fork), append.
  const visibleMsgs = messagesEl.querySelectorAll('.message-user, .message-assistant');
  const nextMsg = typeof messageIndex === 'number' ? visibleMsgs[messageIndex + 1] : null;
  if (nextMsg) {
    messagesEl.insertBefore(el, nextMsg);
  } else {
    messagesEl.appendChild(el);
  }
}

function markForkPointMessage(messageIndex) {
  const visibleMsgs = messagesEl.querySelectorAll('.message-user, .message-assistant');
  const msgEl = visibleMsgs[messageIndex];
  if (!msgEl) return;
  const marker = document.createElement('div');
  marker.className = 'msg-fork-point-marker';
  marker.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg> fork point';
  msgEl.appendChild(marker);
}

function addForkBadges(forkPoints) {
  // forkPoints is { messageIndex: [{ id, name }] }
  const visibleMsgs = messagesEl.querySelectorAll('.message-user, .message-assistant');
  for (const [idx, forks] of Object.entries(forkPoints)) {
    const msgEl = visibleMsgs[Number(idx)];
    if (!msgEl) continue;
    const badge = document.createElement('div');
    badge.className = 'msg-fork-badge';
    const count = forks.length;
    badge.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="3" r="1"/><circle cx="6" cy="21" r="1"/><circle cx="18" cy="21" r="1"/><path d="M12 4v6m0 0c-3.5 0-6 4-6 10m6-10c3.5 0 6 4 6 10"/></svg> ${count}`;
    badge.title = forks.map(f => f.name).join(', ');
    // Clicking the badge navigates to the first (or only) fork
    if (count === 1) {
      badge.style.cursor = 'pointer';
      badge.onclick = (e) => { e.stopPropagation(); switchSession(forks[0].id); };
    } else {
      // Show a small picker for multiple forks
      badge.style.cursor = 'pointer';
      badge.onclick = (e) => {
        e.stopPropagation();
        showForkPicker(badge, forks);
      };
    }
    msgEl.appendChild(badge);
  }
}

function showForkPicker(anchor, forks) {
  // Remove any existing picker
  document.querySelectorAll('.fork-picker').forEach(el => el.remove());
  const picker = document.createElement('div');
  picker.className = 'fork-picker';
  for (const fork of forks) {
    const item = document.createElement('button');
    item.className = 'fork-picker-item';
    item.textContent = fork.name;
    item.onclick = (e) => { e.stopPropagation(); picker.remove(); switchSession(fork.id); };
    picker.appendChild(item);
  }
  anchor.parentElement.appendChild(picker);
  // Close on outside click
  const close = (e) => { if (!picker.contains(e.target)) { picker.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function createAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'message message-assistant';
  messagesEl.appendChild(el);
  return el;
}

function extractMessageContent(el) {
  const clone = el.cloneNode(true);
  // Remove the action menu elements from the clone
  const actionsBtn = clone.querySelector('.btn-msg-actions');
  if (actionsBtn) actionsBtn.remove();
  const actionsMenu = clone.querySelector('.msg-action-menu');
  if (actionsMenu) actionsMenu.remove();
  // Remove code block copy buttons
  clone.querySelectorAll('.btn-copy-code').forEach(b => b.remove());

  // Build HTML version (clean copy of the rendered content)
  const html = clone.innerHTML;

  // Build plain text version with markdown tables
  clone.querySelectorAll('table').forEach(table => {
    const rows = Array.from(table.querySelectorAll('tr'));
    if (!rows.length) return;

    const mdRows = rows.map(row => {
      const cells = Array.from(row.querySelectorAll('th, td'));
      return '| ' + cells.map(c => c.textContent.trim()).join(' | ') + ' |';
    });

    // Insert separator after header row if first row has <th> cells
    const firstRowCells = rows[0].querySelectorAll('th');
    if (firstRowCells.length > 0) {
      const sep = '| ' + Array.from(firstRowCells).map(() => '---').join(' | ') + ' |';
      mdRows.splice(1, 0, sep);
    }

    const textNode = document.createTextNode('\n' + mdRows.join('\n') + '\n');
    table.replaceWith(textNode);
  });

  return { html, text: clone.innerText };
}

function ensureCopyButton(el) {
  let btn = el.querySelector('.btn-msg-actions');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'btn-msg-actions';
    btn.title = 'Message actions';
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';

    const menu = document.createElement('div');
    menu.className = 'msg-action-menu';

    // Copy action
    const copyItem = document.createElement('button');
    copyItem.className = 'msg-action-menu-item';
    copyItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
    copyItem.onclick = (e) => {
      e.stopPropagation();
      closeAllMsgActionMenus();
      const { html, text } = extractMessageContent(el);
      const doCopy = navigator.clipboard?.write
        ? navigator.clipboard.write([
            new ClipboardItem({
              'text/html': new Blob([html], { type: 'text/html' }),
              'text/plain': new Blob([text], { type: 'text/plain' }),
            })
          ])
        : new Promise((resolve, reject) => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy') ? resolve() : reject();
            ta.remove();
          });
      doCopy.then(() => {
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
        setTimeout(() => {
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>';
        }, 1500);
      });
    };
    menu.appendChild(copyItem);

    // Reference action
    const refItem = document.createElement('button');
    refItem.className = 'msg-action-menu-item';
    refItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> Reference';
    refItem.onclick = (e) => {
      e.stopPropagation();
      closeAllMsgActionMenus();
      setReference(el);
    };
    menu.appendChild(refItem);

    // Speak action (TTS)
    if (window.speechSynthesis) {
      const speakItem = document.createElement('button');
      speakItem.className = 'msg-action-menu-item';
      speakItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg> Speak';
      speakItem.onclick = (e) => {
        e.stopPropagation();
        closeAllMsgActionMenus();
        speakAssistantMessage(el);
      };
      menu.appendChild(speakItem);
    }

    // Fork action — parent item with hover flyout for "up"/"down" choice.
    // Click on parent = fork up (default). Hover reveals explicit Fork up / Fork down.
    if (currentForkDepth < 2) {
      const forkWrap = document.createElement('div');
      forkWrap.className = 'msg-action-menu-item-wrap has-flyout';

      const forkIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>';

      const forkItem = document.createElement('button');
      forkItem.className = 'msg-action-menu-item msg-action-menu-item-parent';
      forkItem.innerHTML = `${forkIcon} Fork from here<span class="msg-action-flyout-caret">▸</span>`;
      forkItem.onclick = async (e) => {
        e.stopPropagation();
        closeAllMsgActionMenus();
        if (!currentSessionId) return;
        const msgIndex = getMsgIndex(el);
        if (msgIndex < 0) return;
        await forkSession(currentSessionId, msgIndex, 'up');
      };
      forkWrap.appendChild(forkItem);

      const flyout = document.createElement('div');
      flyout.className = 'msg-action-flyout';

      const upItem = document.createElement('button');
      upItem.className = 'msg-action-menu-item';
      upItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg> Fork up';
      upItem.title = 'Branch a new session containing this message and everything before it';
      upItem.onclick = async (e) => {
        e.stopPropagation();
        closeAllMsgActionMenus();
        if (!currentSessionId) return;
        const msgIndex = getMsgIndex(el);
        if (msgIndex < 0) return;
        await forkSession(currentSessionId, msgIndex, 'up');
      };
      flyout.appendChild(upItem);

      const downItem = document.createElement('button');
      downItem.className = 'msg-action-menu-item';
      downItem.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12l7 7 7-7"/></svg> Fork down';
      downItem.title = 'Start a fresh amnesiac session — no prior context, but grouped with this session by date';
      downItem.onclick = async (e) => {
        e.stopPropagation();
        closeAllMsgActionMenus();
        if (!currentSessionId) return;
        const msgIndex = getMsgIndex(el);
        if (msgIndex < 0) return;
        await forkSession(currentSessionId, msgIndex, 'down');
      };
      flyout.appendChild(downItem);

      forkWrap.appendChild(flyout);
      menu.appendChild(forkWrap);
    }

    btn.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      closeAllMsgActionMenus();
      if (!wasOpen) {
        menu.classList.add('open');
        btn.classList.add('active');
      }
    };

    el.appendChild(btn);
    el.appendChild(menu);
  }
}

function closeAllMsgActionMenus() {
  document.querySelectorAll('.msg-action-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.btn-msg-actions.active').forEach(b => b.classList.remove('active'));
}

// Close action menus when clicking outside
document.addEventListener('click', () => closeAllMsgActionMenus());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeAllMsgActionMenus();
});

function getMsgIndex(el) {
  // Count user + assistant messages before this one (matches server message array indices)
  const allMsgs = messagesEl.querySelectorAll('.message-user, .message-assistant');
  for (let i = 0; i < allMsgs.length; i++) {
    if (allMsgs[i] === el) return i;
  }
  return -1;
}

async function forkSession(sessionId, msgIndex, direction = 'up') {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIndex: msgIndex, direction }),
    });
    if (!res.ok) {
      const err = await res.json();
      alert('Fork failed: ' + (err.error || 'Unknown error'));
      return;
    }
    const forkedSession = await res.json();
    await switchSession(forkedSession.id);
  } catch (err) {
    console.error('Fork failed:', err);
    alert('Fork failed: ' + err.message);
  }
}

// --- Message reference state ---
let pendingReference = null; // { text: string }

function setReference(msgEl) {
  const { text } = extractMessageContent(msgEl);
  const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
  pendingReference = { text: truncated };
  const preview = document.getElementById('reference-preview');
  const previewText = document.getElementById('reference-preview-text');
  previewText.textContent = truncated;
  preview.style.display = 'flex';
  messageInput.focus();
}

function clearReference() {
  pendingReference = null;
  const preview = document.getElementById('reference-preview');
  preview.style.display = 'none';
}

function addTypingIndicator() {
  let el = document.getElementById('typing-indicator');
  if (!el) {
    el = document.createElement('div');
    el.className = 'typing-indicator';
    el.id = 'typing-indicator';
    el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  }
  // Always (re-)append to keep it at the bottom
  messagesEl.appendChild(el);
  scrollToBottom();
}

function removeTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function getOrCreateToolGroup() {
  // Reuse the last tool group if it's the most recent element (or second to last after typing indicator)
  const children = messagesEl.children;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.classList.contains('tool-group')) return child;
    if (child.classList.contains('typing-indicator')) continue;
    break; // Hit a non-tool, non-typing element — need new group
  }
  const group = document.createElement('div');
  group.className = 'tool-group';
  group.onclick = () => group.classList.toggle('expanded');
  group.innerHTML = `
    <div class="tool-group-header">
      <span class="tool-group-chevron">&#9654;</span>
      <span class="tool-group-label">Tools used</span>
      <span class="tool-group-count"></span>
    </div>
    <div class="tool-group-list"></div>
  `;
  messagesEl.appendChild(group);
  return group;
}

function deactivateToolGroup() {
  const groups = messagesEl.querySelectorAll('.tool-group.active');
  groups.forEach(g => g.classList.remove('active'));
}

function updateToolGroupCount(group) {
  const count = group.querySelectorAll('.tool-item').length;
  const countEl = group.querySelector('.tool-group-count');
  if (countEl) countEl.textContent = `(${count})`;
}

function updateAgentIndicator() {
  // Remove all existing agent badges
  document.querySelectorAll('.tool-agent-badge').forEach(b => b.remove());
  if (pendingAgentToolIds.size === 0) return;
  // Group pending agents by their parent tool-group
  const groupCounts = new Map();
  for (const id of pendingAgentToolIds) {
    const item = document.getElementById(`tool-${id}`);
    if (!item) continue;
    const group = item.closest('.tool-group');
    if (!group) continue;
    groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  }
  // Add badge to each group with active agents
  for (const [group, count] of groupCounts) {
    const header = group.querySelector('.tool-group-header');
    if (!header) continue;
    const badge = document.createElement('span');
    badge.className = 'tool-agent-badge';
    badge.textContent = `\u26A1 ${count} agent${count > 1 ? 's' : ''}`;
    header.appendChild(badge);
  }
}

function addToolIndicator(name, id, input) {
  const group = getOrCreateToolGroup();
  const list = group.querySelector('.tool-group-list');
  const item = document.createElement('div');
  const isAgent = name === 'Agent';
  item.className = `tool-item${isAgent ? ' tool-agent' : ''}`;
  item.id = `tool-${id}`;

  let detailHtml = '';
  if (input) {
    detailHtml = renderToolInput(name, input);
  }

  const isAskUser = name === 'AskUserQuestion';
  const icon = isAgent ? '&#9889;' : isAskUser ? '&#10067;' : '&#9881;'; // ⚡ vs ❓ vs ⚙
  const displayName = isAgent && input?.description ? `Agent: ${input.description}` : isAskUser ? 'Question' : name;

  if (isAskUser) item.classList.add('tool-ask-user', 'tool-detail-open');

  item.innerHTML = `
    <div class="tool-item-header" onclick="event.stopPropagation(); this.parentElement.classList.toggle('tool-detail-open')">
      <span class="tool-item-icon">${icon}</span>
      <span class="tool-item-name">${escapeHtml(displayName)}</span>
      ${detailHtml ? '<span class="tool-detail-chevron">&#9654;</span>' : ''}
    </div>
    ${detailHtml ? `<div class="tool-item-detail">${detailHtml}</div>` : ''}
  `;
  list.appendChild(item);
  updateToolGroupCount(group);
  scrollToBottom();
}

function updateToolDetails(id, name, input) {
  const item = document.getElementById(`tool-${id}`);
  if (!item || !input) return;

  // For Agent tools, update the displayed name to include description
  if (name === 'Agent' && input.description) {
    const nameEl = item.querySelector('.tool-item-name');
    if (nameEl) nameEl.textContent = `Agent: ${input.description}`;
    // Add tool-agent class if not already present (initial event had no input)
    if (!item.classList.contains('tool-agent')) {
      item.classList.add('tool-agent');
      const iconEl = item.querySelector('.tool-item-icon');
      if (iconEl) iconEl.innerHTML = '&#9889;'; // ⚡
    }
  }

  // For AskUserQuestion, auto-expand and restyle
  if (name === 'AskUserQuestion' && !item.classList.contains('tool-ask-user')) {
    item.classList.add('tool-ask-user', 'tool-detail-open');
    const nameEl = item.querySelector('.tool-item-name');
    if (nameEl) nameEl.textContent = 'Question';
    const iconEl = item.querySelector('.tool-item-icon');
    if (iconEl) iconEl.innerHTML = '&#10067;'; // ❓
  }

  const detailHtml = renderToolInput(name, input);
  if (!detailHtml) return;

  // Add chevron if missing
  const header = item.querySelector('.tool-item-header');
  if (header && !header.querySelector('.tool-detail-chevron')) {
    header.insertAdjacentHTML('beforeend', '<span class="tool-detail-chevron">&#9654;</span>');
  }

  // Add or replace detail section
  let detailEl = item.querySelector('.tool-item-detail');
  if (!detailEl) {
    detailEl = document.createElement('div');
    detailEl.className = 'tool-item-detail';
    item.appendChild(detailEl);
  }
  detailEl.innerHTML = detailHtml;
}

function renderToolInput(toolName, input) {
  const name = toolName.toLowerCase();

  // code_file edits — show diff
  if (name.includes('code_file') && input.operation === 'edit' && input.old_string) {
    const fileLabel = input.file_path
      ? (isVaultPath(input.file_path) ? renderVaultFileLabel(input.file_path) : `<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`)
      : '';
    const diffLines = [];
    const file = input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    if (file) diffLines.push(`@@ ${file} @@`);
    for (const line of (input.old_string || '').split('\n')) {
      diffLines.push(`-${line}`);
    }
    for (const line of (input.content || '').split('\n')) {
      diffLines.push(`+${line}`);
    }
    return `${fileLabel}<pre class="tool-diff">${renderDiffBlock(diffLines.join('\n'))}</pre>`;
  }

  // code_file write — show content
  if (name.includes('code_file') && input.operation === 'write' && input.content) {
    const fileLabel = input.file_path
      ? (isVaultPath(input.file_path) ? renderVaultFileLabel(input.file_path) : `<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`)
      : '';
    const lang = (input.file_path || '').split('.').pop() || '';
    return `${fileLabel}<pre><code class="language-${lang}">${escapeHtml(input.content)}</code></pre>`;
  }

  // update_document — show content/strategy
  if (name.includes('update_document')) {
    const parts = [];
    if (input.file_path) {
      parts.push(isVaultPath(input.file_path) ? renderVaultFileLabel(input.file_path) : `<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`);
    }
    if (input.strategy) parts.push(`<div class="tool-meta">Strategy: ${escapeHtml(input.strategy)}</div>`);
    if (input.content) parts.push(`<pre><code>${escapeHtml(input.content)}</code></pre>`);
    return parts.join('');
  }

  // Bash — show command
  if (name === 'bash' && input.command) {
    return `<pre><code class="language-sh">${escapeHtml(input.command)}</code></pre>`;
  }

  // search_vault — show query
  if (name.includes('search_vault') && input.query) {
    return `<div class="tool-meta">Query: ${escapeHtml(input.query)}</div>`;
  }

  // Agent — show subagent type, model, background status
  if (name === 'agent') {
    const parts = [];
    if (input.subagent_type) parts.push(`<div class="tool-meta">Type: ${escapeHtml(input.subagent_type)}</div>`);
    if (input.model) parts.push(`<div class="tool-meta">Model: ${escapeHtml(input.model)}</div>`);
    if (input.run_in_background) parts.push(`<div class="tool-meta">Running in background</div>`);
    return parts.join('');
  }

  // Write — show file path + content
  if (name === 'write' && input.content) {
    const fileLabel = input.file_path
      ? (isVaultPath(input.file_path) ? renderVaultFileLabel(input.file_path) : `<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`)
      : '';
    const lang = (input.file_path || '').split('.').pop() || '';
    return `${fileLabel}<pre><code class="language-${lang}">${escapeHtml(input.content)}</code></pre>`;
  }

  // Edit — show file path + diff
  if (name === 'edit' && input.old_string) {
    const fileLabel = input.file_path
      ? (isVaultPath(input.file_path) ? renderVaultFileLabel(input.file_path) : `<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`)
      : '';
    const diffLines = [];
    const file = input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    if (file) diffLines.push(`@@ ${file} @@`);
    for (const line of (input.old_string || '').split('\n')) {
      diffLines.push(`-${line}`);
    }
    for (const line of (input.new_string || '').split('\n')) {
      diffLines.push(`+${line}`);
    }
    return `${fileLabel}<pre class="tool-diff">${renderDiffBlock(diffLines.join('\n'))}</pre>`;
  }

  // Read — show file path being read
  if (name === 'read' && input.file_path) {
    const fileLabel = isVaultPath(input.file_path) ? renderVaultFileLabel(input.file_path) : `<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`;
    const meta = [];
    if (input.offset) meta.push(`offset: ${input.offset}`);
    if (input.limit) meta.push(`limit: ${input.limit}`);
    return fileLabel + (meta.length ? `<div class="tool-meta">${escapeHtml(meta.join(', '))}</div>` : '');
  }

  // AskUserQuestion — show formatted questions with options
  if (name === 'askuserquestion' && input.questions) {
    return input.questions.map(q => {
      const header = q.header ? `<div class="ask-question-tag">${escapeHtml(q.header)}</div>` : '';
      const multi = q.multiSelect ? ' <span class="ask-question-multi">(select multiple)</span>' : '';
      const question = `<div class="ask-question-text">${escapeHtml(q.question)}${multi}</div>`;
      const options = (q.options || []).map(opt =>
        `<div class="ask-question-option">
          <span class="ask-option-label">${escapeHtml(opt.label)}</span>
          ${opt.description ? `<span class="ask-option-desc">${escapeHtml(opt.description)}</span>` : ''}
        </div>`
      ).join('');
      return `<div class="ask-question">${header}${question}<div class="ask-question-options">${options}</div></div>`;
    }).join('');
  }

  // Generic fallback for tools with small input
  const json = JSON.stringify(input, null, 2);
  if (json.length < 500) {
    return `<pre><code>${escapeHtml(json)}</code></pre>`;
  }

  return '';
}

function renderToolOutput(content) {
  if (!content) return '';
  // content can be a string or array of content blocks
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(block => (typeof block === 'string' ? block : block.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  if (!text) return '';
  // Truncate very large outputs
  const maxLen = 5000;
  const truncated = text.length > maxLen;
  const display = truncated ? text.slice(0, maxLen) : text;
  const escaped = escapeHtml(display);
  const linked = linkifyVaultPaths(escaped);
  return `<pre><code>${linked}</code></pre>${truncated ? '<div class="tool-meta">… output truncated</div>' : ''}`;
}

// Structured output renderers for MCP tools with outputSchema
const STRUCTURED_RENDERERS = {
  'mcp__obsidian-context-manager__search_vault': renderSearchVaultStructured,
  'mcp__obsidian-context-manager__get_memory_base': renderMemoryBaseStructured,
  'mcp__obsidian-context-manager__close_session': renderCloseSessionStructured,
  'mcp__obsidian-context-manager__get_session_context': renderSessionContextStructured,
  'mcp__obsidian-context-manager__get_topic_context': renderTopicContextStructured,
};

function tryRenderStructured(toolName, content) {
  if (!toolName || typeof content !== 'string') return null;
  const renderer = STRUCTURED_RENDERERS[toolName];
  if (!renderer) return null;
  try {
    const data = JSON.parse(content);
    if (typeof data !== 'object' || data === null) return null;
    return renderer(data);
  } catch {
    return null;
  }
}

function renderSearchVaultStructured(data) {
  if (!data.results || !Array.isArray(data.results)) return null;
  const parts = [];
  parts.push(`<div class="struct-header">Search: <span class="struct-query">${escapeHtml(data.query || '')}</span></div>`);
  parts.push(`<div class="struct-meta">${data.showing || 0} of ${data.total_count || 0} results · ${escapeHtml(data.detail_level || 'summary')}</div>`);
  for (const r of data.results) {
    const score = r.semantic_score != null ? `<span class="struct-badge">${(r.semantic_score * 100).toFixed(0)}%</span>` : '';
    const vault = r.vault ? `<span class="struct-badge struct-badge-muted">${escapeHtml(r.vault)}</span>` : '';
    const filePath = escapeHtml(r.file || '');
    const fileName = filePath.split('/').pop();
    parts.push(`<div class="struct-result-card">`);
    parts.push(`  <div class="struct-result-header">${score}${vault}<span class="struct-file-path" title="${filePath}">${escapeHtml(fileName)}</span></div>`);
    if (r.snippets && r.snippets.length > 0) {
      const snippetText = r.snippets.slice(0, 3).map(s => escapeHtml(s)).join('<br>');
      parts.push(`  <div class="struct-snippets">${snippetText}</div>`);
    }
    parts.push(`</div>`);
  }
  if (data.retry && data.retry.results && data.retry.results.length > 0) {
    parts.push(`<div class="struct-retry-label">Retry (${escapeHtml(data.retry.reason || 'broadened')}): ${data.retry.results.length} results</div>`);
  }
  return parts.join('\n');
}

function renderMemoryBaseStructured(data) {
  if (data.has_user_reference == null) return null;
  const parts = [];
  parts.push(`<div class="struct-header">Memory Base</div>`);
  parts.push(`<div class="struct-meta">${data.section_count || 0} sections loaded${data.session_start_time ? ' · ' + escapeHtml(data.session_start_time) : ''}</div>`);
  if (data.handoffs && data.handoffs.length > 0) {
    parts.push(`<div class="struct-section-label">Handoffs (${data.handoffs.length})</div>`);
    for (const h of data.handoffs) {
      parts.push(`<div class="struct-result-card"><div class="struct-result-header"><span class="struct-badge struct-badge-muted">${escapeHtml(h.session_id || '')}</span></div>`);
      const preview = (h.content || '').slice(0, 200);
      parts.push(`<div class="struct-snippets">${escapeHtml(preview)}${h.content && h.content.length > 200 ? '…' : ''}</div></div>`);
    }
  }
  if (data.correction_rules && data.correction_rules.length > 0) {
    parts.push(`<div class="struct-section-label">Corrections (${data.correction_rules.length})</div>`);
    for (const c of data.correction_rules) {
      parts.push(`<div class="struct-result-card"><div class="struct-result-header"><span class="struct-file-path">${escapeHtml(c.title || '')}</span></div></div>`);
    }
  }
  if (data.persistent_issues && data.persistent_issues.length > 0) {
    parts.push(`<div class="struct-section-label">Issues (${data.persistent_issues.length})</div>`);
    for (const i of data.persistent_issues) {
      const prioClass = i.priority === 'high' ? 'struct-badge-high' : i.priority === 'medium' ? 'struct-badge-med' : '';
      parts.push(`<div class="struct-result-card"><div class="struct-result-header"><span class="struct-badge ${prioClass}">${escapeHtml(i.priority || '')}</span><span class="struct-file-path">${escapeHtml(i.slug || '')}</span></div></div>`);
    }
  }
  return parts.join('\n');
}

function renderCloseSessionStructured(data) {
  if (data.phase == null) return null;
  const parts = [];
  if (data.phase === 1) {
    parts.push(`<div class="struct-header">Session Analysis <span class="struct-badge">Phase 1</span></div>`);
    parts.push(`<div class="struct-meta">${escapeHtml(data.session_id || '')}</div>`);
    if (data.detected_repo) {
      parts.push(`<div class="struct-meta">Repo: ${escapeHtml(data.detected_repo.name)}${data.detected_repo.branch ? ' (' + escapeHtml(data.detected_repo.branch) + ')' : ''}</div>`);
    }
    if (data.commit_count > 0) {
      parts.push(`<div class="struct-section-label">Commits (${data.commit_count})</div>`);
      for (const c of (data.commits || [])) {
        const topicCount = (c.related_topics || []).length;
        const decCount = (c.related_decisions || []).length;
        const badges = [];
        if (topicCount > 0) badges.push(`${topicCount} topic${topicCount > 1 ? 's' : ''}`);
        if (decCount > 0) badges.push(`${decCount} decision${decCount > 1 ? 's' : ''}`);
        parts.push(`<div class="struct-result-card"><div class="struct-result-header"><code>${escapeHtml(c.hash || '')}</code>${badges.length ? ' <span class="struct-badge struct-badge-muted">' + escapeHtml(badges.join(', ')) + '</span>' : ''}</div></div>`);
      }
    }
    if (data.topics_for_review && data.topics_for_review.length > 0) {
      parts.push(`<div class="struct-section-label">Topics for Review (${data.topics_for_review.length})</div>`);
      for (const t of data.topics_for_review) {
        parts.push(`<div class="struct-result-card"><div class="struct-result-header"><span class="struct-badge">${escapeHtml(t.source || '')}</span><span class="struct-file-path">${escapeHtml(t.title || '')}</span></div></div>`);
      }
    }
    if (data.semantic_topics_for_review && data.semantic_topics_for_review.length > 0) {
      parts.push(`<div class="struct-section-label">Semantic Topics (${data.semantic_topics_for_review.length})</div>`);
      for (const t of data.semantic_topics_for_review) {
        parts.push(`<div class="struct-result-card"><div class="struct-result-header"><span class="struct-badge struct-badge-muted">semantic</span><span class="struct-file-path">${escapeHtml(t.title || '')}</span></div></div>`);
      }
    }
  } else if (data.phase === 2) {
    parts.push(`<div class="struct-header">Session Finalized <span class="struct-badge">Phase 2</span></div>`);
    parts.push(`<div class="struct-meta">${escapeHtml(data.session_id || '')}</div>`);
    const linked = [];
    if (data.topics_linked && data.topics_linked.length > 0) linked.push(`${data.topics_linked.length} topics`);
    if (data.decisions_linked && data.decisions_linked.length > 0) linked.push(`${data.decisions_linked.length} decisions`);
    if (data.projects_linked && data.projects_linked.length > 0) linked.push(`${data.projects_linked.length} projects`);
    if (linked.length > 0) {
      parts.push(`<div class="struct-meta">Linked: ${escapeHtml(linked.join(', '))}</div>`);
    }
    if (data.files_accessed_count) {
      parts.push(`<div class="struct-meta">Files accessed: ${data.files_accessed_count}</div>`);
    }
    if (data.validation_warnings && data.validation_warnings.length > 0) {
      parts.push(`<div class="struct-section-label struct-warn">Warnings (${data.validation_warnings.length})</div>`);
      for (const w of data.validation_warnings) {
        parts.push(`<div class="struct-result-card"><div class="struct-snippets">${escapeHtml(w)}</div></div>`);
      }
    }
  }
  return parts.join('\n');
}

function renderSessionContextStructured(data) {
  if (!data.session_id) return null;
  const parts = [];
  parts.push(`<div class="struct-header">Session: <span class="struct-query">${escapeHtml(data.session_id)}</span></div>`);
  const meta = [];
  if (data.date) meta.push(escapeHtml(data.date));
  if (data.status) {
    const cls = data.status === 'active' ? 'struct-badge-high' : 'struct-badge-muted';
    meta.push(`<span class="struct-badge ${cls}">${escapeHtml(data.status)}</span>`);
  }
  if (data.working_directory) meta.push(escapeHtml(data.working_directory));
  if (meta.length > 0) parts.push(`<div class="struct-meta">${meta.join(' · ')}</div>`);
  if (data.topics && data.topics.length > 0) {
    parts.push(`<div class="struct-meta">${data.topics.map(t => `<span class="struct-badge">${escapeHtml(t)}</span>`).join(' ')}</div>`);
  }
  if (data.decisions && data.decisions.length > 0) {
    parts.push(`<div class="struct-meta">${data.decisions.map(d => `<span class="struct-badge struct-badge-muted">${escapeHtml(d)}</span>`).join(' ')}</div>`);
  }
  if (data.body) {
    parts.push(`<div class="struct-body">${renderMarkdown(data.body)}</div>`);
  }
  return parts.join('\n');
}

function renderTopicContextStructured(data) {
  if (!data.title) return null;
  const parts = [];
  parts.push(`<div class="struct-header">${escapeHtml(data.title)}</div>`);
  const meta = [];
  if (data.category) meta.push(`<span class="struct-badge">${escapeHtml(data.category)}</span>`);
  if (data.review_count != null) meta.push(`${data.review_count} review${data.review_count !== 1 ? 's' : ''}`);
  if (data.last_reviewed) meta.push(`reviewed ${escapeHtml(data.last_reviewed)}`);
  if (meta.length > 0) parts.push(`<div class="struct-meta">${meta.join(' · ')}</div>`);
  if (data.tags && data.tags.length > 0) {
    parts.push(`<div class="struct-meta">${data.tags.map(t => `<span class="struct-badge struct-badge-muted">${escapeHtml(t)}</span>`).join(' ')}</div>`);
  }
  if (data.body) {
    parts.push(`<div class="struct-body">${renderMarkdown(data.body)}</div>`);
  }
  return parts.join('\n');
}

function addToolOutput(toolUseId, content) {
  const item = document.getElementById(`tool-${toolUseId}`);
  if (!item) return;

  // Try structured rendering first — look up tool name from the DOM element
  const nameEl = item.querySelector('.tool-item-name');
  const toolName = nameEl ? nameEl.textContent : '';
  const structuredHtml = tryRenderStructured(toolName, content);

  const outputHtml = structuredHtml || renderToolOutput(content);
  if (!outputHtml) return;

  // Ensure chevron exists for expandability
  const header = item.querySelector('.tool-item-header');
  if (header && !header.querySelector('.tool-detail-chevron')) {
    header.insertAdjacentHTML('beforeend', '<span class="tool-detail-chevron">&#9654;</span>');
  }

  // Add or replace output section
  let outputEl = item.querySelector('.tool-item-output');
  if (!outputEl) {
    outputEl = document.createElement('div');
    outputEl.className = 'tool-item-output';
    item.appendChild(outputEl);
  }
  outputEl.innerHTML = '<div class="tool-output-label">Output</div>' + outputHtml;
}

function addThinkingIndicator() {
  const el = document.createElement('div');
  el.className = 'thinking-indicator';
  el.id = 'thinking-current';
  el.onclick = () => el.classList.toggle('expanded');
  el.innerHTML = 'Thinking...<div class="thinking-content"></div>';
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function addUsageInfo(data) {
  try {
    const info = JSON.parse(data);
    const totalInput = (info.input_tokens || 0)
      + (info.cache_creation_input_tokens || 0)
      + (info.cache_read_input_tokens || 0);
    const parts = [];
    if (info.duration_ms) parts.push(`${(info.duration_ms / 1000).toFixed(1)}s`);
    if (totalInput) parts.push(`${(totalInput / 1000).toFixed(1)}k in`);
    if (info.output_tokens) parts.push(`${(info.output_tokens / 1000).toFixed(1)}k out`);
    if (parts.length > 0) {
      const el = document.createElement('div');
      el.className = 'message-usage';
      el.textContent = parts.join(' \u00b7 ');
      messagesEl.appendChild(el);
    }
  } catch {}
}

// scrollToBottom() only fires when the user is pinned near the bottom; if they've scrolled up to read, a pill prompts them instead of yanking them down.
let autoScrollEnabled = true;
const SCROLL_STICKY_THRESHOLD = 80;

function isAtBottom() {
  return (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) <= SCROLL_STICKY_THRESHOLD;
}

function showNewContentPill() {
  const pill = document.getElementById('new-content-pill');
  if (pill) pill.classList.add('visible');
}

function hideNewContentPill() {
  const pill = document.getElementById('new-content-pill');
  if (pill) pill.classList.remove('visible');
}

messagesEl.addEventListener('scroll', () => {
  const atBottom = isAtBottom();
  autoScrollEnabled = atBottom;
  if (atBottom) hideNewContentPill();
}, { passive: true });

function scrollToBottom() {
  requestAnimationFrame(() => {
    if (autoScrollEnabled) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      showNewContentPill();
    }
  });
}

function scrollToBottomForce() {
  autoScrollEnabled = true;
  hideNewContentPill();
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// Image paste handling
let pendingAttachments = [];

messageInput.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = reader.result;
        const ext = file.type.split('/')[1] || 'png';
        pendingAttachments.push({ filename: `paste.${ext}`, path: base64 });
        showAttachmentPreview(base64);
      };
      reader.readAsDataURL(file);
    }
  }
});

function handleImageSelect(input) {
  for (const file of input.files) {
    if (!file.type.startsWith('image/')) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result;
      const ext = file.type.split('/')[1] || 'png';
      pendingAttachments.push({ filename: file.name || `image.${ext}`, path: base64 });
      showAttachmentPreview(base64);
    };
    reader.readAsDataURL(file);
  }
  input.value = '';
}

function showAttachmentPreview(dataUrl) {
  let container = document.getElementById('attachment-preview');
  if (!container) {
    container = document.createElement('div');
    container.id = 'attachment-preview';
    container.className = 'attachment-preview';
    document.querySelector('.input-container').before(container);
  }
  const wrapper = document.createElement('div');
  wrapper.className = 'attachment-thumb';
  wrapper.innerHTML = `
    <img src="${dataUrl}" alt="attachment">
    <button class="attachment-remove" onclick="removeAttachment(this)">&times;</button>
  `;
  container.appendChild(wrapper);
}

function removeAttachment(btn) {
  const wrapper = btn.parentElement;
  const container = wrapper.parentElement;
  const idx = Array.from(container.children).indexOf(wrapper);
  pendingAttachments.splice(idx, 1);
  wrapper.remove();
  if (container.children.length === 0) container.remove();
}

function clearAttachments() {
  pendingAttachments = [];
  const container = document.getElementById('attachment-preview');
  if (container) container.remove();
}

// SSE stream reader (shared between send and reconnect)
async function readSSEStream(response, processEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEventType = '';

  function processLines(lines) {
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        lastEventType = line.substring(7).trim();
        continue;
      }
      if (line.startsWith('data: ')) {
        const rawData = line.substring(6);
        let data;
        try {
          data = JSON.parse(rawData);
        } catch {
          data = rawData;
        }
        processEvent(lastEventType, data);
      }
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      processLines(lines);
    }

    // Flush any remaining data in the buffer after stream ends
    if (buffer.trim()) {
      processLines(buffer.split('\n'));
    }
  } catch (err) {
    console.error('SSE stream read error:', err);
    throw err; // Re-throw so caller can handle reconnect
  }
}

// Reconnect to an active stream
async function attemptReconnect(sessionId, processEvent) {
  try {
    // Server replays the FULL buffer from the start of the assistant turn, so
    // we must clear the in-progress DOM first — otherwise live-rendered bubbles
    // co-exist with replay-rebuilt bubbles (double-messages bug). Mirrors the
    // switchSession → replaySessionStream path, which only works because
    // switchSession already called clearMessages + restoreMessages.
    if (currentSessionId === sessionId) {
      await restoreMessages(sessionId, null, { upToLastUser: true });
      // If the view changed during the async restore, abort the reconnect —
      // don't replay into a different session's DOM.
      if (currentSessionId !== sessionId) return false;
    }

    const res = await fetch(`/api/chat/${sessionId}/reconnect`);
    if (!res.ok) return false;

    if (currentSessionId === sessionId) {
      removeTypingIndicator();
      const existingThinking = document.getElementById('thinking-current');
      if (existingThinking) existingThinking.remove();
      addTypingIndicator();
    }

    // Find the last assistant message element to continue appending to it
    let reconnectedAssistantEl = null;
    let reconnectedText = '';
    let receivedContent = false;

    function reconnectProcessor(type, data) {
      // Don't update DOM if user switched to a different session, OR if a
      // switchSession-triggered replaySessionStream has taken over rendering
      // for this session (hijackedStreams). Without the hijacked check, an
      // attemptReconnect already in flight when the user navigates A→B→A
      // renders into its own closure's reconnectedAssistantEl while
      // replaySessionStream concurrently renders into its own — producing
      // two side-by-side identical bubbles (double-messages bug, mechanism C).
      if (currentSessionId !== sessionId || hijackedStreams.has(sessionId)) {
        // Still track content reception for return value
        if (type === 'text' || type === 'tool_use' || type === 'done') {
          receivedContent = true;
        }
        return;
      }
      try {
        // Track whether we received any meaningful content
        if (type === 'text' || type === 'tool_use' || type === 'done') {
          receivedContent = true;
        }
        if (type === 'text') {
          if (!reconnectedAssistantEl) {
            reconnectedAssistantEl = createAssistantMessage();
            addTypingIndicator(); // keep dots at bottom
          }
          reconnectedText += data;
          reconnectedAssistantEl.innerHTML = renderMarkdown(reconnectedText);
          ensureCopyButton(reconnectedAssistantEl);
          scrollToBottom();
        } else if (type === 'tool_use') {
          // Reset text element so next text creates a new bubble after the tool group
          if (reconnectedAssistantEl && reconnectedText) {
            reconnectedAssistantEl = null;
            reconnectedText = '';
          }
          processEvent(type, data);
        } else {
          processEvent(type, data);
        }
      } catch (err) {
        console.error('reconnectProcessor error:', type, err);
        if (type === 'text' && reconnectedAssistantEl && reconnectedText) {
          reconnectedAssistantEl.textContent = reconnectedText;
        }
      }
    }

    await readSSEStream(res, reconnectProcessor);
    if (currentSessionId === sessionId) removeTypingIndicator();
    return receivedContent;
  } catch {
    return false;
  }
}

// Take over rendering of a still-streaming session on switch-back.
// Opens /api/chat/:id/reconnect, which atomically replays the server's SSE
// buffer (everything the originating sendMessage() dropped while the user was
// away) and subscribes to remaining live events. Uses its own closure state so
// it's independent of the originating sendMessage() — which is silenced via
// hijackedStreams for the duration.
async function replaySessionStream(sessionId) {
  // Cancel any in-flight replay for this session so its stale closure state
  // (assistantEl pointing at a now-cleared DOM) can't keep rendering.
  const prev = activeReplayControllers.get(sessionId);
  if (prev) prev.abort();
  const controller = new AbortController();
  activeReplayControllers.set(sessionId, controller);
  let assistantEl = null;
  let currentText = '';
  let thinkingEl = null;
  // Guard against leaked events after the target stream ends. Without this,
  // a user who resubmits in this session before the /reconnect fetch closes
  // would see replay keep rendering the new stream's events in parallel with
  // sendMessage's live processEvent — producing duplicate bubbles.
  let terminated = false;
  try {
    const res = await fetch(`/api/chat/${sessionId}/reconnect`, { signal: controller.signal });
    if (!res.ok) return;
    await readSSEStream(res, (type, data) => {
      // If a newer replaySessionStream() has taken over for this sessionId,
      // bail — prev.abort() at the top of the newer call isn't synchronous,
      // so events already buffered in this reader (e.g. a tool_use→text pair
      // that clears assistantEl then calls createAssistantMessage) would
      // otherwise append new bubbles to messagesEl after the newer call's
      // restoreMessages cleared the DOM. The newer call set itself as the
      // sessionId's controller synchronously, so this check catches the race.
      if (activeReplayControllers.get(sessionId) !== controller) return;
      if (terminated) return;
      // Suppress DOM updates if the user navigated away again mid-replay —
      // but keep consuming the stream so the fetch drains cleanly.
      if (currentSessionId !== sessionId) return;
      try {
        switch (type) {
          case 'text': {
            deactivateToolGroup();
            if (!assistantEl) {
              assistantEl = createAssistantMessage();
              addTypingIndicator();
            }
            currentText += data;
            assistantEl.innerHTML = renderMarkdown(currentText);
            ensureCopyButton(assistantEl);
            scrollToBottom();
            break;
          }
          case 'thinking':
            if (!thinkingEl) {
              thinkingEl = addThinkingIndicator();
              addTypingIndicator();
            }
            const contentEl = thinkingEl.querySelector('.thinking-content');
            if (contentEl) contentEl.textContent += data;
            break;
          case 'tool_use':
            if (assistantEl && currentText) {
              assistantEl = null;
              currentText = '';
            }
            try {
              const tool = JSON.parse(data);
              addToolIndicator(tool.name, tool.id, tool.input);
              if (tool.name === 'Agent') {
                pendingAgentToolIds.add(tool.id);
                updateAgentIndicator();
              }
            } catch {
              addToolIndicator(data, 'unknown');
            }
            getOrCreateToolGroup().classList.add('active');
            addTypingIndicator();
            break;
          case 'tool_update':
            try {
              const tool = JSON.parse(data);
              updateToolDetails(tool.id, tool.name, tool.input);
              if (tool.name?.includes('close_session') && tool.input?.finalize) {
                currentClosedAt = new Date().toISOString();
                loadSessions();
              }
            } catch {}
            break;
          case 'tool_result':
            try {
              const result = JSON.parse(data);
              addToolOutput(result.tool_use_id, result.content);
              if (pendingAgentToolIds.has(result.tool_use_id)) {
                pendingAgentToolIds.delete(result.tool_use_id);
                updateAgentIndicator();
              }
            } catch {}
            break;
          case 'permission_request':
            removeTypingIndicator();
            try {
              const perm = typeof data === 'string' ? JSON.parse(data) : data;
              updateSessionBlockedBadge(sessionId, true);
              showPermissionDialog(perm.id, perm.toolName, perm.toolInput);
            } catch {}
            break;
          case 'error': {
            const errEl = document.createElement('div');
            errEl.className = 'message message-error';
            errEl.textContent = data;
            messagesEl.appendChild(errEl);
            scrollToBottom();
            break;
          }
          case 'done':
            // Safety net (parity with sendMessage's processEvent): if no text
            // events arrived but the done payload includes result_text, render
            // it so the assistant message isn't empty.
            try {
              const doneData = typeof data === 'string' ? JSON.parse(data) : data;
              if (!currentText && doneData.result_text) {
                deactivateToolGroup();
                if (!assistantEl) assistantEl = createAssistantMessage();
                currentText = doneData.result_text;
                assistantEl.innerHTML = renderMarkdown(currentText);
                ensureCopyButton(assistantEl);
              }
            } catch {}
            removeTypingIndicator();
            deactivateToolGroup();
            pendingAgentToolIds.clear();
            addUsageInfo(data);
            scrollToBottom();
            // Terminate the replay — the target stream has ended. Without the
            // abort, the /reconnect fetch stays open until the server's 500ms
            // checkDone poll fires, and if the user resubmits in this session
            // during that window, the server revives the same ActiveStream
            // object with our stale listener still attached — new events leak
            // into this replay closure and render in parallel with the new
            // sendMessage's processEvent (double-messages bug, multi-session
            // variant).
            terminated = true;
            controller.abort();
            break;
        }
      } catch (err) {
        console.error('replaySessionStream render error:', type, err);
      }
    });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('replaySessionStream failed:', err);
  } finally {
    // Only clear the controller if it's still ours — a newer replay may have
    // already replaced it via abort+set.
    if (activeReplayControllers.get(sessionId) === controller) {
      activeReplayControllers.delete(sessionId);
    }
    // Clear hijack flag only when sendMessage has already finished for this
    // session. If sendMessage is still streaming, its reader needs the flag to
    // stay set — otherwise we fall into mechanism D: replay's finally (often
    // triggered by a newer replay aborting this one on a double-click, or by
    // this replay's own 'done' arriving slightly before sendMessage's 'done'
    // drains) clears hijack mid-stream; sendMessage's processEvent then sees
    // hijacked=false on the remaining live text/done events, creates a second
    // assistantEl, and calls addUsageInfo — producing a second bubble and a
    // second usage row in parallel with the replay's own. sendMessage's own
    // finally already clears the flag when the stream ends, so skipping here
    // while it's still in flight is safe.
    if (!streamingSessions.has(sessionId)) {
      hijackedStreams.delete(sessionId);
    }
    if (currentSessionId === sessionId) removeTypingIndicator();
  }
}

// Cancel active stream
async function cancelStream() {
  if (!currentSessionId || !streamingSessions.has(currentSessionId)) return;
  // Clear any queued message — user cancelled, so don't auto-send
  cancelQueuedMessage(currentSessionId);
  try {
    await fetchWithRetry(`/api/chat/${currentSessionId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to cancel:', err);
  }
}

// Send message with streaming SSE parsing
// skipRender: when true, skips rendering user message (already shown from queue)
async function sendMessage(skipRender = false) {
  // Unlock iOS audio on the user's send tap so auto-speak works when the response arrives
  if (ttsAutoSpeak) unlockTTSForIOS();
  // Reset streaming TTS state for new response
  ttsStreamStarted = false;

  let text = messageInput.value.trim();
  if ((!text && pendingAttachments.length === 0) || !currentSessionId) return;

  // Prepend reference if set
  if (pendingReference) {
    text = `> Re: "${pendingReference.text}"\n\n${text}`;
    clearReference();
  }

  // If session is busy, queue the message for later
  if (streamingSessions.has(currentSessionId)) {
    const queued = {
      text,
      attachments: pendingAttachments.length > 0 ? [...pendingAttachments] : undefined
    };
    pendingMessages.set(currentSessionId, queued);
    messageInput.value = '';
    messageInput.style.height = 'auto';
    clearAttachments();
    renderQueuedMessage(currentSessionId, text, queued.attachments);
    return;
  }

  const streamSessionId = currentSessionId;
  streamingSessions.add(streamSessionId);
  sendBtn.style.display = 'flex';
  stopBtn.style.display = 'flex';
  messageInput.placeholder = 'Queue a message...';
  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Capture attachments before clearing UI
  const messageAttachments = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;

  if (!skipRender) {
    addUserMessage(text);
    if (messageAttachments) {
      addInfoMessage(`${messageAttachments.length} image(s) attached`);
    }
  }
  clearAttachments();
  addTypingIndicator();
  ttsFaceResponseStart();

  let assistantEl = null;
  let lastRenderedAssistantEl = null; // persists across tool_use clears, used for auto-speak
  let currentText = '';
  let thinkingEl = null;
  let lastEventType = '';
  let streamCompleted = false;
  let everRenderedText = false; // Track if ANY text was rendered (survives tool_use clears)
  let slowApiTimer = null;
  const renderedAskQuestions = new Set(); // Track AskUserQuestion tool IDs already rendered to chat

  function renderAskUserQuestionInChat(toolId, questions) {
    if (renderedAskQuestions.has(toolId)) return;
    renderedAskQuestions.add(toolId);
    const md = questions.map(q => {
      const parts = [];
      if (q.header) parts.push(`**${q.header}**\n`);
      parts.push(q.question);
      if (q.multiSelect) parts.push(' *(select multiple)*');
      parts.push('');
      for (const opt of (q.options || [])) {
        const desc = opt.description ? ` — ${opt.description}` : '';
        parts.push(`- **${opt.label}**${desc}`);
      }
      return parts.join('\n');
    }).join('\n\n---\n\n');
    const el = createAssistantMessage();
    el.innerHTML = renderMarkdown(md);
    ensureCopyButton(el);
    scrollToBottom();
  }

  function showSlowApiIndicator() {
    if (document.getElementById('slow-api-indicator')) return;
    const el = document.createElement('div');
    el.id = 'slow-api-indicator';
    el.className = 'slow-api-indicator';
    el.textContent = 'API response is slow';
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  function clearSlowApi() {
    if (slowApiTimer) { clearTimeout(slowApiTimer); slowApiTimer = null; }
    const el = document.getElementById('slow-api-indicator');
    if (el) el.remove();
  }

  // In-memory ring buffer (exposed as window._lastSSELog) so post-hoc
  // diagnostics can reconstruct the event sequence when a render bug is
  // reported — don't remove without a replacement.
  const sseLog = [];
  window._lastSSELog = sseLog;
  function logSSE(action, detail) {
    sseLog.push({ t: Date.now(), action, detail, textLen: currentText.length, hasEl: !!assistantEl });
  }

  function processEvent(type, data) {
    // Handle permission requests for background sessions (before mismatch return)
    if (currentSessionId !== streamSessionId && type === 'permission_request') {
      try {
        const perm = typeof data === 'string' ? JSON.parse(data) : data;
        console.log('[permission] background session blocked:', streamSessionId, perm);
        updateSessionBlockedBadge(streamSessionId, true);
      } catch (err) {
        console.error('[permission] failed to parse background permission:', err);
      }
    }
    // Don't update DOM if user switched to a different session, or if a
    // switchSession-triggered replay has taken over rendering for this stream.
    if (currentSessionId !== streamSessionId || hijackedStreams.has(streamSessionId)) {
      logSSE('SESSION_MISMATCH', { type, current: currentSessionId, stream: streamSessionId, hijacked: hijackedStreams.has(streamSessionId) });
      // Still track the end-of-stream signal so the post-loop reconnect check
      // doesn't fire a redundant attemptReconnect after replaySessionStream
      // already finished rendering the turn (which would duplicate it).
      if (type === 'done') streamCompleted = true;
      return;
    }
    try {
      switch (type) {
        case 'init':
          logSSE('init', data);
          // Don't remove typing indicator — keep it visible until content arrives
          break;

        case 'text':
          clearSlowApi();
          ttsFaceSetActivity('idle');
          deactivateToolGroup();
          if (!assistantEl) {
            logSSE('text:create_el', { dataLen: typeof data === 'string' ? data.length : 0, preview: typeof data === 'string' ? data.substring(0, 40) : '' });
            assistantEl = createAssistantMessage();
            lastRenderedAssistantEl = assistantEl; // save before tool_use can clear it
            addTypingIndicator(); // keep dots at bottom
          }
          currentText += data;
          everRenderedText = true;
          logSSE('text:append', { preview: typeof data === 'string' ? data.substring(0, 40) : '', totalLen: currentText.length });
          assistantEl.innerHTML = renderMarkdown(currentText);
          ensureCopyButton(assistantEl);
          scrollToBottom();
          // Progressive TTS: feed sentence buffer during streaming
          if (ttsAutoSpeak) {
            if (!ttsStreamStarted) {
              ttsStreamStart(assistantEl);
            } else if (ttsSpeakingEl !== assistantEl) {
              // assistantEl changed (e.g. after tool_use created new element) — update indicator
              if (ttsSpeakingEl) ttsSpeakingEl.classList.remove('tts-speaking');
              ttsSpeakingEl = assistantEl;
              assistantEl.classList.add('tts-speaking');
            }
            ttsStreamAppend(data);
          }
          break;

        case 'thinking':
          clearSlowApi();
          ttsFaceSetActivity('thinking');
          if (!thinkingEl) {
            thinkingEl = addThinkingIndicator();
            addTypingIndicator(); // keep dots at bottom
          }
          const contentEl = thinkingEl.querySelector('.thinking-content');
          if (contentEl) {
            contentEl.textContent += data;
          }
          break;

        case 'tool_use':
          clearSlowApi();
          ttsFaceSetActivity('tool-working');
          logSSE('tool_use:clear', { hadText: currentText.length, hadEl: !!assistantEl, data: typeof data === 'string' ? data.substring(0, 100) : '' });
          if (assistantEl && currentText) {
            assistantEl = null;
            currentText = '';
            // Reset streaming TTS text buffer (tool_use clears the text segment)
            if (ttsStreamStarted) ttsStreamToolUse();
          }
          try {
            const tool = JSON.parse(data);
            addToolIndicator(tool.name, tool.id, tool.input);
            // Render AskUserQuestion as visible chat text
            if (tool.name === 'AskUserQuestion' && tool.input?.questions) {
              renderAskUserQuestionInChat(tool.id, tool.input.questions);
            }
            // Track active Agent (subagent) calls
            if (tool.name === 'Agent') {
              pendingAgentToolIds.add(tool.id);
              updateAgentIndicator();
            }
          } catch {
            addToolIndicator(data, 'unknown');
          }
          // Pulse the tool group to show Claude is still working
          const activeGroup = getOrCreateToolGroup();
          activeGroup.classList.add('active');
          addTypingIndicator();
          break;

        case 'tool_update':
          // Update existing tool indicator with full details (input arrived after initial stream event)
          try {
            const tool = JSON.parse(data);
            updateToolDetails(tool.id, tool.name, tool.input);
            // Render AskUserQuestion as visible chat text (if not already rendered by tool_use)
            if (tool.name === 'AskUserQuestion' && tool.input?.questions) {
              renderAskUserQuestionInChat(tool.id, tool.input.questions);
            }
            // Detect close_session finalize — update closed state for handoff display
            if (tool.name?.includes('close_session') && tool.input?.finalize) {
              currentClosedAt = new Date().toISOString();
              loadSessions();
            }
          } catch {}
          break;

        case 'tool_result':
          try {
            const result = JSON.parse(data);
            addToolOutput(result.tool_use_id, result.content);
            // Clear completed Agent from active tracking
            if (pendingAgentToolIds.has(result.tool_use_id)) {
              pendingAgentToolIds.delete(result.tool_use_id);
              updateAgentIndicator();
            }
          } catch {}
          break;

        case 'permission_request':
          console.log('[permission] received event, data type:', typeof data, 'data:', data);
          removeTypingIndicator();
          try {
            const perm = typeof data === 'string' ? JSON.parse(data) : data;
            console.log('[permission] parsed:', perm);
            updateSessionBlockedBadge(streamSessionId, true);
            showPermissionDialog(perm.id, perm.toolName, perm.toolInput);
            console.log('[permission] dialog shown, overlay display:', document.getElementById('permission-overlay')?.style.display);
          } catch (err) {
            console.error('[permission] FAILED to show dialog:', err, 'data was:', data);
          }
          break;

        case 'error':
          // Don't remove typing indicator — errors during streaming are often non-fatal
          // (e.g. verbose stderr output during tool execution). The done event or
          // finally block will clean up the indicator when the stream actually ends.
          const errEl = document.createElement('div');
          errEl.className = 'message message-error';
          errEl.textContent = data;
          messagesEl.appendChild(errEl);
          scrollToBottom();
          break;

        case 'done':
          ttsFaceResponseEnd();
          logSSE('done', { textLen: currentText.length, streamCompleted });
          // Safety net: recover text from result if text_delta events were lost
          try {
            const doneData = typeof data === 'string' ? JSON.parse(data) : data;
            if (!currentText && !everRenderedText && doneData.result_text) {
              logSSE('done:text_recovery', { resultLen: doneData.result_text.length });
              deactivateToolGroup();
              if (!assistantEl) {
                assistantEl = createAssistantMessage();
              }
              currentText = doneData.result_text;
              everRenderedText = true;
              assistantEl.innerHTML = renderMarkdown(currentText);
              ensureCopyButton(assistantEl);
            }
          } catch {}
          removeTypingIndicator();
          deactivateToolGroup();
          pendingAgentToolIds.clear();
          addUsageInfo(data);
          streamCompleted = true;
          // Auto-speak: flush streaming TTS if active, else fall back to full-message speak
          if (ttsStreamStarted) {
            ttsStreamFlush();
          } else {
            const speakEl = assistantEl || lastRenderedAssistantEl;
            if (ttsAutoSpeak && speakEl) {
              speakAssistantMessage(speakEl);
            }
          }
          scrollToBottom();
          break;

        default:
          logSSE('unknown_event', { type, data: typeof data === 'string' ? data.substring(0, 100) : '' });
          break;
      }
    } catch (err) {
      logSSE('ERROR', { type, error: err.message });
      console.error('processEvent error:', type, err);
      // Ensure the message is still visible even if rendering failed
      if (type === 'text' && assistantEl && currentText) {
        assistantEl.textContent = currentText;
      }
    }
  }

  slowApiTimer = setTimeout(showSlowApiIndicator, 8000);

  try {
    const res = await fetch(`/api/chat/${currentSessionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text || 'Please analyze the attached image(s).',
        model: getSelectedModel(),
        attachments: messageAttachments,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Request failed');
    }

    await readSSEStream(res, processEvent);

    logSSE('stream_ended', { streamCompleted, textLen: currentText.length });

    // Stream ended without a 'done' event — connection likely dropped (common on mobile).
    // Skip if a switchSession replay has taken over rendering for this stream.
    if (!streamCompleted && !hijackedStreams.has(streamSessionId)) {
      logSSE('reconnect:no_done', { textLen: currentText.length });
      const reconnected = await attemptReconnect(streamSessionId, processEvent);
      logSSE('reconnect:result', { reconnected, textLen: currentText.length });
      if (!reconnected && currentSessionId === streamSessionId && !everRenderedText) {
        // No text was rendered for THIS message and reconnect failed — restore all
        // messages from server. Previous messages may be visible in the DOM, but the
        // current response was lost. Server-side persistence saves events independently
        // of the SSE connection, so restoreMessages will recover the full conversation.
        logSSE('reconnect:fallback_restore', { everRenderedText });
        await new Promise(r => setTimeout(r, 2000));
        await restoreMessages(streamSessionId);
      }
    }
  } catch (err) {
    logSSE('stream_error', { error: err.message, streamCompleted, textLen: currentText.length });
    if (currentSessionId === streamSessionId && !hijackedStreams.has(streamSessionId)) removeTypingIndicator();
    // Only attempt reconnect if we were genuinely mid-stream (not completed/cancelled/hijacked)
    if (!streamCompleted && err.name !== 'AbortError' && !hijackedStreams.has(streamSessionId)) {
      logSSE('reconnect:after_error', { error: err.message });
      const reconnected = await attemptReconnect(streamSessionId, processEvent);
      logSSE('reconnect:error_result', { reconnected, textLen: currentText.length });
      if (!reconnected && currentSessionId === streamSessionId) {
        if (err instanceof TypeError) {
          // Network-level failure — server is likely restarting
          addServerDisconnectedMessage();
        } else if (!everRenderedText) {
          logSSE('reconnect:error_fallback_restore', { everRenderedText });
          await new Promise(r => setTimeout(r, 2000));
          await restoreMessages(streamSessionId);
        }
      }
    } else if (!streamCompleted && currentSessionId === streamSessionId && !hijackedStreams.has(streamSessionId)) {
      const errEl = document.createElement('div');
      errEl.className = 'message message-error';
      errEl.textContent = err.message;
      messagesEl.appendChild(errEl);
      scrollToBottom();
    }
  } finally {
    clearSlowApi();
    if (ttsFaceResponseActive && currentSessionId === streamSessionId) ttsFaceResponseEnd();
    streamingSessions.delete(streamSessionId);
    hijackedStreams.delete(streamSessionId);
    updateSessionBlockedBadge(streamSessionId, false);
    // Only update DOM if we're still viewing the session that finished
    if (currentSessionId === streamSessionId) {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      messageInput.placeholder = 'Type a message...';
      removeTypingIndicator();
      deactivateToolGroup();
      pendingAgentToolIds.clear();
      if (thinkingEl) {
        const label = thinkingEl.childNodes[0];
        if (label && label.nodeType === Node.TEXT_NODE) {
          label.textContent = 'Thought process (tap to expand)';
        }
      }
      // Safety net: if stream completed but NO text was ever rendered, restore from server.
      // The server may have result_text saved even when text_delta events were lost.
      // Don't trigger if text was rendered before tools — currentText being empty just
      // means the last segment was a tool call, not that text was lost.
      if (!everRenderedText && streamCompleted) {
        logSSE('finally:text_missing_restore', { streamCompleted, everRenderedText });
        await new Promise(r => setTimeout(r, 1500));
        await restoreMessages(streamSessionId);
      }
      // Refresh header title (may have been auto-named)
      try {
        const s = await fetch(`/api/sessions/${streamSessionId}`).then(r => r.json());
        chatTitle.textContent = s.name;
      } catch {}
      messageInput.focus();
    }
    loadSessions();
    // Drain queued message if one was added while streaming
    const queued = pendingMessages.get(streamSessionId);
    if (queued) {
      pendingMessages.delete(streamSessionId);
      // Small delay so the user sees the response before next message fires
      await new Promise(r => setTimeout(r, 500));
      if (currentSessionId === streamSessionId) {
        // Foreground drain — reuse the input flow so focus/draft behavior works.
        clearQueuedDecorations(streamSessionId);
        messageInput.value = queued.text;
        if (queued.attachments) {
          pendingAttachments.push(...queued.attachments);
        }
        sendMessage(true);
      } else {
        // Background drain — user is on another session; fire directly so we
        // don't clobber their input/attachments or send to the wrong session.
        drainQueuedMessage(streamSessionId, queued.text, queued.attachments);
      }
    }
  }
}

// Markdown rendering
function renderDiffBlock(code) {
  return code.trim().split('\n').map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('+')) return `<span class="diff-add">${escaped}</span>`;
    if (line.startsWith('-')) return `<span class="diff-del">${escaped}</span>`;
    if (line.startsWith('@@')) return `<span class="diff-hunk">${escaped}</span>`;
    return escaped;
  }).join('\n');
}

// Configure marked
const markedRenderer = new marked.Renderer();

// Custom code block renderer — diff highlighting + copy button
markedRenderer.code = function({ text, lang }) {
  const language = lang || '';
  if (language === 'diff') {
    return `<div class="code-block-wrapper"><button class="btn-copy-code" onclick="copyCode(this)">Copy</button><pre><code class="language-diff">${renderDiffBlock(text)}</code></pre></div>`;
  }
  const escaped = escapeHtml(text);
  return `<div class="code-block-wrapper"><button class="btn-copy-code" onclick="copyCode(this)">Copy</button><pre><code class="language-${language}">${escaped}</code></pre></div>`;
};

// Open links in new tab
markedRenderer.link = function({ href, text }) {
  return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
};

marked.use({
  renderer: markedRenderer,
  breaks: true,
  gfm: true,
});

function renderMarkdown(text) {
  // Pre-process [[wiki-links]] into wiki-link spans before marked parses.
  // Mirrors renderKbMarkdown so vault references Claude writes in chat
  // (e.g. `[[topic-slug]]`) resolve and open in the KB pane on click.
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const display = (parts[1] || parts[0]).trim();
    const escaped = target.replace(/"/g, '&quot;');
    return `<span class="wiki-link" data-target="${escaped}" onclick="navigateWikiLink(this)">${escapeHtml(display)}</span>`;
  });

  // Handle unclosed code block (still streaming) — close it temporarily for parsing
  const unclosedMatch = text.match(/```(\w*)\n([^`]*)$/);
  if (unclosedMatch) {
    // Append a closing fence so marked can parse it, then mark it as streaming
    const closed = text + '\n```';
    let html = marked.parse(closed);
    // Replace last code-block-wrapper with streaming style (no copy button)
    html = html.replace(
      /(<div class="code-block-wrapper"><button class="btn-copy-code"[^>]*>Copy<\/button>)(<pre>)(?![\s\S]*<div class="code-block-wrapper">)/,
      '$2'.replace('<pre>', '<pre class="streaming">')
    );
    // Simpler approach: just swap the last wrapper
    const lastWrapperIdx = html.lastIndexOf('<div class="code-block-wrapper">');
    if (lastWrapperIdx !== -1) {
      const before = html.substring(0, lastWrapperIdx);
      let after = html.substring(lastWrapperIdx);
      // Remove copy button and add streaming class
      after = after.replace('<div class="code-block-wrapper"><button class="btn-copy-code" onclick="copyCode(this)">Copy</button><pre>', '<pre class="streaming">');
      // Remove the trailing </div> that matched the wrapper
      after = after.replace(/<\/div>\s*$/, '');
      html = before + after;
    }
    return linkifyVaultPathsInHtml(html);
  }

  let html = marked.parse(text);
  return linkifyVaultPathsInHtml(html);
}

function linkifyVaultPathsInHtml(html) {
  if (VAULT_NAMES_ALT) {
    // Match absolute vault paths (allow spaces/commas in filenames, non-greedy to .md)
    const absRe = new RegExp(`(\\/[^<"']*?\\/Documents\\/Obsidian\\/(?:${VAULT_NAMES_ALT})\\/[^<"']*?\\.md)`, 'g');
    html = html.replace(absRe, (match) => {
      const short = match.split('/').slice(-3).join('/');
      return `<span class="tool-file-link" onclick="navigateToKbFile('${match.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${short}</span>`;
    });
    // Match relative vault paths (e.g. "Work/Meeting Notes/file.md", "AI-Work/topics/file.md")
    // Lookbehind excludes paths inside href/onclick attributes (preceded by / " ')
    const relRe = new RegExp(`(?<![/"'])(?<!\\w)((?:${VAULT_NAMES_ALT})\\/[^<"'\\n]*?\\.md)`, 'g');
    html = html.replace(relRe, (match) => {
      const resolved = resolveVaultPath(match);
      const short = match.split('/').slice(-3).join('/');
      return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${short}</span>`;
    });
  }
  // Match vault-internal relative paths (e.g. "sessions/2026-03/file.md", "topics/file.md")
  // These lack a vault name prefix — resolve using first configured vault
  html = html.replace(/(?<![/"'\w])((?:sessions|topics|projects|decisions)\/[^<"'\n]*?\.md)/g, (match) => {
    const vaultPrefix = VAULT_NAMES.length ? `${VAULT_NAMES[0]}/` : '';
    const resolved = resolveVaultPath(vaultPrefix + match);
    const short = match.split('/').slice(-2).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${short}</span>`;
  });
  // Match labeled slug references from session close output (e.g. "Topics Updated slug-name").
  // Decisions live at decisions/<projectSlug>/<slug>.md and projects at projects/<slug>/project.md,
  // so route through navigateWikiLink — its /api/vault/kb/resolve-link endpoint handles the
  // bare-name lookup (decisions, topics) and the path-style lookup (projects) on the server.
  html = html.replace(/(Topics (?:Updated|Created)|Projects Linked|Decisions (?:Made|Recorded))\s+([\w][\w ,-]*[\w-])/g, (match, label, slugsPart) => {
    if (!VAULT_NAMES.length) return match;
    const slugs = slugsPart.split(/,\s*/);
    const linked = slugs.map(slug => {
      slug = slug.trim();
      if (!slug) return '';
      const target = label === 'Projects Linked' ? `projects/${slug}/project` : slug;
      const escaped = target.replace(/"/g, '&quot;');
      return `<span class="wiki-link" data-target="${escaped}" onclick="navigateWikiLink(this)" title="Open in Knowledge Base">${escapeHtml(slug)}</span>`;
    }).join(', ');
    return `${label} ${linked}`;
  });
  return html;
}

// Copy code block
function copyCode(btn) {
  const code = btn.nextElementSibling.querySelector('code');
  navigator.clipboard.writeText(code.textContent).then(() => {
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.classList.remove('copied');
    }, 1500);
  });
}

// Utilities
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Permission dialog

function updateSessionBlockedBadge(sessionId, blocked) {
  if (blocked) {
    permissionBlockedSessions.add(sessionId);
  } else {
    permissionBlockedSessions.delete(sessionId);
  }
  document.querySelectorAll('.session-item').forEach(el => {
    const elSessionId = el.getAttribute('onclick')?.match(/switchSession\('([^']+)'\)/)?.[1];
    if (elSessionId !== sessionId) return;
    const nameEl = el.querySelector('.session-item-name');
    if (!nameEl) return;
    const existingBlocked = nameEl.querySelector('.session-blocked-badge');
    if (blocked && !existingBlocked) {
      // Hide existing badges, insert blocked badge
      const closedBadge = nameEl.querySelector('.session-closed-badge');
      const codeBadge = nameEl.querySelector('.session-code-badge');
      const agentBadge = nameEl.querySelector('.session-agent-badge');
      const docBadge = nameEl.querySelector('.session-doc-badge');
      if (closedBadge) closedBadge.style.display = 'none';
      if (codeBadge) codeBadge.style.display = 'none';
      if (agentBadge) agentBadge.style.display = 'none';
      if (docBadge) docBadge.style.display = 'none';
      const badge = document.createElement('span');
      badge.className = 'session-blocked-badge';
      badge.title = 'Waiting for permission';
      badge.textContent = '!';
      nameEl.insertBefore(badge, nameEl.firstChild);
    } else if (!blocked && existingBlocked) {
      existingBlocked.remove();
      // Restore hidden badges
      const closedBadge = nameEl.querySelector('.session-closed-badge');
      const codeBadge = nameEl.querySelector('.session-code-badge');
      const agentBadge = nameEl.querySelector('.session-agent-badge');
      const docBadge = nameEl.querySelector('.session-doc-badge');
      if (closedBadge) closedBadge.style.display = '';
      if (codeBadge) codeBadge.style.display = '';
      if (agentBadge) agentBadge.style.display = '';
      if (docBadge) docBadge.style.display = '';
    }
  });
}

// Poll for pending permission requests (fallback when SSE event doesn't arrive)
function startPermissionPolling() {
  if (permissionPollInterval) return;
  console.log('[permission-poll] started');
  permissionPollInterval = setInterval(async () => {
    if (pendingPermissionId || !currentSessionId) return;
    try {
      const res = await fetchWithRetry(`/api/permissions/pending/${currentSessionId}`, {}, { timeout: 5000 });
      const pending = await res.json();
      if (pending && pending.id && !pendingPermissionId) {
        console.log('[permission-poll] found pending request:', pending);
        showPermissionDialog(pending.id, pending.toolName, pending.toolInput);
      }
    } catch (err) {
      console.error('[permission-poll] fetch error:', err);
    }
  }, 2000);
}

function stopPermissionPolling() {
  if (permissionPollInterval) {
    clearInterval(permissionPollInterval);
    permissionPollInterval = null;
  }
}

// Start polling when page loads
startPermissionPolling();

function showPermissionDialog(id, toolName, toolInput) {
  // If a dialog is already showing, queue this request
  if (pendingPermissionId) {
    console.log('[permission] queuing request (dialog already open):', id);
    permissionQueue.push({ id, toolName, toolInput });
    return;
  }

  pendingPermissionId = id;
  pendingPermissionSessionId = currentSessionId;
  document.getElementById('permission-tool-name').textContent = toolName;

  // Format the tool input for display
  let detail = '';
  if (toolName === 'Bash' && toolInput?.command) {
    detail = toolInput.command;
  } else if ((toolName === 'Edit' || toolName === 'Write') && toolInput?.file_path) {
    detail = toolInput.file_path;
  } else if (toolInput?.file_path) {
    detail = `${toolInput.operation || 'write'}: ${toolInput.file_path}`;
  } else if (toolInput) {
    const json = JSON.stringify(toolInput, null, 2);
    detail = json.length > 500 ? json.substring(0, 500) + '...' : json;
  }
  document.getElementById('permission-tool-detail').textContent = detail || '(no details)';
  document.getElementById('permission-overlay').style.display = '';
}

async function respondPermission(decision, allowAll) {
  const overlay = document.getElementById('permission-overlay');
  overlay.style.display = 'none';

  if (!pendingPermissionId) {
    console.warn('[permission] respondPermission called but pendingPermissionId is null');
    return;
  }

  console.log(`[permission] responding: decision=${decision} allowAll=${!!allowAll} requestId=${pendingPermissionId}`);

  try {
    const res = await fetchWithRetry('/api/permissions/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: pendingPermissionId,
        decision,
        allowAll: !!allowAll,
      }),
    });
    const body = await res.json();
    console.log(`[permission] respond status=${res.status}`, body);
  } catch (err) {
    console.error('[permission] respond fetch error:', err);
  }

  pendingPermissionId = null;

  // Clear blocked badge for the session that was waiting
  if (pendingPermissionSessionId) {
    updateSessionBlockedBadge(pendingPermissionSessionId, false);
    pendingPermissionSessionId = null;
  }

  // Handle queued permission requests
  if (allowAll && permissionQueue.length > 0) {
    // "Allow All" auto-responds to all queued requests (backend cascade handles them,
    // but clear the queue so we don't show stale dialogs)
    console.log(`[permission] allowAll: clearing ${permissionQueue.length} queued request(s)`);
    permissionQueue.length = 0;
  } else if (permissionQueue.length > 0) {
    // Show the next queued permission dialog
    const next = permissionQueue.shift();
    console.log('[permission] showing next queued request:', next.id);
    showPermissionDialog(next.id, next.toolName, next.toolInput);
    return; // don't add typing indicator — still waiting for permission
  }

  addTypingIndicator();
}

// ============================================================
// Settings View
// ============================================================

let currentView = 'sessions';
let settingsData = null;
let activeSettingsSection = 'appearance';

function toggleViewMenu() {
  const menu = document.getElementById('sidebar-view-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

// Close view menu on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.sidebar-view-switcher')) {
    document.getElementById('sidebar-view-menu').style.display = 'none';
  }
});

function switchView(view) {
  if (view === currentView) {
    document.getElementById('sidebar-view-menu').style.display = 'none';
    return;
  }
  // Guard against navigating away from KB while editing — flush autosave first
  if (currentView === 'kb' && kbIsEditing) {
    clearTimeout(kbAutosaveTimer);
    kbAutosave();
    cancelKbEdit();
  }
  currentView = view;
  document.getElementById('sidebar-view-menu').style.display = 'none';
  const labels = { sessions: 'Sessions', kb: 'Knowledge Base', settings: 'Settings' };
  document.getElementById('sidebar-view-label').textContent = labels[view] || view;

  // Update dropdown active state
  document.querySelectorAll('.sidebar-view-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.view === view);
  });

  const sessionsView = document.getElementById('sessions-view');
  const settingsView = document.getElementById('settings-view');
  const kbView = document.getElementById('kb-view');
  const sessionsToolbar = document.getElementById('sessions-toolbar');
  const chatMain = document.querySelector('.chat-main');
  const settingsPanel = document.getElementById('settings-panel');
  const kbPanel = document.getElementById('kb-panel');

  // Hide everything first
  sessionsView.style.display = 'none';
  sessionsToolbar.style.display = 'none';
  settingsView.style.display = 'none';
  kbView.style.display = 'none';
  chatMain.style.display = 'none';
  settingsPanel.style.display = 'none';
  kbPanel.style.display = 'none';

  if (view === 'settings') {
    settingsView.style.display = '';
    settingsPanel.style.display = 'flex';
    loadSettings();
  } else if (view === 'kb') {
    kbView.style.display = '';
    kbPanel.style.display = 'flex';
    if (!kbTreeLoaded) {
      loadKbTree();
      if (!kbPrefsLoaded) loadKbPreferences();
    }
  } else {
    sessionsView.style.display = '';
    sessionsToolbar.style.display = '';
    chatMain.style.display = '';
  }
}

function showSettingsSection(section) {
  activeSettingsSection = section;
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.section === section);
  });
  renderSettingsContent();
  // On mobile, close sidebar so the settings content is visible
  if (sidebar.classList.contains('open')) toggleSidebar();
}

async function loadSettings() {
  try {
    const res = await fetchWithRetry('/api/settings');
    settingsData = await res.json();
  } catch {
    settingsData = { primaryVaults: [], secondaryVaults: [], security: { accessControl: { allowedPaths: [] } } };
  }
  renderSettingsContent();
}

async function saveSettings() {
  try {
    await fetchWithRetry('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsData),
    });
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

function renderSettingsContent() {
  const container = document.getElementById('settings-content');
  if (!settingsData) {
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    return;
  }

  // Paths section uses bridge-config, not MCP config — always accessible
  if (activeSettingsSection === 'paths') {
    renderPathsSettings(container);
    return;
  }

  // Appearance is also independent of MCP config
  if (activeSettingsSection === 'appearance') {
    renderAppearanceSettings(container);
    return;
  }

  // Voice section is independent of MCP config
  if (activeSettingsSection === 'voice') {
    renderVoiceSettings(container);
    return;
  }

  // Updates section is independent of MCP config
  if (activeSettingsSection === 'updates') {
    renderUpdatesSettings(container);
    return;
  }

  // Show config path setup if the file wasn't found (for MCP-dependent sections)
  if (!settingsData._configFound) {
    renderConfigPathSetup(container);
    return;
  }

  if (activeSettingsSection === 'vault-setup') {
    renderVaultSettings(container);
  } else if (activeSettingsSection === 'allowed-paths') {
    renderAllowedPaths(container);
  }
}

function renderAppearanceSettings(container) {
  const currentTheme = localStorage.getItem('chat-bridge-theme') || 'dark';
  container.innerHTML = `
    <h2 class="settings-title">Appearance</h2>
    <div class="settings-section">
      <div class="settings-section-title">Theme</div>
      <div class="settings-section-desc">Choose between dark and light mode for the interface.</div>
      <div class="settings-theme-toggle">
        <button class="settings-theme-btn ${currentTheme === 'dark' ? 'active' : ''}" data-theme="dark" onclick="setTheme('dark')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
          Dark
        </button>
        <button class="settings-theme-btn ${currentTheme === 'light' ? 'active' : ''}" data-theme="light" onclick="setTheme('light')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
          Light
        </button>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Tool Usage Display</div>
      <div class="settings-section-desc">Show or hide the "Tools used" groups in chat messages.</div>
      <div class="settings-theme-toggle">
        <button class="settings-theme-btn ${localStorage.getItem('chat-bridge-hide-tools') !== 'true' ? 'active' : ''}" onclick="setHideTools(false)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
          </svg>
          Show
        </button>
        <button class="settings-theme-btn ${localStorage.getItem('chat-bridge-hide-tools') === 'true' ? 'active' : ''}" onclick="setHideTools(true)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
          Hide
        </button>
      </div>
    </div>
  `;
}

function setTTSFace(enabled) {
  ttsFaceEnabled = enabled;
  localStorage.setItem('chat-bridge-tts-face', enabled ? 'true' : 'false');
  if (!enabled) {
    ttsFaceActivity = 'idle';
    ttsFaceResponseActive = false;
    ttsFaceHideImmediate();
  }
  // Re-render to update active states
  const container = document.getElementById('settings-content');
  if (container) renderVoiceSettings(container);
}

function buildTTSFaceHTML() {
  const onClass = ttsFaceEnabled ? 'active' : '';
  const offClass = !ttsFaceEnabled ? 'active' : '';
  return '<div class="settings-section">' +
    '<div class="settings-section-title">Speaking Face</div>' +
    '<div class="settings-section-desc">Show an animated face that thinks, watches tools work, and speaks during TTS.</div>' +
    '<div class="settings-theme-toggle">' +
      '<button class="settings-theme-btn ' + onClass + '" onclick="setTTSFace(true)">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"/>' +
          '<path d="M8 14s1.5 2 4 2 4-2 4-2"/>' +
          '<line x1="9" y1="9" x2="9.01" y2="9"/>' +
          '<line x1="15" y1="9" x2="15.01" y2="9"/>' +
        '</svg>' +
        ' On' +
      '</button>' +
      '<button class="settings-theme-btn ' + offClass + '" onclick="setTTSFace(false)">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"/>' +
          '<line x1="8" y1="15" x2="16" y2="15"/>' +
          '<line x1="9" y1="9" x2="9.01" y2="9"/>' +
          '<line x1="15" y1="9" x2="15.01" y2="9"/>' +
        '</svg>' +
        ' Off' +
      '</button>' +
    '</div>' +
  '</div>';
}

async function renderVoiceSettings(container) {
  container.innerHTML = `
    <h2 class="settings-title">Voice</h2>
    ${buildTTSProviderHTML()}
    ${ttsProvider === 'google-cloud' ? buildGoogleTTSKeyHTML() : ''}
    ${ttsProvider === 'google-cloud' ? '<div id="google-voice-section"></div>' : buildBrowserTTSSettingsHTML()}
    ${buildTTSSpeedHTML()}
    ${buildTTSAutoSpeakHTML()}
    ${buildTTSFaceHTML()}
  `;
  // Load Google Cloud voices if that provider is selected
  if (ttsProvider === 'google-cloud') {
    await renderGoogleVoiceSelector();
  }
}

function setHideTools(hide) {
  localStorage.setItem('chat-bridge-hide-tools', hide ? 'true' : 'false');
  document.documentElement.setAttribute('data-hide-tools', hide ? 'true' : 'false');
  // Re-render to update active states
  const container = document.getElementById('settings-content');
  if (container) renderAppearanceSettings(container);
}

function buildTTSProviderHTML() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">TTS Provider</div>
      <div class="settings-section-desc">Choose between browser built-in speech or Google Cloud Text-to-Speech for higher-quality voices.</div>
      <div class="settings-theme-toggle">
        <button class="settings-theme-btn ${ttsProvider === 'browser' ? 'active' : ''}" onclick="setTTSProvider('browser')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          </svg>
          Built-in
        </button>
        <button class="settings-theme-btn ${ttsProvider === 'google-cloud' ? 'active' : ''}" onclick="setTTSProvider('google-cloud')">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 12c0-1.5-.5-2.8-1.3-3.8"/>
            <path d="M17 8a5 5 0 0 0-10 0c-2.8 0-5 2.2-5 5s2.2 5 5 5h10c2.8 0 5-2.2 5-5 0-1-.3-2-.7-2.8"/>
          </svg>
          Google Cloud
        </button>
      </div>
    </div>
  `;
}

function buildGoogleTTSKeyHTML() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Google Cloud API Key</div>
      <div class="settings-section-desc">Enter your Google Cloud Text-to-Speech API key. Stored securely on the server, never sent to the browser.</div>
      <div class="tts-voice-row">
        <input type="password" id="google-tts-key-input" class="tts-select" placeholder="Enter API key..." style="font-family: monospace; letter-spacing: 1px;">
        <button class="tts-preview-btn" onclick="saveGoogleTTSKey()" title="Save API key">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
      <div id="google-tts-key-status" class="settings-section-desc" style="margin-top: 6px;"></div>
    </div>
  `;
}

function buildBrowserTTSSettingsHTML() {
  const voices = window.speechSynthesis ? speechSynthesis.getVoices().filter(v => v.lang.startsWith('en')) : [];
  const savedVoice = localStorage.getItem('chat-bridge-tts-voice') || '';

  if (!window.speechSynthesis) {
    return `
      <div class="settings-section">
        <div class="settings-section-title">Text-to-Speech</div>
        <div class="settings-section-desc">Speech synthesis is not available in this browser.</div>
      </div>
    `;
  }

  function voiceTier(v) {
    const id = (v.voiceURI || '') + ' ' + v.name;
    if (/premium/i.test(id)) return 'premium';
    if (/enhanced/i.test(id)) return 'enhanced';
    if (/compact/i.test(id)) return 'compact';
    return 'standard';
  }
  const premium = voices.filter(v => voiceTier(v) === 'premium');
  const enhanced = voices.filter(v => voiceTier(v) === 'enhanced');
  const standard = voices.filter(v => voiceTier(v) === 'standard');
  const compact = voices.filter(v => voiceTier(v) === 'compact');

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function voiceKey(v) { return v.voiceURI || v.name; }

  function voiceOptions(list, label) {
    if (!list.length) return '';
    return `<optgroup label="${esc(label)}">${list.map(v => {
      const key = voiceKey(v);
      const tier = voiceTier(v);
      const displayName = (tier !== 'standard') ? `${v.name} (${tier})` : v.name;
      return `<option value="${esc(key)}" ${key === savedVoice ? 'selected' : ''}>${esc(displayName)}</option>`;
    }).join('')}</optgroup>`;
  }

  const hasSelected = voices.some(v => voiceKey(v) === savedVoice);

  return `
    <div class="settings-section">
      <div class="settings-section-title">Text-to-Speech Voice</div>
      <div class="settings-section-desc">On iOS, "System Default" uses whatever voice you set in Settings > Accessibility > Read & Speak > Voices > English (e.g. Ava). Enhanced/Premium voices must be downloaded there first. The list below only shows voices the browser exposes directly. (${voices.length} found)</div>
      <div class="tts-voice-row">
        <select id="tts-voice-select" class="tts-select" onchange="setTTSVoice(this.value)">
          <option value="" ${!hasSelected ? 'selected' : ''}>System Default</option>
          ${voiceOptions(premium, 'Premium')}
          ${voiceOptions(enhanced, 'Enhanced')}
          ${voiceOptions(standard, 'Standard')}
          ${voiceOptions(compact, 'Compact')}
        </select>
        <button class="tts-preview-btn" onclick="previewTTSVoice()" title="Preview voice">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
    </div>
  `;
}

function buildTTSSpeedHTML() {
  const savedRate = localStorage.getItem('chat-bridge-tts-rate') || '1.0';
  return `
    <div class="settings-section">
      <div class="settings-section-title">Speech Speed</div>
      <div class="settings-section-desc">Adjust how fast the voice speaks.</div>
      <div class="tts-speed-row">
        <input type="range" id="tts-rate-slider" class="tts-slider" min="0.5" max="2.0" step="0.1" value="${savedRate}" oninput="setTTSRate(this.value)">
        <span id="tts-rate-label" class="tts-rate-label">${parseFloat(savedRate).toFixed(1)}x</span>
      </div>
    </div>
  `;
}

function buildTTSAutoSpeakHTML() {
  return `
    <div class="settings-section">
      <div class="settings-section-title">Auto-Speak</div>
      <div class="settings-section-desc">Automatically read new assistant responses aloud when they finish.</div>
      <div class="settings-theme-toggle">
        <button class="settings-theme-btn ${ttsAutoSpeak ? 'active' : ''}" onclick="setTTSAutoSpeak(true)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
          </svg>
          On
        </button>
        <button class="settings-theme-btn ${!ttsAutoSpeak ? 'active' : ''}" onclick="setTTSAutoSpeak(false)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
            <line x1="23" y1="9" x2="17" y2="15"/>
            <line x1="17" y1="9" x2="23" y2="15"/>
          </svg>
          Off
        </button>
      </div>
    </div>
  `;
}

// Google Cloud voice selector — fetches voices from server and renders dropdown
async function renderGoogleVoiceSelector() {
  const section = document.getElementById('google-voice-section');
  if (!section) return;

  // Show API key status
  const statusEl = document.getElementById('google-tts-key-status');
  try {
    const keyResp = await fetchWithRetry('/api/tts/api-key');
    const keyData = await keyResp.json();
    if (statusEl) {
      statusEl.textContent = keyData.configured
        ? `Key configured: ${keyData.maskedKey}`
        : 'No API key configured yet.';
      statusEl.style.color = keyData.configured ? 'var(--text-muted)' : 'var(--accent)';
    }
    if (!keyData.configured) {
      section.innerHTML = `
        <div class="settings-section">
          <div class="settings-section-title">Google Cloud Voice</div>
          <div class="settings-section-desc">Save an API key above to load available voices.</div>
        </div>
      `;
      return;
    }
  } catch {
    if (statusEl) statusEl.textContent = 'Could not check API key status.';
  }

  // Fetch voices (use cache if available)
  if (!ttsGoogleVoicesCache) {
    section.innerHTML = `
      <div class="settings-section">
        <div class="settings-section-title">Google Cloud Voice</div>
        <div class="settings-section-desc">Loading voices...</div>
      </div>
    `;
    try {
      const resp = await fetch('/api/tts/voices');
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        const errMsg = (err.error || 'Unknown error').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        section.innerHTML = `
          <div class="settings-section">
            <div class="settings-section-title">Google Cloud Voice</div>
            <div class="settings-section-desc" style="color: var(--accent);">Failed to load voices: ${errMsg}</div>
          </div>
        `;
        return;
      }
      const data = await resp.json();
      ttsGoogleVoicesCache = data.voices || [];
    } catch (err) {
      section.innerHTML = `
        <div class="settings-section">
          <div class="settings-section-title">Google Cloud Voice</div>
          <div class="settings-section-desc" style="color: var(--accent);">Network error loading voices.</div>
        </div>
      `;
      return;
    }
  }

  const voices = ttsGoogleVoicesCache;
  const savedVoice = localStorage.getItem('chat-bridge-tts-google-voice') || '';

  function esc(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

  // Group by tier
  const tiers = ['Next Gen', 'Studio', 'Journey', 'Neural2', 'Polyglot', 'WaveNet', 'Standard'];
  const grouped = {};
  for (const t of tiers) grouped[t] = [];
  for (const v of voices) {
    const t = v.tier || 'Standard';
    if (!grouped[t]) grouped[t] = [];
    grouped[t].push(v);
  }

  let optionsHTML = `<option value="" ${!savedVoice ? 'selected' : ''}>Default (en-US)</option>`;
  for (const tier of tiers) {
    const list = grouped[tier];
    if (!list || !list.length) continue;
    optionsHTML += `<optgroup label="${esc(tier)}">`;
    for (const v of list) {
      const genderLabel = v.gender === 'MALE' ? 'M' : v.gender === 'FEMALE' ? 'F' : '?';
      const displayName = `${v.name} (${genderLabel})`;
      optionsHTML += `<option value="${esc(v.name)}" ${v.name === savedVoice ? 'selected' : ''}>${esc(displayName)}</option>`;
    }
    optionsHTML += `</optgroup>`;
  }

  section.innerHTML = `
    <div class="settings-section">
      <div class="settings-section-title">Google Cloud Voice</div>
      <div class="settings-section-desc">Higher-tier voices (Studio, Journey) sound more natural. ${voices.length} English voices available.</div>
      <div class="tts-voice-row">
        <select id="tts-google-voice-select" class="tts-select" onchange="setGoogleTTSVoice(this.value)">
          ${optionsHTML}
        </select>
        <button class="tts-preview-btn" onclick="previewTTSVoice()" title="Preview voice">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </div>
    </div>
  `;
}

function setTTSProvider(provider) {
  ttsProvider = provider;
  localStorage.setItem('chat-bridge-tts-provider', provider);
  // Don't kill streaming TTS on provider switch — the consumer reads ttsProvider
  // dynamically, so the new provider kicks in on the next sentence automatically
  if (!ttsStreamActive && !ttsStreamConsuming) {
    stopSpeaking();
  }
  const container = document.getElementById('settings-content');
  if (container && activeSettingsSection === 'voice') renderVoiceSettings(container);
}

async function saveGoogleTTSKey() {
  const input = document.getElementById('google-tts-key-input');
  const statusEl = document.getElementById('google-tts-key-status');
  if (!input) return;

  const apiKey = input.value.trim();
  try {
    const resp = await fetchWithRetry('/api/tts/api-key', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const data = await resp.json();
    if (statusEl) {
      statusEl.textContent = data.configured ? 'API key saved.' : 'API key cleared.';
      statusEl.style.color = 'var(--text-muted)';
    }
    input.value = '';
    // Clear voice cache and re-render to load voices with new key
    ttsGoogleVoicesCache = null;
    const container = document.getElementById('settings-content');
    if (container && activeSettingsSection === 'voice') renderVoiceSettings(container);
  } catch (err) {
    if (statusEl) {
      statusEl.textContent = 'Failed to save API key.';
      statusEl.style.color = 'var(--accent)';
    }
  }
}

function setGoogleTTSVoice(name) {
  localStorage.setItem('chat-bridge-tts-google-voice', name);
}

function setTTSVoice(name) {
  localStorage.setItem('chat-bridge-tts-voice', name);
}

function setTTSRate(rate) {
  localStorage.setItem('chat-bridge-tts-rate', rate);
  const label = document.getElementById('tts-rate-label');
  if (label) label.textContent = parseFloat(rate).toFixed(1) + 'x';
}

async function setTTSAutoSpeak(on) {
  ttsAutoSpeak = on;
  localStorage.setItem('chat-bridge-tts-auto', on ? 'true' : 'false');
  updateTTSToggleBtn();
  const container = document.getElementById('settings-content');
  if (container && activeSettingsSection === 'voice') await renderVoiceSettings(container);
}

function previewTTSVoice() {
  speakText('Hey Jesse, this is what I sound like. Not bad for a browser, right?', null);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('chat-bridge-theme', theme);
  document.querySelectorAll('.settings-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

// Updates settings — version check
async function renderUpdatesSettings(container) {
  container.innerHTML = `
    <h2 class="settings-title">Updates</h2>
    <div class="settings-section">
      <div class="settings-section-title">Claude Code CLI Version</div>
      <div class="settings-section-desc">Check if a newer version of the Claude Code CLI is available.</div>
      <div class="version-status">
        <div class="version-loading">Checking version...</div>
      </div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Source Versions</div>
      <div class="settings-section-desc">Currently running build of the bridge and MCP server.</div>
      <div id="source-versions-content"><div class="version-loading">Loading...</div></div>
    </div>
    <div class="settings-section">
      <div class="settings-section-title">Project Source Updates</div>
      <div class="settings-section-desc">Pull the latest changes from git, build, and restart the server.</div>
      <div id="git-pull-status"></div>
      <div class="version-actions" style="margin-top:12px">
        <button class="settings-theme-btn" onclick="pullProjectUpdates()">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>
          </svg>
          Pull &amp; Restart
        </button>
      </div>
    </div>
  `;

  loadSourceVersions(container);

  try {
    const res = await fetchWithRetry('/api/settings/version');
    versionData = await res.json();
  } catch {
    container.querySelector('.version-status').innerHTML =
      '<div class="version-error">Failed to check version.</div>';
    return;
  }

  const { currentVersion, latestVersion, updateAvailable } = versionData;
  const statusEl = container.querySelector('.version-status');

  let statusBadge = '';
  if (updateAvailable === true) {
    statusBadge = '<span class="version-badge version-badge-update">Update available</span>';
  } else if (updateAvailable === false) {
    statusBadge = '<span class="version-badge version-badge-current">Up to date</span>';
  }

  statusEl.innerHTML = `
    <div class="version-info">
      <div class="version-row">
        <span class="version-label">Installed</span>
        <span class="version-value">${currentVersion || 'Unknown'}</span>
      </div>
      <div class="version-row">
        <span class="version-label">Latest</span>
        <span class="version-value">${latestVersion || 'Unknown'}</span>
      </div>
      <div class="version-row">
        <span class="version-label">Status</span>
        <span class="version-value">${statusBadge || 'Unable to determine'}</span>
      </div>
    </div>
    <div class="version-actions">
      <button class="settings-theme-btn" onclick="checkVersionUpdate()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="23 4 23 10 17 10"/>
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
        </svg>
        Refresh
      </button>
      ${updateAvailable ? `<button class="settings-theme-btn" onclick="window.open('https://github.com/anthropics/claude-code/releases', '_blank')">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        Release Notes
      </button>` : ''}
      <button class="settings-theme-btn" onclick="updateClaudeCli()">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Update CLI
      </button>
    </div>
    <div id="cli-update-status"></div>
  `;

  // Acknowledge current version as seen (dismisses startup banner)
  if (currentVersion) {
    try {
      await fetchWithRetry('/api/settings/version/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: currentVersion }),
      });
    } catch {}
  }
}

async function loadSourceVersions(container) {
  const el = container.querySelector('#source-versions-content');
  if (!el) return;
  let data;
  try {
    const res = await fetchWithRetry('/api/settings/source-versions');
    data = await res.json();
  } catch {
    el.innerHTML = '<div class="version-error">Failed to load source versions.</div>';
    return;
  }
  el.innerHTML = (data.projects || []).map(p => {
    let shaPart;
    if (p.sha) {
      shaPart = `<code class="source-version-sha-code">${escapeHtml(p.sha)}</code>` +
        (p.dirty ? ' <span class="version-badge version-badge-update" title="Uncommitted local changes">dirty</span>' : '');
    } else if (p.error) {
      shaPart = `<span class="version-error">${escapeHtml(p.error)}</span>`;
    } else {
      shaPart = '<span class="source-version-detail-value">Unknown</span>';
    }
    const commitFmt = p.commitDate ? new Date(p.commitDate).toLocaleString() : '—';
    const builtFmt = p.builtAt ? new Date(p.builtAt).toLocaleString() : null;
    const buildIdRow = p.buildId
      ? `<div class="source-version-detail"><span class="source-version-detail-label">Build ID</span><span class="source-version-detail-value"><code class="source-version-sha-code">${escapeHtml(p.buildId)}</code></span></div>`
      : '';
    const builtRow = builtFmt
      ? `<div class="source-version-detail"><span class="source-version-detail-label">Built</span><span class="source-version-detail-value">${escapeHtml(builtFmt)}</span></div>`
      : '';
    return `
      <div class="source-version-card">
        <div class="source-version-card-header">
          <span class="source-version-name">${escapeHtml(p.name)}</span>
          <span class="source-version-sha">${shaPart}</span>
        </div>
        <div class="source-version-card-body">
          <div class="source-version-detail">
            <span class="source-version-detail-label">Commit date</span>
            <span class="source-version-detail-value">${escapeHtml(commitFmt)}</span>
          </div>
          ${buildIdRow}
          ${builtRow}
        </div>
      </div>
    `;
  }).join('');
}

async function checkVersionUpdate() {
  versionData = null;
  const container = document.getElementById('settings-content');
  renderUpdatesSettings(container);
}

async function updateClaudeCli() {
  const statusEl = document.getElementById('cli-update-status');
  if (!statusEl) return;
  statusEl.innerHTML = '<div class="version-loading">Updating Claude Code CLI...</div>';
  try {
    const res = await fetchWithRetry('/api/settings/update-cli', { method: 'POST' }, { timeout: 120000 });
    const data = await res.json();
    if (data.success) {
      statusEl.innerHTML = `
        <div class="git-pull-result">
          <div class="git-pull-result-header">
            <span class="git-pull-result-name">@anthropic-ai/claude-code</span>
            <span class="version-badge version-badge-current">${data.updated ? 'Updated' : 'Up to date'}</span>
          </div>
          ${data.output ? `<pre class="git-pull-output">${escapeHtml(data.output)}</pre>` : ''}
        </div>
      `;
      // Always re-fetch version info after a successful update attempt
      versionData = null;
      const container = document.getElementById('settings-content');
      renderUpdatesSettings(container);
    } else {
      statusEl.innerHTML = `
        <div class="git-pull-result">
          <div class="git-pull-result-header">
            <span class="git-pull-result-name">@anthropic-ai/claude-code</span>
            <span class="version-badge version-badge-error">Failed</span>
          </div>
          ${data.output ? `<pre class="git-pull-output">${escapeHtml(data.output)}</pre>` : ''}
        </div>
      `;
    }
  } catch {
    statusEl.innerHTML = '<div class="version-error">Failed to update Claude Code CLI.</div>';
  }
}

async function pullProjectUpdates() {
  const statusEl = document.getElementById('git-pull-status');
  if (!statusEl) return;
  statusEl.innerHTML = '<div class="version-loading">Pulling updates &amp; building...</div>';
  try {
    const res = await fetchWithRetry('/api/settings/git-pull', { method: 'POST' }, { timeout: 300000 });
    const data = await res.json();
    const anyBuilt = data.results.some(r => r.built);
    const allSuccess = data.results.every(r => r.success);

    statusEl.innerHTML = data.results.map(r => {
      let badge = '';
      if (!r.success) {
        badge = '<span class="version-badge version-badge-error">Failed</span>';
      } else if (r.built) {
        badge = '<span class="version-badge version-badge-current">Pulled &amp; Built</span>';
      } else {
        badge = '<span class="version-badge version-badge-current">Up to date</span>';
      }
      const pullSection = r.pullOutput ? `<pre class="git-pull-output">${escapeHtml(r.pullOutput)}</pre>` : '';
      const buildSection = r.buildOutput ? `<div style="margin-top:6px;font-size:12px;color:var(--text-secondary)">Build output:</div><pre class="git-pull-output">${escapeHtml(r.buildOutput)}</pre>` : '';
      return `
        <div class="git-pull-result">
          <div class="git-pull-result-header">
            <span class="git-pull-result-name">${escapeHtml(r.name)}</span>
            ${badge}
          </div>
          ${pullSection}
          ${buildSection}
        </div>
      `;
    }).join('');

    // If new code was built successfully, restart the server
    if (anyBuilt && allSuccess) {
      statusEl.innerHTML += '<div class="version-loading" style="margin-top:12px">Restarting server...</div>';
      try {
        await fetch('/api/settings/restart', { method: 'POST' });
      } catch { /* expected — server is dying */ }
      // Wait for server to come back, then reload
      statusEl.innerHTML += '<div class="version-loading" style="margin-top:4px">Waiting for server to restart...</div>';
      await waitForServer(10000);
      window.location.reload();
    }
  } catch {
    statusEl.innerHTML = '<div class="version-error">Failed to pull updates.</div>';
  }
}

async function waitForServer(timeoutMs) {
  const start = Date.now();
  // Initial delay to let the server shut down
  await new Promise(r => setTimeout(r, 1500));
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch('/api/settings/version', { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* server not up yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
}

// Bridge paths settings — cached from /api/settings/bridge-paths
let bridgePathsData = null;

async function renderPathsSettings(container) {
  if (!bridgePathsData) {
    container.innerHTML = '<div class="settings-loading">Loading...</div>';
    try {
      const res = await fetchWithRetry('/api/settings/bridge-paths');
      bridgePathsData = await res.json();
    } catch {
      container.innerHTML = '<div class="settings-section-desc">Failed to load bridge paths.</div>';
      return;
    }
  }
  const fields = [
    { key: 'workingDir', label: 'Working Directory', desc: 'Default working directory for new sessions' },
    { key: 'claudePath', label: 'Claude CLI Path', desc: 'Path to the Claude CLI binary' },
    { key: 'mcpConfigPath', label: 'MCP Config Path', desc: 'Path to .obsidian-mcp.json configuration file' },
    { key: 'pluginDir', label: 'Plugin Directory', desc: 'Path to the obsidian-claude-plugin directory passed to Claude via --plugin-dir' },
  ];
  let html = '<h2 class="settings-title">Paths</h2>';
  html += '<p class="settings-section-desc">Configure file system paths for the bridge. Changes take effect on next server restart.</p>';
  html += '<div class="settings-section">';
  for (const f of fields) {
    const val = bridgePathsData[f.key] || '';
    html += `<div class="settings-form-field">
      <label>${f.label}</label>
      <div class="settings-section-desc" style="margin-bottom:4px">${f.desc}</div>
      <div class="settings-path-input">
        <input type="text" id="bridge-path-${f.key}" value="${escapeHtml(val)}">
        <button class="settings-browse-btn" onclick="browseForPath('bridge-path-${f.key}')">Browse</button>
      </div>
      <div id="bridge-path-${f.key}-browser" class="settings-path-browser" style="display:none"></div>
    </div>`;
  }
  html += `<div class="settings-form-actions">
    <button class="settings-form-save" onclick="saveBridgePaths()">Save</button>
  </div>`;
  html += '</div>';
  container.innerHTML = html;
}

async function saveBridgePaths() {
  const updates = {};
  const stringFields = ['workingDir', 'claudePath', 'mcpConfigPath', 'pluginDir'];
  for (const key of stringFields) {
    const el = document.getElementById(`bridge-path-${key}`);
    if (el) updates[key] = el.value.trim();
  }
  try {
    const res = await fetchWithRetry('/api/settings/bridge-paths', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    bridgePathsData = await res.json();
    // Refresh frontend vault config
    await loadBridgePaths();
    renderSettingsContent();
  } catch (err) {
    console.error('Failed to save bridge paths:', err);
  }
}

function renderConfigPathSetup(container) {
  const currentPath = settingsData._configPath || '';
  container.innerHTML = `
    <div class="settings-first-run">
      <h2 class="settings-title">MCP Server Configuration</h2>
      <p class="settings-section-desc">
        The <code>.obsidian-mcp.json</code> config file was not found at the expected location.
        Browse to the directory where your obsidian-mcp-server is installed and select the file.
      </p>
      <div class="settings-section">
        <div class="settings-item" style="opacity: 0.6">
          <div class="settings-item-info">
            <span class="settings-item-name">Current path</span>
            <span class="settings-item-meta">${escapeHtml(currentPath)}</span>
          </div>
        </div>
        <div class="settings-add-form" style="display:block; margin-top: 12px;">
          <div class="settings-form-field">
            <label>Path to .obsidian-mcp.json</label>
            <div class="settings-path-input">
              <input type="text" id="mcp-config-path-input" placeholder="/path/to/obsidian-mcp-server/.obsidian-mcp.json" value="${escapeHtml(currentPath)}">
              <button class="settings-browse-btn" onclick="browseForPath('mcp-config-path-input')">Browse</button>
            </div>
            <div id="mcp-config-path-input-browser" class="settings-path-browser" style="display:none"></div>
          </div>
          <div class="settings-form-actions">
            <button class="settings-form-save" onclick="saveConfigPath()">Save &amp; Load</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

async function saveConfigPath() {
  const input = document.getElementById('mcp-config-path-input');
  let newPath = input.value.trim();
  if (!newPath) return;
  // If user browsed to a directory, append the filename
  if (!newPath.endsWith('.obsidian-mcp.json')) {
    newPath = newPath.replace(/\/$/, '') + '/.obsidian-mcp.json';
    input.value = newPath;
  }
  try {
    const res = await fetchWithRetry('/api/settings/config-path', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    });
    const result = await res.json();
    if (result.exists) {
      await loadSettings();
    } else {
      renderConfigPathSetup(document.getElementById('settings-content'));
      // Show inline error
      const field = document.querySelector('.settings-form-field');
      if (field && !field.querySelector('.settings-field-error')) {
        const err = document.createElement('div');
        err.className = 'settings-field-error';
        err.textContent = 'File not found at this path. Check the location and try again.';
        field.appendChild(err);
      }
    }
  } catch (err) {
    console.error('Failed to save config path:', err);
  }
}

function renderVaultSettings(container) {
  let html = '<h2 class="settings-title">Vault Setup</h2>';

  // Primary Vaults
  html += '<div class="settings-section">';
  html += '<h3 class="settings-section-title">Primary Vaults</h3>';
  html += '<p class="settings-section-desc">Main vaults used for AI session storage per mode.</p>';
  (settingsData.primaryVaults || []).forEach((v, i) => {
    html += `<div class="settings-item">
      <div class="settings-item-info">
        <span class="settings-item-name">${escapeHtml(v.name)}</span>
        <span class="settings-item-meta">${escapeHtml(v.mode)} &middot; ${escapeHtml(v.path)}</span>
      </div>
      <button class="settings-item-remove" onclick="removeVault('primaryVaults', ${i})" title="Remove">&times;</button>
    </div>`;
  });
  html += `<button class="settings-add-btn" onclick="showAddVaultForm('primaryVaults')">+ Add Primary Vault</button>`;
  html += '<div id="add-form-primaryVaults" class="settings-add-form" style="display:none"></div>';
  html += '</div>';

  // Secondary Vaults
  html += '<div class="settings-section">';
  html += '<h3 class="settings-section-title">Secondary Vaults</h3>';
  html += '<p class="settings-section-desc">Read-only reference vaults (curated notes, docs).</p>';
  (settingsData.secondaryVaults || []).forEach((v, i) => {
    html += `<div class="settings-item">
      <div class="settings-item-info">
        <span class="settings-item-name">${escapeHtml(v.name)}</span>
        <span class="settings-item-meta">${escapeHtml(v.mode)} &middot; ${escapeHtml(v.authority || 'curated')} &middot; ${escapeHtml(v.path)}</span>
      </div>
      <button class="settings-item-remove" onclick="removeVault('secondaryVaults', ${i})" title="Remove">&times;</button>
    </div>`;
  });
  html += `<button class="settings-add-btn" onclick="showAddVaultForm('secondaryVaults')">+ Add Secondary Vault</button>`;
  html += '<div id="add-form-secondaryVaults" class="settings-add-form" style="display:none"></div>';
  html += '</div>';

  container.innerHTML = html;
}

function renderAllowedPaths(container) {
  const paths = settingsData.security?.accessControl?.allowedPaths || [];
  let html = '<h2 class="settings-title">Allowed Paths</h2>';
  html += '<p class="settings-section-desc">Directories the MCP server is permitted to access.</p>';
  html += '<div class="settings-section">';
  paths.forEach((p, i) => {
    html += `<div class="settings-item">
      <div class="settings-item-info">
        <span class="settings-item-name">${escapeHtml(p)}</span>
      </div>
      <button class="settings-item-remove" onclick="removeAllowedPath(${i})" title="Remove">&times;</button>
    </div>`;
  });
  html += `<button class="settings-add-btn" onclick="showAddPathForm()">+ Add Path</button>`;
  html += '<div id="add-form-allowed-path" class="settings-add-form" style="display:none"></div>';
  html += '</div>';

  container.innerHTML = html;
}

function showAddVaultForm(type) {
  const formEl = document.getElementById(`add-form-${type}`);
  if (formEl.style.display !== 'none') { formEl.style.display = 'none'; return; }
  const isSecondary = type === 'secondaryVaults';
  formEl.innerHTML = `
    <div class="settings-form-field">
      <label>Name</label>
      <input type="text" id="vault-name-${type}" placeholder="My Vault">
    </div>
    <div class="settings-form-field">
      <label>Path</label>
      <div class="settings-path-input">
        <input type="text" id="vault-path-${type}" placeholder="/path/to/vault">
        <button class="settings-browse-btn" onclick="browseForPath('vault-path-${type}')">Browse</button>
      </div>
      <div id="vault-path-browser-${type}" class="settings-path-browser" style="display:none"></div>
    </div>
    <div class="settings-form-field">
      <label>Mode</label>
      <select id="vault-mode-${type}">
        <option value="work">Work</option>
        <option value="personal">Personal</option>
      </select>
    </div>
    ${isSecondary ? `<div class="settings-form-field">
      <label>Authority</label>
      <select id="vault-authority-${type}">
        <option value="curated">Curated</option>
        <option value="managed">Managed</option>
      </select>
    </div>` : ''}
    <div class="settings-form-actions">
      <button class="settings-form-cancel" onclick="document.getElementById('add-form-${type}').style.display='none'">Cancel</button>
      <button class="settings-form-save" onclick="addVault('${type}')">Add</button>
    </div>
  `;
  formEl.style.display = 'block';
}

async function addVault(type) {
  const name = document.getElementById(`vault-name-${type}`).value.trim();
  const path = document.getElementById(`vault-path-${type}`).value.trim();
  const mode = document.getElementById(`vault-mode-${type}`).value;
  if (!name || !path) return;

  const vault = { path, name, mode };
  if (type === 'secondaryVaults') {
    vault.authority = document.getElementById(`vault-authority-${type}`).value;
  }
  if (!settingsData[type]) settingsData[type] = [];
  settingsData[type].push(vault);
  await saveSettings();
  renderSettingsContent();
}

async function removeVault(type, index) {
  settingsData[type].splice(index, 1);
  await saveSettings();
  renderSettingsContent();
}

function showAddPathForm() {
  const formEl = document.getElementById('add-form-allowed-path');
  if (formEl.style.display !== 'none') { formEl.style.display = 'none'; return; }
  formEl.innerHTML = `
    <div class="settings-form-field">
      <label>Path</label>
      <div class="settings-path-input">
        <input type="text" id="new-allowed-path" placeholder="/path/to/directory">
        <button class="settings-browse-btn" onclick="browseForPath('new-allowed-path')">Browse</button>
      </div>
      <div id="new-allowed-path-browser" class="settings-path-browser" style="display:none"></div>
    </div>
    <div class="settings-form-actions">
      <button class="settings-form-cancel" onclick="document.getElementById('add-form-allowed-path').style.display='none'">Cancel</button>
      <button class="settings-form-save" onclick="addAllowedPath()">Add</button>
    </div>
  `;
  formEl.style.display = 'block';
}

async function addAllowedPath() {
  const path = document.getElementById('new-allowed-path').value.trim();
  if (!path) return;
  if (!settingsData.security) settingsData.security = { accessControl: { allowedPaths: [] } };
  if (!settingsData.security.accessControl) settingsData.security.accessControl = { allowedPaths: [] };
  if (!settingsData.security.accessControl.allowedPaths) settingsData.security.accessControl.allowedPaths = [];
  settingsData.security.accessControl.allowedPaths.push(path);
  await saveSettings();
  renderSettingsContent();
}

async function removeAllowedPath(index) {
  settingsData.security.accessControl.allowedPaths.splice(index, 1);
  await saveSettings();
  renderSettingsContent();
}

function browseForPath(inputId) {
  const input = document.getElementById(inputId);
  const browserId = inputId + '-browser';
  let browserEl = document.getElementById(browserId);
  if (!browserEl) {
    // Create browser container next to the input
    browserEl = document.createElement('div');
    browserEl.id = browserId;
    browserEl.className = 'settings-path-browser';
    input.closest('.settings-form-field').appendChild(browserEl);
  }
  const isOpen = browserEl.style.display !== 'none';
  if (isOpen) { browserEl.style.display = 'none'; return; }
  const onSelect = (dirPath) => {
    browserEl.style.display = 'none';
    input.value = dirPath;
  };
  const startPath = input.value || '/Users';
  renderDirBrowser(browserEl, startPath, onSelect, { unrestricted: true });
}

// ============================================================
// KB Browser
// ============================================================

let kbCurrentFile = null;     // { path, name, content }
let kbIsEditing = false;
let kbShowingDiff = false;
let kbEditor = null;          // Toast UI Editor instance
let kbFrontmatter = '';       // Stashed frontmatter (stripped before editor, restored on save)
let kbHistory = [];           // Navigation history stack for back button
let kbEntryPoint = null;      // { sessionId } — session user jumped from into KB, consumed by Back when kbHistory is empty
let kbTreeLoaded = false;
const kbExpandedDirs = new Set();
const kbTreeCache = new Map(); // path -> entries
let kbSearchTimer = null;
let kbAutosaveTimer = null;
let kbBookmarks = []; // [{path, name}] — loaded from server
let kbShowingBookmarks = false;
let kbShowingRecent = false;
let kbTemplatesCache = null;  // null = not fetched, [] = no templates
let kbPrefsLoaded = false;    // true once server prefs are fetched
let kbPendingNavigation = null; // set by navigateToKbFile/openSessionInKb to prevent prefs from clobbering

// --- KB Preferences: server-side persistence ---

function saveKbPreferences(partial) {
  fetchWithRetry('/api/settings/kb-preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  }).catch(() => {}); // fire-and-forget
}

async function loadKbPreferences() {
  try {
    const resp = await fetchWithRetry('/api/settings/kb-preferences');
    const prefs = await resp.json();
    kbBookmarks = prefs.bookmarks || [];
    kbPrefsLoaded = true;

    // Migrate localStorage bookmarks if server has none
    const localBm = localStorage.getItem('kb-bookmarks');
    if (kbBookmarks.length === 0 && localBm) {
      try {
        const parsed = JSON.parse(localBm);
        if (Array.isArray(parsed) && parsed.length > 0) {
          kbBookmarks = parsed;
          saveKbPreferences({ bookmarks: kbBookmarks });
        }
      } catch {}
      localStorage.removeItem('kb-bookmarks');
    } else if (localBm) {
      // Server has bookmarks — clean up localStorage
      localStorage.removeItem('kb-bookmarks');
    }

    // Restore view mode
    if (prefs.viewMode === 'bookmarks') {
      toggleKbBookmarksView();
    } else if (prefs.viewMode === 'recent') {
      toggleKbRecentView();
    }

    // Restore last open file — skip if a link navigation is already targeting a specific file
    if (prefs.currentFile && !kbPendingNavigation) {
      loadKbFile(prefs.currentFile, { skipHistory: true });
    }
  } catch {
    // Fallback: try localStorage bookmarks if server is down
    try {
      kbBookmarks = JSON.parse(localStorage.getItem('kb-bookmarks') || '[]');
    } catch { kbBookmarks = []; }
    kbPrefsLoaded = true;
  }
}

// KB search: debounced input handler
document.addEventListener('DOMContentLoaded', () => {
  // Initialize TTS toggle button state
  updateTTSToggleBtn();

  const searchInput = document.getElementById('kb-search');
  const clearBtn = document.getElementById('kb-search-clear');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(kbSearchTimer);
      const q = searchInput.value.trim();
      clearBtn.style.display = q ? '' : 'none';
      if (!q) {
        document.getElementById('kb-search-results').style.display = 'none';
        document.getElementById('kb-search-results').innerHTML = '';
        document.getElementById('kb-bookmarks-list').style.display = 'none';
        document.getElementById('kb-recent-list').style.display = 'none';
        document.getElementById('kb-tree').style.display = '';
        if (kbShowingBookmarks) {
          kbShowingBookmarks = false;
          document.getElementById('kb-toolbar-bookmarks').classList.remove('active');
        }
        if (kbShowingRecent) {
          kbShowingRecent = false;
          document.getElementById('kb-toolbar-recent').classList.remove('active');
        }
        return;
      }
      // Hide bookmarks, recent, and tree when searching
      document.getElementById('kb-bookmarks-list').style.display = 'none';
      document.getElementById('kb-recent-list').style.display = 'none';
      document.getElementById('kb-tree').style.display = 'none';
      if (kbShowingBookmarks) {
        kbShowingBookmarks = false;
        document.getElementById('kb-toolbar-bookmarks').classList.remove('active');
      }
      if (kbShowingRecent) {
        kbShowingRecent = false;
        document.getElementById('kb-toolbar-recent').classList.remove('active');
      }
      kbSearchTimer = setTimeout(() => kbSearchDocs(q), 200);
    });
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.style.display = 'none';
      document.getElementById('kb-search-results').style.display = 'none';
      document.getElementById('kb-search-results').innerHTML = '';
      document.getElementById('kb-bookmarks-list').style.display = 'none';
      document.getElementById('kb-recent-list').style.display = 'none';
      document.getElementById('kb-tree').style.display = '';
      if (kbShowingBookmarks) {
        kbShowingBookmarks = false;
        document.getElementById('kb-toolbar-bookmarks').classList.remove('active');
      }
      if (kbShowingRecent) {
        kbShowingRecent = false;
        document.getElementById('kb-toolbar-recent').classList.remove('active');
      }
      searchInput.focus();
    });
  }
});

async function kbSearchDocs(query) {
  const treeEl = document.getElementById('kb-tree');
  const resultsEl = document.getElementById('kb-search-results');
  try {
    const res = await fetchWithRetry(`/api/vault/kb/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();

    // If input changed while fetching, discard stale results
    const current = document.getElementById('kb-search').value.trim();
    if (current !== query) return;

    treeEl.style.display = 'none';
    resultsEl.style.display = '';
    resultsEl.innerHTML = '';

    if (data.results.length === 0) {
      resultsEl.innerHTML = '<div class="kb-search-empty">No matching documents</div>';
      return;
    }

    for (const r of data.results) {
      const item = document.createElement('div');
      item.className = 'kb-search-result';
      item.innerHTML =
        `<span class="kb-search-result-name">${escapeHtml(r.name)}</span>` +
        `<span class="kb-search-result-folder">${escapeHtml(r.folder)}</span>`;
      item.addEventListener('click', () => {
        if (kbIsEditing) {
          clearTimeout(kbAutosaveTimer);
          kbAutosave();
          cancelKbEdit();
        }
        loadKbFile(r.path);
      });
      resultsEl.appendChild(item);
    }
  } catch (err) {
    console.error('KB search failed:', err);
  }
}

// Vault path detection and linking (fetched from server config)
let OBSIDIAN_ROOT = '';
let VAULT_NAMES = [];
let VAULT_NAMES_ALT = '';
let VAULT_PATH_RE = null;
let VAULT_NAMES_RE = null;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadBridgePaths() {
  try {
    // Derive vault info from MCP config (Vault Setup)
    const res = await fetchWithRetry('/api/settings');
    const data = await res.json();
    const allVaults = [...(data.primaryVaults || []), ...(data.secondaryVaults || [])];
    VAULT_NAMES = allVaults.map(v => v.name);
    OBSIDIAN_ROOT = allVaults.length ? allVaults[0].path.replace(/\/[^/]+$/, '') : '';
    if (VAULT_NAMES.length && OBSIDIAN_ROOT) {
      const namesPattern = VAULT_NAMES.map(escapeRegex).join('|');
      VAULT_NAMES_ALT = namesPattern;
      VAULT_PATH_RE = new RegExp(escapeRegex(OBSIDIAN_ROOT) + '/(' + namesPattern + ')/');
      VAULT_NAMES_RE = new RegExp(`^(?:${namesPattern})\\/`);
    } else {
      VAULT_NAMES_ALT = '';
    }
  } catch (err) {
    console.error('Failed to load vault config:', err);
  }
}

function isVaultPath(filePath) {
  if (!VAULT_PATH_RE || !VAULT_NAMES_RE) return false;
  return VAULT_PATH_RE.test(filePath) || VAULT_NAMES_RE.test(filePath);
}

function resolveVaultPath(filePath) {
  // If already absolute, return as-is
  if (filePath.startsWith('/')) return filePath;
  // If relative vault path (e.g. "Work/Meeting Notes/..."), prepend root
  if (VAULT_NAMES_RE && VAULT_NAMES_RE.test(filePath)) return `${OBSIDIAN_ROOT}/${filePath}`;
  return filePath;
}

function navigateToKbFile(filePath) {
  const resolved = resolveVaultPath(filePath);
  if (currentView === 'sessions' && currentSessionId) {
    kbEntryPoint = { sessionId: currentSessionId };
  }
  kbPendingNavigation = resolved;
  switchView('kb');
  loadKbFile(resolved);
}

function renderVaultFileLabel(filePath) {
  const shortPath = filePath.split('/').slice(-2).join('/');
  const resolved = resolveVaultPath(filePath);
  return `<div class="tool-file-label tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(shortPath)}</div>`;
}

function linkifyVaultPaths(escapedText) {
  if (VAULT_NAMES_ALT) {
    // Match absolute vault file paths in already-escaped tool output (allow spaces/commas)
    const absEscRe = new RegExp(`(\\/[^&lt;\\n]*?\\/Documents\\/Obsidian\\/(?:${VAULT_NAMES_ALT})\\/[^&lt;\\n]*?\\.md)`, 'g');
    escapedText = escapedText.replace(absEscRe, (match) => {
      const realPath = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const short = realPath.split('/').slice(-3).join('/');
      return `<span class="tool-file-link" onclick="navigateToKbFile('${realPath.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(short)}</span>`;
    });
    // Match relative vault paths (e.g. "Work/Meeting Notes/file.md")
    const relEscRe = new RegExp(`(?<![\\/\\w])((?:${VAULT_NAMES_ALT})\\/[^&lt;\\n]*?\\.md)`, 'g');
    escapedText = escapedText.replace(relEscRe, (match) => {
      const realPath = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
      const resolved = resolveVaultPath(realPath);
      const short = realPath.split('/').slice(-3).join('/');
      return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(short)}</span>`;
    });
  }
  // Match vault-internal relative paths (e.g. "sessions/2026-03/file.md", "topics/file.md")
  escapedText = escapedText.replace(/(?<![\/\w])((?:sessions|topics|projects|decisions)\/[^&lt;\n]*?\.md)/g, (match) => {
    const realPath = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const vaultPrefix = VAULT_NAMES.length ? `${VAULT_NAMES[0]}/` : '';
    const resolved = resolveVaultPath(vaultPrefix + realPath);
    const short = realPath.split('/').slice(-2).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(short)}</span>`;
  });
  // Match labeled slug references (e.g. "Topics Updated slug-name").
  // Decisions live at decisions/<projectSlug>/<slug>.md, so the dir+slug shortcut
  // can't construct the right path client-side. Route through navigateWikiLink
  // and let /api/vault/kb/resolve-link handle bare-name (decisions, topics) and
  // path-style (projects) resolution on the server.
  escapedText = escapedText.replace(/(Topics (?:Updated|Created)|Projects Linked|Decisions (?:Made|Recorded))\s+([\w][\w ,-]*[\w-])/g, (match, label, slugsPart) => {
    if (!VAULT_NAMES.length) return match;
    const slugs = slugsPart.split(/,\s*/);
    const linked = slugs.map(slug => {
      slug = slug.trim();
      if (!slug) return '';
      const target = label === 'Projects Linked' ? `projects/${slug}/project` : slug;
      const escaped = target.replace(/"/g, '&quot;');
      return `<span class="wiki-link" data-target="${escaped}" onclick="navigateWikiLink(this)" title="Open in Knowledge Base">${escapeHtml(slug)}</span>`;
    }).join(', ');
    return `${label} ${linked}`;
  });
  return escapedText;
}

async function loadKbTree(dirPath) {
  const url = dirPath
    ? `/api/vault/kb/tree?path=${encodeURIComponent(dirPath)}`
    : '/api/vault/kb/tree';
  try {
    const res = await fetchWithRetry(url);
    const data = await res.json();
    if (data.error) return null;
    kbTreeCache.set(data.path, data.entries);

    if (!dirPath) {
      // Root load
      kbTreeLoaded = true;
      const treeEl = document.getElementById('kb-tree');
      treeEl.innerHTML = '';
      for (const entry of data.entries) {
        treeEl.appendChild(createKbTreeNode(entry, 0));
      }
    }
    return data;
  } catch (err) {
    console.error('Failed to load KB tree:', err);
    return null;
  }
}

async function kbMoveFile(sourcePath, destDirPath) {
  const fileName = sourcePath.split('/').pop();
  const destination = destDirPath + '/' + fileName;
  try {
    const res = await fetchWithRetry('/api/vault/kb/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: sourcePath, destination }),
    });
    const data = await res.json();
    if (data.error) {
      alert('Move failed: ' + data.error);
      return false;
    }
    // Invalidate caches for source parent and destination
    const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
    kbTreeCache.delete(sourceDir);
    kbTreeCache.delete(destDirPath);
    // If the moved file was currently open, update its path
    if (kbCurrentFile && kbCurrentFile.path === sourcePath) {
      kbCurrentFile.path = data.path;
    }
    return true;
  } catch (err) {
    console.error('Failed to move file:', err);
    alert('Move failed: ' + err.message);
    return false;
  }
}

// Delete a KB file
async function deleteKbFile(filePath, dirPath) {
  const fileName = filePath.split('/').pop();
  if (!confirm(`Delete "${fileName}"?`)) return;
  try {
    const res = await fetchWithRetry(`/api/vault/kb/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) {
      alert('Delete failed: ' + data.error);
      return;
    }
    // Clear current file if it was the deleted one
    if (kbCurrentFile && kbCurrentFile.path === filePath) {
      kbCurrentFile = null;
      document.getElementById('kb-title').textContent = 'Knowledge Base';
      document.getElementById('kb-title').style.cursor = 'default';
      document.getElementById('kb-welcome').style.display = '';
      document.getElementById('kb-rendered').style.display = 'none';
      document.getElementById('kb-diff-btn').style.display = 'none';
      document.getElementById('kb-edit-btn').style.display = 'none';
      document.getElementById('kb-bookmark-toggle').style.display = 'none';
    }
    // Remove from bookmarks if bookmarked
    const bmIdx = kbBookmarks.findIndex(b => b.path === filePath);
    if (bmIdx !== -1) {
      kbBookmarks.splice(bmIdx, 1);
      saveKbBookmarks();
      if (kbShowingBookmarks) renderKbBookmarksList();
    }
    // Refresh tree
    kbTreeCache.delete(dirPath);
    await reloadKbSubtree(dirPath);
  } catch (err) {
    console.error('Failed to delete KB file:', err);
  }
}

// Create a new directory, then enter rename mode
async function createKbDir(dirPath) {
  // Find a unique name
  let tempName = 'New Folder';
  let newPath = dirPath + '/' + tempName;
  let counter = 1;
  const cached = kbTreeCache.get(dirPath);
  if (cached) {
    const names = new Set(cached.map(e => e.name));
    while (names.has(tempName)) {
      tempName = 'New Folder ' + counter++;
    }
    newPath = dirPath + '/' + tempName;
  }

  try {
    const res = await fetchWithRetry('/api/vault/kb/dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: newPath }),
    });
    const data = await res.json();
    if (data.error) {
      alert('Create folder failed: ' + data.error);
      return;
    }
    // Refresh the parent tree
    kbTreeCache.delete(dirPath);
    await reloadKbSubtree(dirPath);

    // Start rename on the new directory
    const newItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(data.path)}"]`);
    if (newItem) {
      const nameSpan = newItem.querySelector('.kb-tree-name');
      if (nameSpan) startKbRenameDir(data.path, nameSpan);
    }
  } catch (err) {
    console.error('Failed to create directory:', err);
    alert('Create folder failed: ' + err.message);
  }
}

// Delete an empty directory
async function deleteKbDir(dirPath) {
  const dirName = dirPath.split('/').pop();
  if (!confirm(`Delete folder "${dirName}"? (must be empty)`)) return;
  try {
    const res = await fetchWithRetry(`/api/vault/kb/dir?path=${encodeURIComponent(dirPath)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) {
      alert('Delete folder failed: ' + data.error);
      return;
    }
    const parentPath = dirPath.substring(0, dirPath.lastIndexOf('/'));
    kbTreeCache.delete(parentPath);
    kbExpandedDirs.delete(dirPath);
    await reloadKbSubtree(parentPath);
  } catch (err) {
    console.error('Failed to delete directory:', err);
    alert('Delete folder failed: ' + err.message);
  }
}

// Rename a directory inline (similar to startKbRename for files)
function startKbRenameDir(entryPath, nameEl) {
  const originalName = nameEl.textContent;
  nameEl.contentEditable = true;
  nameEl.classList.add('editing');
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  async function finish() {
    nameEl.contentEditable = false;
    nameEl.classList.remove('editing');
    const newName = nameEl.textContent.trim();
    if (!newName || newName === originalName) {
      nameEl.textContent = originalName;
      return;
    }
    const parentDir = entryPath.substring(0, entryPath.lastIndexOf('/'));
    const newPath = parentDir + '/' + newName;
    try {
      const res = await fetchWithRetry('/api/vault/kb/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: entryPath, destination: newPath }),
      });
      const data = await res.json();
      if (data.error) {
        alert('Rename failed: ' + data.error);
        nameEl.textContent = originalName;
        return;
      }
      // Update expanded dirs set
      if (kbExpandedDirs.has(entryPath)) {
        kbExpandedDirs.delete(entryPath);
        kbExpandedDirs.add(data.path);
      }
      kbTreeCache.delete(parentDir);
      await reloadKbSubtree(parentDir);
    } catch (err) {
      alert('Rename failed: ' + err.message);
      nameEl.textContent = originalName;
    }
  }

  nameEl.addEventListener('blur', finish, { once: true });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = originalName; nameEl.blur(); }
  }, { once: true });
}

// KB Context Menu
let kbContextMenuEl = null;

function getOrCreateKbContextMenu() {
  if (!kbContextMenuEl) {
    kbContextMenuEl = document.createElement('div');
    kbContextMenuEl.className = 'kb-context-menu';
    document.body.appendChild(kbContextMenuEl);
    document.addEventListener('click', dismissKbContextMenu);
    document.addEventListener('contextmenu', dismissKbContextMenu);
    document.addEventListener('scroll', dismissKbContextMenu, true);
  }
  return kbContextMenuEl;
}

function dismissKbContextMenu() {
  if (kbContextMenuEl) kbContextMenuEl.style.display = 'none';
}

function showKbContextMenu(x, y, entry, depth) {
  const menu = getOrCreateKbContextMenu();
  menu.innerHTML = '';

  const isDir = entry.type === 'directory';
  const isRootVault = depth === 0 && isDir;

  const items = [];

  if (isDir) {
    items.push({ label: 'New File', action: () => {
      // Find the tree item's children container and chevron for createKbFile
      const dirItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(entry.path)}"]`);
      if (!dirItem) return;
      const chevron = dirItem.querySelector('.kb-tree-chevron');
      const childrenContainer = dirItem.parentElement.querySelector('.kb-tree-children');
      if (chevron && childrenContainer) {
        const indent = dirItem.querySelector('.kb-tree-indent');
        const d = indent ? Math.round(parseInt(indent.style.width) / 16) : 0;
        createKbFile(entry.path, childrenContainer, chevron, d);
      }
    }});
    items.push({ label: 'New Folder', action: () => createKbDir(entry.path) });
  }

  if (!isRootVault) {
    items.push({ label: 'Rename', action: () => {
      const treeItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(entry.path)}"]`);
      if (!treeItem) return;
      const nameSpan = treeItem.querySelector('.kb-tree-name');
      if (isDir) {
        startKbRenameDir(entry.path, nameSpan);
      } else {
        startKbRename(entry.path, nameSpan);
      }
    }});
  }

  if (!isDir) {
    items.push({ label: 'Duplicate', action: () => duplicateKbFile(entry.path) });
    items.push({ label: 'Export', action: () => showKbExportModal(entry.path, entry.name) });
  }

  items.push({ label: 'Copy Path', action: () => {
    const relativePath = OBSIDIAN_ROOT
      ? entry.path.replace(OBSIDIAN_ROOT + '/', '')
      : entry.path;
    navigator.clipboard.writeText(relativePath).catch(() => {});
  }});

  if (!isRootVault) {
    if (isDir) {
      items.push({ label: 'Delete Folder', className: 'danger', action: () => deleteKbDir(entry.path) });
    } else {
      items.push({ label: 'Delete', className: 'danger', action: () => {
        const dirPath = entry.path.substring(0, entry.path.lastIndexOf('/'));
        deleteKbFile(entry.path, dirPath);
      }});
    }
  }

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'kb-context-menu-item' + (item.className ? ' ' + item.className : '');
    btn.textContent = item.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissKbContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  }

  // Position: ensure menu stays within viewport
  menu.style.display = 'block';
  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = (x + menuRect.width > vw ? vw - menuRect.width - 4 : x) + 'px';
  menu.style.top = (y + menuRect.height > vh ? vh - menuRect.height - 4 : y) + 'px';
}

// KB Export
let kbExportCurrentFile = null;

function showKbExportModal(filePath, fileName) {
  kbExportCurrentFile = { path: filePath, name: fileName };
  document.getElementById('kb-export-filename').textContent = fileName;
  document.getElementById('kb-export-overlay').style.display = '';
}

function dismissKbExportModal() {
  document.getElementById('kb-export-overlay').style.display = 'none';
  kbExportCurrentFile = null;
}

async function exportKbFileToPdf() {
  if (!kbExportCurrentFile) return;
  const { path: filePath, name: fileName } = kbExportCurrentFile;
  dismissKbExportModal();

  // Open window synchronously within the click handler to avoid popup blockers
  const printWin = window.open('', '_blank');
  if (!printWin) {
    alert('Popup blocked — please allow popups for this page to export.');
    return;
  }
  printWin.document.write('<html><body style="font-family:sans-serif;padding:24px">Preparing export…</body></html>');

  try {
    const res = await fetchWithRetry(`/api/vault/kb/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) { printWin.close(); alert('Export failed: ' + data.error); return; }

    const html = renderKbMarkdown(data.content);
    const isIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);
    const hint = isIOS
      ? 'Tap the <strong>Share</strong> button ↑, then tap <strong>Print</strong> to save as PDF to Files.'
      : 'In the print dialog, choose <strong>Save as PDF</strong> to select where to save.';

    printWin.document.open();
    printWin.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fileName)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #111; margin: 0; padding: 24px 40px; max-width: 800px; }
    h1 { font-size: 22px; margin-bottom: 4px; }
    h2 { font-size: 18px; } h3 { font-size: 16px; }
    h1, h2, h3, h4 { line-height: 1.3; margin-top: 1.4em; }
    code { font-family: 'Courier New', monospace; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 0.88em; }
    pre { background: #f4f4f4; padding: 12px 16px; border-radius: 4px; overflow-x: auto; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 3px solid #ccc; margin: 0 0 0 4px; padding-left: 14px; color: #555; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
    th { background: #f0f0f0; }
    a { color: #0070f3; }
    img { max-width: 100%; }
    hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
    .kb-frontmatter { display: none; }
    .wiki-link { color: #0070f3; }
    .export-hint { background: #fff8e1; border: 1px solid #ffe082; border-radius: 4px; padding: 8px 12px; font-size: 13px; color: #5d4037; margin-bottom: 20px; }
    @media print { .export-hint { display: none; } }
  </style>
</head>
<body>
  <p class="export-hint">${hint}</p>
  <h1>${escapeHtml(fileName)}</h1>
  ${html}
  <script>window.onload = function() { window.print(); };<\/script>
</body>
</html>`);
    printWin.document.close();
  } catch (err) {
    printWin.close();
    alert('Export failed: ' + err.message);
  }
}

// Duplicate a file: copy content to "Name (copy).md" and enter rename mode
async function duplicateKbFile(filePath) {
  try {
    // Read source content
    const readRes = await fetchWithRetry(`/api/vault/kb/file?path=${encodeURIComponent(filePath)}`);
    const readData = await readRes.json();
    if (readData.error) { alert('Duplicate failed: ' + readData.error); return; }

    // Build copy path
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));
    const baseName = filePath.split('/').pop().replace(/\.md$/, '');
    let copyName = baseName + ' (copy)';
    let copyPath = dirPath + '/' + copyName + '.md';
    let counter = 2;
    const cached = kbTreeCache.get(dirPath);
    if (cached) {
      const names = new Set(cached.map(e => e.name));
      while (names.has(copyName + '.md')) {
        copyName = baseName + ' (copy ' + counter++ + ')';
        copyPath = dirPath + '/' + copyName + '.md';
      }
    }

    // Create the new file
    const createRes = await fetchWithRetry('/api/vault/kb/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: copyPath }),
    });
    const createData = await createRes.json();
    if (createData.error) { alert('Duplicate failed: ' + createData.error); return; }

    // Write the content
    if (readData.content) {
      await fetchWithRetry('/api/vault/kb/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: createData.path, content: readData.content }),
      });
    }

    // Refresh tree and enter rename mode
    kbTreeCache.delete(dirPath);
    await reloadKbSubtree(dirPath);
    const newItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(createData.path)}"]`);
    if (newItem) {
      const nameSpan = newItem.querySelector('.kb-tree-name');
      if (nameSpan) startKbRename(createData.path, nameSpan);
    }
  } catch (err) {
    console.error('Failed to duplicate file:', err);
    alert('Duplicate failed: ' + err.message);
  }
}

// Create a new file in a directory, then immediately enter rename mode
async function createKbFile(dirPath, childrenContainer, chevron, depth) {
  // Ensure directory is expanded
  if (!kbExpandedDirs.has(dirPath)) {
    kbExpandedDirs.add(dirPath);
    chevron.classList.add('expanded');
    childrenContainer.classList.remove('collapsed');

    if (!kbTreeCache.has(dirPath)) {
      const data = await loadKbTree(dirPath);
      if (data) {
        childrenContainer.innerHTML = '';
        for (const child of data.entries) {
          childrenContainer.appendChild(createKbTreeNode(child, depth + 1));
        }
      }
    }
  }

  // Find a unique name
  let tempName = 'Untitled';
  let filePath = dirPath + '/' + tempName + '.md';
  let counter = 1;
  // Check cache for existing names to avoid 409s
  const cached = kbTreeCache.get(dirPath);
  if (cached) {
    const names = new Set(cached.map(e => e.name));
    while (names.has(tempName)) {
      tempName = 'Untitled ' + counter++;
    }
    filePath = dirPath + '/' + tempName + '.md';
  }

  try {
    const res = await fetchWithRetry('/api/vault/kb/file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    if (data.error) {
      alert('Create failed: ' + data.error);
      return;
    }

    // Refresh tree to show the new file
    kbTreeCache.delete(dirPath);
    await reloadKbSubtree(dirPath);

    // Find the new file's name span and start rename
    const newItem = childrenContainer.querySelector(`.kb-tree-item[data-path="${CSS.escape(data.path)}"]`);
    if (newItem) {
      const nameSpan = newItem.querySelector('.kb-tree-name');
      if (nameSpan) {
        startKbRename(data.path, nameSpan);
      }
    }
  } catch (err) {
    console.error('Failed to create KB file:', err);
  }
}

// Rename a KB file via inline editing
function startKbRename(entryPath, nameEl) {
  const originalName = nameEl.textContent;
  nameEl.contentEditable = true;
  nameEl.classList.add('editing');
  nameEl.focus();
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  async function finish() {
    nameEl.contentEditable = false;
    nameEl.classList.remove('editing');
    const newName = nameEl.textContent.trim();
    if (!newName || newName === originalName) {
      nameEl.textContent = originalName;
      return;
    }
    const dir = entryPath.substring(0, entryPath.lastIndexOf('/'));
    const newPath = dir + '/' + newName + '.md';
    try {
      const res = await fetchWithRetry('/api/vault/kb/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: entryPath, destination: newPath }),
      });
      const data = await res.json();
      if (data.error) {
        alert('Rename failed: ' + data.error);
        nameEl.textContent = originalName;
        return;
      }
      if (kbCurrentFile && kbCurrentFile.path === entryPath) {
        kbCurrentFile.path = data.path;
        kbCurrentFile.name = newName;
        document.getElementById('kb-title').textContent = newName;
      }
      const bmIdx = kbBookmarks.findIndex(b => b.path === entryPath);
      if (bmIdx !== -1) {
        kbBookmarks[bmIdx].path = data.path;
        kbBookmarks[bmIdx].name = newName;
        saveKbBookmarks();
        if (kbShowingBookmarks) renderKbBookmarksList();
      }
      kbTreeCache.delete(dir);
      await reloadKbSubtree(dir);
    } catch (err) {
      console.error('Failed to rename KB file:', err);
      nameEl.textContent = originalName;
    }
  }

  nameEl.onblur = finish;
  nameEl.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.contentEditable = false; nameEl.classList.remove('editing'); nameEl.textContent = originalName; }
  };
}

function renameCurrentKbFile() {
  if (!kbCurrentFile) return;
  startKbRename(kbCurrentFile.path, document.getElementById('kb-title'));
}

async function reloadKbSubtree(dirPath) {
  // Fetch fresh data for this directory
  kbTreeCache.delete(dirPath);
  const data = await loadKbTree(dirPath);
  if (!data) return;

  // Find the existing tree item for this directory and rebuild its children
  const dirItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(dirPath)}"]`);
  if (!dirItem) return;
  const childrenContainer = dirItem.parentElement.querySelector('.kb-tree-children');
  if (!childrenContainer) return;

  // Determine depth from indentation
  const indent = dirItem.querySelector('.kb-tree-indent');
  const parentDepth = indent ? Math.round(parseInt(indent.style.width) / 16) : 0;

  childrenContainer.innerHTML = '';
  for (const child of data.entries) {
    childrenContainer.appendChild(createKbTreeNode(child, parentDepth + 1));
  }
}

function createKbTreeNode(entry, depth) {
  const wrapper = document.createElement('div');

  const item = document.createElement('div');
  item.className = 'kb-tree-item' + (entry.type === 'file' ? ' kb-tree-file' : '');
  item.dataset.path = entry.path;
  item.dataset.type = entry.type;

  // Drag-and-drop: make non-root items draggable (root vaults are drop-only)
  const isRootVault = depth === 0 && entry.type === 'directory';
  item.draggable = !isRootVault;
  item.addEventListener('dragstart', (e) => {
    if (isRootVault) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', entry.path);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('kb-dragging');
    // Prevent parent folder click from firing
    e.stopPropagation();
  });
  item.addEventListener('dragend', () => {
    item.classList.remove('kb-dragging');
    document.querySelectorAll('.kb-drop-target').forEach(el => el.classList.remove('kb-drop-target'));
  });

  // Drop target: directories accept drops
  if (entry.type === 'directory') {
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('kb-drop-target');
    });
    item.addEventListener('dragleave', (e) => {
      // Only remove highlight when leaving the item itself, not its children
      if (!item.contains(e.relatedTarget)) {
        item.classList.remove('kb-drop-target');
      }
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.classList.remove('kb-drop-target');
      const sourcePath = e.dataTransfer.getData('text/plain');
      if (!sourcePath || sourcePath === entry.path) return;
      // Don't drop a folder into itself
      if (entry.path.startsWith(sourcePath + '/')) return;
      // Don't move if source is already in this directory
      const sourceDir = sourcePath.substring(0, sourcePath.lastIndexOf('/'));
      if (sourceDir === entry.path) return;

      const fileName = sourcePath.split('/').pop();
      if (!confirm(`Move "${fileName}" to "${entry.name}"?`)) return;

      const success = await kbMoveFile(sourcePath, entry.path);
      if (success) {
        // Reload the affected tree branches
        await reloadKbSubtree(sourceDir);
        await reloadKbSubtree(entry.path);
      }
    });
  }

  // Indent
  if (depth > 0) {
    const indent = document.createElement('span');
    indent.className = 'kb-tree-indent';
    indent.style.width = (depth * 16) + 'px';
    item.appendChild(indent);
  }

  if (entry.type === 'directory') {
    // Chevron
    const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    chevron.setAttribute('class', 'kb-tree-chevron');
    chevron.setAttribute('viewBox', '0 0 24 24');
    chevron.setAttribute('width', '14');
    chevron.setAttribute('height', '14');
    chevron.setAttribute('fill', 'none');
    chevron.setAttribute('stroke', 'currentColor');
    chevron.setAttribute('stroke-width', '2');
    chevron.setAttribute('stroke-linecap', 'round');
    chevron.setAttribute('stroke-linejoin', 'round');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '9 18 15 12 9 6');
    chevron.appendChild(polyline);
    item.appendChild(chevron);

    // Folder icon
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'kb-tree-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const folderPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    folderPath.setAttribute('d', 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z');
    icon.appendChild(folderPath);
    item.appendChild(icon);

    // Children container
    const children = document.createElement('div');
    children.className = 'kb-tree-children collapsed';

    item.addEventListener('click', async () => {
      const isExpanded = kbExpandedDirs.has(entry.path);
      if (isExpanded) {
        kbExpandedDirs.delete(entry.path);
        chevron.classList.remove('expanded');
        children.classList.add('collapsed');
      } else {
        kbExpandedDirs.add(entry.path);
        chevron.classList.add('expanded');
        children.classList.remove('collapsed');

        // Lazy load children if not cached
        if (!kbTreeCache.has(entry.path)) {
          const data = await loadKbTree(entry.path);
          if (data) {
            children.innerHTML = '';
            for (const child of data.entries) {
              children.appendChild(createKbTreeNode(child, depth + 1));
            }
          }
        } else if (children.children.length === 0) {
          const entries = kbTreeCache.get(entry.path);
          for (const child of entries) {
            children.appendChild(createKbTreeNode(child, depth + 1));
          }
        }
      }
    });

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'kb-tree-name';
    nameSpan.textContent = entry.name;
    item.appendChild(nameSpan);

    // Context menu (right-click / long-press)
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showKbContextMenu(e.clientX, e.clientY, entry, depth);
    });
    let _touchTimer;
    item.addEventListener('touchstart', (e) => {
      _touchTimer = setTimeout(() => {
        e.preventDefault();
        const touch = e.touches[0];
        showKbContextMenu(touch.clientX, touch.clientY, entry, depth);
      }, 500);
    }, { passive: false });
    item.addEventListener('touchend', () => clearTimeout(_touchTimer));
    item.addEventListener('touchmove', () => clearTimeout(_touchTimer));

    wrapper.appendChild(item);
    wrapper.appendChild(children);
  } else {
    // File icon
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'kb-tree-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '16');
    icon.setAttribute('height', '16');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.setAttribute('stroke-linecap', 'round');
    icon.setAttribute('stroke-linejoin', 'round');
    const filePath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    filePath1.setAttribute('d', 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z');
    const filePath2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    filePath2.setAttribute('points', '14 2 14 8 20 8');
    icon.appendChild(filePath1);
    icon.appendChild(filePath2);
    item.appendChild(icon);

    // Name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'kb-tree-name';
    nameSpan.textContent = entry.name;
    item.appendChild(nameSpan);

    item.addEventListener('click', () => {
      if (kbIsEditing) {
        clearTimeout(kbAutosaveTimer);
        kbAutosave();
        cancelKbEdit();
      }
      loadKbFile(entry.path);
    });

    nameSpan.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startKbRename(entry.path, nameSpan);
    });

    // Context menu (right-click / long-press)
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showKbContextMenu(e.clientX, e.clientY, entry, depth);
    });
    let _touchTimer;
    item.addEventListener('touchstart', (e) => {
      _touchTimer = setTimeout(() => {
        e.preventDefault();
        const touch = e.touches[0];
        showKbContextMenu(touch.clientX, touch.clientY, entry, depth);
      }, 500);
    }, { passive: false });
    item.addEventListener('touchend', () => clearTimeout(_touchTimer));
    item.addEventListener('touchmove', () => clearTimeout(_touchTimer));

    wrapper.appendChild(item);
  }

  return wrapper;
}

function parseSessionMeta(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  // Only session files
  if (!/category:\s*session/.test(fm)) return null;

  const wdMatch = fm.match(/working_directory:\s*["']?([^"'\n]+)["']?/);
  const idMatch = fm.match(/session_id:\s*["']?([^"'\n]+)["']?/);

  if (!idMatch) return null;

  const sessionId = idMatch[1].trim();
  const slugMatch = sessionId.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)$/);
  const sessionName = slugMatch ? slugMatch[1].replace(/-/g, ' ') : sessionId;

  return {
    sessionId,
    sessionName,
    workingDir: wdMatch ? wdMatch[1].trim() : '',
  };
}

function parseTopicMeta(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];

  if (!/category:\s*topic/.test(fm)) return null;

  const titleMatch = fm.match(/title:\s*["']?([^"'\n]+)["']?/);
  const topicName = titleMatch ? titleMatch[1].trim() : null;

  return { topicName };
}

async function startFromTopic() {
  const btn = document.getElementById('kb-start-from-topic-btn');
  const topicName = btn.dataset.topicName;
  const topicPath = btn.dataset.topicPath;

  try {
    // Create a new session using the last selected working directory (or none)
    const res = await fetchWithRetry('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: selectedNewChatDir || currentWorkingDir, mode: currentMode }),
    });
    const session = await res.json();

    // Switch to chat view
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    currentWorkingDir = session.workingDir || '';
    currentSessionCreated = session.created || '';
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    document.querySelector('.dir-picker-wrapper').style.display = '';
    document.getElementById('session-details-panel').style.display = 'none';
    clearMessages();
    loadSessions();
    switchView('sessions');

    // Auto-send /vault:work or /vault:personal based on current mode
    const modeCommand = currentMode === 'personal' ? '/vault:personal' : '/vault:work';
    messageInput.value = modeCommand;
    await sendMessage();

    // Ask Claude to load the topic context
    messageInput.value = `I want to work on the topic: "${topicName}". Please use get_topic_context to load the full context for this topic, then summarize what's documented and ask what I'd like to do.`;
    sendMessage();
  } catch (err) {
    console.error('Failed to start session from topic:', err);
  }
}

async function continueFromSession() {
  const btn = document.getElementById('kb-continue-session-btn');
  const workingDir = btn.dataset.workingDir;
  const sessionId = btn.dataset.sessionId;
  const sessionName = btn.dataset.sessionName;

  if (!workingDir) {
    alert('No working directory found for this session.');
    return;
  }

  try {
    // Create a new session with the same working directory
    const res = await fetchWithRetry('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir, mode: currentMode }),
    });
    const session = await res.json();

    // Switch to chat view
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    currentWorkingDir = session.workingDir || '';
    currentSessionCreated = session.created || '';
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    document.querySelector('.dir-picker-wrapper').style.display = '';
    document.getElementById('session-details-panel').style.display = 'none';
    clearMessages();
    loadSessions();
    switchView('sessions');

    // Auto-send /vault:work or /vault:personal based on current mode
    const modeCommand2 = currentMode === 'personal' ? '/vault:personal' : '/vault:work';
    messageInput.value = modeCommand2;
    await sendMessage();

    // Ask Claude to load the session context via MCP tools
    messageInput.value = `I'm continuing from a previous session: "${sessionName}" (session ID: ${sessionId}). Please use get_session_context to load the full context for this session, including related sessions and topics, then summarize what was done and what's next.`;
    sendMessage();
  } catch (err) {
    console.error('Failed to continue session:', err);
  }
}

async function expandKbPathTo(filePath) {
  if (!OBSIDIAN_ROOT || !kbTreeLoaded) return;

  // Build list of directory segments from vault root down to the file's parent
  // e.g. for .../AI-Work/sessions/2026-04/file.md -> [.../AI-Work, .../AI-Work/sessions, .../AI-Work/sessions/2026-04]
  const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
  const segments = [];
  let current = parentDir;
  while (current.length > OBSIDIAN_ROOT.length) {
    segments.unshift(current);
    current = current.substring(0, current.lastIndexOf('/'));
  }

  // Expand each directory level
  for (const dirPath of segments) {
    if (kbExpandedDirs.has(dirPath)) continue;

    const dirItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(dirPath)}"]`);
    if (!dirItem) continue;

    const chevron = dirItem.querySelector('.kb-tree-chevron');
    const childrenContainer = dirItem.parentElement.querySelector('.kb-tree-children');
    if (!childrenContainer) continue;

    // Mark as expanded
    kbExpandedDirs.add(dirPath);
    if (chevron) chevron.classList.add('expanded');
    childrenContainer.classList.remove('collapsed');

    // Load children if needed
    if (!kbTreeCache.has(dirPath)) {
      const data = await loadKbTree(dirPath);
      if (data) {
        const indent = dirItem.querySelector('.kb-tree-indent');
        const parentDepth = indent ? Math.round(parseInt(indent.style.width) / 16) : 0;
        childrenContainer.innerHTML = '';
        for (const child of data.entries) {
          childrenContainer.appendChild(createKbTreeNode(child, parentDepth + 1));
        }
      }
    } else if (childrenContainer.children.length === 0) {
      const indent = dirItem.querySelector('.kb-tree-indent');
      const parentDepth = indent ? Math.round(parseInt(indent.style.width) / 16) : 0;
      const entries = kbTreeCache.get(dirPath);
      for (const child of entries) {
        childrenContainer.appendChild(createKbTreeNode(child, parentDepth + 1));
      }
    }
  }

  // Highlight the active file
  document.querySelectorAll('.kb-tree-item.active').forEach(el => el.classList.remove('active'));
  const activeItem = document.querySelector(`.kb-tree-item[data-path="${CSS.escape(filePath)}"]`);
  if (activeItem) {
    activeItem.classList.add('active');
    requestAnimationFrame(() => activeItem.scrollIntoView({ block: 'center', behavior: 'auto' }));
  }
}

async function loadKbFile(filePath, { skipHistory = false } = {}) {
  try {
    const res = await fetchWithRetry(`/api/vault/kb/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) return;

    // Push current file to history before navigating away
    if (!skipHistory && kbCurrentFile) {
      kbHistory.push(kbCurrentFile.path);
    }

    kbCurrentFile = data;
    // Clear pending-navigation only after the intended file has committed —
    // clearing earlier lets a concurrent loadKbPreferences() (kicked off by
    // switchView('kb') on first KB open) restore the last-viewed file and
    // clobber the click target.
    if (kbPendingNavigation === filePath) kbPendingNavigation = null;
    kbIsEditing = false;
    kbShowingDiff = false;

    // Clean up Toast UI Editor + frontmatter panel if switching files while editing
    if (kbEditor) {
      kbEditor.destroy();
      kbEditor = null;
      kbFrontmatter = '';
      hideFrontmatterEditor();
      document.getElementById('kb-editor').innerHTML = '';
    }

    document.getElementById('kb-title').textContent = data.name;
    document.getElementById('kb-title').style.cursor = 'pointer';
    document.getElementById('kb-welcome').style.display = 'none';
    document.getElementById('kb-rendered').style.display = '';
    document.getElementById('kb-diff').style.display = 'none';
    document.getElementById('kb-diff-btn').style.display = '';
    document.getElementById('kb-edit-btn').style.display = '';
    document.getElementById('kb-editor').style.display = 'none';
    document.getElementById('kb-save-btn').style.display = 'none';
    document.getElementById('kb-cancel-btn').style.display = 'none';
    document.getElementById('kb-bookmark-toggle').style.display = '';
    updateKbBookmarkBtn();

    // Detect session files and show/hide Continue Session button
    const continueBtn = document.getElementById('kb-continue-session-btn');
    const continueWrapper = document.getElementById('kb-continue-session-wrapper');
    const sessionMeta = parseSessionMeta(data.content);
    if (sessionMeta) {
      continueWrapper.style.display = '';
      continueBtn.dataset.workingDir = sessionMeta.workingDir || '';
      continueBtn.dataset.sessionId = sessionMeta.sessionId || '';
      continueBtn.dataset.sessionName = sessionMeta.sessionName || data.name;
    } else {
      continueWrapper.style.display = 'none';
    }

    // Detect topic files and show/hide Start Session from Topic button
    const topicBtn = document.getElementById('kb-start-from-topic-btn');
    const topicWrapper = document.getElementById('kb-start-from-topic-wrapper');
    const topicMeta = parseTopicMeta(data.content);
    if (topicMeta) {
      topicWrapper.style.display = '';
      topicBtn.dataset.topicName = topicMeta.topicName || data.name;
      topicBtn.dataset.topicPath = data.path;
    } else {
      topicWrapper.style.display = 'none';
    }

    // Show/hide back button and action bar
    const backBtn = document.getElementById('kb-back-btn');
    const actionBar = document.getElementById('kb-action-bar');
    const canGoBack = kbHistory.length > 0 || kbEntryPoint !== null;
    backBtn.style.display = canGoBack ? '' : 'none';
    const hasAnyButton = canGoBack || sessionMeta || topicMeta;
    actionBar.style.display = hasAnyButton ? '' : 'none';

    // Render markdown
    document.getElementById('kb-rendered').innerHTML = renderKbMarkdown(data.content);

    // Expand tree path to this file and highlight it
    await expandKbPathTo(filePath);

    // Close sidebar on mobile
    if (sidebar.classList.contains('open')) toggleSidebar();

    // Scroll to top
    document.getElementById('kb-content').scrollTop = 0;

    // Persist current file for cross-device continuity
    saveKbPreferences({ currentFile: filePath });
  } catch (err) {
    console.error('Failed to load KB file:', err);
  }
}

function navigateKbBack() {
  if (kbHistory.length > 0) {
    const previousPath = kbHistory.pop();
    loadKbFile(previousPath, { skipHistory: true });
    return;
  }
  if (kbEntryPoint) {
    const { sessionId } = kbEntryPoint;
    kbEntryPoint = null;
    switchView('sessions');
    switchSession(sessionId);
  }
}

// ---- KB Bookmarks ----

function saveKbBookmarks() {
  saveKbPreferences({ bookmarks: kbBookmarks });
}

function isKbBookmarked(filePath) {
  return kbBookmarks.some(b => b.path === filePath);
}

function toggleKbBookmark() {
  if (!kbCurrentFile) return;
  const idx = kbBookmarks.findIndex(b => b.path === kbCurrentFile.path);
  if (idx >= 0) {
    kbBookmarks.splice(idx, 1);
  } else {
    kbBookmarks.push({ path: kbCurrentFile.path, name: kbCurrentFile.name });
  }
  saveKbBookmarks();
  updateKbBookmarkBtn();
  if (kbShowingBookmarks) renderKbBookmarksList();
}

function updateKbBookmarkBtn() {
  const btn = document.getElementById('kb-bookmark-toggle');
  if (!btn) return;
  if (kbCurrentFile && isKbBookmarked(kbCurrentFile.path)) {
    btn.classList.add('bookmarked');
  } else {
    btn.classList.remove('bookmarked');
  }
}

function toggleKbBookmarksView() {
  const tree = document.getElementById('kb-tree');
  const searchResults = document.getElementById('kb-search-results');
  const bookmarksList = document.getElementById('kb-bookmarks-list');
  const recentList = document.getElementById('kb-recent-list');
  const toolbarBtn = document.getElementById('kb-toolbar-bookmarks');
  const recentBtn = document.getElementById('kb-toolbar-recent');

  kbShowingBookmarks = !kbShowingBookmarks;

  if (kbShowingBookmarks) {
    // Exit recent if active
    if (kbShowingRecent) {
      kbShowingRecent = false;
      recentList.style.display = 'none';
      recentBtn.classList.remove('active');
    }
    tree.style.display = 'none';
    searchResults.style.display = 'none';
    bookmarksList.style.display = '';
    toolbarBtn.classList.add('active');
    renderKbBookmarksList();
    saveKbPreferences({ viewMode: 'bookmarks' });
  } else {
    bookmarksList.style.display = 'none';
    tree.style.display = '';
    toolbarBtn.classList.remove('active');
    saveKbPreferences({ viewMode: 'tree' });
  }
  updateKbClearFiltersBtn();
}

function renderKbBookmarksList() {
  const container = document.getElementById('kb-bookmarks-list');
  container.innerHTML = '';

  if (kbBookmarks.length === 0) {
    container.innerHTML = '<div class="kb-bookmarks-empty">No bookmarks yet.<br>Open a file and click the bookmark icon in the title bar.</div>';
    return;
  }

  for (const bm of kbBookmarks) {
    const item = document.createElement('div');
    item.className = 'kb-bookmark-item';

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('width', '14');
    icon.setAttribute('height', '14');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = bm.name;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'kb-bookmark-remove';
    removeBtn.setAttribute('aria-label', 'Remove bookmark');
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      kbBookmarks = kbBookmarks.filter(b => b.path !== bm.path);
      saveKbBookmarks();
      updateKbBookmarkBtn();
      renderKbBookmarksList();
    });

    item.appendChild(icon);
    item.appendChild(nameSpan);
    item.appendChild(removeBtn);
    item.addEventListener('click', () => loadKbFile(bm.path));
    container.appendChild(item);
  }
}

// ---- KB Collapse All ----

function collapseAllKbDirs() {
  kbExpandedDirs.clear();
  const tree = document.getElementById('kb-tree');
  tree.querySelectorAll('.kb-tree-chevron.expanded').forEach(chev => {
    chev.classList.remove('expanded');
  });
  tree.querySelectorAll('.kb-tree-children').forEach(children => {
    children.classList.add('collapsed');
  });
  // Exit bookmarks/recent view if active
  let viewChanged = false;
  if (kbShowingBookmarks) {
    kbShowingBookmarks = false;
    document.getElementById('kb-bookmarks-list').style.display = 'none';
    document.getElementById('kb-toolbar-bookmarks').classList.remove('active');
    tree.style.display = '';
    viewChanged = true;
  }
  if (kbShowingRecent) {
    kbShowingRecent = false;
    document.getElementById('kb-recent-list').style.display = 'none';
    document.getElementById('kb-toolbar-recent').classList.remove('active');
    tree.style.display = '';
    viewChanged = true;
  }
  if (viewChanged) saveKbPreferences({ viewMode: 'tree' });
  updateKbClearFiltersBtn();
}

// ---- KB Recent Files ----

function toggleKbRecentView() {
  const tree = document.getElementById('kb-tree');
  const searchResults = document.getElementById('kb-search-results');
  const bookmarksList = document.getElementById('kb-bookmarks-list');
  const recentList = document.getElementById('kb-recent-list');
  const toolbarBtn = document.getElementById('kb-toolbar-recent');
  const bookmarksBtn = document.getElementById('kb-toolbar-bookmarks');

  kbShowingRecent = !kbShowingRecent;

  if (kbShowingRecent) {
    // Exit bookmarks if active
    if (kbShowingBookmarks) {
      kbShowingBookmarks = false;
      bookmarksList.style.display = 'none';
      bookmarksBtn.classList.remove('active');
    }
    tree.style.display = 'none';
    searchResults.style.display = 'none';
    recentList.style.display = '';
    toolbarBtn.classList.add('active');
    loadKbRecentFiles();
    saveKbPreferences({ viewMode: 'recent' });
  } else {
    recentList.style.display = 'none';
    tree.style.display = '';
    toolbarBtn.classList.remove('active');
    saveKbPreferences({ viewMode: 'tree' });
  }
  updateKbClearFiltersBtn();
}

function clearKbFilters() {
  const tree = document.getElementById('kb-tree');

  if (kbShowingBookmarks) {
    kbShowingBookmarks = false;
    document.getElementById('kb-bookmarks-list').style.display = 'none';
    document.getElementById('kb-toolbar-bookmarks').classList.remove('active');
  }
  if (kbShowingRecent) {
    kbShowingRecent = false;
    document.getElementById('kb-recent-list').style.display = 'none';
    document.getElementById('kb-toolbar-recent').classList.remove('active');
  }

  tree.style.display = '';
  saveKbPreferences({ viewMode: 'tree' });
  updateKbClearFiltersBtn();
}

function updateKbClearFiltersBtn() {
  const btn = document.getElementById('kb-toolbar-clear-filters');
  if (!btn) return;
  btn.style.display = (kbShowingBookmarks || kbShowingRecent) ? '' : 'none';
}

async function loadKbRecentFiles() {
  const container = document.getElementById('kb-recent-list');
  container.innerHTML = '<div class="kb-bookmarks-empty">Loading…</div>';

  try {
    const resp = await fetchWithRetry('/api/vault/kb/recent');
    const data = await resp.json();

    if (!data.results || data.results.length === 0) {
      container.innerHTML = '<div class="kb-bookmarks-empty">No recent files found.</div>';
      return;
    }

    container.innerHTML = '';
    for (const file of data.results) {
      const item = document.createElement('div');
      item.className = 'kb-bookmark-item';

      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.setAttribute('width', '14');
      icon.setAttribute('height', '14');
      icon.setAttribute('fill', 'none');
      icon.setAttribute('stroke', 'currentColor');
      icon.setAttribute('stroke-width', '2');
      icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';

      const textWrap = document.createElement('div');
      textWrap.className = 'kb-recent-text';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'kb-recent-name';
      nameSpan.textContent = file.name;
      const folderSpan = document.createElement('span');
      folderSpan.className = 'kb-recent-folder';
      folderSpan.textContent = file.folder;
      textWrap.appendChild(nameSpan);
      textWrap.appendChild(folderSpan);

      item.appendChild(icon);
      item.appendChild(textWrap);
      item.addEventListener('click', () => loadKbFile(file.path));
      container.appendChild(item);
    }
  } catch (err) {
    container.innerHTML = '<div class="kb-bookmarks-empty">Failed to load recent files.</div>';
  }
}

function renderKbMarkdown(text) {
  // Extract and render frontmatter separately
  let body = text;
  let frontmatterHtml = '';
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    frontmatterHtml = `<div class="kb-frontmatter">${escapeHtml(fmMatch[1])}</div>`;
    body = text.slice(fmMatch[0].length);
  }

  // Pre-process wiki-links into HTML spans before marked parsing
  const withLinks = body.replace(/\[\[([^\]]+)\]\]/g, (_match, inner) => {
    const parts = inner.split('|');
    const target = parts[0].trim();
    const display = (parts[1] || parts[0]).trim();
    const escaped = target.replace(/"/g, '&quot;');
    return `<span class="wiki-link" data-target="${escaped}" onclick="navigateWikiLink(this)">${escapeHtml(display)}</span>`;
  });

  // Parse with marked (reuse existing marked instance)
  const rendered = marked.parse(withLinks);
  return frontmatterHtml + rendered;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function navigateWikiLink(el) {
  const target = el.dataset.target;
  const contextPath = kbCurrentFile?.path || '';
  const flashBroken = () => {
    el.style.color = 'var(--error)';
    setTimeout(() => { el.style.color = ''; }, 1500);
  };
  try {
    // Use raw fetch — fetchWithRetry throws on 404, which is exactly the
    // "not found" signal we need to distinguish from a transport error.
    const res = await fetch(`/api/vault/kb/resolve-link?name=${encodeURIComponent(target)}&context=${encodeURIComponent(contextPath)}`);
    if (res.status === 404) {
      flashBroken();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.path) {
      // Route through navigateToKbFile so the same handler works from both
      // the KB pane and the chat pane (switchView is a no-op when already on kb).
      navigateToKbFile(data.path);
    } else {
      flashBroken();
    }
  } catch (err) {
    console.error('Failed to resolve wiki-link:', err);
    flashBroken();
  }
}

// Intercept clicks on standard markdown links in KB rendered view
// so that internal vault links navigate within the KB instead of opening new tabs
document.getElementById('kb-rendered')?.addEventListener('click', async (e) => {
  const anchor = e.target.closest('a');
  if (!anchor) return;

  const href = anchor.getAttribute('href');
  if (!href) return;

  const obsidianRoot = '/Documents/Obsidian/';

  // Absolute vault path (e.g. /Users/.../Documents/Obsidian/AI-Work/topics/foo.md)
  if (href.includes(obsidianRoot) && href.endsWith('.md')) {
    e.preventDefault();
    loadKbFile(href);
    return;
  }

  // Relative .md link (e.g. ./file.md, ../topics/file.md, file.md)
  // Must not start with http/https/mailto/# and must end in .md
  if (!href.match(/^(https?:|mailto:|#)/) && href.endsWith('.md') && kbCurrentFile?.path) {
    e.preventDefault();
    // Resolve relative to current file's directory
    const currentDir = kbCurrentFile.path.substring(0, kbCurrentFile.path.lastIndexOf('/'));
    const resolved = decodeURIComponent(new URL(href, 'file:///' + currentDir + '/').pathname);
    loadKbFile(resolved);
    return;
  }
});

async function toggleKbDiff() {
  if (!kbCurrentFile) return;

  // If already showing diff, switch back to rendered view
  if (kbShowingDiff) {
    kbShowingDiff = false;
    document.getElementById('kb-diff').style.display = 'none';
    document.getElementById('kb-rendered').style.display = '';
    document.getElementById('kb-diff-btn').classList.remove('kb-action-btn-active');
    return;
  }

  kbShowingDiff = true;
  document.getElementById('kb-rendered').style.display = 'none';
  document.getElementById('kb-diff').style.display = '';
  document.getElementById('kb-diff-btn').classList.add('kb-action-btn-active');
  document.getElementById('kb-diff').innerHTML = '<div class="kb-diff-loading">Loading diff...</div>';

  try {
    const res = await fetchWithRetry(`/api/vault/kb/diff?path=${encodeURIComponent(kbCurrentFile.path)}`);
    const data = await res.json();

    if (!data.diff) {
      document.getElementById('kb-diff').innerHTML =
        `<div class="kb-diff-empty">${escapeHtml(data.message || 'No diff available')}</div>`;
      return;
    }

    document.getElementById('kb-diff').innerHTML = renderDiff(data.diff);
  } catch (err) {
    console.error('Failed to load diff:', err);
    document.getElementById('kb-diff').innerHTML =
      '<div class="kb-diff-empty">Failed to load diff</div>';
  }
}

function renderDiff(rawDiff) {
  const lines = rawDiff.split('\n');
  let html = '';
  let inHeader = true;
  let headerLines = [];
  let diffLines = [];

  for (const line of lines) {
    if (inHeader) {
      // Header ends at the first "diff --git" line
      if (line.startsWith('diff --git')) {
        inHeader = false;
      } else {
        headerLines.push(line);
        continue;
      }
    }

    if (line.startsWith('diff --git')) {
      // File separator — skip, we only have one file
      continue;
    } else if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
      // Git metadata lines — skip
      continue;
    } else if (line.startsWith('@@')) {
      diffLines.push(`<div class="kb-diff-hunk">${escapeHtml(line)}</div>`);
    } else if (line.startsWith('+')) {
      diffLines.push(`<div class="kb-diff-add">${escapeHtml(line)}</div>`);
    } else if (line.startsWith('-')) {
      diffLines.push(`<div class="kb-diff-del">${escapeHtml(line)}</div>`);
    } else {
      diffLines.push(`<div class="kb-diff-ctx">${escapeHtml(line)}</div>`);
    }
  }

  // Build commit header
  if (headerLines.length) {
    html += '<div class="kb-diff-header">';
    for (const hl of headerLines) {
      html += `<div>${escapeHtml(hl)}</div>`;
    }
    html += '</div>';
  }

  html += '<div class="kb-diff-body">' + diffLines.join('') + '</div>';
  return html;
}

// --- Frontmatter editor panel ---

let kbFmExpanded = false;

function toggleFrontmatterPanel() {
  const panel = document.getElementById('kb-frontmatter-editor');
  kbFmExpanded = !kbFmExpanded;
  panel.classList.toggle('expanded', kbFmExpanded);
  if (kbFmExpanded) {
    const ta = document.getElementById('kb-frontmatter-textarea');
    autoResizeFmTextarea(ta);
    ta.focus();
  }
}

function showFrontmatterEditor(yaml) {
  const panel = document.getElementById('kb-frontmatter-editor');
  const ta = document.getElementById('kb-frontmatter-textarea');
  ta.value = yaml;
  panel.style.display = '';
  // Collapse by default when content exists, expand when empty (adding new)
  kbFmExpanded = !yaml.trim();
  panel.classList.toggle('expanded', kbFmExpanded);
  autoResizeFmTextarea(ta);
  // Hook up autosave + auto-resize on input
  ta.addEventListener('input', onFmTextareaInput);
}

function hideFrontmatterEditor() {
  const panel = document.getElementById('kb-frontmatter-editor');
  const ta = document.getElementById('kb-frontmatter-textarea');
  panel.style.display = 'none';
  panel.classList.remove('expanded');
  ta.removeEventListener('input', onFmTextareaInput);
  ta.value = '';
  kbFmExpanded = false;
}

function onFmTextareaInput() {
  autoResizeFmTextarea(this);
  scheduleKbAutosave();
}

function autoResizeFmTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 380) + 'px';
}

function getCurrentFrontmatter() {
  const ta = document.getElementById('kb-frontmatter-textarea');
  const val = ta.value.trim();
  if (!val) return '';
  return '---\n' + val + '\n---\n';
}

// ============================================================================
// [[wiki-link]] autocomplete for the KB Toast UI editor (WYSIWYG mode).
// Listens for `[[query` before the caret in a text node, offers active-mode
// vault filenames from /api/vault/kb/link-candidates, and inserts the bare
// filename inside `[[...]]` on selection — matching Obsidian's convention.
// ============================================================================
const wikiLinkState = {
  open: false,
  startNode: null,
  startOffset: -1,
  query: '',
  results: [],
  selectedIdx: 0,
  fetchSeq: 0,
  popoverEl: null,
};
const WIKI_FETCH_DEBOUNCE_MS = 150;
let wikiFetchTimer = null;

function ensureWikiPopover() {
  if (wikiLinkState.popoverEl) return wikiLinkState.popoverEl;
  const el = document.createElement('div');
  el.id = 'wiki-link-popover';
  el.className = 'mention-popover wiki-link-popover';
  el.style.display = 'none';
  document.body.appendChild(el);
  wikiLinkState.popoverEl = el;
  return el;
}

function closeWikiPopover() {
  wikiLinkState.open = false;
  wikiLinkState.startNode = null;
  wikiLinkState.startOffset = -1;
  wikiLinkState.query = '';
  wikiLinkState.results = [];
  wikiLinkState.selectedIdx = 0;
  wikiLinkState.fetchSeq++;
  if (wikiFetchTimer) { clearTimeout(wikiFetchTimer); wikiFetchTimer = null; }
  if (wikiLinkState.popoverEl) wikiLinkState.popoverEl.style.display = 'none';
}

function positionWikiPopover() {
  const el = ensureWikiPopover();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) { el.style.display = 'none'; return; }
  const range = sel.getRangeAt(0).cloneRange();
  range.collapse(true);
  let rect = range.getBoundingClientRect();
  // Empty text nodes return 0,0 rects; fall back to the parent element's rect.
  if (rect.top === 0 && rect.left === 0 && rect.bottom === 0) {
    const container = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer
      : range.startContainer.parentElement;
    if (container) rect = container.getBoundingClientRect();
  }
  const POPOVER_WIDTH = 360;
  const left = Math.min(Math.max(rect.left, 8), window.innerWidth - POPOVER_WIDTH - 8);
  el.style.left = `${left}px`;
  el.style.top = `${rect.bottom + 4}px`;
  el.style.bottom = 'auto';
  el.style.width = `${POPOVER_WIDTH}px`;
}

function renderWikiPopover() {
  const el = ensureWikiPopover();
  if (!wikiLinkState.results.length) {
    el.innerHTML = '<div class="mention-empty">No matches</div>';
  } else {
    el.innerHTML = wikiLinkState.results.map((r, idx) => {
      const cls = idx === wikiLinkState.selectedIdx ? 'mention-item selected' : 'mention-item';
      const vault = r.vault ? `<span class="mention-vault">${escapeMentionHtml(r.vault)}</span>` : '';
      return `<div class="${cls}" data-idx="${idx}"><span class="mention-icon">🔗</span><span class="mention-name">${escapeMentionHtml(r.name)}</span>${vault}</div>`;
    }).join('');
    el.querySelectorAll('.mention-item').forEach(itemEl => {
      itemEl.addEventListener('mousedown', (e) => {
        e.preventDefault();
        applyWikiSelection(parseInt(itemEl.getAttribute('data-idx'), 10));
      });
    });
  }
  positionWikiPopover();
  el.style.display = 'block';
  scrollSelectedMentionIntoView(el, wikiLinkState.selectedIdx);
}

async function fetchWikiCandidates(query) {
  const seq = ++wikiLinkState.fetchSeq;
  try {
    const r = await fetch(`/api/vault/kb/link-candidates?mode=${currentMode}&q=${encodeURIComponent(query)}&limit=20`);
    if (seq !== wikiLinkState.fetchSeq) return;
    if (!r.ok) return;
    const results = await r.json();
    wikiLinkState.results = results;
    wikiLinkState.selectedIdx = 0;
    renderWikiPopover();
  } catch {}
}

function scheduleWikiFetch(query) {
  if (wikiFetchTimer) clearTimeout(wikiFetchTimer);
  wikiFetchTimer = setTimeout(() => fetchWikiCandidates(query), WIKI_FETCH_DEBOUNCE_MS);
}

function detectWikiToken() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!range.collapsed) return null;
  const node = range.startContainer;
  const offset = range.startOffset;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;
  const text = node.textContent || '';
  const slice = text.slice(0, offset);
  const idx = slice.lastIndexOf('[[');
  if (idx < 0) return null;
  const after = slice.slice(idx + 2);
  // Stop tracking if the user has typed ']' or a newline after '[['
  if (/[\]\n]/.test(after)) return null;
  return { node, startOffset: idx, query: after };
}

function updateWikiPicker() {
  if (!kbIsEditing || !kbEditor) {
    if (wikiLinkState.open) closeWikiPopover();
    return;
  }
  const tok = detectWikiToken();
  if (!tok) {
    if (wikiLinkState.open) closeWikiPopover();
    return;
  }
  wikiLinkState.open = true;
  wikiLinkState.startNode = tok.node;
  wikiLinkState.startOffset = tok.startOffset;
  wikiLinkState.query = tok.query;
  scheduleWikiFetch(tok.query);
  positionWikiPopover();
  ensureWikiPopover().style.display = 'block';
}

function applyWikiSelection(idx) {
  if (idx < 0 || idx >= wikiLinkState.results.length) return;
  const chosen = wikiLinkState.results[idx];
  const node = wikiLinkState.startNode;
  if (!node || !node.parentNode) {
    closeWikiPopover();
    return;
  }
  const sel = window.getSelection();
  if (!sel) {
    closeWikiPopover();
    return;
  }
  let cursorOffset = (node.textContent || '').length;
  if (sel.rangeCount && sel.getRangeAt(0).startContainer === node) {
    cursorOffset = sel.getRangeAt(0).startOffset;
  }
  try {
    const range = document.createRange();
    range.setStart(node, wikiLinkState.startOffset);
    range.setEnd(node, cursorOffset);
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('insertText', false, `[[${chosen.name}]]`);
    if (!ok && kbEditor && typeof kbEditor.insertText === 'function') {
      kbEditor.insertText(`[[${chosen.name}]]`);
    }
  } catch {
    try { kbEditor.insertText(`[[${chosen.name}]]`); } catch {}
  }
  closeWikiPopover();
}

function handleWikiKeydown(e) {
  if (!wikiLinkState.open) return false;
  if (e.key === 'ArrowDown' && wikiLinkState.results.length) {
    e.preventDefault(); e.stopPropagation();
    wikiLinkState.selectedIdx = (wikiLinkState.selectedIdx + 1) % wikiLinkState.results.length;
    renderWikiPopover();
    return true;
  }
  if (e.key === 'ArrowUp' && wikiLinkState.results.length) {
    e.preventDefault(); e.stopPropagation();
    wikiLinkState.selectedIdx = (wikiLinkState.selectedIdx - 1 + wikiLinkState.results.length) % wikiLinkState.results.length;
    renderWikiPopover();
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (wikiLinkState.results.length) {
      e.preventDefault(); e.stopPropagation();
      applyWikiSelection(wikiLinkState.selectedIdx);
      return true;
    }
  }
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    closeWikiPopover();
    return true;
  }
  return false;
}

function attachWikiLinkListeners(editorRootEl) {
  if (editorRootEl.dataset.wikiLinkBound === '1') return;
  editorRootEl.dataset.wikiLinkBound = '1';
  editorRootEl.addEventListener('keydown', handleWikiKeydown, true);
  editorRootEl.addEventListener('input', updateWikiPicker);
  editorRootEl.addEventListener('click', updateWikiPicker);
  editorRootEl.addEventListener('keyup', (e) => {
    // Arrow keys and printable keystrokes can move the caret outside [[...]] — re-evaluate.
    if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','Backspace','Delete'].includes(e.key)) {
      updateWikiPicker();
    }
  });
}

async function toggleKbEdit() {
  if (!kbCurrentFile) return;
  kbIsEditing = true;
  kbShowingDiff = false;

  document.getElementById('kb-rendered').style.display = 'none';
  document.getElementById('kb-diff').style.display = 'none';
  document.getElementById('kb-diff-btn').style.display = 'none';
  document.getElementById('kb-diff-btn').classList.remove('kb-action-btn-active');
  document.getElementById('kb-editor').style.display = 'block';
  document.getElementById('kb-edit-btn').style.display = 'none';
  document.getElementById('kb-save-btn').style.display = '';
  document.getElementById('kb-cancel-btn').style.display = '';

  // Initialize Toast UI Editor in WYSIWYG mode
  if (kbEditor) {
    kbEditor.destroy();
    kbEditor = null;
  }

  // Strip YAML frontmatter — editor can't handle it; show in separate panel
  kbFrontmatter = '';
  let editContent = kbCurrentFile.content;
  let fmYaml = '';
  const fmMatch = editContent.match(/^---\r?\n([\s\S]*?\r?\n)---\r?\n?/);
  if (fmMatch) {
    kbFrontmatter = fmMatch[0];
    fmYaml = fmMatch[1];
    editContent = editContent.slice(fmMatch[0].length);
  }
  showFrontmatterEditor(fmYaml);

  // Fetch templates if not cached, then build toolbar
  if (kbTemplatesCache === null) await fetchKbTemplates();

  const templateToolbarItem = (kbTemplatesCache && kbTemplatesCache.length > 0) ? [{
    name: 'template',
    tooltip: 'Insert template',
    className: 'toastui-editor-toolbar-icons kb-template-toolbar-btn',
    command: 'insertTemplate',
  }] : [];

  const editorEl = document.getElementById('kb-editor');
  editorEl.innerHTML = '';
  kbEditor = new toastui.Editor({
    el: editorEl,
    initialEditType: 'wysiwyg',
    initialValue: editContent,
    previewStyle: 'vertical',
    height: 'calc(100vh - 160px)',
    usageStatistics: false,
    autofocus: true,
    toolbarItems: [
      ['heading', 'bold', 'italic', 'strike'],
      ['hr', 'quote'],
      ['ul', 'ol', 'task'],
      ['table', 'link', {
        name: 'imageUrl',
        tooltip: 'Insert image (URL)',
        className: 'toastui-editor-toolbar-icons image',
        command: 'imageUrl',
      }, 'code', 'codeblock'],
      ...templateToolbarItem.length ? [templateToolbarItem] : [],
    ],
  });

  // Autosave on content changes (debounced 2s)
  kbEditor.on('change', scheduleKbAutosave);

  // Custom image URL-only button — no file upload
  kbEditor.addCommand('wysiwyg', 'imageUrl', () => {
    const url = prompt('Image URL:');
    if (!url) return;
    const alt = prompt('Description (optional):') || '';
    kbEditor.insertText(`![${alt}](${url})`);
    return true;
  });
  kbEditor.addCommand('markdown', 'imageUrl', () => {
    const url = prompt('Image URL:');
    if (!url) return;
    const alt = prompt('Description (optional):') || '';
    kbEditor.insertText(`![${alt}](${url})`);
    return true;
  });

  // Template picker command
  kbEditor.addCommand('wysiwyg', 'insertTemplate', () => { showTemplatePicker(); return true; });
  kbEditor.addCommand('markdown', 'insertTemplate', () => { showTemplatePicker(); return true; });

  // Wire [[wiki-link]] autocomplete — capture-phase listener on the persistent
  // host intercepts ProseMirror's keyboard handling for Tab/Enter/Escape.
  attachWikiLinkListeners(editorEl);
}

function cancelKbEdit() {
  closeWikiPopover();
  clearTimeout(kbAutosaveTimer);
  kbIsEditing = false;
  kbFrontmatter = '';
  hideFrontmatterEditor();

  // Destroy Toast UI Editor instance
  if (kbEditor) {
    kbEditor.destroy();
    kbEditor = null;
    document.getElementById('kb-editor').innerHTML = '';
  }

  document.getElementById('kb-rendered').style.display = '';
  document.getElementById('kb-diff').style.display = 'none';
  document.getElementById('kb-editor').style.display = 'none';
  document.getElementById('kb-diff-btn').style.display = '';
  document.getElementById('kb-edit-btn').style.display = '';
  document.getElementById('kb-save-btn').style.display = 'none';
  document.getElementById('kb-cancel-btn').style.display = 'none';
  const statusEl = document.getElementById('kb-save-status');
  if (statusEl) statusEl.remove();
}

// Clean up Toast UI's overly aggressive markdown escaping
function cleanToastMarkdown(md) {
  return md
    // Restore wiki-links: \[\[...\]\] → [[...]]
    .replace(/\\\[\\\[/g, '[[')
    .replace(/\\\]\\\]/g, ']]')
    // Remove backslash escapes before hyphens, underscores, and pipes inside links/text
    .replace(/\\([_\-|])/g, '$1');
}

async function fetchKbTemplates() {
  try {
    const res = await fetchWithRetry('/api/vault/kb/templates');
    const data = await res.json();
    kbTemplatesCache = data.templates || [];
  } catch {
    kbTemplatesCache = [];
  }
  return kbTemplatesCache;
}

function showTemplatePicker() {
  // Remove existing picker if open
  const existing = document.querySelector('.kb-template-picker');
  if (existing) { existing.remove(); return; }

  const templates = kbTemplatesCache;
  if (!templates || templates.length === 0) return;

  // Find the toolbar button to anchor the dropdown
  const btn = document.querySelector('.kb-template-toolbar-btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const picker = document.createElement('div');
  picker.className = 'kb-template-picker';
  picker.style.position = 'fixed';
  picker.style.top = (rect.bottom + 4) + 'px';
  picker.style.left = rect.left + 'px';
  picker.style.zIndex = '9999';

  // Group by vault, then by folder
  const grouped = {};
  for (const t of templates) {
    const key = t.vault;
    if (!grouped[key]) grouped[key] = {};
    const folder = t.folder || '';
    if (!grouped[key][folder]) grouped[key][folder] = [];
    grouped[key][folder].push(t);
  }

  const vaults = Object.keys(grouped);
  for (const vault of vaults) {
    if (vaults.length > 1) {
      const header = document.createElement('div');
      header.className = 'kb-template-picker-vault';
      header.textContent = vault;
      picker.appendChild(header);
    }
    const folders = Object.keys(grouped[vault]).sort();
    for (const folder of folders) {
      if (folder) {
        const folderHeader = document.createElement('div');
        folderHeader.className = 'kb-template-picker-folder';
        folderHeader.textContent = folder;
        picker.appendChild(folderHeader);
      }
      for (const t of grouped[vault][folder]) {
        const item = document.createElement('div');
        item.className = 'kb-template-picker-item';
        if (folder) item.style.paddingLeft = '24px';
        item.textContent = t.name;
        item.addEventListener('click', () => applyTemplate(t));
        picker.appendChild(item);
      }
    }
  }

  document.body.appendChild(picker);

  // Close on outside click
  setTimeout(() => {
    function closePicker(e) {
      if (!picker.contains(e.target) && e.target !== btn) {
        picker.remove();
        document.removeEventListener('click', closePicker);
      }
    }
    document.addEventListener('click', closePicker);
  }, 0);
}

async function applyTemplate(template) {
  // Close picker
  const picker = document.querySelector('.kb-template-picker');
  if (picker) picker.remove();

  if (!kbEditor) return;

  try {
    const res = await fetchWithRetry('/api/vault/kb/file?path=' + encodeURIComponent(template.path));
    const data = await res.json();
    if (data.content == null) return;

    // Separate frontmatter from template body — update the frontmatter panel
    let body = data.content;
    const fmMatch = body.match(/^---\r?\n([\s\S]*?\r?\n)---\r?\n?/);
    if (fmMatch) {
      body = body.slice(fmMatch[0].length);
      // Push template frontmatter into the editor panel
      const ta = document.getElementById('kb-frontmatter-textarea');
      ta.value = fmMatch[1];
      autoResizeFmTextarea(ta);
    }

    // Replace editor content with template body
    kbEditor.setMarkdown(body);
  } catch (err) {
    console.error('Failed to load template:', err);
  }
}

function showKbSaveStatus(text, type = 'info') {
  let el = document.getElementById('kb-save-status');
  if (!el) {
    el = document.createElement('span');
    el.id = 'kb-save-status';
    el.style.cssText = 'font-size:12px;margin-left:8px;opacity:0.7;transition:opacity 0.3s';
    document.getElementById('kb-save-btn').parentNode.insertBefore(el, document.getElementById('kb-save-btn'));
  }
  el.textContent = text;
  el.style.color = type === 'error' ? '#e74c3c' : '#888';
  el.style.opacity = '1';
  if (type !== 'error') {
    setTimeout(() => { el.style.opacity = '0'; }, 2000);
  }
}

async function kbAutosave() {
  if (!kbEditor || !kbCurrentFile || !kbIsEditing) return;
  const rawContent = kbEditor.getMarkdown();
  const editorContent = cleanToastMarkdown(rawContent);
  const content = getCurrentFrontmatter() + editorContent;
  // Skip save if content hasn't actually changed
  if (content === kbCurrentFile.content) return;
  try {
    showKbSaveStatus('Saving...');
    const res = await fetchWithRetry('/api/vault/kb/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: kbCurrentFile.path, content }),
    });
    const data = await res.json();
    if (data.success) {
      kbCurrentFile.content = content;
      showKbSaveStatus('Saved');
    } else {
      showKbSaveStatus('Save failed', 'error');
    }
  } catch (err) {
    console.error('Autosave failed:', err);
    showKbSaveStatus('Save failed', 'error');
  }
}

function scheduleKbAutosave() {
  clearTimeout(kbAutosaveTimer);
  kbAutosaveTimer = setTimeout(kbAutosave, 2000);
}

async function saveKbFile() {
  clearTimeout(kbAutosaveTimer);
  const rawContent = kbEditor ? kbEditor.getMarkdown() : '';
  const editorContent = cleanToastMarkdown(rawContent);
  const content = getCurrentFrontmatter() + editorContent;
  try {
    const res = await fetchWithRetry('/api/vault/kb/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: kbCurrentFile.path, content }),
    });
    const data = await res.json();
    if (data.success) {
      kbCurrentFile.content = content;
      cancelKbEdit();
      // Re-render with updated content
      document.getElementById('kb-rendered').innerHTML = renderKbMarkdown(content);
    } else {
      alert('Save failed: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('Failed to save KB file:', err);
    alert('Save failed: ' + err.message);
  }
}

/* ===== Sidebar Resize (Desktop Only) ===== */
(function initSidebarResize() {
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  if (!handle) return;

  const STORAGE_KEY = 'sidebar-width';
  const MIN_WIDTH = 220;
  const MAX_WIDTH = 500;

  // Restore saved width on desktop
  function applySavedWidth() {
    if (window.innerWidth < 768) return;
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, parseInt(saved, 10)));
      sidebar.style.width = w + 'px';
    }
  }
  applySavedWidth();

  let dragging = false;

  handle.addEventListener('mousedown', function (e) {
    if (window.innerWidth < 768) return;
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, e.clientX));
    sidebar.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(STORAGE_KEY, parseInt(sidebar.style.width, 10));
  });

  // Reset to default width on mobile resize
  window.addEventListener('resize', function () {
    if (window.innerWidth < 768) {
      sidebar.style.width = '';
    } else {
      applySavedWidth();
    }
  });
})();
