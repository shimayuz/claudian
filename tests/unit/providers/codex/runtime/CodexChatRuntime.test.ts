import * as codexSdkMockModule from '@openai/codex-sdk';

import type { PreparedChatTurn } from '@/core/runtime/types';
import type { StreamChunk } from '@/core/types/chat';
import { CodexChatRuntime } from '@/providers/codex/runtime/CodexChatRuntime';

const {
  mockCodexConstructor,
  mockRunStreamed,
  mockStartThread,
  mockResumeThread,
  resetCodexSdkMocks,
} = codexSdkMockModule as unknown as {
  mockCodexConstructor: jest.Mock;
  mockRunStreamed: jest.Mock;
  mockStartThread: jest.Mock;
  mockResumeThread: jest.Mock;
  resetCodexSdkMocks: () => void;
};

jest.mock('@/utils/path', () => ({
  getVaultPath: jest.fn().mockReturnValue('/test/vault'),
}));

jest.mock('@/utils/env', () => ({
  parseEnvironmentVariables: jest.requireActual('@/utils/env').parseEnvironmentVariables,
  getEnhancedPath: jest.fn().mockReturnValue('/usr/bin:/usr/local/bin'),
}));

// Mock CodexFileTailEngine so tests don't need filesystem
const mockPrimeCursor = jest.fn().mockResolvedValue(undefined);
const mockStartPolling = jest.fn();
const mockStopPolling = jest.fn().mockResolvedValue(undefined);
const mockWaitForSettle = jest.fn().mockResolvedValue(undefined);
const mockCollectPendingEvents = jest.fn().mockReturnValue([]);
const mockResetForNewTurn = jest.fn();
let mockTurnCompleteEmitted = false;
let mockUsageEmitted = false;

// Configurable: tests can push chunks that collectPendingEvents returns
let pendingFileTailChunks: StreamChunk[] = [];

jest.mock('@/providers/codex/runtime/CodexSessionFileTail', () => ({
  CodexFileTailEngine: jest.fn().mockImplementation(() => ({
    primeCursor: mockPrimeCursor,
    startPolling: mockStartPolling,
    stopPolling: mockStopPolling,
    waitForSettle: mockWaitForSettle,
    collectPendingEvents: mockCollectPendingEvents.mockImplementation(() => {
      const events = [...pendingFileTailChunks];
      pendingFileTailChunks = [];
      return events;
    }),
    resetForNewTurn: mockResetForNewTurn,
    get turnCompleteEmitted() { return mockTurnCompleteEmitted; },
    get usageEmitted() { return mockUsageEmitted; },
  })),
  getCodexContextWindow: jest.fn().mockReturnValue(200_000),
}));

