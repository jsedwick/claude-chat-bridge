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
