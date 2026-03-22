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

export function listSessions(): ChatSession[] {
  return sessions.sort((a, b) =>
    new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
  );
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

export function listSessionsByMode(mode: string): ChatSession[] {
  return sessions
    .filter(s => (s.mode || 'work') === mode)
    .sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
}

export function updateSession(id: string, updates: Partial<ChatSession>): ChatSession | undefined {
  const session = sessions.find(s => s.id === id);
  if (!session) return undefined;
  Object.assign(session, updates, { lastActivity: new Date().toISOString() });
  save();
  return session;
}

export function deleteSession(id: string): boolean {
  const idx = sessions.findIndex(s => s.id === id);
  if (idx === -1) return false;
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
