import * as fs from 'fs';

import type { StreamChunk, UsageInfo } from '../../../core/types/chat';
import { findCodexSessionFile } from '../history/CodexHistoryStore';
import {
  isCodexToolOutputError,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
} from '../normalization';

// ---------------------------------------------------------------------------
// Model-specific context windows
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT_WINDOW = 200_000;

export const CODEX_CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'gpt-5.2': 400_000,
  'gpt-5.3-codex': 400_000,
  'gpt-5.3-codex-spark': 128_000,
};

export function getCodexContextWindow(model?: string): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  return CODEX_CONTEXT_WINDOW_BY_MODEL[model] ?? DEFAULT_CONTEXT_WINDOW;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function getNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parsePayloadValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function stringifyPayloadValue(raw: unknown): string {
  try {
    const result = JSON.stringify(raw);
    return typeof result === 'string' ? result : String(raw);
  } catch {
    return String(raw);
  }
}

export function extractResponseItemMessageText(raw: unknown): string {
  if (!Array.isArray(raw)) return '';

  return raw
    .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .join('');
}

export function extractResponseItemReasoningText(raw: Record<string, unknown>): string {
  if (Array.isArray(raw.summary) && raw.summary.length > 0) {
    return raw.summary
      .map(part => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
  }

  return typeof raw.text === 'string' ? raw.text : '';
}

// ---------------------------------------------------------------------------
// SessionTailState
// ---------------------------------------------------------------------------

export interface ResponseItemTailState {
  emittedToolUseIds: Set<string>;
  emittedToolResultIds: Set<string>;
  knownCalls: Map<string, { toolName: string; toolInput: unknown }>;
}

export interface SessionTailState {
  responseItemState: ResponseItemTailState;
  currentTurnId: string | null;
  syntheticTurnCounter: number;
  lastTextByTurn: Map<string, string>;
  lastThinkingByTurn: Map<string, string>;
  pendingUsageByTurn: Map<string, { contextTokens: number; contextWindow: number }>;
  emittedDoneByTurn: Set<string>;
  emittedUsageByTurn: Set<string>;
}

export function createSessionTailState(): SessionTailState {
  return {
    responseItemState: {
      emittedToolUseIds: new Set(),
      emittedToolResultIds: new Set(),
      knownCalls: new Map(),
    },
    currentTurnId: null,
    syntheticTurnCounter: 0,
    lastTextByTurn: new Map(),
    lastThinkingByTurn: new Map(),
    pendingUsageByTurn: new Map(),
    emittedDoneByTurn: new Set(),
    emittedUsageByTurn: new Set(),
  };
}

// ---------------------------------------------------------------------------
// Turn ID resolution
// ---------------------------------------------------------------------------

export function resolveTurnId(
  state: SessionTailState,
  preferredTurnId: string | undefined,
): string {
  if (preferredTurnId) return preferredTurnId;
  if (state.currentTurnId) return state.currentTurnId;
  const id = `synthetic-turn-${state.syntheticTurnCounter}`;
  state.syntheticTurnCounter += 1;
  return id;
}

// ---------------------------------------------------------------------------
// Unhandled event type tracking (log-once)
// ---------------------------------------------------------------------------

const reportedUnhandledSessionEventTypes = new Set<string>();

// ---------------------------------------------------------------------------
// Top-level dispatcher
// ---------------------------------------------------------------------------

export function mapSessionFileEvent(
  event: Record<string, unknown>,
  sessionId: string,
  lineIndex: number,
  state: SessionTailState,
): StreamChunk[] {
  const eventType = event.type as string | undefined;

  if (eventType === 'event_msg') {
    const payload = (event.payload ?? event) as Record<string, unknown>;
    return mapEventMsgEvent(payload, sessionId, state);
  }

  if (eventType === 'response_item') {
    return mapResponseItemEvent(event, sessionId, lineIndex, state);
  }

  if (eventType && !reportedUnhandledSessionEventTypes.has(eventType)) {
    reportedUnhandledSessionEventTypes.add(eventType);
  }

  return [];
}

// ---------------------------------------------------------------------------
// event_msg handler
// ---------------------------------------------------------------------------

export function mapEventMsgEvent(
  payload: Record<string, unknown>,
  sessionId: string,
  state: SessionTailState,
): StreamChunk[] {
  const payloadType = payload.type as string | undefined;
  const info = isRecord(payload.info) ? payload.info : {};

  switch (payloadType) {
    case 'task_started': {
      const turnId = getNonEmptyString(
        info.id,
        getNonEmptyString(payload.turn_id, `synthetic-turn-${state.syntheticTurnCounter++}`),
      );
      state.currentTurnId = turnId;
      return [];
    }

    case 'task_complete': {
      const turnId = resolveTurnId(state, undefined);
      const chunks: StreamChunk[] = [];

      if (!state.emittedUsageByTurn.has(turnId)) {
        const pending = state.pendingUsageByTurn.get(turnId);
        if (pending) {
          const usage = buildUsageInfo(pending.contextTokens, pending.contextWindow);
          chunks.push({ type: 'usage', usage, sessionId });
          state.emittedUsageByTurn.add(turnId);
        }
      }

      if (!state.emittedDoneByTurn.has(turnId)) {
        chunks.push({ type: 'done' });
        state.emittedDoneByTurn.add(turnId);
      }

      return chunks;
    }

    case 'turn_aborted': {
      const turnId = resolveTurnId(state, undefined);
      const chunks: StreamChunk[] = [];

      if (!state.emittedDoneByTurn.has(turnId)) {
        chunks.push({ type: 'done' });
        state.emittedDoneByTurn.add(turnId);
      }

      return chunks;
    }

    case 'user_message':
      return [];

    case 'agent_message': {
      const turnId = resolveTurnId(state, undefined);
      const fullText = typeof payload.text === 'string'
        ? payload.text
        : typeof payload.message === 'string'
          ? payload.message
          : '';
      if (!fullText) return [];

      const lastText = state.lastTextByTurn.get(turnId) ?? '';
      if (fullText.length <= lastText.length) return [];

      const delta = fullText.slice(lastText.length);
      state.lastTextByTurn.set(turnId, fullText);
      return [{ type: 'text', content: delta }];
    }

    case 'agent_reasoning': {
      const turnId = resolveTurnId(state, undefined);
      const fullText = typeof payload.text === 'string' ? payload.text : '';
      if (!fullText) return [];

      const lastThinking = state.lastThinkingByTurn.get(turnId) ?? '';
      if (fullText.length <= lastThinking.length) return [];

      const delta = fullText.slice(lastThinking.length);
      state.lastThinkingByTurn.set(turnId, fullText);
      return [{ type: 'thinking', content: delta }];
    }

    case 'token_count': {
      const turnId = resolveTurnId(state, undefined);
      const lastTokenUsage = isRecord(info.last_token_usage) ? info.last_token_usage : {};
      const inputTokens = typeof lastTokenUsage.input === 'number' ? lastTokenUsage.input : 0;
      const contextWindow = typeof info.model_context_window === 'number'
        ? info.model_context_window
        : DEFAULT_CONTEXT_WINDOW;

      state.pendingUsageByTurn.set(turnId, {
        contextTokens: inputTokens,
        contextWindow,
      });
      return [];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// response_item handler
// ---------------------------------------------------------------------------

export function mapResponseItemEvent(
  event: Record<string, unknown>,
  sessionId: string,
  lineIndex: number,
  state: SessionTailState,
): StreamChunk[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  const payloadType = payload.type as string | undefined;
  const riState = state.responseItemState;

  switch (payloadType) {
    case 'message': {
      if (payload.role !== 'assistant') return [];

      const turnId = resolveTurnId(state, undefined);
      const fullText = extractResponseItemMessageText(payload.content);
      if (!fullText) return [];

      const lastText = state.lastTextByTurn.get(turnId) ?? '';
      if (fullText.length <= lastText.length) return [];

      const delta = fullText.slice(lastText.length);
      state.lastTextByTurn.set(turnId, fullText);
      return [{ type: 'text', content: delta }];
    }

    case 'reasoning': {
      const turnId = resolveTurnId(state, undefined);
      const fullText = extractResponseItemReasoningText(payload);
      if (!fullText) return [];

      const lastThinking = state.lastThinkingByTurn.get(turnId) ?? '';
      if (fullText.length <= lastThinking.length) return [];

      const delta = fullText.slice(lastThinking.length);
      state.lastThinkingByTurn.set(turnId, fullText);
      return [{ type: 'thinking', content: delta }];
    }

    case 'function_call':
    case 'custom_tool_call': {
      const callId = getNonEmptyString(payload.call_id, `tail-call-${lineIndex}`);
      if (riState.emittedToolUseIds.has(callId)) return [];
      riState.emittedToolUseIds.add(callId);

      const rawName = typeof payload.name === 'string' ? payload.name : undefined;
      const rawArgs = typeof payload.arguments === 'string'
        ? payload.arguments
        : typeof payload.input === 'string'
          ? payload.input
          : undefined;
      const parsedArgs = parseCodexArguments(rawArgs);
      const normalizedName = normalizeCodexToolName(rawName);
      const normalizedInput = normalizeCodexToolInput(rawName, parsedArgs);

      riState.knownCalls.set(callId, { toolName: normalizedName, toolInput: normalizedInput });

      return [{
        type: 'tool_use',
        id: callId,
        name: normalizedName,
        input: normalizedInput,
      }];
    }

    case 'web_search_call': {
      const callId = getNonEmptyString(payload.call_id, `tail-ws-${lineIndex}`);
      if (riState.emittedToolUseIds.has(callId)) return [];
      riState.emittedToolUseIds.add(callId);

      const input = normalizeCodexToolInput('web_search_call', {
        action: payload.action ?? {},
      });

      riState.knownCalls.set(callId, { toolName: 'WebSearch', toolInput: input });

      return [{
        type: 'tool_use',
        id: callId,
        name: 'WebSearch',
        input,
      }];
    }

    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = getNonEmptyString(payload.call_id, `tail-out-${lineIndex}`);
      if (riState.emittedToolResultIds.has(callId)) return [];
      riState.emittedToolResultIds.add(callId);

      const rawOutput = typeof payload.output === 'string' ? payload.output : stringifyPayloadValue(payload.output);
      const known = riState.knownCalls.get(callId);
      const normalizedName = known?.toolName ?? 'tool';
      const content = normalizeCodexToolResult(normalizedName, rawOutput);

      return [{
        type: 'tool_result',
        id: callId,
        content,
        isError: isCodexToolOutputError(rawOutput),
      }];
    }

    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Usage builder
// ---------------------------------------------------------------------------

function buildUsageInfo(contextTokens: number, contextWindow: number): UsageInfo {
  return {
    inputTokens: contextTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    contextWindow,
    contextTokens,
    percentage: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0,
  };
}

// ---------------------------------------------------------------------------
// File-tail polling engine
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class CodexFileTailEngine {
  private tailState: SessionTailState = createSessionTailState();
  private tailSessionFile: string | null = null;
  private tailLineCursor = 0;
  private pendingEvents: StreamChunk[] = [];
  private pollingActive = false;
  private pollPromise: Promise<void> | null = null;
  private lastEventAt = 0;
  private lastPollAt = 0;
  private consecutiveReadFailures = 0;

  private _turnCompleteEmitted = false;
  private _usageEmitted = false;

  constructor(
    private sessionsDir: string,
    private defaultContextWindow: number,
  ) {}

  get turnCompleteEmitted(): boolean {
    return this._turnCompleteEmitted;
  }

  get usageEmitted(): boolean {
    return this._usageEmitted;
  }

  async primeCursor(sessionId: string): Promise<void> {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return;

    const lines = this.readFileLines(filePath);
    this.tailLineCursor = lines.length;
  }

  startPolling(sessionId: string): void {
    this.pollingActive = true;
    this.pollPromise = this.pollLoop(sessionId);
  }

  async stopPolling(): Promise<void> {
    this.pollingActive = false;
    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = null;
    }
  }

  async waitForSettle(): Promise<void> {
    const maxWait = 2500;
    const checkInterval = 80;
    const idleThreshold = 500;
    const pollRecencyThreshold = 250;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const now = Date.now();
      const idle = this.lastEventAt > 0 ? now - this.lastEventAt : now - start;
      const pollRecent = this.lastPollAt > 0 && (now - this.lastPollAt) < pollRecencyThreshold;

      if (idle >= idleThreshold && pollRecent) {
        return;
      }

      await sleep(checkInterval);
    }
  }

  collectPendingEvents(): StreamChunk[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }

  resetForNewTurn(): void {
    this.tailState = createSessionTailState();
    this.pendingEvents = [];
    this._turnCompleteEmitted = false;
    this._usageEmitted = false;
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private async pollLoop(sessionId: string): Promise<void> {
    while (this.pollingActive) {
      const events = this.drainSessionFileEvents(sessionId);
      if (events.length > 0) {
        this.pendingEvents.push(...events);
        this.lastEventAt = Date.now();
        this.trackTailFlags(events);
      }
      this.lastPollAt = Date.now();
      await sleep(100);
    }

    // Final drain after stop
    const finalEvents = this.drainSessionFileEvents(sessionId);
    if (finalEvents.length > 0) {
      this.pendingEvents.push(...finalEvents);
      this.trackTailFlags(finalEvents);
    }
    this.lastPollAt = Date.now();
  }

  private drainSessionFileEvents(sessionId: string): StreamChunk[] {
    if (!sessionId) return [];

    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return [];

    let lines: string[];
    try {
      lines = this.readFileLines(filePath);
      this.consecutiveReadFailures = 0;
    } catch {
      this.consecutiveReadFailures += 1;
      if (this.consecutiveReadFailures >= 5) {
        throw new Error(`CodexFileTailEngine: 5 consecutive read failures for ${filePath}`);
      }
      return [];
    }

    // Handle rotation: cursor beyond file length
    if (this.tailLineCursor > lines.length) {
      this.tailLineCursor = 0;
    }

    if (this.tailLineCursor >= lines.length) return [];

    const newLines = lines.slice(this.tailLineCursor);
    const startIndex = this.tailLineCursor;
    this.tailLineCursor = lines.length;

    const chunks: StreamChunk[] = [];
    for (let i = 0; i < newLines.length; i++) {
      const line = newLines[i];
      if (!line.trim()) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const mapped = mapSessionFileEvent(parsed, sessionId, startIndex + i, this.tailState);
      chunks.push(...mapped);
    }

    return chunks;
  }

  private findSessionFile(sessionId: string): string | null {
    if (this.tailSessionFile) {
      try {
        if (fs.existsSync(this.tailSessionFile)) {
          return this.tailSessionFile;
        }
      } catch {
        // fall through and refind
      }

      this.tailSessionFile = null;
    }

    const filePath = findCodexSessionFile(sessionId, this.sessionsDir);
    if (filePath) {
      this.tailSessionFile = filePath;
    }

    return filePath;
  }

  private readFileLines(filePath: string): string[] {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(line => line.trim());
  }

  private trackTailFlags(events: StreamChunk[]): void {
    for (const event of events) {
      if (event.type === 'done') {
        this._turnCompleteEmitted = true;
      }
      if (event.type === 'usage') {
        this._usageEmitted = true;
      }
    }
  }
}
