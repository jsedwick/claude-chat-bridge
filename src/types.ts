export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'tool_result' | 'usage';
  content: string;
  timestamp: number;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

export interface ChatSession {
  id: string;
  claudeSessionId: string | null;
  name: string;
  model?: string;
  effort?: EffortLevel;
  mode: 'work' | 'personal';
  workingDir?: string;
  created: string;
  lastActivity: string;
  lastMessage: string;
  messageCount: number;
  messages: ChatMessage[];
  archived?: boolean;
  trashed?: boolean;
  trashedAt?: string;
  closedAt?: string;
  handoff?: string;
  sessionFilePath?: string;
  usedCodeFile?: boolean;
  usedVaultDoc?: boolean;
  usedAgent?: boolean;
  forkedFrom?: {
    sessionId: string;
    sessionName: string;
    messageIndex: number;
    parentWorkingDir?: string;
    direction?: 'up' | 'down';
  };
}

export interface StreamEvent {
  type: 'init' | 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'done' | 'permission_request';
  data: string;
}

export interface ClaudeRunnerOptions {
  sessionId?: string;
  forkFromSessionId?: string;
  appSessionId: string;
  // Parent bridge ChatSession.id when this spawn is for a forked session.
  // Exported as CHAT_BRIDGE_FORKED_FROM so obsidian-mcp-server can walk the
  // recovery-file lineage chain (Decision 070) and capture pre-fork edits.
  forkedFromAppSessionId?: string;
  message: string;
  model?: string;
  effort?: EffortLevel;
  mode?: 'work' | 'personal';
  workingDir?: string;
  attachments?: Array<{ filename: string; path: string }>;
  // Prior conversation messages injected into the system prompt as historical
  // context. Used on the first turn of an amnesiac fork-down so Claude can
  // respond coherently without --resume'ing the parent session.
  priorContext?: ChatMessage[];
  onEvent: (event: StreamEvent) => void;
  onClose: (claudeSessionId: string | null) => void;
}
