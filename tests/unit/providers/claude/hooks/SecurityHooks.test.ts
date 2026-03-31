import {
  type BlocklistContext,
  createBlocklistHook,
} from '@/providers/claude/hooks/SecurityHooks';

describe('SecurityHooks', () => {
  describe('createBlocklistHook', () => {
    const createHookInput = (command: string) => ({
      hook_event_name: 'PreToolUse' as const,
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/vault',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'tool-1',
    });

    it('blocks commands in the blocklist when blocklist is enabled', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf', 'chmod 777'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput('rm -rf /'),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('Command blocked by blocklist'),
        },
      });
    });

    it('allows commands not in the blocklist', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput('ls -la'),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('allows all commands when blocklist is disabled', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: false,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput('rm -rf /'),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('handles empty command', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput(''),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('handles undefined command', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        {
          hook_event_name: 'PreToolUse' as const,
          session_id: 'test-session',
          transcript_path: '/tmp/transcript',
          cwd: '/vault',
          tool_name: 'Bash',
          tool_input: {},
          tool_use_id: 'tool-1',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('matcher is set to Bash tool', () => {
      const hook = createBlocklistHook(() => ({
        blockedCommands: { unix: [], windows: [] },
        enableBlocklist: true,
      }));

      expect(hook.matcher).toBe('Bash');
    });
  });
});
