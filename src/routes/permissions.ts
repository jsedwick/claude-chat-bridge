import { Router, Request, Response } from 'express';
import { getAppSessionByClaudeId, emitToStream } from '../services/claude-runner';
import { getSession } from '../services/session-store';
import {
  isAutoAllowed,
  isBashAskCommand,
  isSessionAllowed,
  createPermissionRequest,
  resolvePermission,
  getPendingForSession,
} from '../services/permissions';

const router = Router();
const pollSeen = new Set<string>();

// Called by the PreToolUse hook script — held open until user responds
router.post('/request', async (req: Request, res: Response) => {
  const { tool_name, tool_input, session_id } = req.body;

  if (!tool_name || !session_id) {
    res.status(400).json({ error: 'tool_name and session_id required' });
    return;
  }

  // Look up the app session from Claude's session ID
  const appSessionId = getAppSessionByClaudeId(session_id);
  if (!appSessionId) {
    // No active bridge session — auto-allow (might be terminal usage)
    res.json({ decision: 'allow' });
    return;
  }

  // Auto-allow safe tools
  if (isAutoAllowed(tool_name)) {
    console.log(`[permissions] auto-allow: ${tool_name}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Bash: auto-allow unless it's a git add/commit/push
  if (tool_name === 'Bash' && !isBashAskCommand(tool_input || {})) {
    console.log(`[permissions] auto-allow bash: ${(tool_input?.command as string || '').substring(0, 80)}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Auto-allow git operations inside vault directories (no confirmation needed)
  const VAULT_DIRS = ['/Users/jsedwick/Documents/Obsidian/'];
  const session = getSession(appSessionId);
  if (session?.workingDir && VAULT_DIRS.some(v => session.workingDir!.startsWith(v))) {
    console.log(`[permissions] auto-allow (vault dir): ${tool_name} in ${session.workingDir}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Check session-level allow-all
  if (isSessionAllowed(appSessionId, tool_name)) {
    console.log(`[permissions] session-allow: ${tool_name}`);
    res.json({ decision: 'allow' });
    return;
  }

  // Create a pending permission request and emit to the client
  console.log(`[permissions] ASKING USER: ${tool_name}`, tool_input ? JSON.stringify(tool_input).substring(0, 200) : '');
  const decision = createPermissionRequest(appSessionId, tool_name, tool_input || {});

  // Send SSE event to the client through the active stream
  const pending = getPendingForSession(appSessionId);
  if (pending) {
    emitToStream(appSessionId, {
      type: 'permission_request',
      data: JSON.stringify({
        id: pending.id,
        toolName: pending.toolName,
        toolInput: pending.toolInput,
      }),
    });
    console.log(`[permissions] SSE event sent for request ${pending.id}`);
  } else {
    console.log(`[permissions] WARNING: no pending request found after creation`);
  }

  // Wait for user response (or timeout)
  const result = await decision;
  console.log(`[permissions] user decision: ${result} for ${tool_name}`);
  res.json({ decision: result });
});

// Poll for pending permission request (fallback for SSE delivery issues)
router.get('/pending/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const pending = getPendingForSession(sessionId);
  if (pending) {
    console.log(`[permissions-poll] HIT session=${sessionId.slice(0, 8)} tool=${pending.toolName}`);
    res.json({
      id: pending.id,
      toolName: pending.toolName,
      toolInput: pending.toolInput,
    });
  } else {
    // Log first poll per session to confirm polling is active (avoid spam)
    if (!pollSeen.has(sessionId)) {
      console.log(`[permissions-poll] active for session=${sessionId.slice(0, 8)}`);
      pollSeen.add(sessionId);
    }
    res.json(null);
  }
});

// Called by the client with user's decision
router.post('/respond', (req: Request, res: Response) => {
  const { requestId, decision, allowAll } = req.body;

  if (!requestId || !decision) {
    res.status(400).json({ error: 'requestId and decision required' });
    return;
  }

  if (decision !== 'allow' && decision !== 'deny') {
    res.status(400).json({ error: 'decision must be "allow" or "deny"' });
    return;
  }

  const resolved = resolvePermission(requestId, decision, allowAll === true);
  if (resolved) {
    res.json({ status: 'ok' });
  } else {
    res.status(404).json({ error: 'No pending permission with that ID' });
  }
});

export default router;
