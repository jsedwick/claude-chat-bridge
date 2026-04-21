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

// Expand ~ to the current user's home directory
function expandTilde(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(home, p.slice(1));
  }
  return p;
}

export const config = {
  port: parseInt(process.env.CHAT_BRIDGE_PORT || '3456', 10),
  certsPath: process.env.CHAT_BRIDGE_CERTS_PATH || path.join(__dirname, '..', 'certs'),
  workingDir: expandTilde(resolve('CHAT_BRIDGE_WORKING_DIR', 'workingDir', home)),
  maxConcurrentSessions: 3,
  sessionStorePath: path.join(__dirname, '..', 'chat-sessions.json'),
  claudePath: expandTilde(resolve('CHAT_BRIDGE_CLAUDE_PATH', 'claudePath', path.join(home, '.local', 'bin', 'claude'))),
  permissionMode: 'bypassPermissions' as const,
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  autoArchiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  autoDeleteAfterMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxTrashedSessions: 10, // FIFO cap on trash
  defaultMode: 'work' as Mode,
  // Path to .obsidian-mcp.json — resolved from: env var > bridge-config.json > default
  mcpConfigPath: expandTilde(resolve('CHAT_BRIDGE_MCP_CONFIG', 'mcpConfigPath',
    path.join(home, 'Projects', 'obsidian-mcp-server', '.obsidian-mcp.json'))),
  pluginDir: expandTilde(resolve('CHAT_BRIDGE_PLUGIN_DIR', 'pluginDir',
    path.join(home, 'Projects', 'obsidian-claude-plugin'))),
};

// Derive vault configuration from MCP config (Vault Setup)
function readMcpVaults(): Array<{ name: string; path: string; mode: string }> {
  try {
    const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8');
    const data = JSON.parse(raw);
    const vaults = [...(data.primaryVaults || []), ...(data.secondaryVaults || [])];
    return vaults.map(v => ({ ...v, path: expandTilde(v.path) }));
  } catch {
    return [];
  }
}

export function getObsidianRoot(): string {
  const vaults = readMcpVaults();
  if (vaults.length === 0) return path.join(home, 'Documents', 'Obsidian');
  // Common parent directory of all vault paths
  return path.dirname(vaults[0].path);
}

export function getObsidianVaults(): string[] {
  const vaults = readMcpVaults();
  if (vaults.length === 0) return [];
  return vaults.map(v => path.basename(v.path));
}

export function getVaultPath(mode: Mode): string {
  try {
    const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8');
    const data = JSON.parse(raw);
    const primary = (data.primaryVaults || []).find((v: any) => v.mode === mode);
    if (primary) return expandTilde(primary.path);
  } catch {}
  return path.join(home, 'Documents', 'Obsidian', mode === 'work' ? 'AI-Work' : 'AI-Home');
}

export function getMcpConfigPath(): string {
  return config.mcpConfigPath;
}

export function getAllowedPaths(): string[] {
  try {
    const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8');
    const data = JSON.parse(raw);
    const paths: string[] = data?.security?.accessControl?.allowedPaths || [];
    return paths.map(expandTilde);
  } catch {
    return [];
  }
}

export function getActiveModeVaults(mode: Mode): Array<{ name: string; path: string }> {
  const vaults = readMcpVaults();
  return vaults
    .filter(v => v.mode === mode)
    .map(v => ({ name: v.name, path: v.path }));
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
    pluginDir: config.pluginDir,
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
