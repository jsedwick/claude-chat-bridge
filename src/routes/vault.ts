import { Router, Request, Response } from 'express';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { getObsidianRoot, getObsidianVaults, getVaultPath, getActiveModeVaults, getVaultModeForPath, parseMode } from '../config';
import { scanVaultProjects } from '../services/vault-projects';
import { moveToTrash, restoreFromTrash, listTrash, emptyTrash, permanentDelete, isInTrash } from '../services/kb-trash';
import { semanticSearch } from '../services/kb-semantic';

const router = Router();

// List available workflows for the requested mode's vault (supports nested folders as categories)
router.get('/workflows', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }
  const vaultPath = getVaultPath(mode);
  const workflowsDir = path.join(vaultPath, 'workflows');

  try {
    const workflows: { slug: string; description: string; category: string }[] = [];

    function scanDir(dir: string, category: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) {
          scanDir(path.join(dir, e.name), e.name);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          const filename = e.name.replace(/\.md$/, '');
          const slug = category ? `${category}/${filename}` : filename;
          let description = '';
          try {
            const content = fs.readFileSync(path.join(dir, e.name), 'utf-8');
            const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
            if (fmMatch) {
              const descMatch = fmMatch[1].match(/description:\s*(.+)/);
              if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, '').trim();
            }
          } catch {}
          workflows.push({ slug, description, category });
        }
      }
    }

    scanDir(workflowsDir, '');
    workflows.sort((a, b) => a.category.localeCompare(b.category) || a.slug.localeCompare(b.slug));

    res.json(workflows);
  } catch {
    res.json([]);
  }
});

