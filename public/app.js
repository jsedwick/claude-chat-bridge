// State
let currentSessionId = null;
const streamingSessions = new Set(); // track which sessions are actively streaming
const sessionInputDrafts = new Map(); // preserve input text per session
const pendingMessages = new Map(); // queued messages per session (sent when stream completes)
let currentMode = 'work';
let pendingPermissionId = null;
let permissionPollInterval = null;
const permissionQueue = []; // queue for parallel permission requests
let versionData = null; // cached version check data

// Message history (server-backed)
async function restoreMessages(sessionId) {
  console.log('[SSE] restoreMessages called', sessionId, new Error().stack?.split('\n').slice(1,4).join(' <- '));
  clearMessages();
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`);
    const messages = await res.json();
    for (const msg of messages) {
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
    scrollToBottom();
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

// Restore saved model
const savedModel = localStorage.getItem('chat-bridge-model') || 'opus';
modelSelect.value = savedModel;

function saveModel(value) {
  localStorage.setItem('chat-bridge-model', value);
}

function getSelectedModel() {
  return modelSelect.value;
}

// Mode management
async function loadMode() {
  try {
    const res = await fetch('/api/sessions/mode/current');
    const { mode } = await res.json();
    currentMode = mode;
    updateModeTabsUI(mode);
  } catch {}
}

async function setMode(mode) {
  if (mode === currentMode) return;
  try {
    const res = await fetch('/api/sessions/mode/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    const result = await res.json();
    currentMode = result.mode;
    updateModeTabsUI(result.mode);

    // Deselect current chat if it doesn't belong to this mode
    if (currentSessionId) {
      try {
        const s = await fetch(`/api/sessions/${currentSessionId}`).then(r => r.json());
        if ((s.mode || 'work') !== result.mode) {
          currentSessionId = null;
          chatTitle.textContent = 'Claude Chat Bridge';
          currentWorkingDir = '';
          welcomeEl.style.display = 'flex';
          inputArea.style.display = 'none';
          document.querySelector('.dir-picker-wrapper').style.display = 'none';
          clearMessages();
        }
      } catch {}
    }

    // Reload sidebar and welcome screen with filtered sessions/topics
    loadSessions();
    loadWelcomeSessions();
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
  }
}

function updateModeTabsUI(mode) {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
}

// Directory browser state
let currentWorkingDir = '';
const dirPicker = document.getElementById('dir-picker');

// Shared directory browser renderer
async function renderDirRoots(container, onSelect) {
  container.innerHTML = '<div class="dir-browser-loading">Loading...</div>';
  container.style.display = 'block';

  try {
    const res = await fetch('/api/sessions/dirs/roots');
    const roots = await res.json();

    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'dir-browser-header';
    const pathLabel = document.createElement('span');
    pathLabel.className = 'dir-browser-path';
    pathLabel.textContent = 'Allowed Directories';
    header.appendChild(pathLabel);
    container.appendChild(header);

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
    try {
      await fetch(`/api/sessions/${currentSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: dirPath }),
      });
      currentWorkingDir = dirPath;
    } catch (err) {
      console.error('Failed to update working directory:', err);
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

// Apply saved theme and tool visibility before first paint
(function() {
  const saved = localStorage.getItem('chat-bridge-theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  if (localStorage.getItem('chat-bridge-hide-tools') === 'true') {
    document.documentElement.setAttribute('data-hide-tools', 'true');
  }
})();

// Initialize — always start in work mode on page load
(async () => {
  try {
    await fetch('/api/sessions/mode/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'work' }),
    });
  } catch {}
  currentMode = 'work';
  updateModeTabsUI('work');
  await loadBridgePaths();
  loadSessions();
  startActiveSessionPolling();
  checkVersionOnStartup();
})();

