import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getMode, config } from '../config';

const router = Router();

// List available workflows for the current mode's vault
router.get('/workflows', (_req: Request, res: Response) => {
  const vaultPath = config.vaultPaths[getMode()];
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
  const vaultPath = config.vaultPaths[getMode()];
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

export default router;
