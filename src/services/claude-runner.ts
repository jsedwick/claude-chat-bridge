import { spawn, ChildProcess } from 'child_process';
import { config } from '../config';
import { StreamEvent, ClaudeRunnerOptions } from '../types';

const activeSessions = new Map<string, ChildProcess>();
// Maps app session ID → tracking ID for cancel support (exported for shutdown cleanup)
export const appSessionMap = new Map<string, string>();
// Reverse map: Claude session ID → app session ID
const claudeToAppMap = new Map<string, string>();

// Stream buffering and pub/sub for reconnect support
interface ActiveStream {
  buffer: StreamEvent[];
  listeners: Set<(event: StreamEvent) => void>;
  done: boolean;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}
const activeStreams = new Map<string, ActiveStream>();
const STREAM_BUFFER_TTL = 60_000; // Keep buffer 60s after stream ends

function getOrCreateStream(appSessionId: string): ActiveStream {
  let stream = activeStreams.get(appSessionId);
  if (!stream) {
    stream = { buffer: [], listeners: new Set(), done: false };
    activeStreams.set(appSessionId, stream);
  } else if (stream.done) {
    // Reusing a stream from a previous message — cancel the pending cleanup
    // and reset for the new process. Without this, the old timeout would delete
    // the stream from the map while the new process is still emitting events.
    if (stream.cleanupTimer) clearTimeout(stream.cleanupTimer);
    stream.done = false;
    stream.buffer = [];
  }
  return stream;
}

export function emitToStream(appSessionId: string, event: StreamEvent): void {
  const stream = activeStreams.get(appSessionId);
  if (!stream) return;
  stream.buffer.push(event);
  for (const listener of stream.listeners) {
    listener(event);
  }
}

function closeStream(appSessionId: string): void {
  const stream = activeStreams.get(appSessionId);
  if (stream) {
    stream.done = true;
    // Cancel any existing cleanup timer before starting a new one —
    // prevents orphaned timeouts when closeStream is called multiple times
    // (e.g., early cleanup on done + proc.on('close') for monitor processes).
    if (stream.cleanupTimer) clearTimeout(stream.cleanupTimer);
    // Clean up after TTL — store handle so getOrCreateStream can cancel if reused
    stream.cleanupTimer = setTimeout(() => activeStreams.delete(appSessionId), STREAM_BUFFER_TTL);
  }
}

export function isStreamActive(appSessionId: string): boolean {
  const stream = activeStreams.get(appSessionId);
  return !!stream && !stream.done;
}

export function getStreamBuffer(appSessionId: string): StreamEvent[] | null {
  const stream = activeStreams.get(appSessionId);
  return stream ? [...stream.buffer] : null;
}

export function subscribeToStream(appSessionId: string, listener: (event: StreamEvent) => void): (() => void) | null {
  const stream = activeStreams.get(appSessionId);
  if (!stream) return null;
  stream.listeners.add(listener);
  return () => stream.listeners.delete(listener);
}

// Atomically get buffer snapshot and subscribe — no events can be missed between the two
export function subscribeWithBuffer(appSessionId: string, listener: (event: StreamEvent) => void): { buffer: StreamEvent[], unsubscribe: () => void } | null {
  const stream = activeStreams.get(appSessionId);
  if (!stream) return null;
  // Snapshot buffer and subscribe in same tick — emitToStream is synchronous
  const buffer = [...stream.buffer];
  stream.listeners.add(listener);
  return { buffer, unsubscribe: () => stream.listeners.delete(listener) };
}

export function getActiveSessionCount(): number {
  return activeSessions.size;
}

export function getActiveAppSessionIds(): string[] {
  return Array.from(appSessionMap.keys());
}

export function isSessionBusy(sessionId: string): boolean {
  // Check both maps: activeSessions is keyed by Claude session ID (or 'pending-...'),
  // appSessionMap is keyed by app session ID. When claudeSessionId hasn't been persisted
  // yet (process still running due to monitors), the caller falls back to appSessionId,
  // which only exists in appSessionMap.
  return activeSessions.has(sessionId) || appSessionMap.has(sessionId);
}

export function killSession(sessionId: string): void {
  const proc = activeSessions.get(sessionId);
  if (proc) {
    proc.kill('SIGTERM');
    activeSessions.delete(sessionId);
  }
}

export function cancelByAppSession(appSessionId: string): boolean {
  const trackingId = appSessionMap.get(appSessionId);
  if (trackingId) {
    killSession(trackingId);
    appSessionMap.delete(appSessionId);
    return true;
  }
  return false;
}

export function getAppSessionByClaudeId(claudeSessionId: string): string | undefined {
  return claudeToAppMap.get(claudeSessionId);
}

