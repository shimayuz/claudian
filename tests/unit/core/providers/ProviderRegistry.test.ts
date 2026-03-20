import { ProviderRegistry } from '@/core/providers';
import { CLAUDE_PROVIDER_CAPABILITIES } from '@/providers/claude/capabilities';
import { ClaudeConversationHistoryService } from '@/providers/claude/history';
import { ClaudeChatRuntime } from '@/providers/claude/runtime';
import { ClaudeCliResolver } from '@/providers/claude/runtime/ClaudeCliResolver';
import { ClaudeTaskResultInterpreter } from '@/providers/claude/runtime/ClaudeTaskResultInterpreter';

describe('ProviderRegistry', () => {
  it('creates the Claude runtime by default', () => {
    const runtime = ProviderRegistry.createChatRuntime({
      plugin: {} as any,
      mcpManager: {} as any,
    });

    expect(runtime).toBeInstanceOf(ClaudeChatRuntime);
    expect(runtime.providerId).toBe('claude');
  });

  it('returns the registered Claude capabilities', () => {
    expect(ProviderRegistry.getCapabilities('claude')).toEqual(CLAUDE_PROVIDER_CAPABILITIES);
  });

  it('returns provider-owned boundary services for the default provider', () => {
    expect(ProviderRegistry.createCliResolver()).toBeInstanceOf(ClaudeCliResolver);
    expect(ProviderRegistry.getConversationHistoryService()).toBeInstanceOf(ClaudeConversationHistoryService);
    expect(ProviderRegistry.getTaskResultInterpreter()).toBeInstanceOf(ClaudeTaskResultInterpreter);
  });

  it('throws when the provider is not registered', () => {
    expect(() => ProviderRegistry.createChatRuntime({
      providerId: 'codex',
      plugin: {} as any,
      mcpManager: {} as any,
    })).toThrow('Provider "codex" is not registered.');
  });
});