function createMockPlugin(): any {
  return {
    settings: {
      model: 'gpt-5.4',
      effortLevel: 'medium',
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(
      'OPENAI_API_KEY=test-key\nOPENAI_BASE_URL=https://example.test/v1',
    ),
    getResolvedCodexCliPath: jest.fn().mockReturnValue('/usr/local/bin/codex'),
    app: {
      vault: {
        adapter: { basePath: '/test/vault' },
      },
    },
  };
}

function createTurn(text = 'hello'): PreparedChatTurn {
  return {
    request: { text },
    persistedContent: text,
    prompt: text,
    isCompact: false,
    mcpMentions: new Set(),
  };
}

async function* makeEvents(events: any[]): AsyncGenerator<any> {
  for (const event of events) {
    yield event;
  }
}

async function collectChunks(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

function resetFileTailMocks(): void {
  mockPrimeCursor.mockClear();
  mockStartPolling.mockClear();
  mockStopPolling.mockClear();
  mockWaitForSettle.mockClear();
  mockCollectPendingEvents.mockClear();
  mockResetForNewTurn.mockClear();
  mockTurnCompleteEmitted = false;
  mockUsageEmitted = false;
  pendingFileTailChunks = [];
}

describe('CodexChatRuntime', () => {
  let runtime: CodexChatRuntime;

  beforeEach(() => {
    resetCodexSdkMocks();
    resetFileTailMocks();
    runtime = new CodexChatRuntime(createMockPlugin());
  });

  afterEach(() => {
    runtime.cleanup();
  });

  it('should have codex as providerId', () => {
    expect(runtime.providerId).toBe('codex');
  });

  it('should return codex capabilities', () => {
    const caps = runtime.getCapabilities();
    expect(caps.providerId).toBe('codex');
    expect(caps.supportsRewind).toBe(false);
    expect(caps.supportsFork).toBe(false);
  });

  it('passes the configured environment variables to the Codex client', async () => {
    await runtime.ensureReady();

    expect(mockCodexConstructor).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({
        OPENAI_API_KEY: 'test-key',
        OPENAI_BASE_URL: 'https://example.test/v1',
      }),
    }));
  });

  it('writes the shared system prompt to a model_instructions_file for Codex', async () => {
    const plugin = createMockPlugin();
    plugin.settings.systemPrompt = 'Always answer with structured bullets.';
    plugin.settings.mediaFolder = 'attachments';
    const promptRuntime = new CodexChatRuntime(plugin);

    await promptRuntime.ensureReady();

    const constructorArg = mockCodexConstructor.mock.calls[0]?.[0];
    expect(constructorArg?.config?.model_instructions_file).toEqual(expect.any(String));

    const promptFilePath = constructorArg.config.model_instructions_file as string;
    const promptText = await import('fs').then(fs => fs.readFileSync(promptFilePath, 'utf8'));

    expect(promptText).toContain('## Custom Instructions');
    expect(promptText).toContain('Always answer with structured bullets.');
    expect(promptText).toContain('## Embedded Images in Notes');
    expect(promptText).not.toContain('## Tool Usage Guidelines');

    promptRuntime.cleanup();
  });

  it('rebuilds the Codex client when the shared prompt changes', async () => {
    const plugin = createMockPlugin();
    const promptRuntime = new CodexChatRuntime(plugin);

    await promptRuntime.ensureReady();
    expect(mockCodexConstructor).toHaveBeenCalledTimes(1);

    plugin.settings.systemPrompt = 'Use terse answers.';
    await promptRuntime.ensureReady();
    expect(mockCodexConstructor).toHaveBeenCalledTimes(2);

    const constructorArg = mockCodexConstructor.mock.calls[1]?.[0];
    const promptFilePath = constructorArg?.config?.model_instructions_file as string;
    const promptText = await import('fs').then(fs => fs.readFileSync(promptFilePath, 'utf8'));

    expect(promptText).toContain('Use terse answers.');

    promptRuntime.cleanup();
  });

  it('passes the resolved Codex CLI path to the Codex client', async () => {
    await runtime.ensureReady();

    expect(mockCodexConstructor).toHaveBeenCalledWith(expect.objectContaining({
      codexPathOverride: '/usr/local/bin/codex',
    }));
  });

  it('lets the SDK resolve codex from PATH when no explicit CLI path is configured', async () => {
    const plugin = createMockPlugin();
    plugin.getResolvedCodexCliPath.mockReturnValue(null);
    const pathRuntime = new CodexChatRuntime(plugin);

    await pathRuntime.ensureReady();

    expect(mockCodexConstructor).toHaveBeenCalledWith(expect.not.objectContaining({
      codexPathOverride: expect.any(String),
    }));

    pathRuntime.cleanup();
  });

  it('should return empty commands', async () => {
    const commands = await runtime.getSupportedCommands();
    expect(commands).toEqual([]);
  });

  it('should return canRewind: false', async () => {
    const result = await runtime.rewind('u1', 'a1');
    expect(result.canRewind).toBe(false);
  });

  describe('query - hybrid streaming via file-tail', () => {
    it('should yield text chunks from file-tail engine', async () => {
      // File-tail provides content; SDK provides lifecycle only
      mockCollectPendingEvents.mockReturnValueOnce([
        { type: 'text', content: 'Hello' },
        { type: 'text', content: ' world' },
      ]).mockReturnValue([]);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_001' },
          { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const textChunks = chunks.filter(c => c.type === 'text');
      expect(textChunks).toEqual([
        { type: 'text', content: 'Hello' },
        { type: 'text', content: ' world' },
      ]);
    });

    it('should yield thinking chunks from file-tail engine', async () => {
      mockCollectPendingEvents.mockReturnValueOnce([
        { type: 'thinking', content: 'Analyzing...' },
      ]).mockReturnValue([]);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_002' },
          { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 10 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const thinkingChunks = chunks.filter(c => c.type === 'thinking');
      expect(thinkingChunks).toEqual([
        { type: 'thinking', content: 'Analyzing...' },
      ]);
    });

    it('should yield tool_use and tool_result from file-tail engine', async () => {
      mockCollectPendingEvents.mockReturnValueOnce([
        { type: 'tool_use', id: 'cmd1', name: 'Bash', input: { command: 'ls -la' } },
      ]).mockReturnValueOnce([
        { type: 'tool_result', id: 'cmd1', content: 'file.txt', isError: false },
      ]).mockReturnValue([]);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_003' },
          { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const toolUse = chunks.find(c => c.type === 'tool_use');
      const toolResult = chunks.find(c => c.type === 'tool_result');

      expect(toolUse).toEqual({
        type: 'tool_use',
        id: 'cmd1',
        name: 'Bash',
        input: { command: 'ls -la' },
      });
      expect(toolResult).toEqual({
        type: 'tool_result',
        id: 'cmd1',
        content: 'file.txt',
        isError: false,
      });
    });
  });

  describe('query - lifecycle events', () => {
    it('should capture thread ID from thread.started', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_lifecycle_1' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));
      expect(runtime.getSessionId()).toBe('thread_lifecycle_1');
    });

    it('should yield error from SDK error events', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_err' },
          { type: 'error', message: 'Something broke' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      expect(chunks).toContainEqual({ type: 'error', content: 'Something broke' });
    });
  });

  describe('query - fallback usage and done', () => {
    it('should emit SDK fallback usage when file-tail did not emit usage', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = false;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_006' },
          { type: 'turn.completed', usage: { input_tokens: 150, cached_input_tokens: 10, output_tokens: 42 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const usageChunk = chunks.find(c => c.type === 'usage');

      expect(usageChunk).toBeDefined();
      expect(usageChunk).toMatchObject({
        type: 'usage',
        usage: {
          inputTokens: 150,
          cacheReadInputTokens: 10,
          contextWindow: 200_000,
          contextTokens: 160,
        },
      });
      const usage = (usageChunk as { type: 'usage'; usage: { percentage: number } }).usage;
      expect(usage.percentage).toBeCloseTo(0.08);
    });

    it('should emit fallback done when file-tail did not emit done', async () => {
      mockTurnCompleteEmitted = false;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_007' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('should emit error and done fallback on turn.failed when file-tail did not emit', async () => {
      mockTurnCompleteEmitted = false;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_fail' },
          { type: 'turn.failed', error: { message: 'Something went wrong' } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      expect(chunks).toContainEqual({ type: 'error', content: 'Something went wrong' });
      expect(chunks).toContainEqual({ type: 'done' });
    });

    it('should not emit fallback done when file-tail already emitted done', async () => {
      // File-tail emits done; SDK also has turn.completed
      mockCollectPendingEvents
        .mockReturnValueOnce([{ type: 'done' }])
        .mockReturnValue([]);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_no_dup' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(createTurn()));
      const doneChunks = chunks.filter(c => c.type === 'done');
      // Only the file-tail done, no fallback
      expect(doneChunks).toHaveLength(1);
    });
  });

  describe('query - image support', () => {
    it('should accept queries with images via temp-file bridge', async () => {
      const turn = createTurn();
      turn.request.images = [
        { id: 'img1', name: 'test.png', mediaType: 'image/png', data: Buffer.from('fake-png').toString('base64'), size: 100, source: 'file' },
      ];
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_img' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      const chunks = await collectChunks(runtime.query(turn));
      // Should not contain an image rejection error
      expect(chunks).not.toContainEqual(expect.objectContaining({ content: 'Codex does not support image attachments' }));
      // runStreamed should have been called with array input (not plain string)
      expect(mockRunStreamed).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: 'local_image' }),
        ]),
        expect.any(Object),
      );
    });
  });

  describe('query - thread options', () => {
    it('passes external context paths as additional directories', async () => {
      const turn = createTurn();
      turn.request.externalContextPaths = ['/external/a', '/external/b'];
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_dirs' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(turn));

      expect(mockStartThread).toHaveBeenCalledWith(expect.objectContaining({
        additionalDirectories: ['/external/a', '/external/b'],
      }));
    });
  });

  describe('query - permission mode', () => {
    it('uses yolo mode (never + danger-full-access) when permissionMode is yolo', async () => {
      const plugin = createMockPlugin();
      plugin.settings.permissionMode = 'yolo';
      const yoloRuntime = new CodexChatRuntime(plugin);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_perm_yolo' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(yoloRuntime.query(createTurn()));

      expect(mockStartThread).toHaveBeenCalledWith(expect.objectContaining({
        approvalPolicy: 'never',
        sandboxMode: 'danger-full-access',
      }));

      yoloRuntime.cleanup();
    });

    it('uses safe mode (never + workspace-write) when permissionMode is normal', async () => {
      const plugin = createMockPlugin();
      plugin.settings.permissionMode = 'normal';
      const safeRuntime = new CodexChatRuntime(plugin);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_perm_safe' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(safeRuntime.query(createTurn()));

      expect(mockStartThread).toHaveBeenCalledWith(expect.objectContaining({
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
      }));

      safeRuntime.cleanup();
    });

    it('falls back to normal mode when permissionMode is unrecognized', async () => {
      const plugin = createMockPlugin();
      plugin.settings.permissionMode = 'plan';
      const planRuntime = new CodexChatRuntime(plugin);
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_perm_fallback' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(planRuntime.query(createTurn()));

      expect(mockStartThread).toHaveBeenCalledWith(expect.objectContaining({
        approvalPolicy: 'never',
        sandboxMode: 'workspace-write',
      }));

      planRuntime.cleanup();
    });
  });

  describe('query - resumeThread', () => {
    it('should use resumeThread when a threadId is already set', async () => {
      runtime.syncConversationState({
        sessionId: 'thread_existing',
        providerState: {
          threadId: 'thread_existing',
          sessionFilePath: '/tmp/session.jsonl',
        },
      });
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 10 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      expect(mockResumeThread).toHaveBeenCalledWith('thread_existing', expect.any(Object));
      expect(mockStartThread).not.toHaveBeenCalled();
      // Verify primeCursor was called for the existing thread
      expect(mockPrimeCursor).toHaveBeenCalledWith('thread_existing');
    });

    it('uses conversation.sessionId when providerState is absent', async () => {
      runtime.syncConversationState({
        sessionId: 'thread_from_session_id',
        providerState: undefined,
      });
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'turn.started' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      expect(mockResumeThread).toHaveBeenCalledWith('thread_from_session_id', expect.any(Object));
    });

    it('should use startThread when no threadId is set', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_new' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      expect(mockStartThread).toHaveBeenCalled();
      expect(mockResumeThread).not.toHaveBeenCalled();
    });
  });

  describe('query - file-tail engine lifecycle', () => {
    it('should call startPolling after runStreamed', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_poll' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));
      expect(mockStartPolling).toHaveBeenCalled();
    });

    it('starts polling with the real thread id after thread.started on a new thread', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_live_new' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      expect(mockStartPolling).toHaveBeenCalledWith('thread_live_new');
    });

    it('should call waitForSettle and stopPolling after stream ends', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_settle' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));
      expect(mockWaitForSettle).toHaveBeenCalled();
      expect(mockStopPolling).toHaveBeenCalled();
    });

    it('should stop polling on abort error', async () => {
      mockRunStreamed.mockRejectedValue(Object.assign(new Error('AbortError'), { name: 'AbortError' }));

      const chunks = await collectChunks(runtime.query(createTurn()));
      expect(chunks).toContainEqual({ type: 'done' });
      expect(mockStopPolling).toHaveBeenCalled();
    });
  });

  describe('session management', () => {
    it('should capture thread ID from thread.started event', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_captured' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));
      expect(runtime.getSessionId()).toBe('thread_captured');
    });

    it('should build session updates with thread ID', async () => {
      mockTurnCompleteEmitted = true;
      mockUsageEmitted = true;

      mockRunStreamed.mockResolvedValue({
        events: makeEvents([
          { type: 'thread.started', thread_id: 'thread_for_updates' },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
        ]),
      });

      await collectChunks(runtime.query(createTurn()));

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect(result.updates.sessionId).toBe('thread_for_updates');
      expect((result.updates.providerState as any).threadId).toBe('thread_for_updates');
    });

    it('should round-trip an existing session file path from provider state', () => {
      runtime.syncConversationState({
        sessionId: 'thread_persisted',
        providerState: {
          threadId: 'thread_persisted',
          sessionFilePath: '/tmp/codex-thread.jsonl',
        },
      });

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect((result.updates.providerState as any).sessionFilePath).toBe('/tmp/codex-thread.jsonl');
    });

    it('clears the previous transcript path when switching threads without a persisted path', () => {
      runtime.syncConversationState({
        sessionId: 'thread_a',
        providerState: {
          threadId: 'thread_a',
          sessionFilePath: '/tmp/thread-a.jsonl',
        },
      });

      runtime.syncConversationState({
        sessionId: 'thread_b',
        providerState: {
          threadId: 'thread_b',
        },
      });

      const result = runtime.buildSessionUpdates({
        conversation: null,
        sessionInvalidated: false,
      });

      expect(result.updates.sessionId).toBe('thread_b');
      expect(result.updates.providerState).toEqual({
        threadId: 'thread_b',
      });
    });

    it('clears provider state when the session is invalidated', () => {
      runtime.syncConversationState({
        sessionId: 'thread_invalidated',
        providerState: {
          threadId: 'thread_invalidated',
          sessionFilePath: '/tmp/thread-invalidated.jsonl',
        },
      });

      const result = runtime.buildSessionUpdates({
        conversation: {} as any,
        sessionInvalidated: true,
      });

      expect(result.updates.sessionId).toBeNull();
      expect(result.updates.providerState).toBeUndefined();
    });
  });
});