export function runClaude(options: ClaudeRunnerOptions): void {
  const { sessionId, forkFromSessionId, appSessionId, message, model, mode, workingDir, attachments, onEvent, onClose } = options;

  if (activeSessions.size >= config.maxConcurrentSessions && !activeSessions.has(sessionId || '')) {
    onEvent({ type: 'error', data: `Max concurrent sessions (${config.maxConcurrentSessions}) reached. Try again later.` });
    onClose(null);
    return;
  }

  // Build message content blocks
  const contentBlocks: Array<Record<string, unknown>> = [];

  // Add image content blocks from attachments
  if (attachments?.length) {
    for (const att of attachments) {
      const match = att.path.match(/^data:(image\/[^;]+);base64,(.+)$/s);
      if (match) {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: match[1],
            data: match[2],
          },
        });
      }
    }
  }

  // Add text content block
  contentBlocks.push({ type: 'text', text: message });

  const hasImages = contentBlocks.some(b => b.type === 'image');

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--dangerously-skip-permissions',
    '--plugin-dir', '/Users/jsedwick/Projects/obsidian-claude-plugin',
  ];

  if (hasImages) {
    args.push('--input-format', 'stream-json');
  }

  if (model) {
    args.push('--model', model);
  }

  if (mode && mode !== 'work') {
    args.push('--append-system-prompt', `You are in ${mode} mode. Run /vault:${mode} at the start of this session to load the correct vault context.`);
  }

  if (sessionId) {
    args.push('--resume', sessionId);
  } else if (forkFromSessionId) {
    args.push('--resume', forkFromSessionId, '--fork-session');
  }

  // When no images, pass message as CLI arg (simpler)
  if (!hasImages) {
    args.push(message);
  }

  const proc = spawn(config.claudePath, args, {
    cwd: workingDir || config.workingDir,
    env: { ...process.env, CHAT_BRIDGE_SESSION: appSessionId, ...(mode ? { VAULT_MODE: mode } : {}) },
    stdio: [hasImages ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });

  // Pipe image+text content via stdin for stream-json input
  if (hasImages && proc.stdin) {
    const inputMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
    });
    proc.stdin.write(inputMessage + '\n');
    proc.stdin.end();
  }

  const trackingId = sessionId || 'pending-' + Date.now();
  activeSessions.set(trackingId, proc);
  appSessionMap.set(appSessionId, trackingId);

  // Set up stream buffer and register initial listener
  const stream = getOrCreateStream(appSessionId);
  stream.listeners.add(onEvent);

  let capturedSessionId: string | null = sessionId || null;
  let authFailed = false;
  let buffer = '';

  proc.stdout!.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // Log raw events for Bash tool use debugging
        if (parsed.type === 'user' && parsed.message?.content?.some((b: any) => b.type === 'tool_result')) {
          for (const b of parsed.message.content) {
            if (b.type === 'tool_result') {
              const preview = typeof b.content === 'string' ? b.content.substring(0, 300) : JSON.stringify(b.content)?.substring(0, 300);
              console.log(`[debug:${appSessionId.slice(0,8)}] RAW_TOOL_RESULT id=${b.tool_use_id?.slice(0,8)} is_error=${b.is_error} preview=${preview}`);
            }
          }
        }
        // Reset streamedText when we see a user message (tool_result), which marks
        // the boundary between assistant turns. Do NOT reset on assistant events —
        // with --include-partial-messages, partial assistant snapshots arrive during
        // streaming and would clear the dedup flag, causing snapshot text to re-emit
        // on top of already-streamed text_delta content.
        if (parsed.type === 'user') {
          resetStreamedText(appSessionId);
        }

        const result = parseClaudeEvent(parsed, getEmittedToolIds(appSessionId), hasStreamedText(appSessionId));
        if (result) {
          const events = Array.isArray(result) ? result : [result];
          for (const event of events) {
            if (event.type === 'text') {
              console.log(`[debug:${appSessionId.slice(0,8)}] TEXT_EMIT len=${(event.data as string).length} streamed=${hasStreamedText(appSessionId)}`);
              markStreamedText(appSessionId);
            } else if (event.type === 'tool_use') {
              const toolData = JSON.parse(event.data as string);
              console.log(`[debug:${appSessionId.slice(0,8)}] TOOL_USE name=${toolData.name} id=${toolData.id?.slice(0,8)}`);
            } else if (event.type === 'tool_result') {
              const resultData = JSON.parse(event.data as string);
              const preview = typeof resultData.content === 'string' ? resultData.content.substring(0, 200) : JSON.stringify(resultData.content)?.substring(0, 200);
              console.log(`[debug:${appSessionId.slice(0,8)}] TOOL_RESULT id=${resultData.tool_use_id?.slice(0,8)} preview=${preview}`);
            }
            emitToStream(appSessionId, event);
          }
        } else if (parsed.type === 'assistant' || parsed.type === 'stream_event') {
          // Log when assistant/stream events produce no output (potential text loss)
          const hasText = parsed.type === 'assistant' && parsed.message?.content?.some((b: any) => b.type === 'text' && b.text);
          if (hasText) {
            console.log(`[debug:${appSessionId.slice(0,8)}] TEXT_SKIPPED type=${parsed.type} streamedText=${hasStreamedText(appSessionId)}`);
          }
        }

        // Capture session ID from init event
        if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
          claudeToAppMap.set(parsed.session_id, appSessionId);
        }

        // Detect authentication failure
        if (parsed.type === 'assistant' && parsed.error === 'authentication_failed') {
          authFailed = true;
          emitToStream(appSessionId, {
            type: 'error',
            data: 'Claude authentication expired. Please run `claude` in a terminal and log in, then try again.',
          });
        }

        // Surface API errors (500, overloaded, rate_limit, etc.)
        if (parsed.type === 'error' || (parsed.error && parsed.type !== 'assistant')) {
          const errMsg = parsed.error?.message || parsed.message || JSON.stringify(parsed.error || parsed);
          emitToStream(appSessionId, {
            type: 'error',
            data: `API error: ${errMsg}`,
          });
        }

        // Capture session ID from result event
        if (parsed.type === 'result' && parsed.session_id) {
          capturedSessionId = parsed.session_id;
          const usage = parsed.usage;
          const cost = parsed.total_cost_usd;
          emitToStream(appSessionId, {
            type: 'done',
            data: JSON.stringify({
              session_id: parsed.session_id,
              duration_ms: parsed.duration_ms,
              cost_usd: cost,
              input_tokens: usage?.input_tokens,
              output_tokens: usage?.output_tokens,
              cache_creation_input_tokens: usage?.cache_creation_input_tokens,
              cache_read_input_tokens: usage?.cache_read_input_tokens,
              // Include final response text for recovery when text_delta events are lost
              result_text: typeof parsed.result === 'string' ? parsed.result : undefined,
            }),
          });

          // Clean up immediately on done — don't wait for process exit.
          // With plugin monitors, the CLI process outlives the response indefinitely,
          // leaving the session in activeSessions/appSessionMap (blocks new sessions,
          // causes sidebar pulse, and allows duplicate message sends).
          activeSessions.delete(trackingId);
          appSessionMap.delete(appSessionId);
          if (capturedSessionId) {
            claudeToAppMap.delete(capturedSessionId);
            if (trackingId !== capturedSessionId) {
              activeSessions.delete(capturedSessionId);
            }
          }
          // Remove this listener so events from a future process on the same
          // session don't trigger duplicate saves via this closure's onEvent.
          stream.listeners.delete(onEvent);
          // Mark stream as done so reconnect replays buffer instead of
          // subscribing and waiting for a process that's only running monitors.
          closeStream(appSessionId);
        }
      } catch {
        // Non-JSON line — check if it looks like an error message from Claude Code
        const trimmed = line.trim();
        if (trimmed && /error|failed|overloaded|rate.?limit/i.test(trimmed)) {
          emitToStream(appSessionId, { type: 'error', data: trimmed });
        }
      }
    }
  });

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (!text) return;
    // Ignore session-end hook failures — expected in -p mode
    if (text.includes('SessionEnd') || text.includes('session-end')) return;
    // Surface hook failures as errors so the user can see what was blocked
    if (text.includes('Hook cancelled') || text.includes('hook')) {
      emitToStream(appSessionId, { type: 'error', data: `Hook: ${text}` });
    } else if (/error|ENOENT|EACCES|EPERM|fatal|panic|crash/i.test(text)) {
      // Only emit stderr as error if it looks like an actual error
      emitToStream(appSessionId, { type: 'error', data: text });
    }
    // Verbose/informational stderr output is silently dropped
  });

  proc.on('close', (code) => {
    activeSessions.delete(trackingId);
    appSessionMap.delete(appSessionId);
    resetStreamedText(appSessionId);
    if (capturedSessionId) {
      claudeToAppMap.delete(capturedSessionId);
      if (trackingId !== capturedSessionId) {
        activeSessions.delete(capturedSessionId);
      }
    }

    // Process any remaining buffer — emit events, not just capture session ID
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'user') {
            resetStreamedText(appSessionId);
          }
          const result = parseClaudeEvent(parsed, getEmittedToolIds(appSessionId), hasStreamedText(appSessionId));
          if (result) {
            const events = Array.isArray(result) ? result : [result];
            for (const event of events) {
              if (event.type === 'text') markStreamedText(appSessionId);
              else if (event.type === 'tool_use') {
                const toolData = JSON.parse(event.data as string);
                console.log(`[debug:${appSessionId.slice(0,8)}] TOOL_USE name=${toolData.name} id=${toolData.id?.slice(0,8)}`);
              } else if (event.type === 'tool_result') {
                const resultData = JSON.parse(event.data as string);
                const preview = typeof resultData.content === 'string' ? resultData.content.substring(0, 200) : JSON.stringify(resultData.content)?.substring(0, 200);
                console.log(`[debug:${appSessionId.slice(0,8)}] TOOL_RESULT id=${resultData.tool_use_id?.slice(0,8)} preview=${preview}`);
              }
              emitToStream(appSessionId, event);
            }
          }
          if (parsed.type === 'result' && parsed.session_id) {
            capturedSessionId = parsed.session_id;
            const usage = parsed.usage;
            const cost = parsed.total_cost_usd;
            emitToStream(appSessionId, {
              type: 'done',
              data: JSON.stringify({
                session_id: parsed.session_id,
                duration_ms: parsed.duration_ms,
                cost_usd: cost,
                input_tokens: usage?.input_tokens,
                output_tokens: usage?.output_tokens,
                cache_creation_input_tokens: usage?.cache_creation_input_tokens,
                cache_read_input_tokens: usage?.cache_read_input_tokens,
                result_text: typeof parsed.result === 'string' ? parsed.result : undefined,
              }),
            });
          }
        } catch {
          const trimmed = line.trim();
          if (trimmed && /error|failed|overloaded|rate.?limit/i.test(trimmed)) {
            emitToStream(appSessionId, { type: 'error', data: trimmed });
          }
        }
      }
    }

    if (code !== 0 && code !== null && !authFailed) {
      emitToStream(appSessionId, { type: 'error', data: `Claude process exited with code ${code}` });
    }

    // Remove the initial listener and close the stream
    sessionToolUseIds.delete(appSessionId);
    stream.listeners.delete(onEvent);
    closeStream(appSessionId);
    onClose(capturedSessionId);
  });

  proc.on('error', (err) => {
    activeSessions.delete(trackingId);
    emitToStream(appSessionId, { type: 'error', data: `Failed to spawn claude: ${err.message}` });
    stream.listeners.delete(onEvent);
    closeStream(appSessionId);
    onClose(null);
  });
}

