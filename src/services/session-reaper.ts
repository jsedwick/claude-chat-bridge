import { config } from '../config';
import { cancelByAppSession, appSessionMap } from './claude-runner';
import { clearSessionPermissions } from './permissions';
import { listAllSessions, archiveSession, deleteSession } from './session-store';

export function cleanupSessionResources(sessionId: string): void {
  cancelByAppSession(sessionId);
  clearSessionPermissions(sessionId);
}

export function startReaper(): NodeJS.Timeout {
  return setInterval(() => {
    const now = Date.now();
    const sessions = listAllSessions();

    for (const session of sessions) {
      const age = now - new Date(session.lastActivity).getTime();

      if (!session.archived && age > config.autoArchiveAfterMs) {
        console.log(`[reaper] Auto-archiving session "${session.name}" (inactive ${Math.round(age / 86400000)}d)`);
        cleanupSessionResources(session.id);
        archiveSession(session.id);
      } else if (session.archived && age > config.autoDeleteAfterMs) {
        console.log(`[reaper] Auto-deleting archived session "${session.name}" (inactive ${Math.round(age / 86400000)}d)`);
        cleanupSessionResources(session.id);
        deleteSession(session.id);
      }
    }
  }, config.sessionTimeoutMs);
}

export function shutdownAll(): void {
  for (const appSessionId of appSessionMap.keys()) {
    cancelByAppSession(appSessionId);
  }
}
