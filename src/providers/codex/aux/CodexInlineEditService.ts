import {
  buildInlineEditPrompt,
  getInlineEditSystemPrompt,
  parseInlineEditResponse,
} from '../../../core/prompt/inlineEdit';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type {
  InlineEditRequest,
  InlineEditResult,
  InlineEditService,
} from '../../../core/providers/types';
import type ClaudianPlugin from '../../../main';
import { appendContextFiles } from '../../../utils/context';
import { CodexAuxQueryRunner } from '../runtime/CodexAuxQueryRunner';

export class CodexInlineEditService implements InlineEditService {
  private plugin: ClaudianPlugin;
  private runner: CodexAuxQueryRunner;
  private abortController: AbortController | null = null;
  private hasThread = false;

  constructor(plugin: ClaudianPlugin) {
    this.plugin = plugin;
    this.runner = new CodexAuxQueryRunner(plugin);
  }

  resetConversation(): void {
    this.runner.reset();
    this.hasThread = false;
  }

  async editText(request: InlineEditRequest): Promise<InlineEditResult> {
    this.resetConversation();
    const prompt = buildInlineEditPrompt(request);
    return this.sendMessage(prompt);
  }

  async continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult> {
    if (!this.hasThread) {
      return { success: false, error: 'No active conversation to continue' };
    }
    let prompt = message;
    if (contextFiles && contextFiles.length > 0) {
      prompt = appendContextFiles(message, contextFiles);
    }
    return this.sendMessage(prompt);
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(prompt: string): Promise<InlineEditResult> {
    const settings = ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      this.plugin.settings as unknown as Record<string, unknown>,
      'codex',
    );

    this.abortController = new AbortController();

    try {
      const text = await this.runner.query({
        systemPrompt: getInlineEditSystemPrompt(settings.allowExternalAccess as boolean),
        abortController: this.abortController,
      }, prompt);

      this.hasThread = true;
      return parseInlineEditResponse(text);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }
}
