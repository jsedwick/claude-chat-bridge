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
  // Write to a temp file in the same directory, then rename — atomic on POSIX,
  // so a crash mid-write can't leave a half-written bridge-config.json.
  const tmp = `${bridgeConfigPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, bridgeConfigPath);
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
  // bypassPermissions is universally available; auto requires org-level opt-in.
  permissionMode: resolve('CHAT_BRIDGE_PERMISSION_MODE', 'permissionMode', 'bypassPermissions'),
  sessionTimeoutMs: 30 * 60 * 1000, // 30 minutes
  autoArchiveAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  autoDeleteAfterMs: 30 * 24 * 60 * 60 * 1000, // 30 days
  maxTrashedSessions: 10, // FIFO cap on session trash
  maxTrashedKbItems: 20, // FIFO cap on KB trash per vault
  // Path to .obsidian-mcp.json — resolved from: env var > bridge-config.json > default
  mcpConfigPath: expandTilde(resolve('CHAT_BRIDGE_MCP_CONFIG', 'mcpConfigPath',
    path.join(home, 'Projects', 'obsidian-mcp-server', '.obsidian-mcp.json'))),
  pluginDir: expandTilde(resolve('CHAT_BRIDGE_PLUGIN_DIR', 'pluginDir',
    path.join(home, 'Projects', 'obsidian-claude-plugin'))),
  // launchd service label — used by /api/settings/restart and the bridge-restart-watch monitor.
  // Default derives from the running user so two installs on the same Mac don't collide.
  serviceLabel: resolve('CHAT_BRIDGE_SERVICE_LABEL', 'serviceLabel',
    `com.${os.userInfo().username}.claude-chat-bridge`),
  // Web Push (VAPID). Keys live in bridge-config.json (gitignored) or env vars;
  // empty when unset — the push endpoints and notifier then no-op.
  vapidPublicKey: resolve('CHAT_BRIDGE_VAPID_PUBLIC', 'vapidPublicKey', ''),
  vapidPrivateKey: resolve('CHAT_BRIDGE_VAPID_PRIVATE', 'vapidPrivateKey', ''),
  vapidSubject: resolve('CHAT_BRIDGE_VAPID_SUBJECT', 'vapidSubject', 'mailto:admin@localhost'),
  // Where browser push subscriptions are persisted (mirrors sessionStorePath).
  pushStorePath: path.join(__dirname, '..', 'push-subscriptions.json'),
};

// Fail loud at startup if mcpConfigPath does not resolve to a readable file.
// Without it, downstream helpers (getVaultPath, getObsidianRoot, etc.) silently
// degrade to wrong-data fallbacks instead of surfacing the misconfiguration.
if (!fs.existsSync(config.mcpConfigPath)) {
  throw new Error(
    `Bridge config error: mcpConfigPath does not exist at ${config.mcpConfigPath}.\n` +
    `Set via CHAT_BRIDGE_MCP_CONFIG env var or "mcpConfigPath" in bridge-config.json.`
  );
}

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
  const raw = fs.readFileSync(config.mcpConfigPath, 'utf-8');
  const data = JSON.parse(raw);
  const primary = (data.primaryVaults || []).find((v: any) => v.mode === mode);
  if (!primary) {
    throw new Error(
      `No primaryVaults entry for mode "${mode}" in ${config.mcpConfigPath}. ` +
      `Add a vault with this mode to .obsidian-mcp.json.`
    );
  }
  return expandTilde(primary.path);
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

export function getVaultModeForPath(absPath: string): Mode | null {
  const vaults = readMcpVaults();
  for (const v of vaults) {
    if (absPath === v.path || absPath.startsWith(v.path + path.sep)) {
      return v.mode === 'work' || v.mode === 'personal' ? v.mode : null;
    }
  }
  return null;
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

// Validate a string is a valid Mode. Returns null if not — callers should 400.
export function parseMode(value: unknown): Mode | null {
  return value === 'work' || value === 'personal' ? value : null;
}
