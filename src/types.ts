export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'tool_result' | 'usage';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  claudeSessionId: string | null;
  name: string;
  model?: string;
  mode: 'work' | 'personal';
  workingDir?: string;
  created: string;
  lastActivity: string;
  lastMessage: string;
  messageCount: number;
  messages: ChatMessage[];
  archived?: boolean;
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
  message: string;
  model?: string;
  mode?: 'work' | 'personal';
  workingDir?: string;
  attachments?: Array<{ filename: string; path: string }>;
  onEvent: (event: StreamEvent) => void;
  onClose: (claudeSessionId: string | null) => void;
}
