import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CodexFileTailEngine,
  createSessionTailState,
  getCodexContextWindow,
  getNonEmptyString,
  isRecord,
  mapEventMsgEvent,
  mapResponseItemEvent,
  mapSessionFileEvent,
  parsePayloadValue,
  resolveTurnId,
  type SessionTailState,
  stringifyPayloadValue,
} from '@/providers/codex/runtime/CodexSessionFileTail';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<SessionTailState> = {}): SessionTailState {
  return { ...createSessionTailState(), ...overrides };
}

// ---------------------------------------------------------------------------
// Pure utility functions
// ---------------------------------------------------------------------------

describe('getNonEmptyString', () => {
  it('returns value when it is a non-empty string', () => {
    expect(getNonEmptyString('hello', 'default')).toBe('hello');
  });

  it('returns fallback when value is empty string', () => {
    expect(getNonEmptyString('', 'default')).toBe('default');
  });

  it('returns fallback when value is not a string', () => {
    expect(getNonEmptyString(42, 'default')).toBe('default');
    expect(getNonEmptyString(null, 'default')).toBe('default');
    expect(getNonEmptyString(undefined, 'default')).toBe('default');
  });
});

describe('isRecord', () => {
  it('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord('string')).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord([])).toBe(false);
  });
});

describe('parsePayloadValue', () => {
  it('parses valid JSON strings', () => {
    expect(parsePayloadValue('{"a":1}')).toEqual({ a: 1 });
    expect(parsePayloadValue('"hello"')).toBe('hello');
  });

  it('returns non-string values as-is', () => {
    const obj = { a: 1 };
    expect(parsePayloadValue(obj)).toBe(obj);
    expect(parsePayloadValue(42)).toBe(42);
    expect(parsePayloadValue(null)).toBeNull();
  });

  it('returns invalid JSON strings as-is', () => {
    expect(parsePayloadValue('not json')).toBe('not json');
  });
});

describe('stringifyPayloadValue', () => {
  it('stringifies objects to JSON', () => {
    expect(stringifyPayloadValue({ a: 1 })).toBe('{"a":1}');
  });

  it('stringifies primitives via String()', () => {
    expect(stringifyPayloadValue(42)).toBe('42');
  });

  it('handles undefined gracefully', () => {
    expect(stringifyPayloadValue(undefined)).toBe('undefined');
  });
});

// ---------------------------------------------------------------------------
// resolveTurnId
// ---------------------------------------------------------------------------

