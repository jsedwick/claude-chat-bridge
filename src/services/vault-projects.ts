import fs from 'fs';
import path from 'path';
import { getVaultPath, Mode } from '../config';

export interface VaultProject {
  name: string;
  slug: string;
  filePath: string;
  repoPath: string;
  exists: boolean;
  lastSessionDate: string | null;
  lastUpdated: string;
  mode: Mode;
}

export function scanVaultProjects(vaultPath: string, mode: Mode): VaultProject[] {
  const projectsDir = path.join(vaultPath, 'projects');
  const results: VaultProject[] = [];

  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const slug = dir.name;
    const filePath = path.join(projectsDir, slug, 'project.md');
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      // Directory has commits/ subdir but no project.md — skip
      continue;
    }

    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) continue;
    const fm = fmMatch[1];

    // Handle both frontmatter shapes:
    //   newer: project_name + repo_path
    //   older: title + repository.path (nested)
    const projectNameMatch = fm.match(/^project_name:\s*["']?([^"'\n]+)["']?/m);
    const titleMatch = fm.match(/^title:\s*["']?([^"'\n]+)["']?/m);
    const name = (projectNameMatch?.[1] || titleMatch?.[1] || slug).trim();

    const repoPathMatch = fm.match(/^repo_path:\s*["']?([^"'\n]+)["']?/m);
    // Nested form requires the repository: parent so we don't accidentally grab
    // an unrelated indented `path:` from some other future frontmatter key.
    const nestedPathMatch = fm.match(/^repository:\s*\n\s+path:\s*["']?([^"'\n]+)["']?/m);
    const repoPath = (repoPathMatch?.[1] || nestedPathMatch?.[1] || '').trim();
    if (!repoPath) continue;

    const lastUpdatedMatch = fm.match(/^last_updated:\s*["']?([^"'\n]+)["']?/m);
    const lastCommitMatch = fm.match(/^last_commit_tracked:\s*["']?([^"'\n]+)["']?/m);
    const createdMatch = fm.match(/^created:\s*["']?([^"'\n]+)["']?/m);
    const lastUpdated = (lastUpdatedMatch?.[1] || lastCommitMatch?.[1] || createdMatch?.[1] || '').trim();

    let exists = false;
    try {
      exists = fs.statSync(repoPath).isDirectory();
    } catch {}

    results.push({
      name,
      slug,
      filePath,
      repoPath,
      exists,
      lastSessionDate: null,
      lastUpdated,
      mode,
    });
  }

  return results;
}

// Return a Map<repoPath, Mode> of project roots that exist ONLY in the other mode's vault
// (not also in the active mode's). The directory picker uses this to grey directories that
// are claimed exclusively by the inactive context.
export function getCrossModeProjectRoots(activeMode: Mode): Map<string, Mode> {
  const otherMode: Mode = activeMode === 'work' ? 'personal' : 'work';
  let activeProjects: VaultProject[] = [];
  let otherProjects: VaultProject[] = [];
  try {
    activeProjects = scanVaultProjects(getVaultPath(activeMode), activeMode);
  } catch {}
  try {
    otherProjects = scanVaultProjects(getVaultPath(otherMode), otherMode);
  } catch {}

  const activeRepoPaths = new Set(activeProjects.map(p => p.repoPath));
  const map = new Map<string, Mode>();
  for (const p of otherProjects) {
    if (!activeRepoPaths.has(p.repoPath)) {
      map.set(p.repoPath, p.mode);
    }
  }
  return map;
}
