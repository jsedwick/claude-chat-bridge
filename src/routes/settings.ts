import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { config, getMcpConfigPath, setMcpConfigPath, getBridgePaths, setBridgeConfigValue, loadBridgeConfig, saveBridgeConfig } from '../config';

const home = os.homedir();

// Expand ~ to the current user's home directory in vault paths
function expandVaultPaths(vaults: any[]): any[] {
  if (!Array.isArray(vaults)) return vaults;
  return vaults.map(v => ({
    ...v,
    path: typeof v.path === 'string' && (v.path.startsWith('~/') || v.path === '~')
      ? home + v.path.slice(1)
      : v.path,
  }));
}

// Collapse absolute home directory back to ~ for portable storage
function collapseVaultPaths(vaults: any[]): any[] {
  if (!Array.isArray(vaults)) return vaults;
  return vaults.map(v => ({
    ...v,
    path: typeof v.path === 'string' && v.path.startsWith(home + '/')
      ? '~' + v.path.slice(home.length)
      : v.path,
  }));
}

function collapsePaths(paths: string[]): string[] {
  if (!Array.isArray(paths)) return paths;
  return paths.map(p =>
    typeof p === 'string' && p.startsWith(home + '/') ? '~' + p.slice(home.length) : p
  );
}

const execFileAsync = promisify(execFile);

// Extract semver from CLI output like "2.1.87 (Claude Code)" → "2.1.87"
function extractVersion(raw: string): string {
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : raw.trim();
}

const router = Router();

// GET /api/settings — read .obsidian-mcp.json + config path status
router.get('/', (_req: Request, res: Response) => {
  const configPath = getMcpConfigPath();
  const configExists = fs.existsSync(configPath);

  if (!configExists) {
    res.json({
      _configPath: configPath,
      _configFound: false,
      primaryVaults: [],
      secondaryVaults: [],
      security: { accessControl: { allowedPaths: [] } },
    });
    return;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(raw);
    data._configPath = configPath;
    data._configFound = true;
    if (data.primaryVaults) data.primaryVaults = expandVaultPaths(data.primaryVaults);
    if (data.secondaryVaults) data.secondaryVaults = expandVaultPaths(data.secondaryVaults);
    if (data.security?.accessControl?.allowedPaths) {
      data.security.accessControl.allowedPaths = data.security.accessControl.allowedPaths.map((p: string) =>
        p.startsWith('~/') || p === '~' ? home + p.slice(1) : p
      );
    }
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to read config: ' + err.message });
  }
});

// PUT /api/settings — write .obsidian-mcp.json
router.put('/', (req: Request, res: Response) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    res.status(400).json({ error: 'Invalid config data' });
    return;
  }
  // Strip internal fields and collapse expanded paths back to ~ before writing
  const { _configPath, _configFound, ...writeData } = data;
  if (writeData.primaryVaults) writeData.primaryVaults = collapseVaultPaths(writeData.primaryVaults);
  if (writeData.secondaryVaults) writeData.secondaryVaults = collapseVaultPaths(writeData.secondaryVaults);
  if (writeData.security?.accessControl?.allowedPaths) {
    writeData.security.accessControl.allowedPaths = collapsePaths(writeData.security.accessControl.allowedPaths);
  }
  try {
    fs.writeFileSync(getMcpConfigPath(), JSON.stringify(writeData, null, 2) + '\n', 'utf-8');
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to write config: ' + err.message });
  }
});

// GET /api/settings/config-path — get current MCP config file path
router.get('/config-path', (_req: Request, res: Response) => {
  const configPath = getMcpConfigPath();
  res.json({
    path: configPath,
    exists: fs.existsSync(configPath),
  });
});

// PUT /api/settings/config-path — set MCP config file path
router.put('/config-path', (req: Request, res: Response) => {
  const { path: newPath } = req.body || {};
  if (!newPath || typeof newPath !== 'string') {
    res.status(400).json({ error: 'Path is required' });
    return;
  }
  const exists = fs.existsSync(newPath);
  setMcpConfigPath(newPath);
  res.json({ path: newPath, exists });
});

// GET /api/settings/bridge-paths — get all bridge-configurable paths
router.get('/bridge-paths', (_req: Request, res: Response) => {
  res.json(getBridgePaths());
});

// PUT /api/settings/bridge-paths — update one or more bridge-config paths
router.put('/bridge-paths', (req: Request, res: Response) => {
  const updates = req.body;
  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ error: 'Invalid data' });
    return;
  }
  const allowedKeys = ['workingDir', 'claudePath', 'mcpConfigPath'];
  for (const [key, value] of Object.entries(updates)) {
    if (!allowedKeys.includes(key)) continue;
    setBridgeConfigValue(key, value);
    // Expand ~ for live config so paths resolve correctly at runtime
    const expanded = typeof value === 'string' && (value.startsWith('~/') || value === '~')
      ? home + value.slice(1)
      : value;
    (config as any)[key] = expanded;
  }
  res.json(getBridgePaths());
});

