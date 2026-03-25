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

// All tools are auto-allowed except specific Bash commands listed below
const AUTO_ALLOW_ALL = true;

// Bash commands that require user approval via the permission dialog
const BASH_ASK_PATTERNS = [
  /^git\s+(add|commit|push)\b/,
];

// Check if a Bash command needs user permission
function bashNeedsPermission(toolInput: Record<string, unknown>): boolean {
  const command = (toolInput.command as string) || '';
  return BASH_ASK_PATTERNS.some(pattern => pattern.test(command));
}

const PERMISSION_TIMEOUT_MS = 120_000; // 2 minutes

// Pending permission requests by ID
const pendingPermissions = new Map<string, PendingPermission>();

// Per-session allow-all sets: sessionId → Set of tool names allowed for this session
const sessionAllowAll = new Map<string, Set<string>>();

export function isBashAskCommand(toolInput: Record<string, unknown>): boolean {
  return bashNeedsPermission(toolInput);
}

export function isAutoAllowed(toolName: string): boolean {
  // Auto-allow everything — only Bash git add/commit/push are gated (handled in route)
  return AUTO_ALLOW_ALL;
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
