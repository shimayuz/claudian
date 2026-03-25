import type { ProviderId, ProviderRegistration } from '../core/providers';
import { claudeProviderRegistration } from './claude/registration';

export const PROVIDER_REGISTRATIONS: Partial<Record<ProviderId, ProviderRegistration>> = {
  claude: claudeProviderRegistration,
};