// Track tool_use IDs per session to avoid duplicates
const sessionToolUseIds = new Map<string, Set<string>>();
// Track whether text has been streamed via deltas (to skip duplicate in assistant snapshot)
const sessionStreamedText = new Map<string, boolean>();

function getEmittedToolIds(appSessionId: string): Set<string> {
  let ids = sessionToolUseIds.get(appSessionId);
  if (!ids) {
    ids = new Set();
    sessionToolUseIds.set(appSessionId, ids);
  }
  return ids;
}

function hasStreamedText(appSessionId: string): boolean {
  return sessionStreamedText.get(appSessionId) || false;
}

function markStreamedText(appSessionId: string): void {
  sessionStreamedText.set(appSessionId, true);
}

function resetStreamedText(appSessionId: string): void {
  sessionStreamedText.delete(appSessionId);
}

function parseClaudeEvent(parsed: any, emittedToolUseIds: Set<string>, streamedText: boolean): StreamEvent | StreamEvent[] | null {
  // Init event
  if (parsed.type === 'system' && parsed.subtype === 'init') {
    return { type: 'init', data: JSON.stringify({ session_id: parsed.session_id }) };
  }

  // Assistant message — contains complete tool_use and text blocks (including input)
  if (parsed.type === 'assistant' && parsed.message?.content) {
    const events: StreamEvent[] = [];
    for (const block of parsed.message.content) {
      // Only emit text from snapshot if it wasn't already streamed via text_delta events
      if (block.type === 'text' && block.text && !streamedText) {
        events.push({ type: 'text', data: block.text });
      }
      if (block.type === 'tool_use') {
        const alreadyEmitted = emittedToolUseIds.has(block.id);
        emittedToolUseIds.add(block.id);
        events.push({
          type: 'tool_use',
          data: JSON.stringify({ id: block.id, name: block.name, input: block.input, _update: alreadyEmitted }),
        });
      }
    }
    return events.length > 0 ? events : null;
  }

  // User message with tool_result
  if (parsed.type === 'user' && parsed.message?.content) {
    const events: StreamEvent[] = [];
    for (const block of parsed.message.content) {
      if (block.type === 'tool_result') {
        events.push({
          type: 'tool_result',
          data: JSON.stringify({
            tool_use_id: block.tool_use_id,
            content: block.content,
          }),
        });
      }
    }
    return events.length > 0 ? events : null;
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

    // Tool use start (from stream)
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      if (emittedToolUseIds.has(evt.content_block.id)) return null;
      emittedToolUseIds.add(evt.content_block.id);
      return {
        type: 'tool_use',
        data: JSON.stringify({
          id: evt.content_block.id,
          name: evt.content_block.name,
        }),
      };
    }

    // Tool result (from stream)
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

  return null;
}
