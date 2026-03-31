/**
 * Security Hooks
 *
 * PreToolUse hooks for enforcing the command blocklist.
 */

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { Notice } from 'obsidian';

import { isCommandBlocked } from '../../../core/security/BlocklistChecker';
import { TOOL_BASH } from '../../../core/tools/toolNames';
import { getBashToolBlockedCommands, type PlatformBlockedCommands } from '../../../core/types';

export interface BlocklistContext {
  blockedCommands: PlatformBlockedCommands;
  enableBlocklist: boolean;
}

/**
 * Create a PreToolUse hook to enforce the command blocklist.
 */
export function createBlocklistHook(getContext: () => BlocklistContext): HookCallbackMatcher {
  return {
    matcher: TOOL_BASH,
    hooks: [
      async (hookInput) => {
        const input = hookInput as {
          tool_name: string;
          tool_input: { command?: string };
        };
        const command = input.tool_input?.command || '';
        const context = getContext();

        const bashToolCommands = getBashToolBlockedCommands(context.blockedCommands);
        if (isCommandBlocked(command, bashToolCommands, context.enableBlocklist)) {
          new Notice('Command blocked by security policy');
          return {
            continue: false,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Command blocked by blocklist: ${command}`,
            },
          };
        }

        return { continue: true };
      },
    ],
  };
}
