export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'usage';
  content: string;
  timestamp: number;
}

export interface ChatSession {
  id: string;
  claudeSessionId: string | null;
  name: string;
  mode: 'work' | 'personal';
  workingDir?: string;
  created: string;
  lastActivity: string;
  lastMessage: string;
  messageCount: number;
  messages: ChatMessage[];
}

export interface StreamEvent {
  type: 'init' | 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'done';
  data: string;
}

export interface ClaudeRunnerOptions {
  sessionId?: string;
  appSessionId: string;
  message: string;
  model?: string;
  mode?: 'work' | 'personal';
  workingDir?: string;
  attachments?: Array<{ filename: string; path: string }>;
  onEvent: (event: StreamEvent) => void;
  onClose: (claudeSessionId: string | null) => void;
}
