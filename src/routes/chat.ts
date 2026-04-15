import { Router, Request, Response } from 'express';
import { runClaude, isSessionBusy, cancelByAppSession, isStreamActive, getStreamBuffer, subscribeWithBuffer } from '../services/claude-runner';
import { getSession, updateSession, addMessage, updateToolMessage } from '../services/session-store';

const router = Router();

router.post('/:sessionId', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const { message, model, attachments } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  if (isSessionBusy(session.claudeSessionId || sessionId as string)) {
    res.status(409).json({ error: 'Session is busy processing a message' });
    return;
  }

  // Set up SSE headers — flushHeaders ensures headers are sent immediately so the
  // client's fetch() resolves and readSSEStream starts listening without delay.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Save user message server-side
  addMessage(sessionId, 'user', message);

  // Persist model selection to session (covers legacy sessions without a stored model)
  if (model && !session.model) {
    updateSession(sessionId, { model });
  }

  let clientDisconnected = false;

  let sseEventCount = 0;

  const sendSSE = (event: string, data: string) => {
    sseEventCount++;
    if (clientDisconnected) {
      console.log(`[sse:${sessionId.slice(0, 8)}] #${sseEventCount} SUPPRESSED (disconnected) ${event}`);
      return;
    }
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      console.log(`[sse:${sessionId.slice(0, 8)}] #${sseEventCount} WRITE_FAILED ${event}`);
      clientDisconnected = true;
    }
  };

  // Keepalive ping every 15s to prevent idle connection drops
  const keepalive = setInterval(() => {
    if (clientDisconnected) return;
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  let assistantText = '';

  // For forked sessions on their first message, resume from parent's Claude session with --fork-session
  let forkFromClaudeId: string | undefined;
  if (!session.claudeSessionId && session.forkedFrom) {
    const parentSession = getSession(session.forkedFrom.sessionId);
    if (parentSession?.claudeSessionId) {
      forkFromClaudeId = parentSession.claudeSessionId;
    }
  }

  runClaude({
    sessionId: session.claudeSessionId || undefined,
    forkFromSessionId: forkFromClaudeId,
    appSessionId: sessionId,
    message: message,
    model: model || undefined,
    mode: session.mode || undefined,
    workingDir: session.workingDir || undefined,
    attachments: attachments || undefined,
    onEvent: (event) => {
      // Handle _update tool_use events (from assistant message with complete data)
      // Update persistence AND send to client so it can refresh tool details (input)
      if (event.type === 'tool_use') {
        try {
          const toolData = JSON.parse(event.data);
          if (toolData._update) {
            updateToolMessage(sessionId, toolData.id, event.data);
            sendSSE('tool_update', event.data);
            // Capture handoff + sessionFilePath from close_session finalize _update
            if (toolData.name?.endsWith('__close_session') && toolData.input?.finalize) {
              const updates: Record<string, unknown> = {};
              if (toolData.input.handoff) updates.handoff = toolData.input.handoff;
              if (toolData.input.session_data?.sessionFile) updates.sessionFilePath = toolData.input.session_data.sessionFile;
              if (Object.keys(updates).length) updateSession(sessionId, updates);
            }
            return;
          }
          // Detect close_session MCP tool call — mark session as closed
          if (toolData.name?.endsWith('__close_session')) {
            updateSession(sessionId, { closedAt: new Date().toISOString() });
          }
          // Detect code_file MCP tool call — mark session as having code activity
          if (toolData.name?.endsWith('__code_file')) {
            updateSession(sessionId, { usedCodeFile: true });
          }
          // Detect update_document MCP tool call — mark session as having vault doc activity
          if (toolData.name?.endsWith('__update_document')) {
            updateSession(sessionId, { usedVaultDoc: true });
          }
          // Detect Agent tool call — mark session as having subagent activity
          if (toolData.name === 'Agent') {
            updateSession(sessionId, { usedAgent: true });
          }
        } catch {}
        // Save accumulated text segment before tool call (preserves interleaving)
        if (assistantText) {
          addMessage(sessionId, 'assistant', assistantText);
          assistantText = '';
        }
        sendSSE(event.type, event.data);
        addMessage(sessionId, 'tool', event.data);
        return;
      }

      sendSSE(event.type, event.data);

      // Accumulate assistant text
      if (event.type === 'text') {
        assistantText += event.data;
        console.log(`[debug:${sessionId.slice(0,8)}] TEXT_RECV len=${event.data.length} total=${assistantText.length}`);
      }
      // Save tool result for restore
      if (event.type === 'tool_result') {
        addMessage(sessionId, 'tool_result', event.data);
      }
      // Save usage and flush remaining text on done
      if (event.type === 'done') {
        const hadText = !!assistantText;
        if (assistantText) {
          addMessage(sessionId, 'assistant', assistantText);
          assistantText = '';
        }
        // Safety net: if no text was accumulated but result contains it, save it
        let usageData = event.data;
        try {
          const doneData = JSON.parse(event.data);
          if (!hadText && doneData.result_text) {
            addMessage(sessionId, 'assistant', doneData.result_text);
          }
          // Strip result_text from usage storage (can be very large)
          if (doneData.result_text) {
            const { result_text: _, ...rest } = doneData;
            usageData = JSON.stringify(rest);
          }
          // Persist claudeSessionId immediately — don't wait for process exit.
          // With monitors, proc.on('close') (and thus onClose) can be delayed
          // indefinitely, leaving claudeSessionId unset and allowing the busy
          // check to be bypassed on subsequent messages.
          if (doneData.session_id) {
            updateSession(sessionId, {
              claudeSessionId: doneData.session_id,
              lastMessage: message.substring(0, 200),
              messageCount: session.messageCount + 1,
            });
          }
        } catch {}
        addMessage(sessionId, 'usage', usageData);

        // End the HTTP response now — don't wait for process exit.
        // With plugins/monitors, the Claude process may outlive the response,
        // but the client has everything it needs after 'done'.
        clearInterval(keepalive);
        if (!clientDisconnected) {
          try {
            res.end();
          } catch {}
        }
        clientDisconnected = true;
      }
    },
    onClose: (claudeSessionId) => {
      console.log(`[sse:${sessionId.slice(0, 8)}] STREAM_CLOSE total=${sseEventCount} disconnected=${clientDisconnected} textLen=${assistantText.length}`);
      clearInterval(keepalive);
      // Save accumulated assistant response (normally empty — cleared on done event,
      // but covers edge cases where process exits before done)
      if (assistantText) {
        addMessage(sessionId, 'assistant', assistantText);
      }
      // Update session metadata — claudeSessionId is persisted on done event now,
      // but onClose is the fallback for processes that exit without a result event
      // (e.g., crash, auth failure). lastMessage/messageCount may already be set.
      updateSession(sessionId, {
        claudeSessionId: claudeSessionId || session.claudeSessionId,
        lastMessage: message.substring(0, 200),
        messageCount: session.messageCount + 1,
      });

      if (!clientDisconnected) {
        try {
          res.write('event: close\ndata: "done"\n\n');
          res.end();
        } catch {
          // Client already gone
        }
      }
    },
  });

  // Handle client disconnect — must use res.on('close'), not req.on('close').
  // express.json() consumes the request body before our handler runs, causing
  // req to emit 'close' on the next tick (Node.js Readable behavior), which
  // would prematurely set clientDisconnected=true and suppress all SSE events.
  res.on('close', () => {
    console.log(`[sse:${sessionId.slice(0, 8)}] CLIENT_DISCONNECT after ${sseEventCount} events`);
    clientDisconnected = true;
    clearInterval(keepalive);
    // The claude process will continue running and complete naturally
    // Events continue to be saved server-side even though we can't send them
  });
});

