import fs from 'fs';
import crypto from 'crypto';
import { config, getMode } from '../config';
import { ChatSession, ChatMessage } from '../types';

let sessions: ChatSession[] = [];

function load(): void {
  try {
    const data = fs.readFileSync(config.sessionStorePath, 'utf-8');
    sessions = JSON.parse(data);
  } catch {
    sessions = [];
  }
}

function save(): void {
  fs.writeFileSync(config.sessionStorePath, JSON.stringify(sessions, null, 2));
}

// Load on module init
load();

export function listAllSessions(): ChatSession[] {
  return [...sessions];
}

export function listSessions(): ChatSession[] {
  return sessions
    .filter(s => !s.archived)
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

export function getSession(id: string): ChatSession | undefined {
  return sessions.find(s => s.id === id);
}

export function createSession(name?: string, workingDir?: string): ChatSession {
  const session: ChatSession = {
    id: crypto.randomUUID(),
    claudeSessionId: null,
    name: name || `Chat ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`,
    mode: getMode(),
    workingDir: workingDir || undefined,
    created: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastMessage: '',
    messageCount: 0,
    messages: [],
  };
  sessions.push(session);
  save();
  return session;
}

export function listSessionsByMode(mode: string, includeArchived = false): ChatSession[] {
  return sessions
    .filter(s => (s.mode || 'work') === mode && (includeArchived || !s.archived))
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

export function archiveSession(id: string): ChatSession | undefined {
  const session = sessions.find(s => s.id === id);
  if (!session) return undefined;
  session.archived = true;
  save();
  return session;
}

export function unarchiveSession(id: string): ChatSession | undefined {
  const session = sessions.find(s => s.id === id);
  if (!session) return undefined;
  session.archived = false;
  save();
  return session;
}

export function updateSession(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
  const session = sessions.find(s => s.id === id);
  if (!session) return undefined;
  Object.assign(session, updates, { lastActivity: new Date().toISOString() });
  save();
  return session;
}

export function deleteSession(id: string): boolean {
  const session = sessions.find(s => s.id === id);
  if (!session) return false;

  // Re-parent fork children to this session's parent (or make them root)
  const grandparent = session.forkedFrom || undefined;
  for (const s of sessions) {
    if (s.forkedFrom?.sessionId === id) {
      if (grandparent) {
        s.forkedFrom = { ...grandparent };
      } else {
        delete s.forkedFrom;
      }
    }
  }

  const idx = sessions.findIndex(s => s.id === id);
  sessions.splice(idx, 1);
  save();
  return true;
}

export function addMessage(sessionId: string, role: ChatMessage['role'], content: string): void {
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;
  if (!session.messages) session.messages = [];
  session.messages.push({ role, content, timestamp: Date.now() });
  save();
}

export function updateToolMessage(sessionId: string, toolId: string, content: string): boolean {
  const session = sessions.find(s => s.id === sessionId);
  if (!session?.messages) return false;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== 'tool') continue;
    try {
      if (JSON.parse(msg.content).id === toolId) {
        msg.content = content;
        save();
        return true;
      }
    } catch {}
  }
  return false;
}

export function getMessages(sessionId: string): ChatMessage[] {
  const session = sessions.find(s => s.id === sessionId);
  return session?.messages || [];
}

export function getForkDepth(sessionId: string): number {
  let depth = 0;
  let current = sessions.find(s => s.id === sessionId);
  while (current?.forkedFrom?.sessionId) {
    depth++;
    current = sessions.find(s => s.id === current!.forkedFrom!.sessionId);
  }
  return depth;
}

const MAX_FORK_DEPTH = 2;

export function forkSession(sourceId: string, messageIndex: number): ChatSession | undefined | 'max_depth' {
  const source = sessions.find(s => s.id === sourceId);
  if (!source) return undefined;
  if (getForkDepth(sourceId) >= MAX_FORK_DEPTH) return 'max_depth';
  if (!source.messages || messageIndex < 0 || messageIndex >= source.messages.length) return undefined;

  // Copy messages up to and including messageIndex
  // But we need to map DOM message indices (user + assistant only) to the full messages array
  // which also includes tool, tool_result, and usage messages
  let visibleCount = -1;
  let sliceEnd = 0;
  for (let i = 0; i < source.messages.length; i++) {
    const role = source.messages[i].role;
    if (role === 'user' || role === 'assistant') {
      visibleCount++;
    }
    if (visibleCount === messageIndex) {
      // Include all messages up through the next visible message (or end)
      // This captures tool/tool_result messages that belong to this assistant turn
      sliceEnd = i + 1;
      // Continue to grab trailing tool/tool_result/usage for this turn
      for (let j = i + 1; j < source.messages.length; j++) {
        const r = source.messages[j].role;
        if (r === 'user' || r === 'assistant') break;
        sliceEnd = j + 1;
      }
      break;
    }
  }

  if (visibleCount < messageIndex) return undefined;

  const forked: ChatSession = {
    id: crypto.randomUUID(),
    claudeSessionId: null,
    name: `${source.name} (fork)`,
    mode: source.mode,
    workingDir: source.workingDir,
    created: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastMessage: source.lastMessage,
    messageCount: sliceEnd,
    messages: source.messages.slice(0, sliceEnd).map(m => ({ ...m })),
    forkedFrom: {
      sessionId: source.id,
      sessionName: source.name,
      messageIndex,
    },
  };
  sessions.push(forked);
  save();
  return forked;
}

export function getForkPoints(sessionId: string): Record<number, { id: string; name: string }[]> {
  const forks: Record<number, { id: string; name: string }[]> = {};
  for (const s of sessions) {
    if (s.forkedFrom?.sessionId === sessionId && !s.archived) {
      const idx = s.forkedFrom.messageIndex;
      if (!forks[idx]) forks[idx] = [];
      forks[idx].push({ id: s.id, name: s.name });
    }
  }
  return forks;
}