// List active persistent issues for the requested mode's vault
router.get('/issues', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }
  const vaultPath = getVaultPath(mode);
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
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }
  const currentDir = (req.query.currentDir as string) || '';
  const vaultPath = getVaultPath(mode);
  const sessions = scanVaultSessions(vaultPath);

  // Group by workingDir; sessions without one go into a special ungrouped bucket
  const UNGROUPED = '__ungrouped__';
  const groups = new Map<string, VaultSession[]>();
  for (const s of sessions) {
    const dir = s.workingDir || UNGROUPED;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(s);
  }

  // Keep top 5 per group (already sorted newest first)
  for (const [dir, list] of groups) {
    groups.set(dir, list.slice(0, 5));
  }

  // Order: current dir first, ungrouped last, then by most recent session date
  const sortedDirs = [...groups.keys()].sort((a, b) => {
    if (a === currentDir) return -1;
    if (b === currentDir) return 1;
    if (a === UNGROUPED) return 1;
    if (b === UNGROUPED) return -1;
    const aDate = groups.get(a)![0]?.date || '';
    const bDate = groups.get(b)![0]?.date || '';
    return bDate.localeCompare(aDate);
  });

  // Current dir + 4 more
  const topDirs = sortedDirs.slice(0, 5);

  const result = topDirs.map(dir => ({
    dir: dir === UNGROUPED ? '' : dir,
    dirLabel: dir === UNGROUPED ? 'Other Sessions' : path.basename(dir),
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

router.get('/topics', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }
  const vaultPath = getVaultPath(mode);
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

// List vault projects with most-recent-session-in-CWD sort.
// VaultProject + scanVaultProjects live in services/vault-projects.ts so the
// dirs/browse endpoint can compute cross-mode roots without a circular import.
router.get('/projects', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }
  const vaultPath = getVaultPath(mode);
  const projects = scanVaultProjects(vaultPath, mode);

  // Join recent vault sessions to find the most recent session in each project's CWD.
  // Path containment: session.workingDir === project.repoPath or starts with project.repoPath + sep.
  const sessions = scanVaultSessions(vaultPath);
  for (const p of projects) {
    const prefix = p.repoPath.endsWith(path.sep) ? p.repoPath : p.repoPath + path.sep;
    let latest = '';
    for (const s of sessions) {
      if (!s.workingDir) continue;
      const matches = s.workingDir === p.repoPath || s.workingDir.startsWith(prefix);
      if (matches && s.date > latest) latest = s.date;
    }
    if (latest) p.lastSessionDate = latest;
  }

  // Sort: projects with session activity first (most recent), then by frontmatter last_updated DESC.
  projects.sort((a, b) => {
    if (a.lastSessionDate && b.lastSessionDate) return b.lastSessionDate.localeCompare(a.lastSessionDate);
    if (a.lastSessionDate) return -1;
    if (b.lastSessionDate) return 1;
    return b.lastUpdated.localeCompare(a.lastUpdated);
  });

  res.json({
    projects: projects.map(p => ({
      name: p.name,
      slug: p.slug,
      vaultPath: p.filePath,
      repoPath: p.repoPath,
      exists: p.exists,
      lastSessionDate: p.lastSessionDate,
      lastUpdated: p.lastUpdated,
    })),
  });
});

// --- KB Browser endpoints ---

// Display-only exception (decision 003 / local-model-mcp-server). The privacy-gateway
// handoff review queue is surfaced in the KB tree when the directory is present, WITHOUT
// being added to .obsidian-mcp.json. That keeps it human-reviewable here while the
// obsidian-mcp server — and therefore Claude's MCP read tools — stay blind to it. Do NOT
// add Handoff to the MCP vault config to make it visible; that would expose pending
// (scrubbed-but-unapproved) content to Claude and defeat the gateway's approval gate.
const HANDOFF_DIR_NAME = 'Handoff';

// Resolve vault directory names for a ?vaults= filter ('work' | 'personal');
// anything else means all configured vaults.
function vaultNamesForFilter(filter: string | undefined): string[] {
  if (filter === 'work' || filter === 'personal') {
    return getActiveModeVaults(filter).map(v => path.basename(v.path));
  }
  return getObsidianVaults();
}

// Trash roots for a mode. Handoff is not a configured vault, but its KB-deleted
// items are filed under Handoff/archive/.trash/ (see kb-trash.ts) and must show
// up in the trash panel. It is a work-side artifact (privacy-gateway / TDX
// queue), so it is swept alongside the work-mode vaults only.
function trashVaultsForMode(mode: 'work' | 'personal'): string[] {
  const vaults = getActiveModeVaults(mode).map(v => path.basename(v.path));
  if (mode === 'work') vaults.push(HANDOFF_DIR_NAME);
  return vaults;
}

// Recursive search for KB files matching a query.
// scope=name (default): file-name substring match.
// scope=content: full-text literal scan with per-file snippets.
// scope=semantic: cosine similarity over the MCP server's embedding cache.
// vaults=work|personal: narrow to that mode's vaults (default: all).
router.get('/kb/search', async (req: Request, res: Response) => {
  const rawQ = ((req.query.q as string) || '').trim();
  const q = rawQ.toLowerCase();
  const scope = (req.query.scope as string) || 'name';
  if (!q) {
    res.json({ results: [] });
    return;
  }

  const root = getObsidianRoot();
  const vaultNames = vaultNamesForFilter(req.query.vaults as string);

  if (scope === 'semantic') {
    try {
      const { available, results } = await semanticSearch(rawQ, 30, vaultNames);
      res.json({
        embeddingsAvailable: available,
        results: results.map(r => ({
          name: path.basename(r.path, '.md'),
          path: r.path,
          folder: path.relative(root, path.dirname(r.path)),
          score: r.score,
        })),
      });
    } catch (err) {
      res.status(500).json({
        error: 'Semantic search failed: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
    return;
  }

  if (scope === 'content') {
    const MAX_FILES = 50;
    const MAX_SNIPPETS = 3;
    const SNIPPET_LEN = 180;
    const matched: { name: string; path: string; folder: string; matches: number; snippets: string[] }[] = [];

    function extractSnippets(content: string): { count: number; snippets: string[] } {
      const lower = content.toLowerCase();
      let count = 0;
      let idx = lower.indexOf(q);
      while (idx !== -1) {
        count++;
        idx = lower.indexOf(q, idx + q.length);
      }
      const snippets: string[] = [];
      for (const line of content.split('\n')) {
        if (snippets.length >= MAX_SNIPPETS) break;
        let text = line.trim();
        const li = text.toLowerCase().indexOf(q);
        if (li === -1) continue;
        if (text.length > SNIPPET_LEN) {
          // Window the snippet around the first match in the line
          const start = Math.max(0, li - 50);
          text =
            (start > 0 ? '…' : '') +
            text.slice(start, start + SNIPPET_LEN) +
            (start + SNIPPET_LEN < text.length ? '…' : '');
        }
        snippets.push(text);
      }
      return { count, snippets };
    }

    // Enumerate first (fast), then read in concurrent async batches so a
    // content scan never blocks the event loop the terminal WebSockets share.
    const files: string[] = [];
    function collectFiles(dir: string) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          collectFiles(full);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          files.push(full);
        }
      }
    }

    for (const vault of vaultNames) {
      const vaultDir = path.join(root, vault);
      if (fs.existsSync(vaultDir)) {
        collectFiles(vaultDir);
      }
    }

    const BATCH = 64;
    for (let i = 0; i < files.length; i += BATCH) {
      await Promise.all(
        files.slice(i, i + BATCH).map(async full => {
          let content;
          try {
            content = await fs.promises.readFile(full, 'utf-8');
          } catch {
            return;
          }
          if (!content.toLowerCase().includes(q)) return;
          const { count, snippets } = extractSnippets(content);
          matched.push({
            name: path.basename(full, '.md'),
            path: full,
            folder: path.relative(root, path.dirname(full)),
            matches: count,
            snippets,
          });
        })
      );
    }

    matched.sort((a, b) => b.matches - a.matches);
    res.json({ results: matched.slice(0, MAX_FILES) });
    return;
  }

  // scope=name (default): file-name substring match
  const results: { name: string; path: string; folder: string }[] = [];
  const MAX_RESULTS = 100;

  function walk(dir: string) {
    if (results.length >= MAX_RESULTS) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= MAX_RESULTS) return;
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const nameNoExt = e.name.replace(/\.md$/, '');
        if (nameNoExt.toLowerCase().includes(q)) {
          const rel = path.relative(root, dir);
          results.push({ name: nameNoExt, path: full, folder: rel });
        }
      }
    }
  }

  for (const vault of vaultNames) {
    const vaultDir = path.join(root, vault);
    if (fs.existsSync(vaultDir)) {
      walk(vaultDir);
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ results });
});

