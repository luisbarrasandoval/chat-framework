import type { ChatMemory, SessionSnapshot } from '../types.js';

export interface InMemoryChatMemoryOptions {
  maxTurns?: number;
}

export class InMemoryChatMemory implements ChatMemory {
  private readonly maxTurns: number;
  private readonly sessions = new Map<string, SessionSnapshot>();

  constructor(options: InMemoryChatMemoryOptions = {}) {
    this.maxTurns = options.maxTurns ?? 6;
  }

  getSession(chatId: string, initialState: string): SessionSnapshot {
    let session = this.sessions.get(chatId);
    if (!session) {
      session = {
        currentState: initialState,
        previousState: null,
        history: [initialState],
        context: {},
        turns: [],
        allowedIds: {},
      };
      this.sessions.set(chatId, session);
    }
    return session;
  }

  recordTransition(
    chatId: string,
    params: {
      nextState: string;
      context: Record<string, any>;
      summary?: string;
      userMessage?: string;
      event?: string;
      exposedIds?: Record<string, string[]>;
    },
  ): SessionSnapshot {
    const session = this.getSession(chatId, params.nextState);
    const prev = session.currentState;

    session.previousState = prev;
    session.currentState = params.nextState;
    session.history.push(params.nextState);
    session.context = { ...params.context };

    if (params.exposedIds) {
      for (const [field, ids] of Object.entries(params.exposedIds)) {
        this.registerAllowedIds(chatId, field, ids);
      }
    }

    if (params.summary) {
      session.turns.push({
        userMessage: params.userMessage,
        event: params.event,
        state: params.nextState,
        summary: params.summary,
        timestamp: Date.now(),
      });

      if (session.turns.length > this.maxTurns) {
        session.turns.splice(0, session.turns.length - this.maxTurns);
      }
    }

    return session;
  }

  isIdAllowed(chatId: string, field: string, value: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    const set = session.allowedIds[field];
    return Boolean(set && set.has(value));
  }

  registerAllowedIds(chatId: string, field: string, values: string[]): void {
    const session = this.sessions.get(chatId);
    if (!session) return;
    if (!session.allowedIds[field]) {
      session.allowedIds[field] = new Set();
    }
    for (const v of values) {
      if (v) session.allowedIds[field].add(String(v));
    }
  }

  clearSession(chatId: string): void {
    this.sessions.delete(chatId);
  }
}
