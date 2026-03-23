import crypto from 'crypto';

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
  timer: ReturnType<typeof setTimeout>;
}

// Tools that are always safe (read-only operations)
const AUTO_ALLOW_PATTERNS = [
  'Read', 'Glob', 'Grep', 'ToolSearch', 'Skill',
  'Bash', 'Edit', 'Write', 'NotebookEdit',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'EnterPlanMode', 'ExitPlanMode',
  'AskUserQuestion', 'Agent',
  'WebSearch', 'WebFetch',
];

// MCP tool name prefixes that are safe to auto-allow (checked against last segment after __)
const AUTO_ALLOW_MCP_PREFIXES = [
  'search_', 'get_', 'list_', 'find_', 'detect_', 'analyze_',
  'calendar_', 'email_',
  'switch_', 'toggle_', 'restore_',
  'link_session', 'submit_topic',
  'track_file',
];

// MCP tool names (last segment after __) that are safe to auto-allow (exact match)
const AUTO_ALLOW_MCP_NAMES = [
  'append_to_accumulator', 'record_commit', 'workflow',
  'close_session', 'vault_custodian',
  'update_document', 'code_file', 'create_topic_page', 'create_decision',
  'create_project_page', 'add_task', 'complete_task', 'issue',
  'update_persistent_issue', 'archive_topic',
];

const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes

// Pending permission requests by ID
const pendingPermissions = new Map<string, PendingPermission>();

// Per-session allow-all sets: sessionId → Set of tool names allowed for this session
const sessionAllowAll = new Map<string, Set<string>>();

export function isAutoAllowed(toolName: string): boolean {
  // Check exact match on built-in tools
  if (AUTO_ALLOW_PATTERNS.includes(toolName)) return true;

  // Check MCP tool name (last segment after __)
  const mcpPart = toolName.includes('__') ? toolName.split('__').pop() || '' : '';
  if (mcpPart) {
    if (AUTO_ALLOW_MCP_PREFIXES.some(prefix => mcpPart.startsWith(prefix))) return true;
    if (AUTO_ALLOW_MCP_NAMES.includes(mcpPart)) return true;
  }

  return false;
}

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
    const timer = setTimeout(() => {
      pendingPermissions.delete(id);
      resolve('deny');
    }, PERMISSION_TIMEOUT_MS);

    pendingPermissions.set(id, { request, resolve, timer });
  });
}

export function resolvePermission(requestId: string, decision: 'allow' | 'deny', allowAll?: boolean): boolean {
  const pending = pendingPermissions.get(requestId);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingPermissions.delete(requestId);

  // If allowAll, remember this tool for the session
  if (allowAll && decision === 'allow') {
    addSessionAllow(pending.request.appSessionId, pending.request.toolName);
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
