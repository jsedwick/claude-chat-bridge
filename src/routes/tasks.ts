import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getVaultPath, parseMode } from '../config';

const router = Router();

type Section = 'tasks' | 'todo' | 'completed';
type Priority = 'high' | 'medium' | 'low';
type Context = 'work' | 'personal';

interface ParsedTask {
  raw: string;
  description: string;
  due: string | null;
  dueDate: string | null; // normalized YYYY-MM-DD for sorting
  completed: string | null;
  priority: Priority | null;
  project: string | null;
  context: Context | null;
  done: boolean;
  section: Section;
  trailing: string[];
}

interface ParsedList {
  file: string;
  name: string;
  slug: string;
  tasks: ParsedTask[];
  todo: ParsedTask[];
  completed: ParsedTask[];
}

const DUE_RE = /\(due:\s*([^)]+)\)/;
const COMPLETED_RE = /\(completed:\s*(\d{4}-\d{2}-\d{2})\)/;
const PRIORITY_RE = /@priority:(\w+)/;
const PROJECT_RE = /@project:([\w-]+)/;
const CONTEXT_RE = /@context:(\w+)/;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDue(raw: string | null): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  const d = new Date();
  if (v === 'today') return d.toISOString().slice(0, 10);
  if (v === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    return d.toISOString().slice(0, 10);
  }
  if (v === 'this-week') {
    const day = d.getDay();
    const offset = day <= 5 ? 5 - day : 7 - day + 5;
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

function parseTaskLine(line: string, section: Section): ParsedTask | null {
  const m = line.match(/^[-*] \[([ xX])\] (.+)$/);
  if (!m) return null;
  const done = m[1].toLowerCase() === 'x';
  const text = m[2];

  const dueMatch = text.match(DUE_RE);
  const completedMatch = text.match(COMPLETED_RE);
  const priorityMatch = text.match(PRIORITY_RE);
  const projectMatch = text.match(PROJECT_RE);
  const contextMatch = text.match(CONTEXT_RE);

  let description = text;
  description = description.replace(DUE_RE, '');
  description = description.replace(COMPLETED_RE, '');
  description = description.replace(PRIORITY_RE, '');
  description = description.replace(PROJECT_RE, '');
  description = description.replace(CONTEXT_RE, '');
  description = description.replace(/\s+/g, ' ').trim();

  const priority = priorityMatch?.[1].toLowerCase();
  const validPriority: Priority | null =
    priority === 'high' || priority === 'medium' || priority === 'low' ? priority : null;

  const context = contextMatch?.[1].toLowerCase();
  const validContext: Context | null = context === 'work' || context === 'personal' ? context : null;

  return {
    raw: line,
    description,
    due: dueMatch ? dueMatch[1].trim() : null,
    dueDate: normalizeDue(dueMatch ? dueMatch[1].trim() : null),
    completed: completedMatch ? completedMatch[1] : null,
    priority: validPriority,
    project: projectMatch ? projectMatch[1] : null,
    context: validContext,
    done,
    section,
    trailing: [],
  };
}

function deriveName(content: string, slug: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const titleMatch = fmMatch[1].match(/title:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (titleMatch) return titleMatch[1].trim();
  }
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  return (
    slug
      .replace(/-tasks$/, '')
      .split('-')
      .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ''))
      .join(' ') + ' Tasks'
  );
}

function isActiveTaskList(content: string): boolean {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;
  const fm = fmMatch[1];
  if (!/category:\s*["']?task-list["']?/.test(fm)) return false;
  const inlineTags = fm.match(/tags:\s*\[([^\]]+)\]/);
  if (inlineTags) {
    return /\bactive\b/.test(inlineTags[1]);
  }
  const blockTagsMatch = fm.match(/tags:\n((?:\s+-.+\n?)+)/);
  if (blockTagsMatch) {
    return /^\s*-\s*active\s*$/m.test(blockTagsMatch[1]);
  }
  return false;
}

function splitSections(body: string): Record<Section, string[]> {
  const lines = body.split('\n');
  const sections: Record<Section, string[]> = { tasks: [], todo: [], completed: [] };
  let current: Section | null = null;
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      const name = m[1].trim().toLowerCase();
      if (name === 'tasks' || name === 'todo' || name === 'completed') {
        current = name;
      } else {
        current = null;
      }
      continue;
    }
    if (current) sections[current].push(line);
  }
  return sections;
}

