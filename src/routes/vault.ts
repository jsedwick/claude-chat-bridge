import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getMode, getObsidianRoot, getObsidianVaults, getVaultPath } from '../config';

const router = Router();

// List available workflows for the current mode's vault
router.get('/workflows', (_req: Request, res: Response) => {
  const vaultPath = getVaultPath(getMode());
  const workflowsDir = path.join(vaultPath, 'workflows');

  try {
    const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
    const workflows = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => {
        const slug = e.name.replace(/\.md$/, '');
        // Read description from frontmatter if available
        let description = '';
        try {
          const content = fs.readFileSync(path.join(workflowsDir, e.name), 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const descMatch = fmMatch[1].match(/description:\s*(.+)/);
            if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, '').trim();
          }
        } catch {}
        return { slug, description };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));

    res.json(workflows);
  } catch {
    res.json([]);
  }
});

// List active persistent issues for the current mode's vault
router.get('/issues', (_req: Request, res: Response) => {
  const vaultPath = getVaultPath(getMode());
  const issuesDir = path.join(vaultPath, 'persistent-issues');

  try {
    const entries = fs.readdirSync(issuesDir, { withFileTypes: true });
    const issues = entries
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .map(e => {
        const slug = e.name.replace(/\.md$/, '');
        let priority = 'medium';
        let status = 'active';
        try {
          const content = fs.readFileSync(path.join(issuesDir, e.name), 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (fmMatch) {
            const prioMatch = fmMatch[1].match(/priority:\s*["']?(\w+)["']?/);
            if (prioMatch) priority = prioMatch[1];
            const statusMatch = fmMatch[1].match(/status:\s*["']?(\w+)["']?/);
            if (statusMatch) status = statusMatch[1];
          }
        } catch {}
        return { slug, priority, status };
      })
      .filter(i => i.status === 'active')
      .sort((a, b) => a.slug.localeCompare(b.slug));

    res.json(issues);
  } catch {
    res.json([]);
  }
});

// List recent vault sessions grouped by working directory
interface VaultSession {
  sessionId: string;
  name: string;
  date: string;
  workingDir: string;
  filePath: string;
}

function scanVaultSessions(vaultPath: string): VaultSession[] {
  const sessionsDir = path.join(vaultPath, 'sessions');
  const results: VaultSession[] = [];

  try {
    // Read month directories, sorted descending (most recent first)
    const months = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
      .map(e => e.name)
      .sort((a, b) => b.localeCompare(a));

    // Scan up to 3 most recent months for performance
    for (const month of months.slice(0, 3)) {
      const monthPath = path.join(sessionsDir, month);
      const files = fs.readdirSync(monthPath)
        .filter(f => f.endsWith('.md'))
        .sort((a, b) => b.localeCompare(a)); // newest first by filename

      for (const file of files) {
        try {
          const filePath = path.join(monthPath, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!fmMatch) continue;

          const fm = fmMatch[1];
          const sessionIdMatch = fm.match(/session_id:\s*["']?([^"'\n]+)["']?/);
          const dateMatch = fm.match(/date:\s*["']?([^"'\n]+)["']?/);
          const wdMatch = fm.match(/working_directory:\s*["']?([^"'\n]+)["']?/);

          if (!sessionIdMatch) continue;

          const sessionId = sessionIdMatch[1].trim();
          // Derive display name from session_id slug (after the timestamp prefix)
          const slugMatch = sessionId.match(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_(.+)$/);
          const name = slugMatch ? slugMatch[1].replace(/-/g, ' ') : sessionId;

          results.push({
            sessionId,
            name,
            date: dateMatch ? dateMatch[1].trim() : month,
            workingDir: wdMatch ? wdMatch[1].trim() : '',
            filePath,
          });
        } catch {}
      }
    }
  } catch {}

  return results;
}

router.get('/sessions', (req: Request, res: Response) => {
  const currentDir = (req.query.currentDir as string) || '';
  const vaultPath = getVaultPath(getMode());
  const sessions = scanVaultSessions(vaultPath);

  // Group by workingDir (skip sessions without one)
  const groups = new Map<string, VaultSession[]>();
  for (const s of sessions) {
    const dir = s.workingDir;
    if (!dir) continue;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(s);
  }

  // Keep top 5 per group (already sorted newest first)
  for (const [dir, list] of groups) {
    groups.set(dir, list.slice(0, 5));
  }

  // Order: current dir first, then by most recent session date
  const sortedDirs = [...groups.keys()].sort((a, b) => {
    if (a === currentDir) return -1;
    if (b === currentDir) return 1;
    const aDate = groups.get(a)![0]?.date || '';
    const bDate = groups.get(b)![0]?.date || '';
    return bDate.localeCompare(aDate);
  });

  // Current dir + 4 more
  const topDirs = sortedDirs.slice(0, 5);

  const result = topDirs.map(dir => ({
    dir,
    dirLabel: path.basename(dir),
    current: dir === currentDir,
    sessions: groups.get(dir)!.map(s => ({
      sessionId: s.sessionId,
      name: s.name,
      date: s.date,
      vaultPath: s.filePath,
    })),
  }));

  res.json({ groups: result });
});

// List recent topics from vault
interface VaultTopic {
  name: string;
  filePath: string;
  modified: number;
  category: string;
}

function scanVaultTopics(vaultPath: string): VaultTopic[] {
  const topicsDir = path.join(vaultPath, 'topics');
  const results: VaultTopic[] = [];

  try {
    const files = fs.readdirSync(topicsDir)
      .filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const filePath = path.join(topicsDir, file);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf-8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        let category = 'topic';
        if (fmMatch) {
          const catMatch = fmMatch[1].match(/category:\s*["']?([^"'\n]+)["']?/);
          if (catMatch) category = catMatch[1].trim();
        }
        results.push({
          name: file.replace(/\.md$/, ''),
          filePath,
          modified: stat.mtimeMs,
          category,
        });
      } catch {}
    }
  } catch {}

  return results;
}

router.get('/topics', (_req: Request, res: Response) => {
  const vaultPath = getVaultPath(getMode());
  const topics = scanVaultTopics(vaultPath);

  // Sort by most recently modified, take top 50
  topics.sort((a, b) => b.modified - a.modified);
  const top = topics.slice(0, 50);

  res.json({
    topics: top.map(t => ({
      name: t.name,
      vaultPath: t.filePath,
      category: t.category,
      modified: new Date(t.modified).toISOString().split('T')[0],
    })),
  });
});

// --- KB Browser endpoints ---

function validateKbPath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const root = getObsidianRoot();
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null;
  }
  return resolved;
}

// List directory contents for KB tree
router.get('/kb/tree', (req: Request, res: Response) => {
  const root = getObsidianRoot();
  const vaultNames = getObsidianVaults();
  const reqPath = (req.query.path as string) || root;
  const resolved = validateKbPath(reqPath);
  if (!resolved) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Not a directory' });
      return;
    }

    const entries = fs.readdirSync(resolved, { withFileTypes: true });

    // At root level, only show configured vaults
    const isRoot = resolved === root;

    const items = entries
      .filter(e => {
        if (e.name.startsWith('.')) return false;
        if (isRoot) return e.isDirectory() && vaultNames.includes(e.name);
        if (e.isFile()) return e.name.endsWith('.md');
        return e.isDirectory();
      })
      .map(e => ({
        name: e.isFile() ? e.name.replace(/\.md$/, '') : e.name,
        path: path.join(resolved, e.name),
        type: e.isDirectory() ? 'directory' as const : 'file' as const,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    const parent = resolved === root ? null : path.dirname(resolved);
    res.json({
      path: resolved,
      name: path.basename(resolved),
      parent,
      entries: items,
    });
  } catch {
    res.status(404).json({ error: 'Directory not found' });
  }
});

// Read a markdown file
router.get('/kb/file', (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }

  const resolved = validateKbPath(filePath);
  if (!resolved || !resolved.endsWith('.md')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  try {
    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({
      path: resolved,
      name: path.basename(resolved, '.md'),
      content,
    });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Write to an existing markdown file
router.put('/kb/file', (req: Request, res: Response) => {
  const { path: filePath, content } = req.body;
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'Path and content required' });
    return;
  }

  const resolved = validateKbPath(filePath);
  if (!resolved || !resolved.endsWith('.md')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File does not exist' });
    return;
  }

  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    // Clear wiki-link cache since file changed
    wikiLinkCache = null;
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Move/rename a file or directory within the vault
router.post('/kb/move', (req: Request, res: Response) => {
  const { source, destination } = req.body;
  if (!source || !destination) {
    res.status(400).json({ error: 'Source and destination required' });
    return;
  }

  const resolvedSrc = validateKbPath(source);
  const resolvedDest = validateKbPath(destination);
  if (!resolvedSrc || !resolvedDest) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (!fs.existsSync(resolvedSrc)) {
    res.status(404).json({ error: 'Source does not exist' });
    return;
  }

  if (fs.existsSync(resolvedDest)) {
    res.status(409).json({ error: 'Destination already exists' });
    return;
  }

  // Ensure destination parent directory exists
  const destDir = path.dirname(resolvedDest);
  if (!fs.existsSync(destDir)) {
    res.status(400).json({ error: 'Destination directory does not exist' });
    return;
  }

  try {
    fs.renameSync(resolvedSrc, resolvedDest);
    wikiLinkCache = null;
    res.json({ success: true, path: resolvedDest });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Wiki-link filename index cache
let wikiLinkCache: Map<string, string> | null = null;

function buildWikiLinkIndex(): Map<string, string> {
  const index = new Map<string, string>();

  function scanDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
          scanDir(fullPath);
        } else if (e.name.endsWith('.md')) {
          const name = e.name.replace(/\.md$/, '').toLowerCase();
          // First match wins — later duplicates don't overwrite
          if (!index.has(name)) {
            index.set(name, fullPath);
          }
        }
      }
    } catch {}
  }

  const root = getObsidianRoot();
  for (const vault of getObsidianVaults()) {
    scanDir(path.join(root, vault));
  }
  return index;
}

// Resolve a wiki-link to a file path
router.get('/kb/resolve-link', (req: Request, res: Response) => {
  const name = (req.query.name as string || '').trim();
  const context = (req.query.context as string) || '';

  if (!name) {
    res.status(400).json({ error: 'Name required' });
    return;
  }

  const target = name.toLowerCase();

  // 1. Check same directory as context file
  if (context) {
    const contextDir = path.dirname(context);
    const sameDirPath = path.join(contextDir, name + '.md');
    const resolved = validateKbPath(sameDirPath);
    if (resolved && fs.existsSync(resolved)) {
      res.json({ path: resolved, name: path.basename(resolved, '.md') });
      return;
    }
  }

  // 2. Search all vaults via cached index
  if (!wikiLinkCache) {
    wikiLinkCache = buildWikiLinkIndex();
  }

  const found = wikiLinkCache.get(target);
  if (found && fs.existsSync(found)) {
    res.json({ path: found, name: path.basename(found, '.md') });
    return;
  }

  res.status(404).json({ error: 'Not found' });
});

export default router;
