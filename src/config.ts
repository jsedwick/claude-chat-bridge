import path from 'path';
import fs from 'fs';
import os from 'os';

export type Mode = 'work' | 'personal';

// Bridge-level config file (stores path overrides and other bridge settings)
const bridgeConfigPath = path.join(__dirname, '..', 'bridge-config.json');

function loadBridgeConfig(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(bridgeConfigPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveBridgeConfig(data: Record<string, any>): void {
  fs.writeFileSync(bridgeConfigPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

export { loadBridgeConfig, saveBridgeConfig, bridgeConfigPath };

const bridgeOverrides = loadBridgeConfig();

// Helper: resolve a config value from env var > bridge-config > default
function resolve(envKey: string, bridgeKey: string, fallback: string): string {
  return process.env[envKey] || bridgeOverrides[bridgeKey] || fallback;
}

const home = os.homedir();

export const config = {
  port: parseInt(process.env.CHAT_BRIDGE_PORT || '3456', 10),
  certsPath: process.env.CHAT_BRIDGE_CERTS_PATH || path.join(__dirname, '..', 'certs'),
  workingDir: resolve('CHAT_BRIDGE_WORKING_DIR', 'workingDir', home),
  maxConcurrentSessions: 3,
  sessionStorePath: path.join(__dirname, '..', 'chat-sessions.json'),
  claudePath: resolve('CHAT_BRIDGE_CLAUDE_PATH', 'claudePath', path.join(home, '.local', 'bin', 'claude')),
  permissionMode: 'bypassPermissions' as const,
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  autoArchiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  autoDeleteAfterMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  defaultMode: 'work' as Mode,
  // Path to .obsidian-mcp.json — resolved from: env var > bridge-config.json > default
  mcpConfigPath: resolve('CHAT_BRIDGE_MCP_CONFIG', 'mcpConfigPath',
    path.join(home, 'Projects', 'obsidian-mcp-server', '.obsidian-mcp.json')),
  // Directories to scan for project subdirectories
  projectScanDirs: (process.env.CHAT_BRIDGE_PROJECT_SCAN_DIRS?.split(':')
    || bridgeOverrides.projectScanDirs
    || [path.join(home, 'Projects')]) as string[],
  // Obsidian vault paths per mode
  vaultPaths: (bridgeOverrides.vaultPaths || {
    work: path.join(home, 'Documents', 'Obsidian', 'AI-Work'),
    personal: path.join(home, 'Documents', 'Obsidian', 'AI-Home'),
  }) as Record<Mode, string>,
  // Obsidian root and all vault names (for KB browser)
  obsidianRoot: resolve('CHAT_BRIDGE_OBSIDIAN_ROOT', 'obsidianRoot',
    path.join(home, 'Documents', 'Obsidian')),
  obsidianVaults: (bridgeOverrides.obsidianVaults
    || ['AI-Work', 'AI-Home', 'Work', 'Home']) as string[],
};

export function getMcpConfigPath(): string {
  return config.mcpConfigPath;
}

export function setMcpConfigPath(newPath: string): void {
  config.mcpConfigPath = newPath;
  setBridgeConfigValue('mcpConfigPath', newPath);
}

// Generic setter: update a single key in bridge-config.json and the live config
export function setBridgeConfigValue(key: string, value: any): void {
  const overrides = loadBridgeConfig();
  overrides[key] = value;
  saveBridgeConfig(overrides);
}

// Get all bridge-configurable paths (for Settings UI)
export function getBridgePaths(): Record<string, any> {
  return {
    workingDir: config.workingDir,
    claudePath: config.claudePath,
    mcpConfigPath: config.mcpConfigPath,
    projectScanDirs: config.projectScanDirs,
    obsidianRoot: config.obsidianRoot,
    obsidianVaults: config.obsidianVaults,
    vaultPaths: config.vaultPaths,
  };
}

// Global mutable mode state
let currentMode: Mode = config.defaultMode;

export function getMode(): Mode {
  return currentMode;
}

export function setMode(mode: Mode): void {
  currentMode = mode;
}