router.get('/:sessionId/reconnect', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const streamActive = isStreamActive(sessionId);

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  let reconnectDisconnected = false;

  const sendSSE = (event: string, data: string) => {
    if (reconnectDisconnected) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      reconnectDisconnected = true;
    }
  };

  const sendEvent = (event: { type: string, data: string }) => {
    if (event.type === 'tool_use') {
      try {
        if (JSON.parse(event.data)._update) {
          sendSSE('tool_update', event.data);
          return;
        }
      } catch {}
    }
    sendSSE(event.type, event.data);
  };

  if (!streamActive) {
    // Stream already finished — replay buffer and close
    const buffer = getStreamBuffer(sessionId);
    if (!buffer) {
      res.end();
      return;
    }
    for (const event of buffer) sendEvent(event);
    if (!reconnectDisconnected) {
      try {
        res.write('event: close\ndata: "done"\n\n');
        res.end();
      } catch {}
    }
    return;
  }

  // Atomically get buffer + subscribe so no events are lost between snapshot and subscribe
  const result = subscribeWithBuffer(sessionId, (event) => sendEvent(event));

  if (!result) {
    if (!reconnectDisconnected) {
      try {
        res.write('event: close\ndata: "done"\n\n');
        res.end();
      } catch {}
    }
    return;
  }

  const { buffer, unsubscribe } = result;

  // Replay buffered events
  for (const event of buffer) sendEvent(event);

  // Keepalive ping every 15s
  const keepalive = setInterval(() => {
    if (reconnectDisconnected) return;
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  // When stream finishes, the close event will come through the subscriber
  // but we also need to end the response
  const checkDone = setInterval(() => {
    if (!isStreamActive(sessionId)) {
      clearInterval(checkDone);
      clearInterval(keepalive);
      unsubscribe();
      if (!reconnectDisconnected) {
        try {
          res.write('event: close\ndata: "done"\n\n');
          res.end();
        } catch {}
      }
    }
  }, 500);

  res.on('close', () => {
    reconnectDisconnected = true;
    clearInterval(checkDone);
    clearInterval(keepalive);
    unsubscribe();
  });
});

router.post('/:sessionId/cancel', (req: Request, res: Response) => {
  const sessionId = req.params.sessionId as string;
  const session = getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const cancelled = cancelByAppSession(sessionId);
  if (cancelled) {
    res.json({ status: 'cancelled' });
  } else {
    res.status(404).json({ error: 'No active stream for this session' });
  }
});

export default router;
