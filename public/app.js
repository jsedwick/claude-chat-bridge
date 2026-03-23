// State
let currentSessionId = null;
const streamingSessions = new Set(); // track which sessions are actively streaming
const sessionInputDrafts = new Map(); // preserve input text per session
let currentMode = 'work';
let lastInputTokens = 0;

// Context window limits by model
const MODEL_CONTEXT_LIMITS = {
  opus: 1000000,
  sonnet: 200000,
};

function updateTokenCounter(inputTokens) {
  lastInputTokens = inputTokens;
  const counterEl = document.getElementById('token-counter');
  const countEl = document.getElementById('token-count');
  const limitEl = document.getElementById('token-limit');
  const model = getSelectedModel();
  const limit = MODEL_CONTEXT_LIMITS[model] || 200000;

  countEl.textContent = formatTokenCount(inputTokens);
  limitEl.textContent = formatTokenCount(limit);
  counterEl.style.display = '';

  // Color thresholds
  const ratio = inputTokens / limit;
  counterEl.classList.toggle('warn', ratio >= 0.7 && ratio < 0.9);
  counterEl.classList.toggle('critical', ratio >= 0.9);
}

function resetTokenCounter() {
  lastInputTokens = 0;
  const counterEl = document.getElementById('token-counter');
  counterEl.style.display = 'none';
  counterEl.classList.remove('warn', 'critical');
}