function parseSectionLines(lines: string[], section: Section): ParsedTask[] {
  const out: ParsedTask[] = [];
  let current: ParsedTask | null = null;
  for (const line of lines) {
    const t = parseTaskLine(line, section);
    if (t) {
      out.push(t);
      current = t;
    } else if (current && /^\s+\S/.test(line)) {
      current.trailing.push(line);
    } else if (line.trim() === '') {
      // blank lines don't break the current task's trailing block
    } else {
      current = null;
    }
  }
  return out;
}

function parseListFile(filePath: string): ParsedList | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
  if (!isActiveTaskList(content)) return null;

  const slug = path.basename(filePath, '.md');
  const name = deriveName(content, slug);
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const sections = splitSections(body);

  return {
    file: filePath,
    name,
    slug,
    tasks: parseSectionLines(sections.tasks, 'tasks'),
    todo: parseSectionLines(sections.todo, 'todo'),
    completed: parseSectionLines(sections.completed, 'completed'),
  };
}

function scanAllLists(vaultPath: string): ParsedList[] {
  const tasksDir = path.join(vaultPath, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(tasksDir).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }
  const lists: ParsedList[] = [];
  for (const f of files) {
    const parsed = parseListFile(path.join(tasksDir, f));
    if (parsed) lists.push(parsed);
  }
  return lists;
}

function sortTasksByDue(tasks: ParsedTask[]): ParsedTask[] {
  return tasks.slice().sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
}

function sortCompletedByDate(tasks: ParsedTask[]): ParsedTask[] {
  return tasks.slice().sort((a, b) => {
    if (a.completed && b.completed) return b.completed.localeCompare(a.completed);
    if (a.completed) return -1;
    if (b.completed) return 1;
    return 0;
  });
}

function validateTaskFilePath(file: unknown, mode: 'work' | 'personal'): string | null {
  if (typeof file !== 'string' || !file) return null;
  const resolved = path.resolve(file);
  const tasksDir = path.resolve(path.join(getVaultPath(mode), 'tasks'));
  if (!resolved.startsWith(tasksDir + path.sep)) return null;
  if (!resolved.endsWith('.md')) return null;
  if (!fs.existsSync(resolved)) return null;
  return resolved;
}

function findRawLine(lines: string[], raw: string): number {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === raw) return i;
  }
  return -1;
}

function sectionEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) return i;
  }
  return lines.length;
}

function findSectionHeader(lines: string[], section: Section): number {
  const target = section === 'tasks' ? 'Tasks' : section === 'todo' ? 'Todo' : 'Completed';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m && m[1].trim().toLowerCase() === target.toLowerCase()) return i;
  }
  return -1;
}

function appendToSection(lines: string[], section: Section, taskLine: string): string[] {
  const headerIdx = findSectionHeader(lines, section);
  if (headerIdx === -1) {
    const header = section === 'tasks' ? '## Tasks' : section === 'todo' ? '## Todo' : '## Completed';
    const out = lines.slice();
    while (out.length && out[out.length - 1] === '') out.pop();
    out.push('');
    out.push(header);
    out.push(taskLine);
    return out;
  }
  const endIdx = sectionEnd(lines, headerIdx);
  let insertAt = headerIdx + 1;
  for (let i = endIdx - 1; i > headerIdx; i--) {
    if (lines[i].trim() !== '') {
      insertAt = i + 1;
      break;
    }
  }
  return [...lines.slice(0, insertAt), taskLine, ...lines.slice(insertAt)];
}