// 50 most recently modified .md files across all vaults (or one mode's via ?vaults=)
router.get('/kb/recent', (req: Request, res: Response) => {
  const root = getObsidianRoot();
  const vaultNames = vaultNamesForFilter(req.query.vaults as string);
  const files: { name: string; path: string; folder: string; modified: number }[] = [];

  function walk(dir: string) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        try {
          const stat = fs.statSync(full);
          files.push({
            name: e.name.replace(/\.md$/, ''),
            path: full,
            folder: path.relative(root, dir),
            modified: stat.mtimeMs,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  for (const vault of vaultNames) {
    const vaultDir = path.join(root, vault);
    if (fs.existsSync(vaultDir)) {
      walk(vaultDir);
    }
  }

  files.sort((a, b) => b.modified - a.modified);
  const top = files.slice(0, 50);

  res.json({
    results: top.map(f => ({
      name: f.name,
      path: f.path,
      folder: f.folder,
      modified: new Date(f.modified).toISOString(),
    })),
  });
});

function validateKbPath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  const root = getObsidianRoot();
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    return null;
  }
  return resolved;
}

// List directory contents for KB tree (?vaults= narrows the root vault list)
router.get('/kb/tree', (req: Request, res: Response) => {
  const root = getObsidianRoot();
  const vaultNames = vaultNamesForFilter(req.query.vaults as string);
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
        // Handoff is a display-only exception: shown when present, never from the MCP config.
        if (isRoot) return e.isDirectory() && (vaultNames.includes(e.name) || e.name === HANDOFF_DIR_NAME);
        if (e.isFile()) return e.name.endsWith('.md');
        return e.isDirectory();
      })
      .map(e => {
        const fullPath = path.join(resolved, e.name);
        return {
          name: e.isFile() ? e.name.replace(/\.md$/, '') : e.name,
          path: fullPath,
          type: e.isDirectory() ? 'directory' as const : 'file' as const,
          vaultMode: getVaultModeForPath(fullPath),
        };
      })
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
      vaultMode: getVaultModeForPath(resolved),
    });
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Get the latest git diff for a file
router.get('/kb/diff', (req: Request, res: Response) => {
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

  // Find the git repo root for this file
  let repoDir: string;
  try {
    repoDir = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(resolved),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    res.json({ diff: null, message: 'Not a git repository' });
    return;
  }

  const relativePath = path.relative(repoDir, resolved);

  try {
    // Get the diff of the most recent commit that touched this file
    const diff = execFileSync('git', [
      'log', '-1', '-p',
      '--format=commit %H%nAuthor: %an%nDate: %ai%nSubject: %s',
      '--', relativePath,
    ], { cwd: repoDir, encoding: 'utf-8', timeout: 10000 }).trim();

    if (!diff) {
      res.json({ diff: null, message: 'No git history for this file' });
      return;
    }

    res.json({ diff, path: resolved });
  } catch {
    res.json({ diff: null, message: 'Failed to retrieve git diff' });
  }
});

