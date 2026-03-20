import type { ProviderId, ProviderRegistration } from '../core/providers';
import { claudeProviderRegistration } from './claude/registration';

type RegisteredProviderId = ProviderId;

export const PROVIDER_REGISTRATIONS: Partial<Record<RegisteredProviderId, ProviderRegistration>> = {
  claude: claudeProviderRegistration,
};
