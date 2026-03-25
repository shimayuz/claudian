/**
 * SessionStorage - Handles chat session metadata in vault/.claude/sessions/
 *
 * Each conversation stores metadata as a .meta.json file.
 * Messages are stored by the SDK in ~/.claude/ (provider-native storage).
 */

import { DEFAULT_CHAT_PROVIDER_ID } from '../../../core/providers/types';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import { isSubagentToolName } from '../../../core/tools/toolNames';
import type {
  ChatMessage,
  Conversation,
  ConversationMeta,
  SessionMetadata,
} from '../../../core/types';
import type { SubagentInfo } from '../../../core/types/tools';
import type { ClaudeProviderState } from '../types';

/** Path to sessions folder relative to vault root. */
export const SESSIONS_PATH = '.claude/sessions';

/** Legacy metadata shape before providerId/providerState migration. */
interface LegacySessionMetadata {
  providerSessionId?: string;
  previousProviderSessionIds?: string[];
  forkSource?: { sessionId: string; resumeAt: string };
  subagentData?: Record<string, SubagentInfo>;
}

/**
 * Migrates legacy Claude-specific top-level fields into providerState.
 * Returns the metadata with providerId defaulted and legacy fields folded.
 */
function migrateMetadata(raw: SessionMetadata & LegacySessionMetadata): SessionMetadata {
  if (!raw.providerId) {
    raw.providerId = DEFAULT_CHAT_PROVIDER_ID;
  }

  // Fold legacy top-level Claude fields into providerState
  if (!raw.providerState) {
    const legacy: ClaudeProviderState = {};
    if (raw.providerSessionId !== undefined) legacy.providerSessionId = raw.providerSessionId;
    if (raw.previousProviderSessionIds) legacy.previousProviderSessionIds = raw.previousProviderSessionIds;
    if (raw.forkSource) legacy.forkSource = raw.forkSource;
    if (raw.subagentData) legacy.subagentData = raw.subagentData;

    if (Object.keys(legacy).length > 0) {
      raw.providerState = legacy as Record<string, unknown>;
    }
  }

  // Clean legacy fields from the object
  delete raw.providerSessionId;
  delete raw.previousProviderSessionIds;
  delete raw.forkSource;
  delete raw.subagentData;

  return raw;
}

export class SessionStorage {
  constructor(private adapter: VaultFileAdapter) { }

  getMetadataPath(id: string): string {
    return `${SESSIONS_PATH}/${id}.meta.json`;
  }

  async saveMetadata(metadata: SessionMetadata): Promise<void> {
    const filePath = this.getMetadataPath(metadata.id);
    const content = JSON.stringify(metadata, null, 2);
    await this.adapter.write(filePath, content);
  }

  async loadMetadata(id: string): Promise<SessionMetadata | null> {
    const filePath = this.getMetadataPath(id);

    try {
      if (!(await this.adapter.exists(filePath))) {
        return null;
      }

      const content = await this.adapter.read(filePath);
      const raw = JSON.parse(content) as SessionMetadata & LegacySessionMetadata;
      return migrateMetadata(raw);
    } catch {
      return null;
    }
  }

  async deleteMetadata(id: string): Promise<void> {
    const filePath = this.getMetadataPath(id);
    await this.adapter.delete(filePath);
  }

  /** List all session metadata (.meta.json files). */
  async listMetadata(): Promise<SessionMetadata[]> {
    const metas: SessionMetadata[] = [];

    try {
      const files = await this.adapter.listFiles(SESSIONS_PATH);
      const metaFiles = files.filter(f => f.endsWith('.meta.json'));

      for (const filePath of metaFiles) {
        try {
          const content = await this.adapter.read(filePath);
          const raw = JSON.parse(content) as SessionMetadata & LegacySessionMetadata;
          metas.push(migrateMetadata(raw));
        } catch {
          // Skip files that fail to load
        }
      }
    } catch {
      // Return empty list if directory listing fails
    }

    return metas;
  }

  /** List all conversations as lightweight metadata for the history dropdown. */
  async listAllConversations(): Promise<ConversationMeta[]> {
    const nativeMetas = await this.listMetadata();

    const metas: ConversationMeta[] = nativeMetas.map(meta => ({
      id: meta.id,
      providerId: meta.providerId ?? DEFAULT_CHAT_PROVIDER_ID,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      lastResponseAt: meta.lastResponseAt,
      messageCount: 0,
      preview: 'SDK session',
      titleGenerationStatus: meta.titleGenerationStatus,
    }));

    return metas.sort((a, b) =>
      (b.lastResponseAt ?? b.createdAt) - (a.lastResponseAt ?? a.createdAt)
    );
  }

  toSessionMetadata(conversation: Conversation): SessionMetadata {
    const subagentData = this.extractSubagentData(conversation.messages);

    // Merge extracted subagentData into providerState for persistence
    const providerState: Record<string, unknown> = { ...conversation.providerState };
    if (Object.keys(subagentData).length > 0) {
      providerState.subagentData = subagentData;
    } else {
      delete providerState.subagentData;
    }

    return {
      id: conversation.id,
      providerId: conversation.providerId,
      title: conversation.title,
      titleGenerationStatus: conversation.titleGenerationStatus,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastResponseAt: conversation.lastResponseAt,
      sessionId: conversation.sessionId,
      providerState: Object.keys(providerState).length > 0 ? providerState : undefined,
      currentNote: conversation.currentNote,
      externalContextPaths: conversation.externalContextPaths,
      enabledMcpServers: conversation.enabledMcpServers,
      usage: conversation.usage,
      resumeAtMessageId: conversation.resumeAtMessageId,
    };
  }

  private extractSubagentData(messages: ChatMessage[]): Record<string, SubagentInfo> {
    const result: Record<string, SubagentInfo> = {};

    for (const msg of messages) {
      if (msg.role !== 'assistant') continue;

      if (msg.toolCalls) {
        for (const toolCall of msg.toolCalls) {
          if (!isSubagentToolName(toolCall.name) || !toolCall.subagent) continue;
          result[toolCall.subagent.id] = toolCall.subagent;
        }
      }
    }

    return result;
  }

}