function formatTokenCount(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

// Message history (server-backed)
async function restoreMessages(sessionId) {
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

// Load available working directories
let availableDirs = [];
let currentWorkingDir = '';
const dirPicker = document.getElementById('dir-picker');

async function loadDirs() {
  try {
    const res = await fetch('/api/sessions/dirs/available');
    availableDirs = await res.json();
  } catch {}
}

function toggleSidebarDirPicker() {
  const isOpen = sidebarDirPicker.style.display !== 'none';
  if (isOpen) { sidebarDirPicker.style.display = 'none'; return; }
  sidebarDirPicker.innerHTML = '';
  for (const d of availableDirs) {
    const btn = document.createElement('button');
    btn.className = 'dir-picker-item' + (d.path === selectedNewChatDir ? ' active' : '');
    btn.textContent = d.label;
    btn.onclick = () => selectSidebarDir(d.path);
    sidebarDirPicker.appendChild(btn);
  }
  sidebarDirPicker.style.display = 'block';
}

function selectSidebarDir(dirPath) {
  sidebarDirPicker.style.display = 'none';
  selectedNewChatDir = dirPath;
  sidebarDirBtn.classList.add('selected');
  sidebarDirBtn.title = availableDirs.find(d => d.path === dirPath)?.label || dirPath;
  newChatBtn.disabled = false;
}

function toggleDirPicker() {
  if (!currentSessionId) return;
  const isOpen = dirPicker.style.display !== 'none';
  if (isOpen) { dirPicker.style.display = 'none'; return; }
  dirPicker.innerHTML = '';
  for (const d of availableDirs) {
    const btn = document.createElement('button');
    btn.className = 'dir-picker-item' + (d.path === currentWorkingDir ? ' active' : '');
    btn.textContent = d.label;
    btn.onclick = () => selectDir(d.path);
    dirPicker.appendChild(btn);
  }
  dirPicker.style.display = 'block';
}

async function selectDir(dirPath) {
  dirPicker.style.display = 'none';
  if (!currentSessionId || dirPath === currentWorkingDir) return;
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
  loadDirs();
  loadSessions();
})();

// Sidebar toggle
function toggleSidebar() {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('active');
}

// Action menu commands
const ACTION_MENU_ITEMS = [
  { label: 'Attach Image', icon: 'image', action: 'image' },
  { divider: true },
  { label: 'Workflow', icon: 'play', command: '/workflow' },
  { label: 'Close Session', icon: 'check-circle', command: '/close' },
  { label: 'Close (No Git)', icon: 'x-circle', command: '/close-no-git' },
  { divider: true },
  { label: 'Sessions', icon: 'list', command: '/sessions' },
  { label: 'Projects', icon: 'folder', command: '/projects' },
  { label: 'Issue', icon: 'alert-triangle', command: '/issue' },
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

function buildActionMenu() {
  const menu = document.getElementById('action-menu');
  menu.innerHTML = ACTION_MENU_ITEMS.map(item => {
    if (item.divider) return '<div class="action-menu-divider"></div>';
    const iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ACTION_ICONS[item.icon]}</svg>`;
    if (item.action === 'image') {
      return `<button class="action-menu-item" onclick="triggerImageAttach()">${iconSvg}<span>${item.label}</span></button>`;
    }
    return `<button class="action-menu-item" onclick="fireCommand('${item.command}')">${iconSvg}<span>${item.label}</span></button>`;
  }).join('');
}

function toggleActionMenu() {
  const menu = document.getElementById('action-menu');
  const btn = document.querySelector('.btn-attach');
  const isOpen = menu.style.display !== 'none';
  menu.style.display = isOpen ? 'none' : 'block';
  btn.classList.toggle('active', !isOpen);
}

function closeActionMenu() {
  const menu = document.getElementById('action-menu');
  const btn = document.querySelector('.btn-attach');
  menu.style.display = 'none';
  btn.classList.remove('active');
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
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''} ${isArchived ? 'archived' : ''}"
         onclick="switchSession('${s.id}')">
      ${actions}
      <div class="session-item-name" ondblclick="event.stopPropagation(); renameSession('${s.id}', this)">${escapeHtml(s.name)}</div>
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
    resetTokenCounter();
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
    resetTokenCounter();
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
  resetTokenCounter();
  restoreMessages(id);
  loadSessions();
  // Show correct button state for this session
  if (streamingSessions.has(id)) {
    sendBtn.style.display = 'none';
    stopBtn.style.display = 'flex';
  } else {
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
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
    resetTokenCounter();
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
  const el = document.createElement('div');
  el.className = 'typing-indicator';
  el.id = 'typing-indicator';
  el.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
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
    if (totalInput > 0) {
      updateTokenCounter(totalInput);
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
    removeTypingIndicator();
    const existingThinking = document.getElementById('thinking-current');
    if (existingThinking) existingThinking.remove();

    // Find the last assistant message element to continue appending to it
    let reconnectedAssistantEl = null;
    let reconnectedText = '';
    addTypingIndicator();

    function reconnectProcessor(type, data) {
      try {
        if (type === 'text') {
          removeTypingIndicator();
          if (!reconnectedAssistantEl) {
            reconnectedAssistantEl = createAssistantMessage();
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
    return true;
  } catch {
    return false;
  }
}

// Cancel active stream
async function cancelStream() {
  if (!currentSessionId || !streamingSessions.has(currentSessionId)) return;
  try {
    await fetch(`/api/chat/${currentSessionId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to cancel:', err);
  }
}

// Send message with streaming SSE parsing
async function sendMessage() {
  const text = messageInput.value.trim();
  if ((!text && pendingAttachments.length === 0) || !currentSessionId || streamingSessions.has(currentSessionId)) return;

  const streamSessionId = currentSessionId;
  streamingSessions.add(streamSessionId);
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'flex';
  messageInput.value = '';
  messageInput.style.height = 'auto';

  // Capture attachments before clearing UI
  const messageAttachments = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;

  addUserMessage(text);
  if (messageAttachments) {
    addInfoMessage(`${messageAttachments.length} image(s) attached`);
  }
  clearAttachments();
  addTypingIndicator();

  let assistantEl = null;
  let currentText = '';
  let thinkingEl = null;
  let lastEventType = '';
  let streamCompleted = false;

  function processEvent(type, data) {
    // Don't update DOM if user switched to a different session
    if (currentSessionId !== streamSessionId) return;
    try {
      switch (type) {
        case 'init':
          // Don't remove typing indicator — keep it visible until content arrives
          break;

        case 'text':
          removeTypingIndicator();
          deactivateToolGroup();
          if (!assistantEl) {
            assistantEl = createAssistantMessage();
          }
          currentText += data;
          assistantEl.innerHTML = renderMarkdown(currentText);
          ensureCopyButton(assistantEl);
          scrollToBottom();
          break;

        case 'thinking':
          removeTypingIndicator();
          if (!thinkingEl) {
            thinkingEl = addThinkingIndicator();
          }
          const contentEl = thinkingEl.querySelector('.thinking-content');
          if (contentEl) {
            contentEl.textContent += data;
          }
          break;

        case 'tool_use':
          removeTypingIndicator();
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
          // Results are saved server-side but not displayed (too verbose)
          break;

        case 'permission_request':
          removeTypingIndicator();
          try {
            const perm = JSON.parse(data);
            showPermissionDialog(perm.id, perm.toolName, perm.toolInput);
          } catch {}
          break;

        case 'error':
          removeTypingIndicator();
          deactivateToolGroup();
          const errEl = document.createElement('div');
          errEl.className = 'message message-error';
          errEl.textContent = data;
          messagesEl.appendChild(errEl);
          scrollToBottom();
          break;

        case 'done':
          removeTypingIndicator();
          deactivateToolGroup();
          addUsageInfo(data);
          streamCompleted = true;
          scrollToBottom();
          break;
      }
    } catch (err) {
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

    // Stream ended without a 'done' event — connection likely dropped (common on mobile)
    if (!streamCompleted) {
      const reconnected = await attemptReconnect(streamSessionId, processEvent);
      if (!reconnected && currentSessionId === streamSessionId) {
        // Reload saved messages as fallback — only if still viewing this session
        await restoreMessages(streamSessionId);
      }
    }
  } catch (err) {
    if (currentSessionId === streamSessionId) removeTypingIndicator();
    // Only attempt reconnect if we were genuinely mid-stream (not completed/cancelled)
    if (!streamCompleted && err.name !== 'AbortError') {
      const reconnected = await attemptReconnect(streamSessionId, processEvent);
      if (!reconnected && currentSessionId === streamSessionId) {
        // Fallback: reload saved messages after a brief delay for server to finish saving
        await new Promise(r => setTimeout(r, 2000));
        await restoreMessages(streamSessionId);
      }
    } else if (!streamCompleted) {
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
      removeTypingIndicator();
      if (thinkingEl) {
        const label = thinkingEl.childNodes[0];
        if (label && label.nodeType === Node.TEXT_NODE) {
          label.textContent = 'Thought process (tap to expand)';
        }
      }
      // Refresh header title (may have been auto-named)
      try {
        const s = await fetch(`/api/sessions/${streamSessionId}`).then(r => r.json());
        chatTitle.textContent = s.name;
      } catch {}
      messageInput.focus();
    }
    loadSessions();
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

marked.setDefaults({
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
let pendingPermissionId = null;

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

  if (!pendingPermissionId) return;

  try {
    await fetch('/api/permissions/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: pendingPermissionId,
        decision,
        allowAll: !!allowAll,
      }),
    });
  } catch (err) {
    console.error('Failed to respond to permission:', err);
  }

  pendingPermissionId = null;
  addTypingIndicator();
}