function formatTaskLine(opts: {
  description: string;
  due: string | null;
  priority: Priority | null;
  project: string | null;
  context: Context | null;
}): string {
  let line = `- [ ] ${opts.description.trim()}`;
  if (opts.due) line += ` (due: ${opts.due})`;
  if (opts.context) line += ` @context:${opts.context}`;
  if (opts.project) line += ` @project:${opts.project}`;
  if (opts.priority) line += ` @priority:${opts.priority}`;
  return line;
}

// --- Endpoints ---

router.get('/', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required: "work" or "personal"' });
    return;
  }
  const projectSlug = ((req.query.projectSlug as string) || '').trim();
  const vaultPath = getVaultPath(mode);
  const lists = scanAllLists(vaultPath);

  for (const list of lists) {
    list.tasks = sortTasksByDue(list.tasks);
    list.completed = sortCompletedByDate(list.completed);
  }

  const tasksDir = path.join(vaultPath, 'tasks');
  let defaultList: string | null = null;
  if (projectSlug) {
    const candidate = path.join(tasksDir, `${projectSlug}-tasks.md`);
    if (lists.find(l => l.file === candidate)) defaultList = candidate;
  }
  if (!defaultList) {
    const modeFile = path.join(tasksDir, `${mode}-tasks.md`);
    if (lists.find(l => l.file === modeFile)) defaultList = modeFile;
  }
  if (!defaultList && lists.length > 0) defaultList = lists[0].file;

  lists.sort((a, b) => {
    if (a.file === defaultList) return -1;
    if (b.file === defaultList) return 1;
    return a.name.localeCompare(b.name);
  });

  res.json({ lists, defaultList, today: todayISO() });
});

router.post('/', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required' });
    return;
  }
  const { task, due, priority, list } = req.body || {};
  if (typeof task !== 'string' || !task.trim()) {
    res.status(400).json({ error: 'task string required' });
    return;
  }
  if (due !== undefined && due !== null && typeof due !== 'string') {
    res.status(400).json({ error: 'due must be string or null' });
    return;
  }
  const validPriorities: Priority[] = ['high', 'medium', 'low'];
  if (priority !== undefined && priority !== null && !validPriorities.includes(priority)) {
    res.status(400).json({ error: 'priority must be high/medium/low' });
    return;
  }
  const filePath = validateTaskFilePath(list, mode);
  if (!filePath) {
    res.status(400).json({ error: 'list must be an existing task file in the active vault' });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    res.status(500).json({ error: 'Failed to read list' });
    return;
  }

  const dueClean = typeof due === 'string' && due.trim() ? due.trim() : null;
  const targetSection: Section = dueClean ? 'tasks' : 'todo';

  const slug = path.basename(filePath, '.md');
  const filenameContext: Context | null =
    slug === 'work-tasks' ? 'work' : slug === 'personal-tasks' ? 'personal' : null;
  const filenameProject =
    !filenameContext && slug.endsWith('-tasks') ? slug.replace(/-tasks$/, '') : null;

  const taskLine = formatTaskLine({
    description: task,
    due: dueClean,
    priority: priority ?? null,
    project: filenameProject,
    context: filenameContext,
  });

  const lines = content.split('\n');
  const next = appendToSection(lines, targetSection, taskLine);
  try {
    fs.writeFileSync(filePath, next.join('\n'), 'utf-8');
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }

  const refreshed = parseListFile(filePath);
  if (refreshed) {
    refreshed.tasks = sortTasksByDue(refreshed.tasks);
    refreshed.completed = sortCompletedByDate(refreshed.completed);
  }
  res.json({ list: refreshed, added: taskLine });
});

