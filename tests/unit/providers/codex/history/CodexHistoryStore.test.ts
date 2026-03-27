import * as path from 'path';

import { parseCodexSessionContent, parseCodexSessionFile } from '@/providers/codex/history/CodexHistoryStore';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

describe('CodexHistoryStore', () => {
  describe('parseCodexSessionFile - simple session', () => {
    it('should parse a simple session with reasoning and agent message', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-simple.jsonl');
      const messages = parseCodexSessionFile(filePath);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('Hello! I can help you with that.');

      // Should have thinking content block
      const thinkingBlock = messages[0].contentBlocks?.find(b => b.type === 'thinking');
      expect(thinkingBlock).toBeDefined();
      expect(thinkingBlock).toMatchObject({
        type: 'thinking',
        content: 'Let me think about this request carefully.',
      });

      // Should have text content block
      const textBlock = messages[0].contentBlocks?.find(b => b.type === 'text');
      expect(textBlock).toBeDefined();
    });
  });

  describe('parseCodexSessionFile - tools session', () => {
    it('should parse a session with command execution and file changes', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      expect(messages).toHaveLength(1);

      const msg = messages[0];
      expect(msg.toolCalls).toBeDefined();
      expect(msg.toolCalls!.length).toBeGreaterThanOrEqual(2);

      // Check command execution
      const bashTool = msg.toolCalls!.find(tc => tc.name === 'Bash');
      expect(bashTool).toBeDefined();
      expect(bashTool!.input.command).toBe('cat src/main.ts');
      expect(bashTool!.status).toBe('completed');

      // Check file change
      const patchTool = msg.toolCalls!.find(tc => tc.name === 'apply_patch');
      expect(patchTool).toBeDefined();
      expect(patchTool!.status).toBe('completed');
    });

    it('should preserve content blocks order', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const blocks = messages[0].contentBlocks;
      expect(blocks).toBeDefined();
      expect(blocks!.length).toBeGreaterThanOrEqual(3);

      // First block should be text (from initial agent message)
      expect(blocks![0].type).toBe('text');
      // Then tool_use blocks
      const toolBlocks = blocks!.filter(b => b.type === 'tool_use');
      expect(toolBlocks.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('parseCodexSessionFile - abort session', () => {
    it('should handle turn.failed and mark as interrupted', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-abort.jsonl');
      const messages = parseCodexSessionFile(filePath);

      // Should have two messages: one interrupted, one successful
      expect(messages).toHaveLength(2);
      expect(messages[0].isInterrupt).toBe(true);
      expect(messages[1].isInterrupt).toBeUndefined();
      expect(messages[1].content).toBe('OK, what would you like me to do instead?');
    });

    it('keeps the latest streamed content for interrupted turns', () => {
      const content = [
        JSON.stringify({ type: 'event', event: { type: 'turn.started' } }),
        JSON.stringify({ type: 'event', event: { type: 'item.started', item: { id: 'item_1', type: 'agent_message', text: '' } } }),
        JSON.stringify({ type: 'event', event: { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hello' } } }),
        JSON.stringify({ type: 'event', event: { type: 'item.updated', item: { id: 'item_1', type: 'agent_message', text: 'Hello world' } } }),
        JSON.stringify({ type: 'event', event: { type: 'turn.failed', error: { message: 'Cancelled' } } }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: 'Hello world',
        isInterrupt: true,
      });
    });
  });

  describe('parseCodexSessionFile - web search session', () => {
    it('should parse web search items', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-websearch.jsonl');
      const messages = parseCodexSessionFile(filePath);

      expect(messages).toHaveLength(1);

      const msg = messages[0];
      expect(msg.toolCalls).toBeDefined();

      const searchTool = msg.toolCalls!.find(tc => tc.name === 'WebSearch');
      expect(searchTool).toBeDefined();
      expect(searchTool!.input.query).toBe('obsidian plugin API documentation');
      expect(searchTool!.status).toBe('completed');
    });
  });

  describe('parseCodexSessionFile - non-existent file', () => {
    it('should return empty array for missing files', () => {
      const messages = parseCodexSessionFile('/nonexistent/path.jsonl');
      expect(messages).toEqual([]);
    });
  });

  describe('parseCodexSessionContent - persisted response items', () => {
    it('reconstructs user and assistant turns from response_item logs', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Review this diff.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'agent_reasoning',
            text: 'Thinking through the changes.',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:02.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'shell_command',
            arguments: '{"command":"git diff --stat"}',
            call_id: 'call_1',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'function_call_output',
            call_id: 'call_1',
            output: 'Exit code: 0\nOutput:\n src/main.ts | 2 +-',
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:04.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'The diff looks good.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'Review this diff.',
      });
      expect(messages[1]).toMatchObject({
        role: 'assistant',
        content: 'The diff looks good.',
      });

      expect(messages[1].toolCalls).toEqual([
        expect.objectContaining({
          id: 'call_1',
          name: 'Bash',
          input: { command: 'git diff --stat' },
          status: 'completed',
        }),
      ]);

      // Result should be normalized (Output:\n stripped)
      expect(messages[1].toolCalls![0].result).toBe(' src/main.ts | 2 +-');

      expect(messages[1].contentBlocks).toEqual([
        { type: 'thinking', content: 'Thinking through the changes.' },
        { type: 'tool_use', toolId: 'call_1' },
        { type: 'text', content: 'The diff looks good.' },
      ]);
    });
  });

  describe('parseCodexSessionFile - persisted tools', () => {
    it('restores exec_command as Bash with normalized result', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();

      const bashTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'Bash');
      expect(bashTool).toBeDefined();
      expect(bashTool!.id).toBe('call_exec_1');
      expect(bashTool!.input).toEqual({ command: 'cat src/main.ts' });
      expect(bashTool!.status).toBe('completed');
      // Result should be normalized: "Output:\n" prefix stripped
      expect(bashTool!.result).toBe("import { Plugin } from 'obsidian';");
    });

    it('restores custom_tool_call apply_patch as native apply_patch', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const patchTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'apply_patch');
      expect(patchTool).toBeDefined();
      expect(patchTool!.id).toBe('call_patch_1');
      expect(patchTool!.input.patch).toContain('Update File: src/main.ts');
      expect(patchTool!.status).toBe('completed');
    });

    it('restores update_plan as TodoWrite', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const todoTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'TodoWrite');
      expect(todoTool).toBeDefined();
      expect(todoTool!.id).toBe('call_plan_1');
      expect(todoTool!.input.todos).toEqual([
        expect.objectContaining({ content: 'Fix the bug', status: 'completed' }),
        expect.objectContaining({ content: 'Run tests', status: 'in_progress' }),
      ]);
    });

    it('restores request_user_input as AskUserQuestion', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const askTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'AskUserQuestion');
      expect(askTool).toBeDefined();
      expect(askTool!.id).toBe('call_ask_1');
      expect(askTool!.input.questions).toEqual([
        expect.objectContaining({ question: 'Should I also update the tests?', id: 'q1' }),
      ]);
    });

    it('restores view_image as Read', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const readTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'Read');
      expect(readTool).toBeDefined();
      expect(readTool!.id).toBe('call_img_1');
      expect(readTool!.input.file_path).toBe('/tmp/screenshot.png');
    });

    it('restores write_stdin as native write_stdin', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-persisted-tools.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const stdinTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'write_stdin');
      expect(stdinTool).toBeDefined();
      expect(stdinTool!.id).toBe('call_stdin_1');
      expect(stdinTool!.input.session_id).toBe('sess_1');
    });
  });

  describe('parseCodexSessionFile - agent lifecycle', () => {
    it('restores agent lifecycle tools with native names', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-agent-lifecycle.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();
      const toolNames = assistantMsg!.toolCalls!.map(tc => tc.name);

      expect(toolNames).toContain('spawn_agent');
      expect(toolNames).toContain('send_input');
      expect(toolNames).toContain('wait');
      expect(toolNames).toContain('resume_agent');
      expect(toolNames).toContain('close_agent');

      // Should NOT be mapped to Agent/Task
      expect(toolNames).not.toContain('Agent');
      expect(toolNames).not.toContain('Task');
    });

    it('preserves spawn_agent input fields', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-agent-lifecycle.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const spawnTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'spawn_agent');
      expect(spawnTool!.input).toEqual({
        message: 'Update the imports in utils.ts',
        agent_type: 'code-writer',
      });
    });

    it('preserves wait input fields', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-agent-lifecycle.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      const waitTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'wait');
      expect(waitTool!.input).toEqual({
        ids: ['agent_001'],
        timeout_ms: 30000,
      });
    });
  });

  describe('parseCodexSessionContent - system-injected user messages', () => {
    it('should skip AGENTS.md instructions injected as user message', () => {
      const content = [
        JSON.stringify({ type: 'session_meta', id: 'test-session' }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: '<permissions instructions>\nSandbox mode...\n</permissions instructions>' }],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '# AGENTS.md instructions for /Users/test/project\n\n<INSTRUCTIONS>\nDo good work.\n</INSTRUCTIONS>' },
              { type: 'input_text', text: '<environment_context>\n  <cwd>/Users/test/project</cwd>\n</environment_context>' },
            ],
          },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the bug in main.ts' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      // AGENTS.md message should be filtered out; only real user + assistant remain
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'Fix the bug in main.ts' });
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Done.' });
    });

    it('should skip standalone <environment_context> user message', () => {
      const content = [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/Users/test</cwd>\n</environment_context>' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Ready.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ role: 'assistant', content: 'Ready.' });
    });

    it('should set displayContent stripping bracket context from user messages', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Fix the bug\n[Current note: notes/bug.md]' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({
        role: 'user',
        content: 'Fix the bug\n[Current note: notes/bug.md]',
        displayContent: 'Fix the bug',
      });
    });

    it('should set displayContent stripping editor selection context', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Explain this\n[Editor selection from notes/code.md:\nconst x = 1;\n]' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It declares a variable.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages[0]).toMatchObject({
        role: 'user',
        displayContent: 'Explain this',
      });
    });

    it('should not set displayContent on plain user messages', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'What does main.ts do?' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It initializes the plugin.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages[0]).toMatchObject({ role: 'user', content: 'What does main.ts do?' });
      expect(messages[0].displayContent).toBeUndefined();
    });

    it('should NOT skip real user messages', () => {
      const content = [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'What does main.ts do?' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'It initializes the plugin.' }],
          },
        }),
      ].join('\n');

      const messages = parseCodexSessionContent(content);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ role: 'user', content: 'What does main.ts do?' });
    });
  });

  describe('parseCodexSessionFile - persisted web_search_call', () => {
    it('restores web_search_call as WebSearch', () => {
      const filePath = path.join(FIXTURES_DIR, 'codex-session-websearch-persisted.jsonl');
      const messages = parseCodexSessionFile(filePath);

      const assistantMsg = messages.find(m => m.role === 'assistant' && m.toolCalls);
      expect(assistantMsg).toBeDefined();

      const searchTool = assistantMsg!.toolCalls!.find(tc => tc.name === 'WebSearch');
      expect(searchTool).toBeDefined();
      expect(searchTool!.id).toBe('call_ws_1');
      expect(searchTool!.input.query).toBe('obsidian plugin API');
      expect(searchTool!.status).toBe('completed');
    });
  });
});
