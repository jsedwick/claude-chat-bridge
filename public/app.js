// State
let currentSessionId = null;
const streamingSessions = new Set(); // track which sessions are actively streaming
const sessionInputDrafts = new Map(); // preserve input text per session
const pendingMessages = new Map(); // queued messages per session (sent when stream completes)
let currentMode = 'work';
let pendingPermissionId = null;
let permissionPollInterval = null;

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

    // Reload sidebar with filtered sessions
    loadSessions();
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
async function renderDirBrowser(container, startPath, onSelect) {
  container.innerHTML = '<div class="dir-browser-loading">Loading...</div>';
  container.style.display = 'block';

  try {
    const res = await fetch(`/api/sessions/dirs/browse?path=${encodeURIComponent(startPath)}`);
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
      backBtn.onclick = (e) => { e.stopPropagation(); renderDirBrowser(container, data.parent, onSelect); };
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
        item.onclick = (e) => { e.stopPropagation(); renderDirBrowser(container, child.path, onSelect); };
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
  const startPath = selectedNewChatDir || '/Users';
  renderDirBrowser(sidebarDirPicker, startPath, (dirPath) => {
    sidebarDirPicker.style.display = 'none';
    selectedNewChatDir = dirPath;
    sidebarDirBtn.classList.add('selected');
    sidebarDirBtn.title = dirPath;
    newChatBtn.disabled = false;
  });
}

function toggleDirPicker() {
  if (!currentSessionId) return;
  const isOpen = dirPicker.style.display !== 'none';
  if (isOpen) { dirPicker.style.display = 'none'; return; }
  const startPath = currentWorkingDir || '/Users';
  renderDirBrowser(dirPicker, startPath, async (dirPath) => {
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
  });
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

// Apply saved theme before first paint
(function() {
  const saved = localStorage.getItem('chat-bridge-theme');
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
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
  loadSessions();
  startActiveSessionPolling();
})();

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
  { divider: true },
  { label: 'Workflow', icon: 'play', command: '/workflow', flyout: 'workflows' },
  { label: 'Close Session', icon: 'check-circle', command: '/close' },
  { label: 'Close (No Git)', icon: 'x-circle', command: '/close-no-git' },
  { divider: true },
  { label: 'Sessions', icon: 'list', command: '/sessions' },
  { label: 'Projects', icon: 'folder', command: '/projects' },
  { label: 'Issue', icon: 'alert-triangle', command: '/issue', flyout: 'issues' },
];

const ACTION_ICONS = {
  image: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  'x-circle': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  'alert-triangle': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
};

async function fetchFlyoutData(type) {
  try {
    const res = await fetch(`/api/vault/${type}`);
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

function buildActionMenu() {
  const menu = document.getElementById('action-menu');
  menu.innerHTML = ACTION_MENU_ITEMS.map(item => {
    if (item.divider) return '<div class="action-menu-divider"></div>';
    const iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[item.icon]}</svg>`;
    if (item.action === 'image') {
      return `<button class="action-menu-item" onclick="triggerImageAttach()">${iconSvg}<span>${item.label}</span></button>`;
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
  const items = await fetchFlyoutData(type);

  const flyoutMenu = wrapperEl.querySelector('.flyout-menu');
  const command = wrapperEl.dataset.command;

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
    const file = input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    const diffLines = [];
    if (file) diffLines.push(`@@ ${file} @@`);
    for (const line of (input.old_string || '').split('\n')) {
      diffLines.push(`-${line}`);
    }
    for (const line of (input.content || '').split('\n')) {
      diffLines.push(`+${line}`);
    }
    return `<pre class="tool-diff">${renderDiffBlock(diffLines.join('\n'))}</pre>`;
  }

  // code_file write — show content
  if (name.includes('code_file') && input.operation === 'write' && input.content) {
    const file = input.file_path ? input.file_path.split('/').slice(-2).join('/') : '';
    const lang = (input.file_path || '').split('.').pop() || '';
    return `<div class="tool-file-label">${escapeHtml(file)}</div><pre><code class="language-${lang}">${escapeHtml(input.content)}</code></pre>`;
  }

  // update_document — show content/strategy
  if (name.includes('update_document')) {
    const parts = [];
    if (input.file_path) parts.push(`<div class="tool-file-label">${escapeHtml(input.file_path.split('/').slice(-2).join('/'))}</div>`);
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
  return `<pre><code>${escapeHtml(display)}</code></pre>${truncated ? '<div class="tool-meta">… output truncated</div>' : ''}`;
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
      if (!reconnected && currentSessionId === streamSessionId) {
        // Only restore if we have no visible content — otherwise keep what's on screen
        // rather than replacing with potentially stale server data
        const hasVisibleContent = messagesEl.querySelector('.message-assistant, .tool-group');
        if (!hasVisibleContent) {
          logSSE('reconnect:fallback_restore', {});
          await restoreMessages(streamSessionId);
        } else {
          logSSE('reconnect:keeping_visible_content', { childCount: messagesEl.children.length });
        }
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
      if (!reconnected && currentSessionId === streamSessionId) {
        const hasVisibleContent = messagesEl.querySelector('.message-assistant, .tool-group');
        if (!hasVisibleContent) {
          logSSE('reconnect:error_fallback_restore', {});
          await new Promise(r => setTimeout(r, 2000));
          await restoreMessages(streamSessionId);
        } else {
          logSSE('reconnect:error_keeping_visible_content', { childCount: messagesEl.children.length });
        }
      }
    } else if (!streamCompleted && currentSessionId === streamSessionId) {
      const errEl = document.createElement('div');
      errEl.className = 'message message-error';
      errEl.textContent = err.message;
      messagesEl.appendChild(errEl);
      scrollToBottom();
    }
  } finally {
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
      // Safety net: if NO text was ever rendered but tools were used, restore from server
      // The server may have result_text saved even when text_delta events were lost
      // Don't trigger if text was rendered before tools — currentText being empty just
      // means the last segment was a tool call, not that text was lost
      if (!everRenderedText && messagesEl.querySelector('.tool-group')) {
        logSSE('finally:text_missing_restore', { streamCompleted, everRenderedText });
        await new Promise(r => setTimeout(r, 1500)); // Allow server-side persistence to flush
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
    return html;
  }

  return marked.parse(text);
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
  pendingPermissionId = id;
  document.getElementById('permission-tool-name').textContent = toolName;

  // Format the tool input for display
  let detail = '';
  if (toolName === 'Bash' && toolInput?.command) {
    detail = toolInput.command;
  } else if ((toolName === 'Edit' || toolName === 'Write') && toolInput?.file_path) {
    detail = toolInput.file_path;
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
  currentView = view;
  document.getElementById('sidebar-view-menu').style.display = 'none';
  document.getElementById('sidebar-view-label').textContent = view === 'sessions' ? 'Sessions' : 'Settings';

  // Update dropdown active state
  document.querySelectorAll('.sidebar-view-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.view === view);
  });

  const sessionsView = document.getElementById('sessions-view');
  const settingsView = document.getElementById('settings-view');
  const sessionsToolbar = document.getElementById('sessions-toolbar');
  const chatMain = document.querySelector('.chat-main');
  const settingsPanel = document.getElementById('settings-panel');

  if (view === 'settings') {
    sessionsView.style.display = 'none';
    sessionsToolbar.style.display = 'none';
    settingsView.style.display = '';
    chatMain.style.display = 'none';
    settingsPanel.style.display = 'flex';
    loadSettings();
  } else {
    sessionsView.style.display = '';
    sessionsToolbar.style.display = '';
    settingsView.style.display = 'none';
    chatMain.style.display = '';
    settingsPanel.style.display = 'none';
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

  // Show config path setup if the file wasn't found
  if (!settingsData._configFound) {
    renderConfigPathSetup(container);
    return;
  }

  if (activeSettingsSection === 'appearance') {
    renderAppearanceSettings(container);
  } else if (activeSettingsSection === 'vault-setup') {
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
  `;
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('chat-bridge-theme', theme);
  document.querySelectorAll('.settings-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
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
  const startPath = input.value || '/Users';
  renderDirBrowser(browserEl, startPath, (dirPath) => {
    browserEl.style.display = 'none';
    input.value = dirPath;
  });
}
