import {
  type ApprovalMode,
  Codex,
  type Input,
  type ModelReasoningEffort,
  type SandboxMode,
  type ThreadEvent,
  type ThreadOptions,
} from '@openai/codex-sdk';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt';
import { ProviderSettingsCoordinator } from '../../../core/providers';
import type { ProviderCapabilities, ProviderId } from '../../../core/providers/types';
import type {
  ApprovalCallback,
  AskUserQuestionCallback,
  ChatRewindResult,
  ChatRuntime,
  ChatRuntimeConversationState,
  ChatRuntimeEnsureReadyOptions,
  ChatRuntimeQueryOptions,
  ChatTurnRequest,
  ExitPlanModeCallback,
  PreparedChatTurn,
  SessionUpdateResult,
  SubagentRuntimeState,
} from '../../../core/runtime';
import type { ChatMessage, Conversation, SlashCommand, StreamChunk, UsageInfo } from '../../../core/types';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { CODEX_PROVIDER_CAPABILITIES } from '../capabilities';
import { findCodexSessionFile } from '../history/CodexHistoryStore';
import { encodeCodexTurn } from '../prompt/encodeCodexTurn';
import { type CodexProviderState, getCodexState } from '../types';
import { CodexFileTailEngine, getCodexContextWindow } from './CodexSessionFileTail';
import { CodexSessionManager } from './CodexSessionManager';

const DEFAULT_CONTEXT_WINDOW = 200_000;

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');

const EFFORT_MAP: Record<string, ModelReasoningEffort> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
};

// Codex SDK handles approval internally in its subprocess — no approval events
// are exposed through ThreadEvent. Using 'on-request' would cause the subprocess
// to prompt for input we can't respond to. Both modes use 'never' approval;
// sandbox mode provides the safety boundary instead.
const PERMISSION_MODE_MAP: Record<string, { approvalPolicy: ApprovalMode; sandboxMode: SandboxMode }> = {
  yolo: { approvalPolicy: 'never', sandboxMode: 'danger-full-access' },
  normal: { approvalPolicy: 'never', sandboxMode: 'workspace-write' },
};

export class CodexChatRuntime implements ChatRuntime {
  readonly providerId: ProviderId = 'codex';

  private plugin: ClaudianPlugin;
  private session = new CodexSessionManager();
  private codex: Codex | null = null;
  private abortController: AbortController | null = null;
  private ready = false;
  private readyListeners = new Set<(ready: boolean) => void>();
  private fileTailEngine: CodexFileTailEngine | null = null;
  private tailPollingThreadId: string | null = null;
  private instructionsFileDir: string | null = null;
  private clientConfigKey: string | null = null;

