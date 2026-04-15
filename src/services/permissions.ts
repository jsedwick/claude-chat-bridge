import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

export interface PermissionRequest {
  id: string;
  appSessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timestamp: number;
}

interface PendingPermission {
  request: PermissionRequest;
  resolve: (decision: 'allow' | 'deny') => void;
}

// ---------------------------------------------------------------------------
// Safe-list permission model
//
// Instead of auto-allowing everything and asking about a small whitelist,
// we auto-allow known-safe tools and ask about everything else. This mirrors
// what the Claude Code CLI would normally prompt for in its default mode.
// ---------------------------------------------------------------------------

// Tools that are always safe (read-only / session-local) — never prompt
const ALWAYS_ALLOW_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'TodoWrite',
  'TodoRead',
  'Agent',            // subagents hit their own permission checks
  'WebSearch',        // search is read-only
  'ToolSearch',
  'EnterPlanMode',    // session-local navigation
  'ExitPlanMode',
  'AskUserQuestion',  // just asks the user a question
  'TaskOutput',       // session-local task management
  'TaskStop',
  'Monitor',          // read-only process watching
]);

// Tools that need a file-path check: auto-allow within project dir, prompt outside
const PATH_CHECK_TOOLS = new Set([
  'Write',
  'Edit',
  'NotebookEdit',
]);

// Bash commands that are safe to auto-allow (read-only / informational)
const BASH_SAFE_PATTERNS = [
  /^(ls|pwd|whoami|date|env|which|file|stat|uname|hostname|id|uptime)\b/,
  /^(cat|head|tail|wc|less|more)\s/,
  /^(grep|rg|find|fd|fzf|ag)\s/,
  /^(sort|uniq|tr|cut|paste|column|diff|comm|tee)\s/,
  /^(echo|printf)\s/,
  /^(node|python3?|ruby|go|rustc|java|javac|gcc|g\+\+|clang)\s+(-v|--version|-h|--help)\b/,
  /^(node|npx|tsx|ts-node|bun|deno)\s/,
  /^(npm|yarn|pnpm|bun)\s+(list|ls|view|info|show|outdated|audit|why|explain|run|test|start)\b/,
  /^(pip|pip3|pipx|uv)\s+(list|show|check|freeze)\b/,
  /^(cargo|go|mix|gem|bundle)\s+(check|test|build|clippy|vet|fmt)\b/,
  /^git\s+(status|log|diff|show|branch|tag|remote|stash\s+list|blame|rev-parse|symbolic-ref|describe|shortlog|ls-files|ls-tree|config\s+--get|config\s+--list|name-rev|rev-list|for-each-ref)\b/,
  /^(sed|awk|perl)\s+/,            // text processing (inline edits rare via CLI)
  /^(curl|wget|http)\s/,            // network fetches — Claude uses these to read
  /^(jq|yq|xq)\s/,                  // JSON/YAML processing
  /^(mkdir\s+-p|touch|cp\s+-[^f]|ln\s)/,  // safe filesystem ops (no force)
  /^(docker|podman)\s+(ps|images|inspect|logs|top|stats|version|info)\b/,
  /^(make|cmake|ninja)\s/,
  /^(tsc|eslint|prettier|biome|stylelint)\s/,   // linters/formatters
  /^(pytest|jest|vitest|mocha|ava|tap)\s?/,     // test runners
  /^(du|df|free|top|htop|ps|lsof|netstat|ss)\s?/,  // system info
  /^(open|pbcopy|pbpaste|xdg-open|xclip)\s/,   // macOS/Linux desktop
  /^(launchctl|systemctl|journalctl)\s+(list|status|show|is-active|is-enabled)\b/,
  /^(gh)\s+(pr|issue|repo|run|release)\s+(list|view|status|checks|diff)\b/,
  /^(sqlite3)\s.*\s*$/,             // sqlite read queries
  /^(tar|zip|unzip|gzip|gunzip|bzip2|xz)\s/,   // archive ops
];

// Bash commands that always need permission (destructive / state-changing)
const BASH_ASK_PATTERNS = [
  /^git\s+(add|commit|push|reset|rebase|merge|checkout|switch|cherry-pick|revert|clean|stash\s+(drop|pop|clear))\b/,
  /\brm\s/,
  /\bsudo\s/,
  /\bchmod\s/,
  /\bchown\s/,
  /\bkill(all)?\s/,
  /\bmv\s/,
  /\bcp\s+-.*f/,                    // cp with force flag
  /\b(apt|apt-get|brew|yum|dnf|pacman)\s+(install|remove|uninstall|purge|upgrade)\b/,
  /\b(npm|yarn|pnpm|bun)\s+(install|add|remove|uninstall|publish|link|unlink|pack|init)\b/,
  /\b(pip|pip3|pipx|uv)\s+(install|uninstall)\b/,
  /\b(cargo)\s+(install|publish)\b/,
  /\b(docker|podman)\s+(run|exec|rm|rmi|stop|kill|build|push|pull|compose)\b/,
  /\b(launchctl|systemctl)\s+(start|stop|restart|enable|disable|kickstart|kill)\b/,
  /\b(gh)\s+(pr|issue)\s+(create|close|merge|comment|edit|reopen)\b/,
  /\bdd\s/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  />\s*\/(?!dev\/null\b)/,             // redirect to absolute path (but not /dev/null)
];