describe('resolveTurnId', () => {
  it('uses preferredTurnId when present', () => {
    const state = makeState({ currentTurnId: 'current' });
    expect(resolveTurnId(state, 'preferred')).toBe('preferred');
  });

  it('falls back to state.currentTurnId', () => {
    const state = makeState({ currentTurnId: 'current' });
    expect(resolveTurnId(state, undefined)).toBe('current');
  });

  it('falls back to synthetic counter when both are null', () => {
    const state = makeState({ currentTurnId: null, syntheticTurnCounter: 0 });
    const id = resolveTurnId(state, undefined);
    expect(id).toBe('synthetic-turn-0');
    expect(state.syntheticTurnCounter).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createSessionTailState
// ---------------------------------------------------------------------------

describe('createSessionTailState', () => {
  it('returns a fresh state with empty collections', () => {
    const state = createSessionTailState();
    expect(state.currentTurnId).toBeNull();
    expect(state.syntheticTurnCounter).toBe(0);
    expect(state.lastTextByTurn.size).toBe(0);
    expect(state.lastThinkingByTurn.size).toBe(0);
    expect(state.pendingUsageByTurn.size).toBe(0);
    expect(state.emittedDoneByTurn.size).toBe(0);
    expect(state.emittedUsageByTurn.size).toBe(0);
    expect(state.responseItemState.emittedToolUseIds.size).toBe(0);
    expect(state.responseItemState.emittedToolResultIds.size).toBe(0);
    expect(state.responseItemState.knownCalls.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getCodexContextWindow
// ---------------------------------------------------------------------------

describe('getCodexContextWindow', () => {
  it('returns known model context window', () => {
    expect(getCodexContextWindow('gpt-5.2')).toBe(400_000);
    expect(getCodexContextWindow('gpt-5.3-codex')).toBe(400_000);
    expect(getCodexContextWindow('gpt-5.3-codex-spark')).toBe(128_000);
  });

  it('returns default for unknown model', () => {
    expect(getCodexContextWindow('unknown-model')).toBe(200_000);
  });

  it('returns default when model is undefined', () => {
    expect(getCodexContextWindow(undefined)).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// mapEventMsgEvent — task_started
// ---------------------------------------------------------------------------

describe('mapEventMsgEvent', () => {
  describe('task_started', () => {
    it('sets currentTurnId and returns empty', () => {
      const state = makeState();
      const payload = { type: 'task_started', info: { id: 'turn-1' } };
      const chunks = mapEventMsgEvent(payload, 'sess-1', state);
      expect(chunks).toEqual([]);
      expect(state.currentTurnId).toBe('turn-1');
    });

    it('supports the real turn_id field emitted by Codex transcripts', () => {
      const state = makeState();
      const payload = { type: 'task_started', turn_id: 'real-turn-1' };
      const chunks = mapEventMsgEvent(payload, 'sess-1', state);
      expect(chunks).toEqual([]);
      expect(state.currentTurnId).toBe('real-turn-1');
    });
  });

  describe('task_complete', () => {
    it('emits pending usage then done', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      state.pendingUsageByTurn.set('turn-1', { contextTokens: 500, contextWindow: 200_000 });
      const payload = { type: 'task_complete' };
      const chunks = mapEventMsgEvent(payload, 'sess-1', state);

      const usageChunk = chunks.find(c => c.type === 'usage');
      const doneChunk = chunks.find(c => c.type === 'done');
      expect(usageChunk).toBeDefined();
      expect(doneChunk).toBeDefined();
    });

    it('emits done even without pending usage', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const chunks = mapEventMsgEvent({ type: 'task_complete' }, 'sess-1', state);
      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('does not emit duplicate done for same turn', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      mapEventMsgEvent({ type: 'task_complete' }, 'sess-1', state);
      const chunks2 = mapEventMsgEvent({ type: 'task_complete' }, 'sess-1', state);
      const doneChunks = chunks2.filter(c => c.type === 'done');
      expect(doneChunks).toHaveLength(0);
    });
  });

  describe('turn_aborted', () => {
    it('emits done chunk', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const chunks = mapEventMsgEvent({ type: 'turn_aborted', info: { reason: 'user cancel' } }, 'sess-1', state);
      expect(chunks).toContainEqual({ type: 'done' });
    });
  });

  describe('user_message', () => {
    it('returns empty', () => {
      const state = makeState();
      const chunks = mapEventMsgEvent({ type: 'user_message' }, 'sess-1', state);
      expect(chunks).toEqual([]);
    });
  });

  describe('agent_message', () => {
    it('emits text chunk with dedup', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const payload1 = { type: 'agent_message', text: 'Hello' };
      const chunks1 = mapEventMsgEvent(payload1, 'sess-1', state);
      expect(chunks1).toEqual([{ type: 'text', content: 'Hello' }]);

      // Same text again — should emit the new delta only
      const payload2 = { type: 'agent_message', text: 'Hello world' };
      const chunks2 = mapEventMsgEvent(payload2, 'sess-1', state);
      expect(chunks2).toEqual([{ type: 'text', content: ' world' }]);
    });

    it('emits nothing when text is unchanged', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      mapEventMsgEvent({ type: 'agent_message', text: 'Hello' }, 'sess-1', state);
      const chunks = mapEventMsgEvent({ type: 'agent_message', text: 'Hello' }, 'sess-1', state);
      expect(chunks).toEqual([]);
    });

    it('supports the real message field emitted by Codex transcripts', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const chunks1 = mapEventMsgEvent({ type: 'agent_message', message: 'Hello' }, 'sess-1', state);
      const chunks2 = mapEventMsgEvent({ type: 'agent_message', message: 'Hello world' }, 'sess-1', state);

      expect(chunks1).toEqual([{ type: 'text', content: 'Hello' }]);
      expect(chunks2).toEqual([{ type: 'text', content: ' world' }]);
    });
  });

  describe('agent_reasoning', () => {
    it('emits thinking chunk with dedup', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const payload1 = { type: 'agent_reasoning', text: 'Analyzing...' };
      const chunks1 = mapEventMsgEvent(payload1, 'sess-1', state);
      expect(chunks1).toEqual([{ type: 'thinking', content: 'Analyzing...' }]);

      const payload2 = { type: 'agent_reasoning', text: 'Analyzing... more' };
      const chunks2 = mapEventMsgEvent(payload2, 'sess-1', state);
      expect(chunks2).toEqual([{ type: 'thinking', content: ' more' }]);
    });
  });

  describe('token_count', () => {
    it('stores pending usage in state', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const payload = {
        type: 'token_count',
        info: {
          last_token_usage: { input: 100, output: 50 },
          model_context_window: 200_000,
        },
      };
      const chunks = mapEventMsgEvent(payload, 'sess-1', state);
      expect(chunks).toEqual([]);
      expect(state.pendingUsageByTurn.get('turn-1')).toEqual({
        contextTokens: 100,
        contextWindow: 200_000,
      });
    });
  });
});

// ---------------------------------------------------------------------------
// mapResponseItemEvent
// ---------------------------------------------------------------------------

describe('mapResponseItemEvent', () => {
  describe('function_call', () => {
    it('emits tool_use chunk', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event = {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: '{"command":"ls"}',
        },
      };
      const chunks = mapResponseItemEvent(event, 'sess-1', 0, state);
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toMatchObject({
        type: 'tool_use',
        id: 'call-1',
        name: 'Bash',
        input: { command: 'ls' },
      });
    });

    it('deduplicates by call_id', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event = {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'exec_command',
          arguments: '{"command":"ls"}',
        },
      };
      mapResponseItemEvent(event, 'sess-1', 0, state);
      const chunks2 = mapResponseItemEvent(event, 'sess-1', 1, state);
      expect(chunks2.filter(c => c.type === 'tool_use')).toHaveLength(0);
    });
  });

  describe('custom_tool_call', () => {
    it('emits tool_use chunk for apply_patch', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event = {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          call_id: 'call-2',
          name: 'apply_patch',
          arguments: '{"patch":"data"}',
        },
      };
      const chunks = mapResponseItemEvent(event, 'sess-1', 0, state);
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toMatchObject({
        type: 'tool_use',
        id: 'call-2',
        name: 'apply_patch',
      });
    });
  });

  describe('web_search_call', () => {
    it('emits tool_use chunk for web search', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event = {
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          call_id: 'ws-1',
          action: { query: 'obsidian' },
        },
      };
      const chunks = mapResponseItemEvent(event, 'sess-1', 0, state);
      const toolUse = chunks.find(c => c.type === 'tool_use');
      expect(toolUse).toMatchObject({
        type: 'tool_use',
        id: 'ws-1',
        name: 'WebSearch',
        input: { query: 'obsidian' },
      });
    });
  });

  describe('function_call_output', () => {
    it('emits tool_result chunk', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      // First emit tool_use
      const callEvent = {
        type: 'response_item',
        payload: {
          type: 'function_call',
          call_id: 'call-r1',
          name: 'exec_command',
          arguments: '{"command":"pwd"}',
        },
      };
      mapResponseItemEvent(callEvent, 'sess-1', 0, state);

      const outputEvent = {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-r1',
          output: '/home/user',
        },
      };
      const chunks = mapResponseItemEvent(outputEvent, 'sess-1', 1, state);
      const toolResult = chunks.find(c => c.type === 'tool_result');
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        id: 'call-r1',
        content: '/home/user',
      });
    });

    it('deduplicates by call_id', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const outputEvent = {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-dup',
          output: 'result',
        },
      };
      mapResponseItemEvent(outputEvent, 'sess-1', 0, state);
      const chunks2 = mapResponseItemEvent(outputEvent, 'sess-1', 1, state);
      expect(chunks2.filter(c => c.type === 'tool_result')).toHaveLength(0);
    });
  });

  describe('custom_tool_call_output', () => {
    it('emits tool_result chunk', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event = {
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-ct-out',
          output: 'Applied changes',
        },
      };
      const chunks = mapResponseItemEvent(event, 'sess-1', 0, state);
      const toolResult = chunks.find(c => c.type === 'tool_result');
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        id: 'call-ct-out',
        content: 'Applied changes',
      });
    });
  });

  describe('assistant message payloads', () => {
    it('emits text chunks for response_item assistant messages', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event1 = {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello' }],
        },
      };
      const event2 = {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Hello world' }],
        },
      };

      expect(mapResponseItemEvent(event1, 'sess-1', 0, state)).toEqual([{ type: 'text', content: 'Hello' }]);
      expect(mapResponseItemEvent(event2, 'sess-1', 1, state)).toEqual([{ type: 'text', content: ' world' }]);
    });

    it('emits thinking chunks for response_item reasoning payloads', () => {
      const state = makeState({ currentTurnId: 'turn-1' });
      const event1 = {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Planning' }],
        },
      };
      const event2 = {
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Planning more' }],
        },
      };

      expect(mapResponseItemEvent(event1, 'sess-1', 0, state)).toEqual([{ type: 'thinking', content: 'Planning' }]);
      expect(mapResponseItemEvent(event2, 'sess-1', 1, state)).toEqual([{ type: 'thinking', content: ' more' }]);
    });
  });
});