router.patch('/complete', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required' });
    return;
  }
  const { file, raw } = req.body || {};
  if (typeof raw !== 'string' || !raw.trim()) {
    res.status(400).json({ error: 'raw string required' });
    return;
  }
  const filePath = validateTaskFilePath(file, mode);
  if (!filePath) {
    res.status(400).json({ error: 'file must be an existing task file in the active vault' });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    res.status(500).json({ error: 'Failed to read list' });
    return;
  }
  const lines = content.split('\n');
  const idx = findRawLine(lines, raw);
  if (idx === -1) {
    res.status(404).json({ error: 'Line not found in file' });
    return;
  }

  let trailingEnd = idx + 1;
  while (trailingEnd < lines.length && /^\s+\S/.test(lines[trailingEnd])) trailingEnd++;
  const trailing = lines.slice(idx + 1, trailingEnd);

  let completedLine = raw.replace(/^([-*]) \[ \]/, '$1 [x]');
  completedLine = completedLine.replace(COMPLETED_RE, '').replace(/\s+/g, ' ').trim();
  completedLine += ` (completed: ${todayISO()})`;

  const withoutSource = [...lines.slice(0, idx), ...lines.slice(trailingEnd)];
  const withCompleted = appendToSection(withoutSource, 'completed', completedLine);
  if (trailing.length) {
    const insertAfter = withCompleted.lastIndexOf(completedLine);
    if (insertAfter !== -1) {
      withCompleted.splice(insertAfter + 1, 0, ...trailing);
    }
  }

  try {
    fs.writeFileSync(filePath, withCompleted.join('\n'), 'utf-8');
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }

  const refreshed = parseListFile(filePath);
  if (refreshed) {
    refreshed.tasks = sortTasksByDue(refreshed.tasks);
    refreshed.completed = sortCompletedByDate(refreshed.completed);
  }
  res.json({ list: refreshed });
});

router.patch('/uncomplete', (req: Request, res: Response) => {
  const mode = parseMode(req.query.mode);
  if (!mode) {
    res.status(400).json({ error: 'mode query param required' });
    return;
  }
  const { file, raw } = req.body || {};
  if (typeof raw !== 'string' || !raw.trim()) {
    res.status(400).json({ error: 'raw string required' });
    return;
  }
  const filePath = validateTaskFilePath(file, mode);
  if (!filePath) {
    res.status(400).json({ error: 'file must be an existing task file in the active vault' });
    return;
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    res.status(500).json({ error: 'Failed to read list' });
    return;
  }
  const lines = content.split('\n');
  const idx = findRawLine(lines, raw);
  if (idx === -1) {
    res.status(404).json({ error: 'Line not found in file' });
    return;
  }

  let trailingEnd = idx + 1;
  while (trailingEnd < lines.length && /^\s+\S/.test(lines[trailingEnd])) trailingEnd++;
  const trailing = lines.slice(idx + 1, trailingEnd);

  let restoredLine = raw.replace(/^([-*]) \[[xX]\]/, '$1 [ ]');
  restoredLine = restoredLine.replace(COMPLETED_RE, '').replace(/\s+/g, ' ').trim();
  const targetSection: Section = DUE_RE.test(restoredLine) ? 'tasks' : 'todo';

  const withoutSource = [...lines.slice(0, idx), ...lines.slice(trailingEnd)];
  const withRestored = appendToSection(withoutSource, targetSection, restoredLine);
  if (trailing.length) {
    const insertAfter = withRestored.lastIndexOf(restoredLine);
    if (insertAfter !== -1) {
      withRestored.splice(insertAfter + 1, 0, ...trailing);
    }
  }

  try {
    fs.writeFileSync(filePath, withRestored.join('\n'), 'utf-8');
  } catch (err: any) {
    res.status(500).json({ error: err.message });
    return;
  }

  const refreshed = parseListFile(filePath);
  if (refreshed) {
    refreshed.tasks = sortTasksByDue(refreshed.tasks);
    refreshed.completed = sortCompletedByDate(refreshed.completed);
  }
  res.json({ list: refreshed });
});

export default router;
