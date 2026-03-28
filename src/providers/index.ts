import type { ProviderId, ProviderRegistration } from '../core/providers/types';
import { claudeProviderRegistration } from './claude/registration';
import { codexProviderRegistration } from './codex/registration';

export const PROVIDER_REGISTRATIONS: Partial<Record<ProviderId, ProviderRegistration>> = {
  claude: claudeProviderRegistration,
  codex: codexProviderRegistration,
};
