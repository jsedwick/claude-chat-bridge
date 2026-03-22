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
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
  'EnterPlanMode', 'ExitPlanMode',
  'AskUserQuestion',
  'WebSearch', 'WebFetch',
];

// MCP tool prefixes that are read-only
const AUTO_ALLOW_MCP_PREFIXES = [
  'search_', 'get_', 'list_', 'find_', 'detect_', 'analyze_',
  'calendar_', 'email_',
];

const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes

// Pending permission requests by ID
const pendingPermissions = new Map<string, PendingPermission>();

// Per-session allow-all sets: sessionId → Set of tool names allowed for this session
const sessionAllowAll = new Map<string, Set<string>>();

export function isAutoAllowed(toolName: string): boolean {
  // Check exact match
  if (AUTO_ALLOW_PATTERNS.includes(toolName)) return true;

  // Check MCP tool prefixes (tool name after last __)
  const mcpPart = toolName.includes('__') ? toolName.split('__').pop() || '' : '';
  if (mcpPart && AUTO_ALLOW_MCP_PREFIXES.some(prefix => mcpPart.startsWith(prefix))) {
    return true;
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