// Revert a file to its content at a specific commit
router.post('/kb/revert', (req: Request, res: Response) => {
  const { path: filePath, commitHash } = req.body;
  if (!filePath || !commitHash) {
    res.status(400).json({ error: 'Path and commitHash required' });
    return;
  }
  if (!/^[a-f0-9]{6,40}$/.test(commitHash)) {
    res.status(400).json({ error: 'Invalid commit hash' });
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

  let repoDir: string;
  try {
    repoDir = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: path.dirname(resolved),
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    res.status(400).json({ error: 'Not a git repository' });
    return;
  }

  const relativePath = path.relative(repoDir, resolved);

  let content: string;
  try {
    content = execFileSync('git', ['show', `${commitHash}:${relativePath}`], {
      cwd: repoDir,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    res.status(404).json({ error: 'File not found in that commit' });
    return;
  }

  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    wikiLinkCache = null;
    linkCandidateCache.clear();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Write to an existing markdown file
router.put('/kb/file', (req: Request, res: Response) => {
  const { path: filePath, content, force } = req.body;
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

  // Catastrophic-shrink guard: refuse to overwrite a substantial file with a
  // near-empty payload. Defends against editor corruption (Toast UI parse
  // failures, autosave wipes) at the trust boundary, regardless of which
  // client sent the write. Bypass with `force: true` in the body for
  // legitimate large deletions.
  if (force !== true) {
    try {
      const currentSize = fs.statSync(resolved).size;
      if (
        currentSize > 500 &&
        content.length < currentSize * 0.5 &&
        currentSize - content.length > 500
      ) {
        res.status(409).json({
          error: 'Refusing to overwrite substantial file with near-empty payload',
          code: 'SHRINK_REJECTED',
          currentSize,
          incomingSize: content.length,
          hint: 'If this shrink is intentional, retry with { force: true } in the request body',
        });
        return;
      }
    } catch {
      // stat failed — let writeFileSync surface the underlying error below
    }
  }

  try {
    fs.writeFileSync(resolved, content, 'utf-8');
    // Clear wiki-link caches since file changed
    wikiLinkCache = null;
    linkCandidateCache.clear();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new markdown file
router.post('/kb/file', (req: Request, res: Response) => {
  const { path: filePath } = req.body;
  if (!filePath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }

  const resolved = validateKbPath(filePath);
  if (!resolved || !resolved.endsWith('.md')) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (fs.existsSync(resolved)) {
    res.status(409).json({ error: 'File already exists' });
    return;
  }

  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    res.status(400).json({ error: 'Directory does not exist' });
    return;
  }

  try {
    fs.writeFileSync(resolved, '', 'utf-8');
    wikiLinkCache = null;
    linkCandidateCache.clear();
    res.json({ success: true, path: resolved, name: path.basename(resolved, '.md') });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a markdown file
// Soft-delete a file (move to vault's archive/.trash/). Permanent deletion of
// trash entries goes through DELETE /kb/trash/entry to avoid orphaning wrappers.
router.delete('/kb/file', (req: Request, res: Response) => {
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

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  if (isInTrash(resolved)) {
    res.status(400).json({ error: 'Use DELETE /kb/trash/entry to permanently delete trash items' });
    return;
  }

  try {
    const { wrapperPath, evicted } = moveToTrash(resolved);
    wikiLinkCache = null;
    linkCandidateCache.clear();
    res.json({ success: true, wrapperPath, evicted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a directory
router.post('/kb/dir', (req: Request, res: Response) => {
  const { path: dirPath } = req.body;
  if (!dirPath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }

  const resolved = validateKbPath(dirPath);
  if (!resolved) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (fs.existsSync(resolved)) {
    res.status(409).json({ error: 'Already exists' });
    return;
  }

  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    res.status(400).json({ error: 'Parent directory does not exist' });
    return;
  }

  try {
    fs.mkdirSync(resolved);
    res.json({ success: true, path: resolved, name: path.basename(resolved) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Soft-delete a directory (move to vault's archive/.trash/). The existing
// ?recursive=true flag is retained as a confirmation gate for non-empty
// directories, matching the pre-trash UX. Permanent deletion of trash entries
// goes through DELETE /kb/trash/entry.
router.delete('/kb/dir', (req: Request, res: Response) => {
  const dirPath = req.query.path as string;
  const recursive = req.query.recursive === 'true';
  if (!dirPath) {
    res.status(400).json({ error: 'Path required' });
    return;
  }

  const resolved = validateKbPath(dirPath);
  if (!resolved) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  if (!fs.existsSync(resolved)) {
    res.status(404).json({ error: 'Directory not found' });
    return;
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    res.status(400).json({ error: 'Not a directory' });
    return;
  }

  if (isInTrash(resolved)) {
    res.status(400).json({ error: 'Use DELETE /kb/trash/entry to permanently delete trash items' });
    return;
  }

  // A single misclick on a vault folder must never wipe the vault — even via
  // soft-delete. Handoff is protected the same way: it is a trashable root but
  // deleting the whole directory (vs. files inside it) must be refused.
  const root = getObsidianRoot();
  const protectedRoots = [...getObsidianVaults(), HANDOFF_DIR_NAME];
  if (resolved === root || protectedRoots.some(v => resolved === path.join(root, v))) {
    res.status(400).json({ error: 'Refusing to delete a vault root' });
    return;
  }

  if (!recursive) {
    const contents = fs.readdirSync(resolved);
    if (contents.length > 0) {
      res.status(400).json({ error: 'Directory is not empty' });
      return;
    }
  }

  try {
    const { wrapperPath, evicted } = moveToTrash(resolved);
    wikiLinkCache = null;
    linkCandidateCache.clear();
    res.json({ success: true, wrapperPath, evicted });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List trashed items. Pass ?mode=work|personal to span all vaults in a mode,
// or ?vault=<name> for a single vault.
router.get('/kb/trash', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  const vault = req.query.vault as string | undefined;

  let vaults: string[];
  if (mode) {
    vaults = trashVaultsForMode(mode);
  } else if (vault) {
    if (!getObsidianVaults().includes(vault) && vault !== HANDOFF_DIR_NAME) {
      res.status(400).json({ error: 'Unknown vault' });
      return;
    }
    vaults = [vault];
  } else {
    res.status(400).json({ error: 'mode or vault query param required' });
    return;
  }

  try {
    const entries = vaults.flatMap(v => listTrash(v));
    entries.sort((a, b) => b.meta.trashedAt.localeCompare(a.meta.trashedAt));
    res.json({ entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a trashed item to its original path. Returns 409 with { conflict: true,
// destination } if a file/folder already occupies the original path. Pass
// conflictStrategy='suffix' to write as "<name> (restored).<ext>", or 'overwrite'
// to move the displaced item to trash before restoring.
router.post('/kb/trash/restore', (req: Request, res: Response) => {
  const { wrapperPath, conflictStrategy } = (req.body || {}) as {
    wrapperPath?: string;
    conflictStrategy?: 'suffix' | 'overwrite';
  };
  if (!wrapperPath) {
    res.status(400).json({ error: 'wrapperPath required' });
    return;
  }
  if (conflictStrategy && conflictStrategy !== 'suffix' && conflictStrategy !== 'overwrite') {
    res.status(400).json({ error: 'Invalid conflictStrategy' });
    return;
  }
  const resolved = validateKbPath(wrapperPath);
  if (!resolved || !isInTrash(resolved)) {
    res.status(400).json({ error: 'Invalid trash path' });
    return;
  }
  try {
    const result = restoreFromTrash(resolved, { conflictStrategy });
    if ('conflict' in result) {
      res.status(409).json({ conflict: true, destination: result.destination });
      return;
    }
    wikiLinkCache = null;
    linkCandidateCache.clear();
    res.json({ success: true, restoredPath: result.restoredPath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently delete a single trash entry (the whole wrapper directory)
router.delete('/kb/trash/entry', (req: Request, res: Response) => {
  const wrapperPath = req.query.wrapperPath as string;
  if (!wrapperPath) {
    res.status(400).json({ error: 'wrapperPath required' });
    return;
  }
  const resolved = validateKbPath(wrapperPath);
  if (!resolved || !isInTrash(resolved)) {
    res.status(400).json({ error: 'Invalid trash path' });
    return;
  }
  try {
    permanentDelete(resolved);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Permanently delete every trashed item. Pass ?mode=work|personal to empty
// every vault in a mode, or ?vault=<name> for a single vault.
router.post('/kb/trash/empty', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  const vault = req.query.vault as string | undefined;

  let vaults: string[];
  if (mode) {
    vaults = trashVaultsForMode(mode);
  } else if (vault) {
    if (!getObsidianVaults().includes(vault) && vault !== HANDOFF_DIR_NAME) {
      res.status(400).json({ error: 'Unknown vault' });
      return;
    }
    vaults = [vault];
  } else {
    res.status(400).json({ error: 'mode or vault query param required' });
    return;
  }

  try {
    let deleted = 0;
    for (const v of vaults) deleted += emptyTrash(v).deleted;
    res.json({ success: true, deleted });
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
    linkCandidateCache.clear();
    res.json({ success: true, path: resolvedDest });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List template files from Template(s)/ folders across all vaults
router.get('/kb/templates', (_req: Request, res: Response) => {
  const root = getObsidianRoot();
  const vaultNames = getObsidianVaults();
  const templates: { name: string; path: string; vault: string; folder: string }[] = [];

  function scanTemplateDir(dir: string, vault: string, baseDir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          scanTemplateDir(full, vault, baseDir);
        } else if (e.isFile() && e.name.endsWith('.md')) {
          const rel = path.relative(baseDir, dir);
          templates.push({
            name: e.name.replace(/\.md$/, ''),
            path: full,
            vault,
            folder: rel || '',
          });
        }
      }
    } catch {}
  }

  for (const vault of vaultNames) {
    for (const dirName of ['Templates', 'Template']) {
      const templatesDir = path.join(root, vault, dirName);
      if (!fs.existsSync(templatesDir)) continue;
      scanTemplateDir(templatesDir, vault, templatesDir);
      break; // use first match per vault
    }
  }

  templates.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ templates });
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

// In-memory cache for wiki-link autocomplete candidates, scoped to the KB's vault-context filter.
// Invalidated whenever a vault .md file is written/created/deleted/moved (see wikiLinkCache resets).
interface LinkCandidate {
  name: string;
  path: string;
  vault: string;
  mtimeMs: number;
}
interface LinkCandidateCache {
  entries: LinkCandidate[];
  builtAt: number;
}
const linkCandidateCache = new Map<string, LinkCandidateCache>();
const LINK_CANDIDATE_TTL_MS = 30_000;
const LINK_CANDIDATE_SKIP = new Set(['.git', '.obsidian', '.trash', 'node_modules']);

function buildLinkCandidates(vaults: Array<{ name: string; path: string }>): LinkCandidate[] {
  const results: LinkCandidate[] = [];
  const seen = new Set<string>();
  function walk(dir: string, vault: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || LINK_CANDIDATE_SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, vault);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (seen.has(full)) continue;
        seen.add(full);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch {}
        results.push({ name: e.name.replace(/\.md$/, ''), path: full, vault, mtimeMs });
      }
    }
  }
  for (const v of vaults) walk(v.path, v.name);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results;
}

// Resolve the {name, path} vault list for a ?vaults= filter, mirroring
// vaultNamesForFilter: 'work'|'personal' narrow to that mode, anything else is all vaults.
function vaultsForFilter(filter: string | undefined): Array<{ name: string; path: string }> {
  if (filter === 'work' || filter === 'personal') {
    return getActiveModeVaults(filter);
  }
  const root = getObsidianRoot();
  return getObsidianVaults().map(name => ({ name, path: path.join(root, name) }));
}

function getLinkCandidates(filter: string | undefined): LinkCandidate[] {
  const vaults = vaultsForFilter(filter);
  if (vaults.length === 0) return [];
  const key = (filter || 'all') + ':' + vaults.map(v => v.path).join('|');
  const cached = linkCandidateCache.get(key);
  if (cached && Date.now() - cached.builtAt < LINK_CANDIDATE_TTL_MS) return cached.entries;
  const entries = buildLinkCandidates(vaults);
  linkCandidateCache.set(key, { entries, builtAt: Date.now() });
  return entries;
}

// Wiki-link autocomplete: return .md filenames from the KB's vault-context filter
// matching the query, ranked exact > prefix > substring, then by recency.
router.get('/kb/link-candidates', (req: Request, res: Response) => {
  // Scope to the KB's vault-context filter ('work'|'personal'|all), mirroring
  // /kb/tree and /kb/search — NOT the global chat/terminal mode.
  const filter = req.query.vaults as string | undefined;
  const q = ((req.query.q as string) || '').trim().toLowerCase();
  const limit = Math.min(parseInt((req.query.limit as string) || '20', 10) || 20, 100);
  const entries = getLinkCandidates(filter);
  if (entries.length === 0) {
    res.json([]);
    return;
  }
  let filtered: LinkCandidate[];
  if (!q) {
    filtered = entries.slice(0, limit);
  } else {
    const exact: LinkCandidate[] = [];
    const prefix: LinkCandidate[] = [];
    const substring: LinkCandidate[] = [];
    for (const e of entries) {
      const name = e.name.toLowerCase();
      if (name === q) exact.push(e);
      else if (name.startsWith(q)) prefix.push(e);
      else if (name.includes(q)) substring.push(e);
      if (exact.length + prefix.length + substring.length >= limit * 4) break;
    }
    filtered = [...exact, ...prefix, ...substring].slice(0, limit);
  }
  res.json(filtered.map(e => ({ name: e.name, path: e.path, vault: e.vault })));
});

// Resolve a wiki-link to a file path
router.get('/kb/resolve-link', (req: Request, res: Response) => {
  const name = (req.query.name as string || '').trim();
  const context = (req.query.context as string) || '';

  if (!name) {
    res.status(400).json({ error: 'Name required' });
    return;
  }

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

  // 2. Path-style names (e.g. "projects/foo/project", "projects/foo/commits/abc1234")
  //    resolve as vault-relative paths — the flat bare-name index can't handle these
  //    because every project.md collides on the key "project".
  if (name.includes('/')) {
    const root = getObsidianRoot();
    for (const vault of getObsidianVaults()) {
      const candidate = path.join(root, vault, name + '.md');
      const resolved = validateKbPath(candidate);
      if (resolved && fs.existsSync(resolved)) {
        res.json({ path: resolved, name: path.basename(resolved, '.md') });
        return;
      }
    }
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // 3. Bare-name lookup via cached index
  if (!wikiLinkCache) {
    wikiLinkCache = buildWikiLinkIndex();
  }

  const found = wikiLinkCache.get(name.toLowerCase());
  if (found && fs.existsSync(found)) {
    res.json({ path: found, name: path.basename(found, '.md') });
    return;
  }

  res.status(404).json({ error: 'Not found' });
});

export default router;
