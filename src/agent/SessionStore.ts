import * as path from 'path';
import { FileService } from '../services/FileService';
import { OllamaMessage } from '../tools/ToolTypes';
import { OutputLimiter } from '../services/OutputLimiter';
import { Logger } from '../services/Logger';

export interface Session {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  workspaceRoot: string;
  messages: OllamaMessage[];
}

export class SessionStore {
  private sessionsDir: string;

  constructor(workspaceRoot: string) {
    this.sessionsDir = path.join(workspaceRoot, '.ollama-agent', 'sessions');
  }

  async save(session: Session): Promise<void> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${session.sessionId}.json`);
      // Truncate tool content before persisting to avoid huge files
      const condensed: Session = {
        ...session,
        messages: session.messages.map((m) => {
          if (m.role === 'tool' && m.content.length > 2000) {
            return { ...m, content: OutputLimiter.truncate(m.content, 2000, 'tool result').text };
          }
          return m;
        }),
      };
      await FileService.writeText(sessionPath, JSON.stringify(condensed, null, 2));
    } catch (error) {
      Logger.error('Failed to save session:', error);
      // Session persistence is best-effort, but we should log errors
    }
  }

  async load(sessionId: string): Promise<Session | null> {
    try {
      const sessionPath = path.join(this.sessionsDir, `${sessionId}.json`);
      const text = await FileService.readText(sessionPath);
      return JSON.parse(text) as Session;
    } catch (error) {
      Logger.error('Failed to load session:', error);
      return null;
    }
  }

    async list(): Promise<string[]> {
      try {
        const fs = await import('fs/promises');
        const entries = await fs.readdir(this.sessionsDir);
        return entries.filter((e) => e.endsWith('.json')).map((e) => e.replace('.json', ''));
      } catch (error) {
        Logger.error('Failed to list sessions:', error);
        return [];
      }
    }

  // Get all session IDs
  getSessionIds(): string[] {
    // This is a placeholder implementation - in a real implementation,
    // you would need to parse the JSON files or maintain an index
    return [];
  }

  // Check if a session exists
  hasSession(sessionId: string): boolean {
    // This is a placeholder implementation - in a real implementation,
    // you would check if the session file exists
    return false;
  }
}
