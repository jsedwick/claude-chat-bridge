import fs from 'fs';
import path from 'path';
import { getObsidianRoot, getObsidianVaults, config } from '../config';

export interface TrashMeta {
  originalPath: string;
  type: 'file' | 'folder';
  trashedAt: string;
  vault: string;
  displayName: string;
}

export interface TrashEntry {
  wrapperPath: string;
  meta: TrashMeta;
}

const TRASH_DIRNAME = '.trash';
const ARCHIVE_DIRNAME = 'archive';
const META_FILENAME = '.meta.json';

function sanitizeBasename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'item';
}

function timestampStr(): string {
  // Filesystem-safe ISO variant: 2026-05-28T15-32-00-000Z
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function trashRootForVault(vault: string): string {
  return path.join(getObsidianRoot(), vault, ARCHIVE_DIRNAME, TRASH_DIRNAME);
}

// Handoff is a trashable root even though it is NOT a configured vault. The
// privacy-gateway handoff queue is surfaced in the KB tree via a display-only
// exception (see src/routes/vault.ts / decision 003) and must stay deletable
// from the KB WITHOUT being added to .obsidian-mcp.json — adding it there would
// expose the (possibly un-redacted) handoff originals to Claude's MCP read
// tools. Its trash lives in Handoff/archive/.trash/, still outside the MCP
// config, so Claude stays blind to deleted items too.
const HANDOFF_DIR_NAME = 'Handoff';

function trashableRoots(): string[] {
  return [...getObsidianVaults(), HANDOFF_DIR_NAME];
}

export function vaultForPath(absPath: string): string | null {
  const root = getObsidianRoot();
  const rel = path.relative(root, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  if (!first) return null;
  return trashableRoots().includes(first) ? first : null;
}

export function isInTrash(absPath: string): boolean {
  const vault = vaultForPath(absPath);
  if (!vault) return false;
  const trashRoot = trashRootForVault(vault);
  return absPath === trashRoot || absPath.startsWith(trashRoot + path.sep);
}

export function moveToTrash(absPath: string): { wrapperPath: string; evicted: string[] } {
  if (!fs.existsSync(absPath)) {
    throw new Error('Source does not exist');
  }
  const vault = vaultForPath(absPath);
  if (!vault) {
    throw new Error('Path is not inside a configured vault');
  }
  if (isInTrash(absPath)) {
    throw new Error('Path is already in trash');
  }

  const stat = fs.statSync(absPath);
  const type: 'file' | 'folder' = stat.isDirectory() ? 'folder' : 'file';
  const displayName = path.basename(absPath);
  const sanitized = sanitizeBasename(displayName);
  const ts = timestampStr();

  const trashRoot = trashRootForVault(vault);
  fs.mkdirSync(trashRoot, { recursive: true });

  const wrapperPath = path.join(trashRoot, `${ts}__${sanitized}`);
  fs.mkdirSync(wrapperPath);

  fs.renameSync(absPath, path.join(wrapperPath, displayName));

  const meta: TrashMeta = {
    originalPath: absPath,
    type,
    trashedAt: new Date().toISOString(),
    vault,
    displayName,
  };
  fs.writeFileSync(path.join(wrapperPath, META_FILENAME), JSON.stringify(meta, null, 2));

  const evicted = enforceTrashCap(vault);
  return { wrapperPath, evicted };
}

export type ConflictStrategy = 'suffix' | 'overwrite';

export function restoreFromTrash(
  wrapperPath: string,
  options: { conflictStrategy?: ConflictStrategy } = {},
): { restoredPath: string } | { conflict: true; destination: string } {
  const meta = readMeta(wrapperPath);
  if (!meta) throw new Error('Trash entry not found or corrupt');

  // Defense: a tampered .meta.json could point originalPath outside the vault.
  // Require originalPath to resolve under the SAME vault as the wrapper and
  // refuse to write back into the trash subtree (which would be nonsense).
  const wrapperVault = vaultForPath(wrapperPath);
  const targetResolved = path.resolve(meta.originalPath);
  const targetVault = vaultForPath(targetResolved);
  if (!wrapperVault || targetVault !== wrapperVault) {
    throw new Error('Trash entry points outside its vault');
  }
  if (isInTrash(targetResolved)) {
    throw new Error('Trash entry points back into trash');
  }

  const payloadSrc = path.join(wrapperPath, meta.displayName);
  if (!fs.existsSync(payloadSrc)) {
    throw new Error('Trash payload missing');
  }

  let finalTarget = targetResolved;
  let needsDisplace = false;
  if (fs.existsSync(targetResolved)) {
    if (options.conflictStrategy === 'suffix') {
      finalTarget = uniqueRestoredPath(targetResolved);
    } else if (options.conflictStrategy === 'overwrite') {
      needsDisplace = true;
    } else {
      return { conflict: true, destination: targetResolved };
    }
  }

  if (needsDisplace) {
    // Stage the payload outside the wrapper FIRST, so the FIFO cap triggered
    // by moveToTrash(displaced) can't evict our wrapper (and the payload
    // inside it) before we get to rename.
    const stagingDir = path.dirname(path.dirname(wrapperPath)); // <vault>/archive
    const stagingPath = path.join(stagingDir, `.kb-trash-staging-${Date.now()}`);
    fs.renameSync(payloadSrc, stagingPath);
    try {
      moveToTrash(targetResolved);
      fs.mkdirSync(path.dirname(finalTarget), { recursive: true });
      fs.renameSync(stagingPath, finalTarget);
    } catch (e) {
      // Best-effort rollback: put the payload back into the wrapper.
      try { fs.renameSync(stagingPath, payloadSrc); } catch {}
      throw e;
    }
  } else {
    fs.mkdirSync(path.dirname(finalTarget), { recursive: true });
    fs.renameSync(payloadSrc, finalTarget);
  }

  // Clean up the wrapper (idempotent — may already be gone via cap eviction).
  fs.rmSync(wrapperPath, { recursive: true, force: true });

  return { restoredPath: finalTarget };
}

function uniqueRestoredPath(originalPath: string): string {
  const dir = path.dirname(originalPath);
  const ext = path.extname(originalPath);
  const stem = ext ? path.basename(originalPath, ext) : path.basename(originalPath);
  for (let i = 1; i <= 100; i++) {
    const suffix = i === 1 ? '(restored)' : `(restored ${i})`;
    const candidate = path.join(dir, `${stem} ${suffix}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Too many restored copies — cannot find unique name');
}

export function listTrash(vault: string): TrashEntry[] {
  const trashRoot = trashRootForVault(vault);
  if (!fs.existsSync(trashRoot)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(trashRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: TrashEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const wrapperPath = path.join(trashRoot, e.name);
    const meta = readMeta(wrapperPath);
    if (meta) result.push({ wrapperPath, meta });
  }

  result.sort((a, b) => b.meta.trashedAt.localeCompare(a.meta.trashedAt));
  return result;
}

export function permanentDelete(wrapperPath: string): void {
  if (!fs.existsSync(wrapperPath)) {
    throw new Error('Trash entry not found');
  }
  if (!isInTrash(wrapperPath)) {
    throw new Error('Path is not in trash');
  }
  fs.rmSync(wrapperPath, { recursive: true, force: true });
}

export function emptyTrash(vault: string): { deleted: number } {
  const entries = listTrash(vault);
  let deleted = 0;
  for (const entry of entries) {
    try {
      fs.rmSync(entry.wrapperPath, { recursive: true, force: true });
      deleted++;
    } catch {
      // skip individual failures so a single locked file doesn't abort the whole sweep
    }
  }
  return { deleted };
}

function readMeta(wrapperPath: string): TrashMeta | null {
  try {
    const raw = fs.readFileSync(path.join(wrapperPath, META_FILENAME), 'utf-8');
    const meta = JSON.parse(raw);
    if (
      meta &&
      typeof meta.originalPath === 'string' &&
      typeof meta.displayName === 'string' &&
      typeof meta.trashedAt === 'string' &&
      typeof meta.vault === 'string' &&
      (meta.type === 'file' || meta.type === 'folder')
    ) {
      return meta as TrashMeta;
    }
    return null;
  } catch {
    return null;
  }
}

function enforceTrashCap(vault: string): string[] {
  const entries = listTrash(vault).sort((a, b) =>
    a.meta.trashedAt.localeCompare(b.meta.trashedAt),
  );
  const evicted: string[] = [];
  while (entries.length > config.maxTrashedKbItems) {
    const oldest = entries.shift()!;
    try {
      fs.rmSync(oldest.wrapperPath, { recursive: true, force: true });
      evicted.push(oldest.wrapperPath);
    } catch {
      // skip
    }
  }
  return evicted;
}