// GET /api/settings/version — get current + latest Claude Code CLI version
router.get('/version', async (_req: Request, res: Response) => {
  const claudePath = config.claudePath;
  const bridgeConfig = loadBridgeConfig();

  let currentVersion: string | null = null;
  let latestVersion: string | null = null;

  // Get installed version
  try {
    const { stdout } = await execFileAsync(claudePath, ['--version'], { timeout: 10000 });
    currentVersion = extractVersion(stdout);
  } catch {
    // CLI not found or errored — try bare 'claude' in case it's on PATH
    try {
      const { stdout } = await execFileAsync('claude', ['--version'], { timeout: 10000 });
      currentVersion = extractVersion(stdout);
    } catch {
      // Can't determine current version
    }
  }

  // Get latest published version from npm
  try {
    const { stdout } = await execFileAsync('npm', ['info', '@anthropic-ai/claude-code', 'version'], { timeout: 15000 });
    latestVersion = extractVersion(stdout);
  } catch {
    // npm not available or network error
  }

  const updateAvailable = currentVersion && latestVersion
    ? currentVersion !== latestVersion
    : null;

  // Check if version changed since last seen
  const lastSeenVersion = bridgeConfig.lastSeenVersion || null;
  const versionChanged = currentVersion && lastSeenVersion
    ? currentVersion !== lastSeenVersion
    : false;

  res.json({
    currentVersion,
    latestVersion,
    updateAvailable,
    lastSeenVersion,
    versionChanged,
  });
});

// POST /api/settings/git-pull — run git pull and npm run build on both project directories
router.post('/git-pull', async (_req: Request, res: Response) => {
  const bridgeDir = path.resolve(__dirname, '..', '..');
  const mcpDir = path.dirname(config.mcpConfigPath);

  const projects = [
    { name: 'claude-chat-bridge', dir: bridgeDir },
    { name: 'obsidian-mcp-server', dir: mcpDir },
  ];

  const results = await Promise.all(projects.map(async ({ name, dir }) => {
    // Step 1: git pull
    let pullOutput = '';
    try {
      const { stdout, stderr } = await execFileAsync('git', ['pull'], { cwd: dir, timeout: 30000 });
      pullOutput = (stdout + stderr).trim();
    } catch (err: any) {
      const output = ((err.stdout || '') + (err.stderr || err.message || 'Unknown error')).trim();
      return { name, path: dir, success: false, pullOutput: output, buildOutput: '', pulled: false, built: false };
    }

    // Step 2: npm run build (skip if already up to date)
    const alreadyUpToDate = pullOutput.includes('Already up to date');
    if (alreadyUpToDate) {
      return { name, path: dir, success: true, pullOutput, buildOutput: '', pulled: true, built: false };
    }

    try {
      const { stdout, stderr } = await execFileAsync('npm', ['run', 'build'], { cwd: dir, timeout: 60000 });
      const buildOutput = (stdout + stderr).trim();
      return { name, path: dir, success: true, pullOutput, buildOutput, pulled: true, built: true };
    } catch (err: any) {
      const output = ((err.stdout || '') + (err.stderr || err.message || 'Unknown error')).trim();
      return { name, path: dir, success: false, pullOutput, buildOutput: output, pulled: true, built: false };
    }
  }));

  res.json({ results });
});

// POST /api/settings/update-cli — update Claude Code CLI via npm
router.post('/update-cli', async (_req: Request, res: Response) => {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['update', '-g', '@anthropic-ai/claude-code'], { timeout: 120000 });
    const output = (stdout + stderr).trim();
    const updated = !output.includes('up to date') || output.includes('added') || output.includes('changed');
    res.json({ success: true, updated, output });
  } catch (err: any) {
    const output = ((err.stdout || '') + (err.stderr || err.message || 'Unknown error')).trim();
    res.json({ success: false, updated: false, output });
  }
});

// POST /api/settings/restart — restart the server via launchctl
router.post('/restart', (_req: Request, res: Response) => {
  const uid = process.getuid?.() ?? 501;
  const label = 'com.jsedwick.claude-chat-bridge';
  res.json({ restarting: true });
  // Delay kill so the response can be sent
  setTimeout(() => {
    execFile('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`], (err) => {
      if (err) {
        // If launchctl fails, fall back to process.exit so launchd restarts us
        process.exit(0);
      }
    });
  }, 500);
});

// POST /api/settings/version/acknowledge — mark current version as seen
router.post('/version/acknowledge', async (req: Request, res: Response) => {
  const { version } = req.body || {};
  if (!version || typeof version !== 'string') {
    res.status(400).json({ error: 'Version is required' });
    return;
  }
  const bridgeConfig = loadBridgeConfig();
  bridgeConfig.lastSeenVersion = version;
  saveBridgeConfig(bridgeConfig);
  res.json({ acknowledged: version });
});

export default router;
