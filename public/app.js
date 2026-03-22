// State
let currentSessionId = null;
let isStreaming = false;

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
        addToolIndicator(msg.content, 'restored-' + Math.random());
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
const modeToggle = document.getElementById('mode-toggle');

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
    updateModeUI(mode);
  } catch {}
}

async function toggleMode() {
  const current = modeToggle.textContent.trim().toLowerCase();
  const next = current === 'work' ? 'personal' : 'work';
  try {
    const res = await fetch('/api/sessions/mode/current', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    });
    const { mode } = await res.json();
    updateModeUI(mode);
  } catch (err) {
    console.error('Failed to switch mode:', err);
  }
}

function updateModeUI(mode) {
  modeToggle.textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
  modeToggle.className = `mode-toggle mode-${mode}`;
}

// Initialize
loadMode();
loadSessions();

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
    const res = await fetch('/api/sessions');
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
        <span>${s.messageCount} messages</span>
        <span>${formatTime(s.lastActivity)}</span>
      </div>
    </div>
  `).join('');
}

function renameSession(id, el) {
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
      loadSessions();
      return;
    }
    try {
      await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (currentSessionId === id) chatTitle.textContent = name;
      loadSessions();
    } catch (err) {
      console.error('Failed to rename session:', err);
      loadSessions();
    }
  }

  el.onblur = finish;
  el.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { el.contentEditable = false; el.classList.remove('editing'); loadSessions(); }
  };
}

async function createNewSession() {
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const session = await res.json();
    currentSessionId = session.id;
    chatTitle.textContent = session.name;
    welcomeEl.style.display = 'none';
    inputArea.style.display = 'block';
    clearMessages();
    loadSessions();
    if (sidebar.classList.contains('open')) toggleSidebar();
    messageInput.focus();
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
  restoreMessages(id);
  loadSessions();
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

function addToolIndicator(name, id) {
  const group = getOrCreateToolGroup();
  const list = group.querySelector('.tool-group-list');
  const item = document.createElement('div');
  item.className = 'tool-item';
  item.id = `tool-${id}`;
  item.innerHTML = `
    <span class="tool-item-icon">&#9881;</span>
    <span class="tool-item-name">${escapeHtml(name)}</span>
    <div class="tool-item-result"></div>
  `;
  list.appendChild(item);
  updateToolGroupCount(group);
  scrollToBottom();
}

function updateToolResult(toolUseId, content) {
  const items = document.querySelectorAll('.tool-item');
  for (const item of items) {
    const resultEl = item.querySelector('.tool-item-result');
    if (resultEl && !resultEl.textContent) {
      resultEl.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      break;
    }
  }
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
    const parts = [];
    if (info.duration_ms) parts.push(`${(info.duration_ms / 1000).toFixed(1)}s`);
    if (info.input_tokens) parts.push(`${info.input_tokens} in`);
    if (info.output_tokens) parts.push(`${info.output_tokens} out`);
    if (info.cost_usd) parts.push(`$${info.cost_usd.toFixed(4)}`);
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
  if (!currentSessionId || !isStreaming) return;
  try {
    await fetch(`/api/chat/${currentSessionId}/cancel`, { method: 'POST' });
  } catch (err) {
    console.error('Failed to cancel:', err);
  }
}

// Send message with streaming SSE parsing
async function sendMessage() {
  const text = messageInput.value.trim();
  if ((!text && pendingAttachments.length === 0) || !currentSessionId || isStreaming) return;

  isStreaming = true;
  sendBtn.style.display = 'none';
  stopBtn.style.display = 'flex';
  messageInput.value = '';
  messageInput.style.height = 'auto';

  addUserMessage(text);
  if (pendingAttachments.length > 0) {
    addInfoMessage(`${pendingAttachments.length} image(s) attached`);
  }
  clearAttachments();
  addTypingIndicator();

  let assistantEl = null;
  let currentText = '';
  let thinkingEl = null;
  let lastEventType = '';

  function processEvent(type, data) {
    switch (type) {
      case 'init':
        removeTypingIndicator();
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
          saveMessage(currentSessionId, 'assistant', currentText);
          assistantEl = null;
          currentText = '';
        }
        try {
          const tool = JSON.parse(data);
          addToolIndicator(tool.name, tool.id);
        } catch {
          addToolIndicator(data, 'unknown');
        }
        break;

      case 'tool_result':
        try {
          const result = JSON.parse(data);
          updateToolResult(result.tool_use_id, result.content);
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
        attachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || 'Request failed');
    }

    await readSSEStream(res, processEvent);
  } catch (err) {
    removeTypingIndicator();
    // Attempt reconnect if we were mid-stream
    if (currentSessionId && err.name !== 'AbortError') {
      const reconnected = await attemptReconnect(currentSessionId, processEvent);
      if (!reconnected) {
        const errEl = document.createElement('div');
        errEl.className = 'message message-error';
        errEl.textContent = 'Connection lost. Response may be incomplete.';
        messagesEl.appendChild(errEl);
        scrollToBottom();
      }
    } else {
      const errEl = document.createElement('div');
      errEl.className = 'message message-error';
      errEl.textContent = err.message;
      messagesEl.appendChild(errEl);
      scrollToBottom();
    }
  } finally {
    isStreaming = false;
    sendBtn.style.display = 'flex';
    stopBtn.style.display = 'none';
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
function renderMarkdown(text) {
  // Code blocks first (protect from other replacements)
  const codeBlocks = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<div class="code-block-wrapper"><button class="btn-copy-code" onclick="copyCode(this)">Copy</button><pre><code class="language-${lang}">${escapeHtml(code.trim())}</code></pre></div>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);

  // Headers
  text = text.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Lists
  text = text.replace(/^[\s]*[-*] (.+)$/gm, '<li>$1</li>');
  text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  // Clean up nested ul tags
  text = text.replace(/<\/ul>\s*<ul>/g, '');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Paragraphs
  text = text.replace(/\n\n/g, '</p><p>');
  text = text.replace(/\n/g, '<br>');
  if (!text.startsWith('<')) text = '<p>' + text + '</p>';

  // Restore code blocks
  text = text.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, idx) => codeBlocks[parseInt(idx)]);

  return text;
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