// ---------------------------------------------------------------------------
// mapSessionFileEvent — top-level dispatcher
// ---------------------------------------------------------------------------

describe('mapSessionFileEvent', () => {
  it('dispatches event_msg type', () => {
    const state = makeState();
    const event = {
      type: 'event_msg',
      payload: { type: 'task_started', info: { id: 'turn-d1' } },
    };
    const chunks = mapSessionFileEvent(event, 'sess-1', 0, state);
    expect(chunks).toEqual([]);
    expect(state.currentTurnId).toBe('turn-d1');
  });

  it('dispatches response_item type', () => {
    const state = makeState({ currentTurnId: 'turn-1' });
    const event = {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-d1',
        name: 'exec_command',
        arguments: '{"command":"echo hi"}',
      },
    };
    const chunks = mapSessionFileEvent(event, 'sess-1', 0, state);
    expect(chunks.find(c => c.type === 'tool_use')).toBeDefined();
  });

  it('returns empty for unknown event types', () => {
    const state = makeState();
    const chunks = mapSessionFileEvent({ type: 'unknown_thing' }, 'sess-1', 0, state);
    expect(chunks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CodexFileTailEngine
// ---------------------------------------------------------------------------

describe('CodexFileTailEngine', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tail-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSessionFile(threadId: string, lines: object[]): string {
    const filePath = path.join(tmpDir, `${threadId}.jsonl`);
    const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function writeNestedSessionFile(relativePath: string, lines: object[]): string {
    const filePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('should be constructed without error', () => {
    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    expect(engine).toBeDefined();
  });

  it('primeCursor sets cursor to current EOF', async () => {
    writeSessionFile('thread-1', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
      { type: 'event_msg', payload: { type: 'agent_message', text: 'old text' } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-1');

    // No events should be pending since cursor is at EOF
    const events = engine.collectPendingEvents();
    expect(events).toEqual([]);
  });

  it('collects events written after prime', async () => {
    const filePath = writeSessionFile('thread-2', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-2');

    // Append new data after prime
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', text: 'Hello from tail' },
    }) + '\n');

    engine.startPolling('thread-2');
    // Give polling time to pick up the line
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();

    const events = engine.collectPendingEvents();
    const textChunks = events.filter(c => c.type === 'text');
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
    expect(textChunks[0]).toMatchObject({ type: 'text', content: 'Hello from tail' });
  });

  it('turnCompleteEmitted reflects file-tail done state', async () => {
    const filePath = writeSessionFile('thread-3', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-3');
    expect(engine.turnCompleteEmitted).toBe(false);

    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }) + '\n');

    engine.startPolling('thread-3');
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();
    engine.collectPendingEvents();

    expect(engine.turnCompleteEmitted).toBe(true);
  });

  it('usageEmitted reflects file-tail usage state', async () => {
    const filePath = writeSessionFile('thread-4', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-4');

    // task_started must appear after prime so the tail state has a current turn
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started', info: { id: 'turn-u1' } },
    }) + '\n');
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input: 500, output: 100 },
          model_context_window: 200_000,
        },
      },
    }) + '\n');
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }) + '\n');

    engine.startPolling('thread-4');
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();
    engine.collectPendingEvents();

    expect(engine.usageEmitted).toBe(true);
  });

  it('resetForNewTurn clears state', async () => {
    const filePath = writeSessionFile('thread-5', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-5');

    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }) + '\n');

    engine.startPolling('thread-5');
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();
    engine.collectPendingEvents();

    expect(engine.turnCompleteEmitted).toBe(true);
    engine.resetForNewTurn();
    expect(engine.turnCompleteEmitted).toBe(false);
    expect(engine.usageEmitted).toBe(false);
  });

  it('handles file rotation (cursor > lines)', async () => {
    const filePath = writeSessionFile('thread-6', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
      { type: 'event_msg', payload: { type: 'agent_message', text: 'Line 1' } },
      { type: 'event_msg', payload: { type: 'agent_message', text: 'Line 1 and 2' } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-6');

    // Overwrite file with fewer lines (simulate rotation)
    fs.writeFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', text: 'Fresh start' },
    }) + '\n');

    engine.startPolling('thread-6');
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();

    const events = engine.collectPendingEvents();
    const textChunks = events.filter(c => c.type === 'text');
    expect(textChunks.length).toBeGreaterThanOrEqual(1);
  });

  it('stopPolling is safe to call when not polling', async () => {
    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await expect(engine.stopPolling()).resolves.toBeUndefined();
  });

  it('collectPendingEvents returns empty when no events', () => {
    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    expect(engine.collectPendingEvents()).toEqual([]);
  });

  it('handles tool_use via response_item in the JSONL file', async () => {
    const filePath = writeSessionFile('thread-tool', [
      { type: 'event_msg', payload: { type: 'task_started', info: { id: 'turn-1' } } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-tool');

    fs.appendFileSync(filePath, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-tail-1',
        name: 'exec_command',
        arguments: '{"command":"ls"}',
      },
    }) + '\n');
    fs.appendFileSync(filePath, JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-tail-1',
        output: 'file.txt',
      },
    }) + '\n');

    engine.startPolling('thread-tool');
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();

    const events = engine.collectPendingEvents();
    const toolUse = events.find(c => c.type === 'tool_use');
    const toolResult = events.find(c => c.type === 'tool_result');

    expect(toolUse).toMatchObject({
      type: 'tool_use',
      id: 'call-tail-1',
      name: 'Bash',
      input: { command: 'ls' },
    });
    expect(toolResult).toMatchObject({
      type: 'tool_result',
      id: 'call-tail-1',
      content: 'file.txt',
    });
  });

  it('tails nested session files in the real ~/.codex/sessions layout', async () => {
    const filePath = writeNestedSessionFile('2026/03/28/rollout-2026-03-28T10-00-00-thread-nested.jsonl', [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    ]);

    const engine = new CodexFileTailEngine(tmpDir, 200_000);
    await engine.primeCursor('thread-nested');

    fs.appendFileSync(filePath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Hello from nested tail' },
    }) + '\n');

    engine.startPolling('thread-nested');
    await new Promise(resolve => setTimeout(resolve, 300));
    await engine.stopPolling();

    expect(engine.collectPendingEvents()).toEqual([
      { type: 'text', content: 'Hello from nested tail' },
    ]);
  });
});
