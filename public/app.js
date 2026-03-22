// State
let currentSessionId = null;
const streamingSessions = new Set(); // track which sessions are actively streaming
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
const dirSelect = document.getElementById('dir-select');

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
          welcomeEl.style.display = 'flex';
          inputArea.style.display = 'none';
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
async function loadDirs() {
  try {
    const res = await fetch('/api/sessions/dirs/available');
    const dirs = await res.json();
    dirSelect.innerHTML = dirs.map((d, i) =>
      `<option value="${d.path}"${i === 0 ? ' selected' : ''}>${d.label}</option>`
    ).join('');
  } catch {}
}

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
    const res = await fetch(`/api/sessions?mode=${currentMode}`);
    const sessions = await res.json();
    renderSessionList(sessions);
  } catch (err) {
    console.error('Failed to load sessions:', err);
  }
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = sessions.map(s => `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}"
         onclick="switchSession('${s.id}')">
      <button class="session-item-delete" onclick="event.stopPropagation(); deleteSessionItem('${s.id}')">&times;</button>
      <div class="session-item-name" ondblclick="event.stopPropagation(); renameSession('${s.id}', this)">${escapeHtml(s.name)}</div>
      ${s.lastMessage ? `<div class="session-item-preview">${escapeHtml(s.lastMessage)}</div>` : ''}
      <div class="session-item-meta">
        <span>${s.messageCount} msgs</span>
        ${s.workingDir ? `<span class="session-item-dir">${s.workingDir.split('/').pop()}</span>` : ''}
        <span>${formatTime(s.lastActivity)}</span>
      </div>
    </div>
  `).join('');
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
  try {
    const selectedDir = dirSelect.value || undefined;
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: selectedDir }),
    });
    const session = await res.json();
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    clearMessages();
    resetTokenCounter();
    loadSessions();
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
  currentSessionId = id;
  const res = await fetch(`/api/sessions/${id}`);
  const session = await res.json();
  chatTitle.textContent = session.name;
  welcomeEl.style.display = 'none';
  inputArea.style.display = 'block';
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
  if (currentSessionId === id) {
    currentSessionId = null;
    chatTitle.textContent = 'Claude Chat Bridge';
    welcomeEl.style.display = 'flex';
    inputArea.style.display = 'none';
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

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
}

// Reconnect to an active stream
async function attemptReconnect(sessionId, processEvent) {
  addInfoMessage('Connection lost, reconnecting...');
  try {
    const res = await fetch(`/api/chat/${sessionId}/reconnect`);
    if (!res.ok) return false;

    // Clear current assistant content and re-render from buffer replay
    clearMessages();
    await restoreMessages(sessionId);
    addTypingIndicator();

    let reconnectedAssistantEl = null;
    let reconnectedText = '';

    function reconnectProcessor(type, data) {
      if (type === 'text') {
        removeTypingIndicator();
        if (!reconnectedAssistantEl) {
          reconnectedAssistantEl = createAssistantMessage();
        }
        reconnectedText += data;
        reconnectedAssistantEl.innerHTML = renderMarkdown(reconnectedText);
        scrollToBottom();
      } else {
        processEvent(type, data);
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
    switch (type) {
      case 'init':
        // Don't remove typing indicator — keep it visible until content arrives
        break;

      case 'text':
        removeTypingIndicator();
        if (!assistantEl) {
          assistantEl = createAssistantMessage();
        }
        currentText += data;
        assistantEl.innerHTML = renderMarkdown(currentText);
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
        const errEl = document.createElement('div');
        errEl.className = 'message message-error';
        errEl.textContent = data;
        messagesEl.appendChild(errEl);
        scrollToBottom();
        break;

      case 'done':
        removeTypingIndicator();
        addUsageInfo(data);
        streamCompleted = true;
        scrollToBottom();
        break;
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
    if (!streamCompleted && currentSessionId) {
      const reconnected = await attemptReconnect(currentSessionId, processEvent);
      if (!reconnected) {
        // Reload saved messages as fallback — server saves text on process exit
        await restoreMessages(currentSessionId);
      }
    }
  } catch (err) {
    removeTypingIndicator();
    // Only attempt reconnect if we were genuinely mid-stream (not completed/cancelled)
    if (currentSessionId && !streamCompleted && err.name !== 'AbortError') {
      const reconnected = await attemptReconnect(currentSessionId, processEvent);
      if (!reconnected) {
        // Fallback: reload saved messages after a brief delay for server to finish saving
        await new Promise(r => setTimeout(r, 2000));
        await restoreMessages(currentSessionId);
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
    // Only update UI buttons if we're still viewing the session that finished
    if (currentSessionId === streamSessionId) {
      sendBtn.style.display = 'flex';
      stopBtn.style.display = 'none';
    }
    removeTypingIndicator();
    if (thinkingEl) {
      const label = thinkingEl.childNodes[0];
      if (label && label.nodeType === Node.TEXT_NODE) {
        label.textContent = 'Thought process (tap to expand)';
      }
    }
    loadSessions();
    // Refresh header title (may have been auto-named)
    try {
      const s = await fetch(`/api/sessions/${currentSessionId}`).then(r => r.json());
      chatTitle.textContent = s.name;
    } catch {}
    messageInput.focus();
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
