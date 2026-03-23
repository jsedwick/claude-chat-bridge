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

  const sendSSE = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keepalive ping every 15s to prevent idle connection drops
  const keepalive = setInterval(() => {
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
      }
      // Save tool result for restore
      if (event.type === 'tool_result') {
        addMessage(sessionId, 'tool_result', event.data);
      }
      // Save usage
      if (event.type === 'done') {
        addMessage(sessionId, 'usage', event.data);
      }
    },
    onClose: (claudeSessionId) => {
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

      res.write('event: close\ndata: "done"\n\n');
      res.end();
    },
  });

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(keepalive);
    // The claude process will continue running and complete naturally
    // This is fine - we just won't send more events
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

  const sendSSE = (event: string, data: string) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
    res.write('event: close\ndata: "done"\n\n');
    res.end();
    return;
  }

  // Atomically get buffer + subscribe so no events are lost between snapshot and subscribe
  const result = subscribeWithBuffer(sessionId, (event) => sendEvent(event));

  if (!result) {
    res.write('event: close\ndata: "done"\n\n');
    res.end();
    return;
  }

  const { buffer, unsubscribe } = result;

  // Replay buffered events
  for (const event of buffer) sendEvent(event);

  // Keepalive ping every 15s
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  // When stream finishes, the close event will come through the subscriber
  // but we also need to end the response
  const checkDone = setInterval(() => {
    if (!isStreamActive(sessionId)) {
      clearInterval(checkDone);
      clearInterval(keepalive);
      unsubscribe();
      res.write('event: close\ndata: "done"\n\n');
      res.end();
    }
  }, 500);

  req.on('close', () => {
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
