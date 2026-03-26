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

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Save user message server-side
  addMessage(sessionId, 'user', message);

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

  runClaude({
    sessionId: session.claudeSessionId || undefined,
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
            return;
          }
          // Detect close_session MCP tool call — mark session as closed
          if (toolData.name?.endsWith('__close_session')) {
            updateSession(sessionId, { closedAt: new Date().toISOString() });
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
        } catch {}
        addMessage(sessionId, 'usage', usageData);
      }
    },
    onClose: (claudeSessionId) => {
      console.log(`[sse:${sessionId.slice(0, 8)}] STREAM_CLOSE total=${sseEventCount} disconnected=${clientDisconnected} textLen=${assistantText.length}`);
      clearInterval(keepalive);
      // Save accumulated assistant response
      if (assistantText) {
        addMessage(sessionId, 'assistant', assistantText);
      }
      // Update session metadata
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
