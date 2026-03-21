import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { StreamEvent, ClaudeRunnerOptions } from '../types';

const activeSessions = new Map<string, ChildProcess>();

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

export function isSessionBusy(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export function killSession(sessionId: string): void {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    activeSessions.delete(sessionId);
  }
}

export function runClaude(options: ClaudeRunnerOptions): void {
  const { sessionId, message, onEvent, onClose } = options;

  if (activeSessions.size >= config.maxConcurrentSessions && !activeSessions.has(sessionId || '')) {
    onEvent({ type: 'error', data: `Max concurrent sessions (${config.maxConcurrentSessions}) reached. Try again later.` });
    onClose(null);
    return;
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', config.permissionMode,
  ];

  if (sessionId) {
    args.push('--resume', sessionId);
  }

  args.push(message);

  const proc = spawn(config.claudePath, args, {
    cwd: config.workingDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const trackingId = sessionId || 'pending-' + Date.now();
  activeSessions.set(trackingId, proc);

  let capturedSessionId: string | null = sessionId || null;
  let buffer = '';

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const event = parseClaudeEvent(parsed);
        if (event) {
          onEvent(event);
        }

        // Capture session ID from init event
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
        }

        // Capture session ID from result event
        if (parsed.type === 'result' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
          const usage = parsed.usage;
          const cost = parsed.total_cost_usd;
          onEvent({
            type: 'done',
            data: JSON.stringify({
              session_id: parsed.session_id,
              duration_ms: parsed.duration_ms,
              cost_usd: cost,
              input_tokens: usage?.input_tokens,
              output_tokens: usage?.output_tokens,
            }),
          });
        }
      } catch {
        // Non-JSON line, skip
      }
    }
  });

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    // Filter out expected hook noise
    if (text && !text.includes('Hook cancelled') && !text.includes('hook')) {
      onEvent({ type: 'error', data: text });
    }
  });

  proc.on('close', (code) => {
    activeSessions.delete(trackingId);
    if (capturedSessionId && trackingId !== capturedSessionId) {
      activeSessions.delete(capturedSessionId);
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.type === 'result' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
        }
      } catch {
        // ignore
      }
    }

    if (code !== 0 && code !== null) {
      onEvent({ type: 'error', data: `Claude process exited with code ${code}` });
    }
    onClose(capturedSessionId);
  });

  proc.on('error', (err) => {
    activeSessions.delete(trackingId);
    onEvent({ type: 'error', data: `Failed to spawn claude: ${err.message}` });
    onClose(null);
  });
}

function parseClaudeEvent(parsed: any): StreamEvent | null {
  // Init event
  if (parsed.type === 'system' && parsed.subtype === 'init') {
    return { type: 'init', data: JSON.stringify({ session_id: parsed.session_id }) };
  }

  // Stream events
  if (parsed.type === 'stream_event' && parsed.event) {
    const evt = parsed.event;

    // Text delta
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
      return { type: 'text', data: evt.delta.text };
    }

    // Thinking delta
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'thinking_delta') {
      return { type: 'thinking', data: evt.delta.thinking };
    }

    // Tool use start
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      return {
        type: 'tool_use',
        data: JSON.stringify({
          id: evt.content_block.id,
          name: evt.content_block.name,
        }),
      };
    }

    // Tool result
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_result') {
      return {
        type: 'tool_result',
        data: JSON.stringify({
          tool_use_id: evt.content_block.tool_use_id,
          content: evt.content_block.content,
        }),
      };
    }
  }

  // Assistant message with tool results
  if (parsed.type === 'assistant' && parsed.message?.content) {
    for (const block of parsed.message.content) {
      if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          data: JSON.stringify({ id: block.id, name: block.name, input: block.input }),
        };
      }
    }
  }

  return null;
}