// Check for CLI version change on page load (non-blocking)
async function checkVersionOnStartup() {
  try {
    const res = await fetch('/api/settings/version');
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

  let text = '';
  if (data.versionChanged && data.updateAvailable) {
    text = `Claude Code CLI updated to <strong>${data.currentVersion}</strong> — a newer version <strong>${data.latestVersion}</strong> is also available.`;
  } else if (data.updateAvailable) {
    text = `Claude Code CLI update available: <strong>${data.currentVersion}</strong> → <strong>${data.latestVersion}</strong>`;
  } else if (data.versionChanged) {
    text = `Claude Code CLI updated to <strong>${data.currentVersion}</strong> (previously ${data.lastSeenVersion}).`;
  }

  banner.innerHTML = `
    <span class="version-banner-text">${text}</span>
    <span class="version-banner-actions">
      ${data.updateAvailable ? `<button class="version-banner-btn" onclick="window.open('https://github.com/anthropics/claude-code/releases', '_blank')">Release Notes</button>` : ''}
      <button class="version-banner-btn" onclick="showSettingsSection('updates'); switchView('settings')">View Details</button>
      <button class="version-banner-dismiss" onclick="dismissVersionBanner()" aria-label="Dismiss">&times;</button>
    </span>
  `;

  messages.parentNode.insertBefore(banner, messages);
}

async function dismissVersionBanner() {
  const banner = document.getElementById('version-banner');
  if (banner) banner.remove();
  // Acknowledge current version so it doesn't show again next load
  if (versionData?.currentVersion) {
    try {
      await fetch('/api/settings/version/acknowledge', {
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
      const res = await fetch('/api/sessions/active');
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
    } catch {}
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
  { label: 'Workflow', icon: 'play', command: '/workflow', flyout: 'workflows' },
  { label: 'Close Session', icon: 'check-circle', command: '/close', flyout: 'close' },
  { divider: true },
  { label: 'Tasks', icon: 'check-square', command: '/tasks', flyout: 'tasks' },
  { label: 'Issue', icon: 'alert-triangle', command: '/issue', flyout: 'issues' },
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
    const res = await fetch(`/api/vault/${type}`);
    if (!res.ok) return [];
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

async function showFlyout(wrapperEl, type) {
  const data = await fetchFlyoutData(type);

  const flyoutMenu = wrapperEl.querySelector('.flyout-menu');
  const command = wrapperEl.dataset.command;

  // Static flyout for close — "No Git" option
  if (type === 'close') {
    flyoutMenu.innerHTML = `<button class="flyout-item" onclick="fireCommand('/close-no-git')">
      <span class="flyout-item-label">Close (No Git)</span>
      <span class="flyout-item-desc">Skip git operations</span>
    </button>`;
    wrapperEl.classList.add('flyout-open');
    return;
  }

  // Static flyout for tasks — single "All Tasks" option
  if (type === 'tasks') {
    flyoutMenu.innerHTML = `<button class="flyout-item" onclick="fireCommand('/all-tasks')">
      <span class="flyout-item-label">All Tasks</span>
      <span class="flyout-item-desc">Work + Personal combined</span>
    </button>`;
    wrapperEl.classList.add('flyout-open');
    return;
  }

  // Default flat list rendering for workflows/issues
  const items = data;
  if (!items || items.length === 0) {
    flyoutMenu.innerHTML = '<div class="flyout-empty">None available</div>';
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
    btn.onclick = () => toggleActionMenu();
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
  try {
    const res = await fetch(`/api/vault/sessions?currentDir=${encodeURIComponent(currentWorkingDir)}`);
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
  try {
    const res = await fetch('/api/vault/topics');
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
  switchView('kb');
  loadKbFile(vaultPath);
}

// Auto-resize textarea
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// Keyboard handling
function handleKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// Sessions
async function loadSessions() {
  try {
    const [activeRes, archivedRes] = await Promise.all([
      fetch(`/api/sessions?mode=${currentMode}`),
      fetch(`/api/sessions?mode=${currentMode}&archived=true`),
    ]);
    const activeSessions = await activeRes.json();
    const allSessions = await archivedRes.json();
    const archivedSessions = allSessions.filter(s => s.archived);
    renderSessionList(activeSessions);
    renderArchiveList(archivedSessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function renderSessionItem(s, isArchived) {
  const actions = isArchived
    ? `<div class="session-item-actions">
         <button class="session-item-action" onclick="event.stopPropagation(); unarchiveSessionItem('${s.id}')" title="Unarchive">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
         </button>
         <button class="session-item-action session-item-action-danger" onclick="event.stopPropagation(); deleteSessionItem('${s.id}')" title="Delete permanently">&times;</button>
       </div>`
    : `<div class="session-item-actions">
         <button class="session-item-action" onclick="event.stopPropagation(); archiveSessionItem('${s.id}')" title="Archive">
           <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
         </button>
         <button class="session-item-action session-item-action-danger" onclick="event.stopPropagation(); deleteSessionItem('${s.id}')" title="Delete">&times;</button>
       </div>`;

  return `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''} ${isArchived ? 'archived' : ''} ${s.closedAt ? 'closed' : ''} ${activeSessionIds.has(s.id) ? 'working' : ''}"
         onclick="switchSession('${s.id}')">
      ${actions}
      <div class="session-item-name" ondblclick="event.stopPropagation(); renameSession('${s.id}', this)">${s.closedAt ? '<span class="session-closed-badge" title="Session closed">&#10003;</span>' : s.usedCodeFile ? '<span class="session-code-badge" title="Code changes made">&lt;/&gt;</span>' : ''}${escapeHtml(s.name)}</div>
      ${s.lastMessage ? `<div class="session-item-preview">${escapeHtml(s.lastMessage)}</div>` : ''}
      <div class="session-item-meta">
        <span>${s.messageCount} msgs</span>
        ${s.workingDir ? `<span class="session-item-dir">${s.workingDir.split('/').pop()}</span>` : ''}
        <span>${formatTime(s.lastActivity)}</span>
      </div>
    </div>`;
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = sessions.map(s => renderSessionItem(s, false)).join('');
}

function renderArchiveList(sessions) {
  const countEl = document.getElementById('archive-count');
  const listEl = document.getElementById('archive-list');
  countEl.textContent = sessions.length;
  listEl.innerHTML = sessions.length
    ? sessions.map(s => renderSessionItem(s, true)).join('')
    : '<div class="archive-empty">No archived sessions</div>';
}

function toggleArchiveSection() {
  const listEl = document.getElementById('archive-list');
  const chevron = document.querySelector('.archive-chevron');
  const isOpen = listEl.style.display !== 'none';
  listEl.style.display = isOpen ? 'none' : 'block';
  chevron.classList.toggle('expanded', !isOpen);
}

async function archiveSessionItem(id) {
  await fetch(`/api/sessions/${id}/archive`, { method: 'POST' });
  if (currentSessionId === id) {
    currentSessionId = null;
    chatTitle.textContent = 'Claude Chat Bridge';
    currentWorkingDir = '';
    welcomeEl.style.display = 'flex';
    inputArea.style.display = 'none';
    document.querySelector('.dir-picker-wrapper').style.display = 'none';
    clearMessages();
  }
  loadSessions();
}

async function unarchiveSessionItem(id) {
  await fetch(`/api/sessions/${id}/unarchive`, { method: 'POST' });
  loadSessions();
}

// Rename via header title click
function renameCurrentSession() {
  if (!currentSessionId) return;
  startEditing(currentSessionId, chatTitle);
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
      await fetch(`/api/sessions/${id}`, {
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

async function createNewSession() {
  if (!selectedNewChatDir) return;
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: selectedNewChatDir }),
    });
    const session = await res.json();
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    currentWorkingDir = session.workingDir || '';
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    document.querySelector('.dir-picker-wrapper').style.display = '';
    clearMessages();
    loadSessions();
    // Reset sidebar dir picker for next time
    selectedNewChatDir = '';
    sidebarDirBtn.classList.remove('selected');
    sidebarDirBtn.title = '';
    newChatBtn.disabled = true;
    if (sidebar.classList.contains('open')) toggleSidebar();

    // Auto-send /work or /personal based on active mode tab
    const modeCommand = currentMode === 'personal' ? '/personal' : '/work';
    messageInput.value = modeCommand;
    sendMessage();
  } catch (err) {
    console.error('Failed to create session:', err);
  }
}

async function switchSession(id) {
  // Save current input draft before switching
  if (currentSessionId) {
    sessionInputDrafts.set(currentSessionId, messageInput.value);
  }
  currentSessionId = id;
  // Restore target session's draft
  messageInput.value = sessionInputDrafts.get(id) || '';
  messageInput.style.height = 'auto';
  const res = await fetch(`/api/sessions/${id}`);
  const session = await res.json();
  chatTitle.textContent = session.name;
  currentWorkingDir = session.workingDir || '';
  welcomeEl.style.display = 'none';
  inputArea.style.display = 'block';
  document.querySelector('.dir-picker-wrapper').style.display = '';
  restoreMessages(id);
  loadSessions();
  // Show correct button state for this session
  if (streamingSessions.has(id)) {
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'flex';
    messageInput.placeholder = 'Type a message to queue...';
  } else {
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
    messageInput.placeholder = 'Type a message...';
  }
  if (sidebar.classList.contains('open')) toggleSidebar();
  messageInput.focus();
}

async function deleteSessionItem(id) {
  if (!confirm('Delete this session?')) return;
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  sessionInputDrafts.delete(id);
  if (currentSessionId === id) {
    currentSessionId = null;
    chatTitle.textContent = 'Claude Chat Bridge';
    currentWorkingDir = '';
    welcomeEl.style.display = 'flex';
    inputArea.style.display = 'none';
    document.querySelector('.dir-picker-wrapper').style.display = 'none';
    clearMessages();
  }
  loadSessions();
}

// Messages
function clearMessages() {
  messagesEl.innerHTML = '';
}

function addUserMessage(text) {
  const el = document.createElement('div');
  el.className = 'message message-user';
  el.textContent = text;
  ensureCopyButton(el);
  messagesEl.appendChild(el);
  scrollToBottom();
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

function createAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'message message-assistant';
  messagesEl.appendChild(el);
  return el;
}

function ensureCopyButton(el) {
  let btn = el.querySelector('.btn-copy-msg');
  if (!btn) {
    btn = document.createElement('button');
    btn.className = 'btn-copy-msg';
    btn.title = 'Copy message';
    btn.onclick = () => {
      const text = el.innerText;
      const doCopy = navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(text)
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
        btn.classList.add('copied');
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        }, 1500);
      });
    };
  }
  if (!btn.classList.contains('copied')) {
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  }
  el.appendChild(btn);
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

function addToolIndicator(name, id, input) {
  const group = getOrCreateToolGroup();
  const list = group.querySelector('.tool-group-list');
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.id = `tool-${id}`;

  let detailHtml = '';
  if (input) {
    detailHtml = renderToolInput(name, input);
  }

  item.innerHTML = `
    <div class="tool-item-header" onclick="event.stopPropagation(); this.parentElement.classList.toggle('tool-detail-open')">
      <span class="tool-item-icon">&#9881;</span>
      <span class="tool-item-name">${escapeHtml(name)}</span>
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

function addToolOutput(toolUseId, content) {
  const item = document.getElementById(`tool-${toolUseId}`);
  if (!item) return;

  const outputHtml = renderToolOutput(content);
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

function scrollToBottom() {
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
    const res = await fetch(`/api/chat/${sessionId}/reconnect`);
    if (!res.ok) return false;

    // Don't clear messages — preserve what's already visible on screen.
    // The buffer replay will rebuild from the full stream, so we clear
    // only the in-progress elements (thinking, typing) and let replay rebuild.
    // Only manipulate DOM if we're still viewing this session
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
      console.log(`[SSE:reconnect] ${type}`, typeof data === 'string' ? data.substring(0, 80) : '', `reconnTextLen=${reconnectedText.length}`);
      // Don't update DOM if user switched to a different session
      if (currentSessionId !== sessionId) {
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
            console.log('[SSE:reconnect] creating new assistantEl');
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

// Cancel active stream
async function cancelStream() {
  if (!currentSessionId || !streamingSessions.has(currentSessionId)) return;
  // Clear any queued message — user cancelled, so don't auto-send
  if (pendingMessages.has(currentSessionId)) {
    pendingMessages.delete(currentSessionId);
    addInfoMessage('Queued message cancelled');
  }
  try {
    await fetch(`/api/chat/${currentSessionId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to cancel:', err);
  }
}

// Send message with streaming SSE parsing
// skipRender: when true, skips rendering user message (already shown from queue)
async function sendMessage(skipRender = false) {
  const text = messageInput.value.trim();
  if ((!text && pendingAttachments.length === 0) || !currentSessionId) return;

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
    addUserMessage(text);
    if (queued.attachments) {
      addInfoMessage(`${queued.attachments.length} image(s) attached`);
    }
    addInfoMessage('⏳ Message queued — will send when current response completes');
    scrollToBottom();
    return;
  }

  const streamSessionId = currentSessionId;
  streamingSessions.add(streamSessionId);
  sendBtn.style.display = 'flex';
  stopBtn.style.display = 'flex';
  messageInput.placeholder = 'Type a message to queue...';
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

  let assistantEl = null;
  let currentText = '';
  let thinkingEl = null;
  let lastEventType = '';
  let streamCompleted = false;
  let everRenderedText = false; // Track if ANY text was rendered (survives tool_use clears)
  let slowApiTimer = null;

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

  // Debug logging for missing output diagnosis
  const sseLog = [];
  window._lastSSELog = sseLog;
  function logSSE(action, detail) {
    const entry = { t: Date.now(), action, detail, textLen: currentText.length, hasEl: !!assistantEl };
    sseLog.push(entry);
    console.log(`[SSE] ${action}`, detail, `textLen=${currentText.length} hasEl=${!!assistantEl}`);
  }

  function processEvent(type, data) {
    // Don't update DOM if user switched to a different session
    if (currentSessionId !== streamSessionId) {
      logSSE('SESSION_MISMATCH', { type, current: currentSessionId, stream: streamSessionId });
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
          deactivateToolGroup();
          if (!assistantEl) {
            logSSE('text:create_el', { dataLen: typeof data === 'string' ? data.length : 0 });
            assistantEl = createAssistantMessage();
            addTypingIndicator(); // keep dots at bottom
          }
          currentText += data;
          everRenderedText = true;
          assistantEl.innerHTML = renderMarkdown(currentText);
          ensureCopyButton(assistantEl);
          scrollToBottom();
          break;

        case 'thinking':
          clearSlowApi();
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
          logSSE('tool_use:clear', { hadText: currentText.length, hadEl: !!assistantEl, data: typeof data === 'string' ? data.substring(0, 100) : '' });
          if (assistantEl && currentText) {
            assistantEl = null;
            currentText = '';
          }
          try {
            const tool = JSON.parse(data);
            addToolIndicator(tool.name, tool.id, tool.input);
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
          } catch {}
          break;

        case 'tool_result':
          try {
            const result = JSON.parse(data);
            addToolOutput(result.tool_use_id, result.content);
          } catch {}
          break;

        case 'permission_request':
          console.log('[permission] received event, data type:', typeof data, 'data:', data);
          removeTypingIndicator();
          try {
            const perm = typeof data === 'string' ? JSON.parse(data) : data;
            console.log('[permission] parsed:', perm);
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
          addUsageInfo(data);
          streamCompleted = true;
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

    // Stream ended without a 'done' event — connection likely dropped (common on mobile)
    if (!streamCompleted) {
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
    if (currentSessionId === streamSessionId) removeTypingIndicator();
    // Only attempt reconnect if we were genuinely mid-stream (not completed/cancelled)
    if (!streamCompleted && err.name !== 'AbortError') {
      logSSE('reconnect:after_error', { error: err.message });
      const reconnected = await attemptReconnect(streamSessionId, processEvent);
      logSSE('reconnect:error_result', { reconnected, textLen: currentText.length });
      if (!reconnected && currentSessionId === streamSessionId && !everRenderedText) {
        logSSE('reconnect:error_fallback_restore', { everRenderedText });
        await new Promise(r => setTimeout(r, 2000));
        await restoreMessages(streamSessionId);
      }
    } else if (!streamCompleted && currentSessionId === streamSessionId) {
      const errEl = document.createElement('div');
      errEl.className = 'message message-error';
      errEl.textContent = err.message;
      messagesEl.appendChild(errEl);
      scrollToBottom();
    }
  } finally {
    clearSlowApi();
    streamingSessions.delete(streamSessionId);
    // Only update DOM if we're still viewing the session that finished
    if (currentSessionId === streamSessionId) {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
      messageInput.placeholder = 'Type a message...';
      removeTypingIndicator();
      deactivateToolGroup();
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
      // Populate input and send — skipRender since user message was shown at queue time
      messageInput.value = queued.text;
      if (queued.attachments) {
        pendingAttachments.push(...queued.attachments);
      }
      sendMessage(true);
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
  // Match absolute vault paths (allow spaces/commas in filenames, non-greedy to .md)
  html = html.replace(/(\/[^<"']*?\/Documents\/Obsidian\/(?:AI-Work|AI-Home|Work|Home)\/[^<"']*?\.md)/g, (match) => {
    const short = match.split('/').slice(-3).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${match.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${short}</span>`;
  });
  // Match relative vault paths (e.g. "Work/Meeting Notes/file.md", "AI-Work/topics/file.md")
  // Allow spaces/commas in paths, non-greedy match to .md
  // Lookbehind excludes paths inside href/onclick attributes (preceded by / " ')
  html = html.replace(/(?<![/"'])(?<!\w)((?:AI-Work|AI-Home|Work|Home)\/[^<"'\n]*?\.md)/g, (match) => {
    const resolved = resolveVaultPath(match);
    const short = match.split('/').slice(-3).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${short}</span>`;
  });
  // Match vault-internal relative paths (e.g. "sessions/2026-03/file.md", "topics/file.md")
  // These lack a vault name prefix — resolve using first configured vault
  html = html.replace(/(?<![/"'\w])((?:sessions|topics|projects|decisions)\/[^<"'\n]*?\.md)/g, (match) => {
    const vaultPrefix = VAULT_NAMES.length ? `${VAULT_NAMES[0]}/` : '';
    const resolved = resolveVaultPath(vaultPrefix + match);
    const short = match.split('/').slice(-2).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${short}</span>`;
  });
  // Match labeled slug references from session close output (e.g. "Topics Updated slug-name")
  // Handles comma-separated slugs and wraps each one as a link
  html = html.replace(/(Topics (?:Updated|Created)|Projects Linked|Decisions (?:Made|Recorded))\s+([\w][\w ,-]*[\w-])/g, (match, label, slugsPart) => {
    const dirMap = { 'Topics Updated': 'topics', 'Topics Created': 'topics', 'Projects Linked': 'projects', 'Decisions Made': 'decisions', 'Decisions Recorded': 'decisions' };
    const dir = dirMap[label];
    if (!dir || !VAULT_NAMES.length) return match;
    const slugs = slugsPart.split(/,\s*/);
    const linked = slugs.map(slug => {
      slug = slug.trim();
      if (!slug) return '';
      const filePath = `${VAULT_NAMES[0]}/${dir}/${slug}.md`;
      const resolved = resolveVaultPath(filePath);
      return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${slug}</span>`;
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

// Poll for pending permission requests (fallback when SSE event doesn't arrive)
function startPermissionPolling() {
  if (permissionPollInterval) return;
  console.log('[permission-poll] started');
  permissionPollInterval = setInterval(async () => {
    if (pendingPermissionId || !currentSessionId) return;
    try {
      const res = await fetch(`/api/permissions/pending/${currentSessionId}`);
      if (!res.ok) {
        console.warn('[permission-poll] HTTP error:', res.status);
        return;
      }
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
    const res = await fetch('/api/permissions/respond', {
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
    if (!res.ok) {
      console.error(`[permission] respond FAILED: ${res.status}`, body);
    }
  } catch (err) {
    console.error('[permission] respond fetch error:', err);
  }

  pendingPermissionId = null;

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
    if (!kbTreeLoaded) loadKbTree();
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
}

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    settingsData = await res.json();
  } catch {
    settingsData = { primaryVaults: [], secondaryVaults: [], security: { accessControl: { allowedPaths: [] } } };
  }
  renderSettingsContent();
}

async function saveSettings() {
  try {
    await fetch('/api/settings', {
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

function setHideTools(hide) {
  localStorage.setItem('chat-bridge-hide-tools', hide ? 'true' : 'false');
  document.documentElement.setAttribute('data-hide-tools', hide ? 'true' : 'false');
  // Re-render to update active states
  const container = document.getElementById('settings-content');
  if (container) renderAppearanceSettings(container);
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

  try {
    const res = await fetch('/api/settings/version');
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
      await fetch('/api/settings/version/acknowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: currentVersion }),
      });
    } catch {}
  }
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
    const res = await fetch('/api/settings/update-cli', { method: 'POST' });
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
      if (data.updated) {
        versionData = null;
        const container = document.getElementById('settings-content');
        renderUpdatesSettings(container);
      }
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
    const res = await fetch('/api/settings/git-pull', { method: 'POST' });
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
      const res = await fetch('/api/settings/bridge-paths');
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
  const stringFields = ['workingDir', 'claudePath', 'mcpConfigPath'];
  for (const key of stringFields) {
    const el = document.getElementById(`bridge-path-${key}`);
    if (el) updates[key] = el.value.trim();
  }
  try {
    const res = await fetch('/api/settings/bridge-paths', {
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
    const res = await fetch('/api/settings/config-path', {
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
let kbTreeLoaded = false;
const kbExpandedDirs = new Set();
const kbTreeCache = new Map(); // path -> entries
let kbSearchTimer = null;
let kbAutosaveTimer = null;
let kbBookmarks = JSON.parse(localStorage.getItem('kb-bookmarks') || '[]'); // [{path, name}]
let kbShowingBookmarks = false;
let kbShowingRecent = false;
let kbTemplatesCache = null;  // null = not fetched, [] = no templates

// KB search: debounced input handler
document.addEventListener('DOMContentLoaded', () => {
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
    const res = await fetch(`/api/vault/kb/search?q=${encodeURIComponent(query)}`);
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
let VAULT_PATH_RE = null;
let VAULT_NAMES_RE = null;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function loadBridgePaths() {
  try {
    // Derive vault info from MCP config (Vault Setup)
    const res = await fetch('/api/settings');
    const data = await res.json();
    const allVaults = [...(data.primaryVaults || []), ...(data.secondaryVaults || [])];
    VAULT_NAMES = allVaults.map(v => v.name);
    OBSIDIAN_ROOT = allVaults.length ? allVaults[0].path.replace(/\/[^/]+$/, '') : '';
    if (VAULT_NAMES.length && OBSIDIAN_ROOT) {
      const namesPattern = VAULT_NAMES.map(escapeRegex).join('|');
      VAULT_PATH_RE = new RegExp(escapeRegex(OBSIDIAN_ROOT) + '/(' + namesPattern + ')/');
      VAULT_NAMES_RE = new RegExp(`^(?:${namesPattern})\\/`);
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
  switchView('kb');
  loadKbFile(resolveVaultPath(filePath));
}

function renderVaultFileLabel(filePath) {
  const shortPath = filePath.split('/').slice(-2).join('/');
  const resolved = resolveVaultPath(filePath);
  return `<div class="tool-file-label tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(shortPath)}</div>`;
}

function linkifyVaultPaths(escapedText) {
  // Match absolute vault file paths in already-escaped tool output (allow spaces/commas)
  escapedText = escapedText.replace(/(\/[^&lt;\n]*?\/Documents\/Obsidian\/(?:AI-Work|AI-Home|Work|Home)\/[^&lt;\n]*?\.md)/g, (match) => {
    const realPath = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const short = realPath.split('/').slice(-3).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${realPath.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(short)}</span>`;
  });
  // Match relative vault paths (e.g. "Work/Meeting Notes/file.md")
  escapedText = escapedText.replace(/(?<![\/\w])((?:AI-Work|AI-Home|Work|Home)\/[^&lt;\n]*?\.md)/g, (match) => {
    const realPath = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const resolved = resolveVaultPath(realPath);
    const short = realPath.split('/').slice(-3).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(short)}</span>`;
  });
  // Match vault-internal relative paths (e.g. "sessions/2026-03/file.md", "topics/file.md")
  escapedText = escapedText.replace(/(?<![\/\w])((?:sessions|topics|projects|decisions)\/[^&lt;\n]*?\.md)/g, (match) => {
    const realPath = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    const vaultPrefix = VAULT_NAMES.length ? `${VAULT_NAMES[0]}/` : '';
    const resolved = resolveVaultPath(vaultPrefix + realPath);
    const short = realPath.split('/').slice(-2).join('/');
    return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(short)}</span>`;
  });
  // Match labeled slug references (e.g. "Topics Updated slug-name")
  escapedText = escapedText.replace(/(Topics (?:Updated|Created)|Projects Linked|Decisions (?:Made|Recorded))\s+([\w][\w ,-]*[\w-])/g, (match, label, slugsPart) => {
    const dirMap = { 'Topics Updated': 'topics', 'Topics Created': 'topics', 'Projects Linked': 'projects', 'Decisions Made': 'decisions', 'Decisions Recorded': 'decisions' };
    const dir = dirMap[label];
    if (!dir || !VAULT_NAMES.length) return match;
    const slugs = slugsPart.split(/,\s*/);
    const linked = slugs.map(slug => {
      slug = slug.trim();
      if (!slug) return '';
      const filePath = `${VAULT_NAMES[0]}/${dir}/${slug}.md`;
      const resolved = resolveVaultPath(filePath);
      return `<span class="tool-file-link" onclick="navigateToKbFile('${resolved.replace(/'/g, "\\'")}')" title="Open in Knowledge Base">${escapeHtml(slug)}</span>`;
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
    const res = await fetch(url);
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
    const res = await fetch('/api/vault/kb/move', {
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
    const res = await fetch(`/api/vault/kb/file?path=${encodeURIComponent(filePath)}`, { method: 'DELETE' });
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
      localStorage.setItem('kb-bookmarks', JSON.stringify(kbBookmarks));
      if (kbShowingBookmarks) renderKbBookmarksList();
    }
    // Refresh tree
    kbTreeCache.delete(dirPath);
    await reloadKbSubtree(dirPath);
  } catch (err) {
    console.error('Failed to delete KB file:', err);
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
    const res = await fetch('/api/vault/kb/file', {
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
      const res = await fetch('/api/vault/kb/move', {
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
        localStorage.setItem('kb-bookmarks', JSON.stringify(kbBookmarks));
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

    // New file button (visible on hover)
    const addBtn = document.createElement('button');
    addBtn.className = 'kb-tree-add-btn';
    addBtn.title = 'Create file';
    addBtn.innerHTML = '+';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      createKbFile(entry.path, children, chevron, depth);
    });
    item.appendChild(addBtn);

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

    // Delete button (visible on hover)
    const delBtn = document.createElement('button');
    delBtn.className = 'kb-tree-del-btn';
    delBtn.title = 'Delete file';
    delBtn.innerHTML = '&times;';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dirPath = entry.path.substring(0, entry.path.lastIndexOf('/'));
      deleteKbFile(entry.path, dirPath);
    });
    item.appendChild(delBtn);

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
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: selectedNewChatDir || currentWorkingDir }),
    });
    const session = await res.json();

    // Switch to chat view
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    currentWorkingDir = session.workingDir || '';
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    document.querySelector('.dir-picker-wrapper').style.display = '';
    clearMessages();
    loadSessions();
    switchView('sessions');

    // Auto-send /work or /personal based on current mode
    const modeCommand = currentMode === 'personal' ? '/personal' : '/work';
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
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir }),
    });
    const session = await res.json();

    // Switch to chat view
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    currentWorkingDir = session.workingDir || '';
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    document.querySelector('.dir-picker-wrapper').style.display = '';
    clearMessages();
    loadSessions();
    switchView('sessions');

    // Auto-send /work or /personal based on current mode
    const modeCommand = currentMode === 'personal' ? '/personal' : '/work';
    messageInput.value = modeCommand;
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
    activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

async function loadKbFile(filePath, { skipHistory = false } = {}) {
  try {
    const res = await fetch(`/api/vault/kb/file?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) return;

    // Push current file to history before navigating away
    if (!skipHistory && kbCurrentFile) {
      kbHistory.push(kbCurrentFile.path);
    }

    kbCurrentFile = data;
    kbIsEditing = false;
    kbShowingDiff = false;

    // Clean up Toast UI Editor if switching files while editing
    if (kbEditor) {
      kbEditor.destroy();
      kbEditor = null;
      kbFrontmatter = '';
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
    backBtn.style.display = kbHistory.length > 0 ? '' : 'none';
    const hasAnyButton = kbHistory.length > 0 || sessionMeta || topicMeta;
    actionBar.style.display = hasAnyButton ? '' : 'none';

    // Render markdown
    document.getElementById('kb-rendered').innerHTML = renderKbMarkdown(data.content);

    // Expand tree path to this file and highlight it
    await expandKbPathTo(filePath);

    // Close sidebar on mobile
    if (sidebar.classList.contains('open')) toggleSidebar();

    // Scroll to top
    document.getElementById('kb-content').scrollTop = 0;
  } catch (err) {
    console.error('Failed to load KB file:', err);
  }
}

function navigateKbBack() {
  if (kbHistory.length === 0) return;
  const previousPath = kbHistory.pop();
  loadKbFile(previousPath, { skipHistory: true });
}

// ---- KB Bookmarks ----

function saveKbBookmarks() {
  localStorage.setItem('kb-bookmarks', JSON.stringify(kbBookmarks));
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
  } else {
    bookmarksList.style.display = 'none';
    tree.style.display = '';
    toolbarBtn.classList.remove('active');
  }
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
  if (kbShowingBookmarks) {
    kbShowingBookmarks = false;
    document.getElementById('kb-bookmarks-list').style.display = 'none';
    document.getElementById('kb-toolbar-bookmarks').classList.remove('active');
    tree.style.display = '';
  }
  if (kbShowingRecent) {
    kbShowingRecent = false;
    document.getElementById('kb-recent-list').style.display = 'none';
    document.getElementById('kb-toolbar-recent').classList.remove('active');
    tree.style.display = '';
  }
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
  } else {
    recentList.style.display = 'none';
    tree.style.display = '';
    toolbarBtn.classList.remove('active');
  }
}

async function loadKbRecentFiles() {
  const container = document.getElementById('kb-recent-list');
  container.innerHTML = '<div class="kb-bookmarks-empty">Loading…</div>';

  try {
    const resp = await fetch('/api/vault/kb/recent');
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
  try {
    const res = await fetch(`/api/vault/kb/resolve-link?name=${encodeURIComponent(target)}&context=${encodeURIComponent(contextPath)}`);
    const data = await res.json();
    if (data.path) {
      loadKbFile(data.path);
    } else {
      // Brief visual feedback for broken link
      el.style.color = 'var(--error)';
      setTimeout(() => { el.style.color = ''; }, 1500);
    }
  } catch (err) {
    console.error('Failed to resolve wiki-link:', err);
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
    const res = await fetch(`/api/vault/kb/diff?path=${encodeURIComponent(kbCurrentFile.path)}`);
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

  // Strip YAML frontmatter — editor can't handle it, we'll restore on save
  kbFrontmatter = '';
  let editContent = kbCurrentFile.content;
  const fmMatch = editContent.match(/^---\r?\n([\s\S]*?\r?\n)---\r?\n?/);
  if (fmMatch) {
    kbFrontmatter = fmMatch[0];
    editContent = editContent.slice(fmMatch[0].length);
  }

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
}

function cancelKbEdit() {
  clearTimeout(kbAutosaveTimer);
  kbIsEditing = false;
  kbFrontmatter = '';

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
    const res = await fetch('/api/vault/kb/templates');
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
    const res = await fetch('/api/vault/kb/file?path=' + encodeURIComponent(template.path));
    const data = await res.json();
    if (data.content == null) return;

    // Separate frontmatter from template body
    let body = data.content;
    const fmMatch = body.match(/^---\r?\n([\s\S]*?\r?\n)---\r?\n?/);
    if (fmMatch) {
      kbFrontmatter = fmMatch[0];
      body = body.slice(fmMatch[0].length);
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
  const content = kbFrontmatter + editorContent;
  // Skip save if content hasn't actually changed
  if (content === kbCurrentFile.content) return;
  try {
    showKbSaveStatus('Saving...');
    const res = await fetch('/api/vault/kb/file', {
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
  const content = kbFrontmatter + editorContent;
  try {
    const res = await fetch('/api/vault/kb/file', {
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
