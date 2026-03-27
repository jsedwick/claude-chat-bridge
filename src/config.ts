import path from 'path';
import fs from 'fs';

export type Mode = 'work' | 'personal';

// Bridge-level config file (stores mcpConfigPath override)
const bridgeConfigPath = path.join(__dirname, '..', 'bridge-config.json');

function loadBridgeConfig(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveBridgeConfig(data: Record<string, string>): void {
  fs.writeFileSync(bridgeConfigPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

const bridgeOverrides = loadBridgeConfig();

export const config = {
  port: parseInt(process.env.CHAT_BRIDGE_PORT || '3456', 10),
  certsPath: process.env.CHAT_BRIDGE_CERTS_PATH || path.join(__dirname, '..', 'certs'),
  workingDir: process.env.CHAT_BRIDGE_WORKING_DIR || '/Users/jsedwick',
  maxConcurrentSessions: 3,
  sessionStorePath: path.join(__dirname, '..', 'chat-sessions.json'),
  claudePath: process.env.CHAT_BRIDGE_CLAUDE_PATH || '/Users/jsedwick/.local/bin/claude',
  permissionMode: 'bypassPermissions' as const,
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  autoArchiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  autoDeleteAfterMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  defaultMode: 'work' as Mode,
  // Path to .obsidian-mcp.json — resolved from: env var > bridge-config.json > hardcoded default
  mcpConfigPath: process.env.CHAT_BRIDGE_MCP_CONFIG
    || bridgeOverrides.mcpConfigPath
    || '/Users/jsedwick/Projects/obsidian-mcp-server/.obsidian-mcp.json',
  // Directories to scan for project subdirectories
  projectScanDirs: ['/Users/jsedwick/Projects'],
  // Obsidian vault paths per mode
  vaultPaths: {
    work: '/Users/jsedwick/Documents/Obsidian/AI-Work',
    personal: '/Users/jsedwick/Documents/Obsidian/AI-Home',
  } as Record<Mode, string>,
};

export function getMcpConfigPath(): string {
  return config.mcpConfigPath;
}

export function setMcpConfigPath(newPath: string): void {
  config.mcpConfigPath = newPath;
  const overrides = loadBridgeConfig();
  overrides.mcpConfigPath = newPath;
  saveBridgeConfig(overrides);
}

// Global mutable mode state
let currentMode: Mode = config.defaultMode;

export function getMode(): Mode {
  return currentMode;
}

export function setMode(mode: Mode): void {
  currentMode = mode;
}
