import { Router, Request, Response } from 'express';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { config, getMcpConfigPath, setMcpConfigPath, getBridgePaths, setBridgeConfigValue, loadBridgeConfig, saveBridgeConfig } from '../config';

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
  // Strip internal fields before writing
  const { _configPath, _configFound, ...writeData } = data;
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
    (config as any)[key] = value;
  }
  res.json(getBridgePaths());
});

// GET /api/settings/version — get current + latest Claude Code CLI version
router.get('/version', async (_req: Request, res: Response) => {
  const claudePath = config.claudePath.replace(/^~/, process.env.HOME || '');
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