  /* eslint-disable @typescript-eslint/no-unused-vars */
  private approvalCallback: ApprovalCallback | null = null;
  private approvalDismisser: (() => void) | null = null;
  private askUserCallback: AskUserQuestionCallback | null = null;
  private exitPlanModeCallback: ExitPlanModeCallback | null = null;
  private permissionModeSyncCallback: ((sdkMode: string) => void) | null = null;
  private subagentHookProvider: (() => SubagentRuntimeState) | null = null;
  private autoTurnCallback: ((chunks: StreamChunk[]) => void) | null = null;
  private resumeCheckpoint: string | undefined;
  /* eslint-enable @typescript-eslint/no-unused-vars */

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
  }

  getCapabilities(): Readonly<ProviderCapabilities> {
    return CODEX_PROVIDER_CAPABILITIES;
  }

  prepareTurn(request: ChatTurnRequest): PreparedChatTurn {
    return encodeCodexTurn(request);
  }

  onReadyStateChange(listener: (ready: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  setResumeCheckpoint(checkpointId: string | undefined): void {
    this.resumeCheckpoint = checkpointId;
  }

  syncConversationState(
    conversation: ChatRuntimeConversationState | null,
    _externalContextPaths?: string[],
  ): void {
    if (!conversation) {
      this.session.reset();
      return;
    }

    const state = getCodexState(conversation.providerState);
    const threadId = state.threadId ?? conversation.sessionId ?? null;

    if (!threadId) {
      this.session.reset();
      return;
    }

    this.session.setThread(threadId, state.sessionFilePath);
  }

  async reloadMcpServers(): Promise<void> {
    // No-op: Codex handles MCP internally
  }

  async ensureReady(options?: ChatRuntimeEnsureReadyOptions): Promise<boolean> {
    const promptSettings = this.getSystemPromptSettings();
    const promptKey = computeSystemPromptKey(promptSettings);
    const resolvedCodexPath = this.plugin.getResolvedCodexCliPath();
    const clientConfigKey = [promptKey, resolvedCodexPath ?? ''].join('::');
    const shouldRebuild = !this.codex || options?.force === true || this.clientConfigKey !== clientConfigKey;

    if (shouldRebuild) {
      this.codex = this.createCodexClient(promptSettings, clientConfigKey, resolvedCodexPath);
    }

    this.setReady(true);
    return shouldRebuild;
  }

  async *query(
    turn: PreparedChatTurn,
    _conversationHistory?: ChatMessage[],
    queryOptions?: ChatRuntimeQueryOptions,
  ): AsyncGenerator<StreamChunk> {
    await this.ensureReady();

    this.abortController = new AbortController();

    const externalContextPaths = turn.request.externalContextPaths ?? queryOptions?.externalContextPaths;
    const threadOptions = this.buildThreadOptions(queryOptions, externalContextPaths);
    const model = this.resolveModel(queryOptions);

    // Build SDK input (text + optional images via temp files)
    const { input, cleanup } = createCodexInput(turn.prompt, turn.request.images);

    // Set up file-tail engine for hybrid consumption
    const contextWindow = getCodexContextWindow(model);
    this.fileTailEngine = new CodexFileTailEngine(CODEX_SESSIONS_DIR, contextWindow);
    this.tailPollingThreadId = null;

    const existingThreadId = this.session.getThreadId();
    if (existingThreadId) {
      await this.fileTailEngine.primeCursor(existingThreadId);
    }

    const thread = existingThreadId
      ? this.codex!.resumeThread(existingThreadId, threadOptions)
      : this.codex!.startThread(threadOptions);

    let sdkUsageFallback: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null = null;
    let sdkErrorMessage: string | null = null;

    try {
      const { events } = await thread.runStreamed(input, {
        signal: this.abortController.signal,
      });

      if (existingThreadId) {
        this.fileTailEngine.startPolling(existingThreadId);
        this.tailPollingThreadId = existingThreadId;
      }

      for await (const event of events) {
        // Drain file-tail events before processing SDK event
        for (const chunk of this.fileTailEngine.collectPendingEvents()) {
          yield chunk;
        }

        // SDK events: lifecycle only
        const lifecycleChunks = this.mapLifecycleEvent(event);
        for (const chunk of lifecycleChunks) {
          // Capture fallback data but don't yield done/usage from SDK
          if (chunk.type === 'error') {
            yield chunk;
          }
        }

        // Capture SDK-provided usage/error for fallback
        if (event.type === 'turn.completed' && event.usage) {
          sdkUsageFallback = event.usage;
        }
        if (event.type === 'turn.failed' && event.error) {
          sdkErrorMessage = event.error.message;
        }

        // Drain file-tail events after processing SDK event
        for (const chunk of this.fileTailEngine.collectPendingEvents()) {
          yield chunk;
        }
      }

      // Wait for file-tail to settle after SDK stream ends
      if (this.tailPollingThreadId) {
        await this.fileTailEngine.waitForSettle();
        await this.fileTailEngine.stopPolling();
        this.tailPollingThreadId = null;
      }

      // Final drain
      for (const chunk of this.fileTailEngine.collectPendingEvents()) {
        yield chunk;
      }
    } catch (err: unknown) {
      if (this.fileTailEngine) {
        await this.fileTailEngine.stopPolling();
        this.tailPollingThreadId = null;
      }

      if (err instanceof Error && err.name === 'AbortError') {
        yield { type: 'done' };
        return;
      }
      const message = err instanceof Error ? err.message : 'Unknown Codex error';
      yield { type: 'error', content: message };
      yield { type: 'done' };
      return;
    } finally {
      cleanup();

      // Fallback: emit usage if file-tail didn't
      if (this.fileTailEngine && !this.fileTailEngine.usageEmitted && sdkUsageFallback) {
        const usage = this.mapUsage(sdkUsageFallback, model);
        yield { type: 'usage', usage, sessionId: this.session.getThreadId() };
      }

      // Fallback: emit done if file-tail didn't
      if (this.fileTailEngine && !this.fileTailEngine.turnCompleteEmitted) {
        if (sdkErrorMessage) {
          yield { type: 'error', content: sdkErrorMessage };
        }
        yield { type: 'done' };
      }

      // Session file discovery (existing logic from turn.completed)
      if (!this.session.getSessionFilePath()) {
        const threadId = this.session.getThreadId();
        if (threadId) {
          const sessionFilePath = findCodexSessionFile(threadId);
          if (sessionFilePath) {
            this.session.setThread(threadId, sessionFilePath);
          }
        }
      }

      this.fileTailEngine = null;
      this.tailPollingThreadId = null;
    }
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  resetSession(): void {
    this.session.reset();
    this.codex = null;
    this.tailPollingThreadId = null;
    this.clientConfigKey = null;
    this.cleanupInstructionsFile();
    this.setReady(false);
  }

  getSessionId(): string | null {
    return this.session.getThreadId();
  }

  consumeSessionInvalidation(): boolean {
    return this.session.consumeInvalidation();
  }

  isReady(): boolean {
    return this.ready;
  }

  async getSupportedCommands(): Promise<SlashCommand[]> {
    return [];
  }

  cleanup(): void {
    this.cancel();
    this.session.reset();
    this.codex = null;
    this.tailPollingThreadId = null;
    this.clientConfigKey = null;
    this.cleanupInstructionsFile();
    this.setReady(false);
    this.readyListeners.clear();
  }

  async rewind(
    _userMessageId: string,
    _assistantMessageId: string,
  ): Promise<ChatRewindResult> {
    return { canRewind: false, error: 'Codex does not support rewind' };
  }

  setApprovalCallback(callback: ApprovalCallback | null): void {
    this.approvalCallback = callback;
  }

  setApprovalDismisser(dismisser: (() => void) | null): void {
    this.approvalDismisser = dismisser;
  }

  setAskUserQuestionCallback(callback: AskUserQuestionCallback | null): void {
    this.askUserCallback = callback;
  }

  setExitPlanModeCallback(callback: ExitPlanModeCallback | null): void {
    this.exitPlanModeCallback = callback;
  }

  setPermissionModeSyncCallback(callback: ((sdkMode: string) => void) | null): void {
    this.permissionModeSyncCallback = callback;
  }

  setSubagentHookProvider(getState: () => SubagentRuntimeState): void {
    this.subagentHookProvider = getState;
  }

  setAutoTurnCallback(callback: ((chunks: StreamChunk[]) => void) | null): void {
    this.autoTurnCallback = callback;
  }

  buildSessionUpdates(params: {
    conversation: Conversation | null;
    sessionInvalidated: boolean;
  }): SessionUpdateResult {
    const threadId = this.session.getThreadId();
    const sessionFilePath = this.session.getSessionFilePath();

    const providerState: CodexProviderState = {
      ...(threadId ? { threadId } : {}),
      ...(sessionFilePath ? { sessionFilePath } : {}),
    };

    const updates: Partial<Conversation> = {
      sessionId: threadId,
      providerState: providerState as Record<string, unknown>,
    };

    if (params.sessionInvalidated && params.conversation) {
      updates.sessionId = null;
      updates.providerState = undefined;
    }

    return { updates };
  }

  resolveSessionIdForFork(_conversation: Conversation | null): string | null {
    return null;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private setReady(ready: boolean): void {
    this.ready = ready;
    for (const listener of this.readyListeners) {
      listener(ready);
    }
  }

  private getSystemPromptSettings(): SystemPromptSettings {
    const settings = this.plugin.settings;
    return {
      mediaFolder: settings.mediaFolder,
      customPrompt: settings.systemPrompt,
      allowedExportPaths: settings.allowedExportPaths,
      allowExternalAccess: settings.allowExternalAccess,
      vaultPath: getVaultPath(this.plugin.app) ?? undefined,
      userName: settings.userName,
    };
  }

  private createCodexClient(
    promptSettings: SystemPromptSettings,
    clientConfigKey: string,
    resolvedCodexPath: string | null,
  ): Codex {
    const customEnv = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const baseEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    const enhancedPath = getEnhancedPath(customEnv.PATH);

    const previousInstructionsFileDir = this.instructionsFileDir;
    const previousClientConfigKey = this.clientConfigKey;
    const previousCodex = this.codex;

    const promptText = buildSystemPrompt(promptSettings);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-instructions-'));
    const instructionsFilePath = path.join(tempDir, 'base_instructions.md');
    fs.writeFileSync(instructionsFilePath, promptText, 'utf8');

    try {
      const codex = new Codex({
        ...(resolvedCodexPath ? { codexPathOverride: resolvedCodexPath } : {}),
        config: {
          model_instructions_file: instructionsFilePath,
        },
        env: {
          ...baseEnv,
          ...customEnv,
          PATH: enhancedPath,
        },
      });

      this.instructionsFileDir = tempDir;
      this.clientConfigKey = clientConfigKey;

      if (previousInstructionsFileDir && previousInstructionsFileDir !== tempDir) {
        this.removeInstructionsDirectory(previousInstructionsFileDir);
      }

      return codex;
    } catch (error) {
      this.removeInstructionsDirectory(tempDir);
      this.instructionsFileDir = previousInstructionsFileDir;
      this.clientConfigKey = previousClientConfigKey;
      this.codex = previousCodex;

      const detail = error instanceof Error ? error.message : 'Unknown Codex initialization error';
      throw new Error(
        `Failed to initialize Codex. Install \`codex\` locally and ensure it is available on PATH, or set the Codex CLI path in settings. ${detail}`,
      );
    }
  }

  private cleanupInstructionsFile(): void {
    if (!this.instructionsFileDir) {
      return;
    }

    this.removeInstructionsDirectory(this.instructionsFileDir);
    this.instructionsFileDir = null;
  }

  private removeInstructionsDirectory(dirPath: string): void {
    try {
      fs.rmSync(dirPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  private resolveModel(queryOptions?: ChatRuntimeQueryOptions): string | undefined {
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
    return queryOptions?.model ?? providerSettings.model as string | undefined;
  }

  private buildThreadOptions(
    queryOptions?: ChatRuntimeQueryOptions,
    additionalDirectories?: string[],
  ): ThreadOptions {
    const vaultPath = getVaultPath(this.plugin.app);
    const providerSettings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      this.providerId,
    );
    const model = queryOptions?.model ?? providerSettings.model as string;
    const effort = EFFORT_MAP[providerSettings.effortLevel as string] ?? 'medium';
    const permissionMode = PERMISSION_MODE_MAP[providerSettings.permissionMode as string]
      ?? PERMISSION_MODE_MAP.normal;

    return {
      model,
      workingDirectory: vaultPath ?? undefined,
      sandboxMode: permissionMode.sandboxMode,
      modelReasoningEffort: effort,
      approvalPolicy: permissionMode.approvalPolicy,
      skipGitRepoCheck: true,
      additionalDirectories,
    };
  }

  /**
   * SDK events now only drive lifecycle transitions.
   * Content (text, thinking, tools) comes from file-tail.
   */
  private mapLifecycleEvent(event: ThreadEvent): StreamChunk[] {
    const chunks: StreamChunk[] = [];

    switch (event.type) {
      case 'thread.started':
        if (event.thread_id) {
          this.session.setThread(event.thread_id);
          if (this.fileTailEngine && !this.tailPollingThreadId) {
            this.fileTailEngine.resetForNewTurn();
            this.fileTailEngine.startPolling(event.thread_id);
            this.tailPollingThreadId = event.thread_id;
          }
        }
        break;

      case 'turn.completed':
        // Usage and done are handled by file-tail + fallback in finally block
        break;

      case 'turn.failed':
        // Error and done are handled by file-tail + fallback in finally block
        break;

      case 'error':
        chunks.push({ type: 'error', content: (event as { message?: string }).message ?? 'Unknown error' });
        break;

      default:
        break;
    }

    return chunks;
  }

  private mapUsage(
    sdkUsage: { input_tokens: number; cached_input_tokens: number; output_tokens: number },
    model?: string,
  ): UsageInfo {
    const contextTokens = sdkUsage.input_tokens + sdkUsage.cached_input_tokens;
    const contextWindow = getCodexContextWindow(model) || DEFAULT_CONTEXT_WINDOW;
    return {
      inputTokens: sdkUsage.input_tokens,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: sdkUsage.cached_input_tokens,
      contextWindow,
      contextTokens,
      percentage: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Image attachment → temp file bridge
// ---------------------------------------------------------------------------

interface ImageAttachment {
  data: string;
  mediaType: string;
  filename?: string;
}

interface CodexInputBundle {
  input: Input;
  cleanup: () => void;
}

function toAttachmentFilename(attachment: ImageAttachment, index: number): string {
  const base = (attachment.filename ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '_') || `image-${index + 1}`;
  if (base.includes('.')) return base;
  const subtype = attachment.mediaType.split('/')[1] ?? 'img';
  const extension = subtype === 'jpeg' ? 'jpg' : subtype;
  return `${base}.${extension}`;
}

export function createCodexInput(
  text: string,
  images?: ImageAttachment[],
): CodexInputBundle {
  if (!images || images.length === 0) {
    return { input: text, cleanup: () => {} };
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-images-'));
  const cleanup = () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  };

  try {
    const input: Exclude<Input, string> = [];

    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img.mediaType.startsWith('image/')) continue;

      const filename = `${i + 1}-${toAttachmentFilename(img, i)}`;
      const filePath = path.join(tempDir, filename);
      fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
      input.push({ type: 'local_image', path: filePath });
    }

    if (text) {
      input.push({ type: 'text', text });
    }

    return { input, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Interrupt kind classification
// ---------------------------------------------------------------------------

export type CodexInterruptKind = 'user_request' | 'tool_use' | 'compaction_canceled';

export function mapCodexAbortReasonToInterruptKind(reason: string): CodexInterruptKind | undefined {
  const normalized = reason.trim().toLowerCase();
  if (!normalized) return undefined;

  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') {
    return 'user_request';
  }
  if (normalized.includes('tool')) {
    return 'tool_use';
  }
  if (normalized.includes('compact')) {
    return 'compaction_canceled';
  }

  return undefined;
}
