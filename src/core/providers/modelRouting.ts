import { ProviderRegistry } from './ProviderRegistry';
import { DEFAULT_CHAT_PROVIDER_ID, type ProviderId } from './types';

function isCodexModel(model: string): boolean {
  if (model.startsWith('gpt-')) return true;
  if (model.startsWith('o') && /^\d/.test(model.slice(1))) return true;
  return false;
}

export function getProviderForModel(model: string, settings?: Record<string, unknown>): ProviderId {
  if (isCodexModel(model)) return 'codex';

  // Check custom Codex models from environment variables
  if (settings) {
    const codexOptions = ProviderRegistry.getChatUIConfig('codex').getModelOptions(settings);
    if (codexOptions.some(opt => opt.value === model)) return 'codex';
  }

  return DEFAULT_CHAT_PROVIDER_ID;
}