// ---------------------------------------------------------------------------
// Directory trust
// ---------------------------------------------------------------------------
const TRUSTED_DIRS_PATH = path.join(__dirname, '..', '..', 'trusted-dirs.json');

function loadTrustedDirs(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(TRUSTED_DIRS_PATH, 'utf-8'));
    return new Set(Array.isArray(data) ? data : []);
  } catch {
    return new Set();
  }
}

function saveTrustedDirs(dirs: Set<string>): void {
  fs.writeFileSync(TRUSTED_DIRS_PATH, JSON.stringify([...dirs], null, 2) + '\n');
}

const trustedDirs = loadTrustedDirs();

export function isDirectoryTrusted(dir: string): boolean {
  const resolved = path.resolve(dir);
  // Check if this dir or any parent is trusted
  for (const trusted of trustedDirs) {
    if (resolved === trusted || resolved.startsWith(trusted + '/')) {
      return true;
    }
  }
  return false;
}

export function trustDirectory(dir: string): void {
  trustedDirs.add(path.resolve(dir));
  saveTrustedDirs(trustedDirs);
}

// ---------------------------------------------------------------------------
// Permission decision logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a tool invocation needs user permission.
 * Returns 'allow' for safe operations, 'ask' when the user should decide.
 */
export function checkPermission(
  toolName: string,
  toolInput: Record<string, unknown>,
  workingDir?: string,
): 'allow' | 'ask' {
  // 1. Always-safe tools
  if (ALWAYS_ALLOW_TOOLS.has(toolName)) return 'allow';

  // 2. MCP tools — auto-allow all except code_file (which writes to project code)
  if (/^mcp__/.test(toolName) && !/code_file$/.test(toolName)) {
    return 'allow';
  }

  // 3. Path-checked tools (Write, Edit, NotebookEdit)
  if (PATH_CHECK_TOOLS.has(toolName)) {
    const filePath = (toolInput.file_path as string) || '';
    if (workingDir && filePath) {
      const resolvedFile = path.resolve(filePath);
      const resolvedDir = path.resolve(workingDir);
      // Within project dir or its subtree → safe
      if (resolvedFile.startsWith(resolvedDir + '/') || resolvedFile === resolvedDir) {
        return 'allow';
      }
    }
    // Outside project dir or no working dir → ask
    return 'ask';
  }

  // 4. Bash — check against safe patterns first, then ask patterns
  if (toolName === 'Bash') {
    const command = ((toolInput.command as string) || '').trim();

    // Explicit ask patterns take priority
    if (BASH_ASK_PATTERNS.some(p => p.test(command))) return 'ask';

    // Safe patterns
    if (BASH_SAFE_PATTERNS.some(p => p.test(command))) return 'allow';

    // Unknown bash command → ask
    return 'ask';
  }

  // 5. WebFetch — network access, prompt by default
  if (toolName === 'WebFetch') return 'ask';

  // 6. Everything else (unknown tools, new MCP tools with writes) → ask
  return 'ask';
}

// ---------------------------------------------------------------------------
// Pending permission requests (unchanged from before)
// ---------------------------------------------------------------------------

const pendingPermissions = new Map<string, PendingPermission>();
const sessionAllowAll = new Map<string, Set<string>>();

export function isSessionAllowed(appSessionId: string, toolName: string): boolean {
  const allowed = sessionAllowAll.get(appSessionId);
  return !!allowed && allowed.has(toolName);
}

export function addSessionAllow(appSessionId: string, toolName: string): void {
  if (!sessionAllowAll.has(appSessionId)) {
    sessionAllowAll.set(appSessionId, new Set());
  }
  sessionAllowAll.get(appSessionId)!.add(toolName);
}

export function clearSessionPermissions(appSessionId: string): void {
  sessionAllowAll.delete(appSessionId);
}

export function createPermissionRequest(
  appSessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<'allow' | 'deny'> {
  const id = crypto.randomUUID();
  const request: PermissionRequest = {
    id,
    appSessionId,
    toolName,
    toolInput,
    timestamp: Date.now(),
  };

  return new Promise<'allow' | 'deny'>((resolve) => {
    pendingPermissions.set(id, { request, resolve });
  });
}

export function resolvePermission(requestId: string, decision: 'allow' | 'deny', allowAll?: boolean): boolean {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return false;

  pendingPermissions.delete(requestId);

  // If allowAll, remember this tool for the session and auto-resolve other pending requests
  if (allowAll && decision === 'allow') {
    addSessionAllow(pending.request.appSessionId, pending.request.toolName);

    // Auto-resolve all other pending permission requests for the same session
    for (const [id, other] of pendingPermissions) {
      if (other.request.appSessionId === pending.request.appSessionId) {
        pendingPermissions.delete(id);
        other.resolve('allow');
        console.log(`[permissions] auto-resolved pending request ${id} (allowAll cascade)`);
      }
    }
  }

  pending.resolve(decision);
  return true;
}

export function getPendingRequest(requestId: string): PermissionRequest | undefined {
  return pendingPermissions.get(requestId)?.request;
}

export function getPendingForSession(appSessionId: string): PermissionRequest | undefined {
  for (const [, pending] of pendingPermissions) {
    if (pending.request.appSessionId === appSessionId) {
      return pending.request;
    }
  }
  return undefined;
}
