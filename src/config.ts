import path from 'path';

export type Mode = 'work' | 'personal';

export const config = {
  port: parseInt(process.env.CHAT_BRIDGE_PORT || '3456', 10),
  certsPath: process.env.CHAT_BRIDGE_CERTS_PATH || path.join(__dirname, '..', 'certs'),
  workingDir: process.env.CHAT_BRIDGE_WORKING_DIR || '/Users/jsedwick',
  maxConcurrentSessions: 3,
  sessionStorePath: path.join(__dirname, '..', 'chat-sessions.json'),
  claudePath: process.env.CHAT_BRIDGE_CLAUDE_PATH || '/Users/jsedwick/.local/bin/claude',
  permissionMode: 'bypassPermissions' as const,
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  defaultMode: 'work' as Mode,
  // Directories to scan for project subdirectories
  projectScanDirs: ['/Users/jsedwick/Projects'],
};

// Global mutable mode state
let currentMode: Mode = config.defaultMode;

export function getMode(): Mode {
  return currentMode;
}

export function setMode(mode: Mode): void {
  currentMode = mode;
}
