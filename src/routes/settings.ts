import { Router, Request, Response } from 'express';
import fs from 'fs';
import { config, getMcpConfigPath, setMcpConfigPath, getBridgePaths, setBridgeConfigValue } from '../config';

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

export default router;
