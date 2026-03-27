import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { ChatMessage, ContentBlock, ToolCallInfo } from '../../../core/types';
import {
  isCodexToolOutputError,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  normalizeCodexToolResult,
  parseCodexArguments,
} from '../normalization';

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
  error?: { message: string };
  message?: string;
}

interface CodexItem {
  id: string;
  type: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: Array<{ path: string; kind: string }>;
  query?: string;
  message?: string;
  server?: string;
  tool?: string;
}

interface PersistedMessagePart {
  type?: string;
  text?: string;
}

interface PersistedMessagePayload {
  type: 'message';
  role?: string;
  content?: PersistedMessagePart[];
}

interface PersistedReasoningPayload {
  type: 'reasoning';
  summary?: Array<{ type?: string; text?: string }>;
  text?: string;
}

interface PersistedToolCallPayload {
  type: 'function_call' | 'custom_tool_call';
  name?: string;
  arguments?: string;
  call_id?: string;
  input?: string;
}

interface PersistedToolCallOutputPayload {
  type: 'function_call_output' | 'custom_tool_call_output';
  call_id?: string;
  output?: string;
}

interface PersistedWebSearchCallPayload {
  type: 'web_search_call';
  action?: { query?: string };
  status?: string;
  call_id?: string;
}

interface PersistedEventPayload {
  type?: string;
  text?: string;
}

interface TurnAccumulator {
  assistantText: string;
  thinkingText: string;
  toolCalls: ToolCallInfo[];
  contentBlocks: ContentBlock[];
  interrupted: boolean;
  timestamp: number;
}

type PersistedPayload =
  | PersistedMessagePayload
  | PersistedReasoningPayload
  | PersistedToolCallPayload
  | PersistedToolCallOutputPayload
  | PersistedWebSearchCallPayload
  | PersistedEventPayload
  | undefined;

function newTurn(timestamp = 0): TurnAccumulator {
  return {
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    contentBlocks: [],
    interrupted: false,
    timestamp,
  };
}

function flushTurn(turn: TurnAccumulator, messages: ChatMessage[], msgIndex: number): number {
  if (
    !turn.assistantText &&
    !turn.thinkingText &&
    turn.toolCalls.length === 0
  ) {
    return msgIndex;
  }

  const msg: ChatMessage = {
    id: `codex-msg-${msgIndex}`,
    role: 'assistant',
    content: turn.assistantText,
    timestamp: turn.timestamp || Date.now(),
    toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    contentBlocks: turn.contentBlocks.length > 0 ? turn.contentBlocks : undefined,
  };

  if (turn.interrupted) {
    msg.isInterrupt = true;
  }

  messages.push(msg);
  return msgIndex + 1;
}

function setTextBlock(turn: TurnAccumulator, content: string): void {
  const index = turn.contentBlocks.findIndex(block => block.type === 'text');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'text', content });
    return;
  }

  turn.contentBlocks[index] = { type: 'text', content };
}

function appendThinkingBlock(turn: TurnAccumulator, content: string): void {
  const normalized = content.trim();
  if (!normalized) {
    return;
  }

  const parts = turn.thinkingText
    ? turn.thinkingText.split('\n\n').map(part => part.trim())
    : [];
  if (parts.includes(normalized)) {
    return;
  }

  turn.thinkingText = turn.thinkingText
    ? `${turn.thinkingText}\n\n${normalized}`
    : normalized;

  const index = turn.contentBlocks.findIndex(block => block.type === 'thinking');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'thinking', content: turn.thinkingText });
    return;
  }

  turn.contentBlocks[index] = { type: 'thinking', content: turn.thinkingText };
}

function setThinkingBlock(turn: TurnAccumulator, content: string): void {
  const normalized = content.trim();
  if (!normalized) {
    return;
  }

  turn.thinkingText = normalized;

  const index = turn.contentBlocks.findIndex(block => block.type === 'thinking');
  if (index === -1) {
    turn.contentBlocks.push({ type: 'thinking', content: normalized });
    return;
  }

  turn.contentBlocks[index] = { type: 'thinking', content: normalized };
}

function touchTurn(turn: TurnAccumulator, timestamp: number): void {
  if (turn.timestamp === 0 && timestamp > 0) {
    turn.timestamp = timestamp;
  }
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const CODEX_SYSTEM_MESSAGE_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context>',
];

// Matches bracket-format context appended by encodeCodexTurn
const CODEX_BRACKET_CONTEXT_PATTERN = /\n\[(?:Current note|Editor selection from|Browser selection from|Canvas selection from)\b/;

function isCodexSystemMessage(text: string): boolean {
  const trimmed = text.trimStart();
  return CODEX_SYSTEM_MESSAGE_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function extractCodexDisplayContent(text: string): string | undefined {
  if (!text) return undefined;

  const bracketMatch = text.match(CODEX_BRACKET_CONTEXT_PATTERN);
  if (bracketMatch?.index !== undefined) {
    return text.substring(0, bracketMatch.index).trim();
  }

  return undefined;
}

function extractMessageText(content: PersistedMessagePart[] | undefined): string {
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map(part => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
}

function extractReasoningText(payload: PersistedReasoningPayload | PersistedEventPayload): string {
  if ('summary' in payload && Array.isArray(payload.summary) && payload.summary.length > 0) {
    return payload.summary
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }

  return typeof payload.text === 'string' ? payload.text.trim() : '';
}

// Local helpers removed — now using shared normalization layer.

function processLegacyItem(
  eventType: string,
  item: CodexItem,
  turn: TurnAccumulator,
): void {
  switch (item.type) {
    case 'agent_message':
      if (eventType === 'item.completed' || eventType === 'item.updated') {
        if (item.text) {
          turn.assistantText = item.text;
          setTextBlock(turn, item.text);
        }
      }
      break;

    case 'reasoning':
      if (eventType === 'item.completed' || eventType === 'item.updated') {
        if (item.text) {
          setThinkingBlock(turn, item.text);
        }
      }
      break;

    case 'command_execution':
      if (eventType === 'item.started') {
        turn.toolCalls.push({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { command: item.command ?? '' }),
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          const rawOutput = item.aggregated_output ?? '';
          tc.result = normalizeCodexToolResult(tc.name, rawOutput);
          tc.status = item.exit_code === 0 ? 'completed' : 'error';
        }
      }
      break;

    case 'file_change': {
      const changes = item.changes ?? [];
      if (eventType === 'item.started' || eventType === 'item.completed') {
        const existing = turn.toolCalls.find(tool => tool.id === item.id);
        if (!existing) {
          const paths = changes.map(change => `${change.kind}: ${change.path}`).join(', ');
          turn.toolCalls.push({
            id: item.id,
            name: normalizeCodexToolName('file_change'),
            input: { changes },
            status: item.status === 'completed' ? 'completed' : 'error',
            result: paths ? `Applied: ${paths}` : 'Applied',
          });
          turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
        } else if (eventType === 'item.completed') {
          existing.status = item.status === 'completed' ? 'completed' : 'error';
        }
      }
      break;
    }

    case 'web_search':
      if (eventType === 'item.started') {
        turn.toolCalls.push({
          id: item.id,
          name: normalizeCodexToolName(item.type),
          input: normalizeCodexToolInput(item.type, { query: item.query ?? '' }),
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          tc.result = 'Search complete';
          tc.status = 'completed';
        }
      }
      break;

    case 'mcp_tool_call':
      if (eventType === 'item.started') {
        const server = item.server ?? '';
        const tool = item.tool ?? '';
        turn.toolCalls.push({
          id: item.id,
          name: `mcp__${server}__${tool}`,
          input: {},
          status: 'running',
        });
        turn.contentBlocks.push({ type: 'tool_use', toolId: item.id });
      } else if (eventType === 'item.completed') {
        const tc = turn.toolCalls.find(tool => tool.id === item.id);
        if (tc) {
          tc.status = item.status === 'completed' ? 'completed' : 'error';
          tc.result = item.status === 'completed' ? 'Completed' : 'Failed';
        }
      }
      break;

    default:
      break;
  }
}

function processPersistedToolCall(
  payload: PersistedToolCallPayload,
  timestamp: number,
  turn: TurnAccumulator,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  touchTurn(turn, timestamp);
  const rawArgs = payload.arguments ?? payload.input;
  const parsedArgs = parseCodexArguments(rawArgs);
  const normalizedName = normalizeCodexToolName(payload.name);
  const normalizedInput = normalizeCodexToolInput(payload.name, parsedArgs);

  turn.toolCalls.push({
    id: callId,
    name: normalizedName,
    input: normalizedInput,
    status: 'running',
  });
  turn.contentBlocks.push({ type: 'tool_use', toolId: callId });
}

function processPersistedToolOutput(
  payload: PersistedToolCallOutputPayload,
  timestamp: number,
  turn: TurnAccumulator,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  touchTurn(turn, timestamp);
  const rawOutput = payload.output ?? '';
  const existing = turn.toolCalls.find(tool => tool.id === callId);
  const normalizedResult = normalizeCodexToolResult(
    existing?.name ?? 'tool',
    rawOutput,
  );

  if (existing) {
    existing.result = normalizedResult;
    existing.status = isCodexToolOutputError(rawOutput) ? 'error' : 'completed';
  } else {
    turn.toolCalls.push({
      id: callId,
      name: 'tool',
      input: {},
      status: isCodexToolOutputError(rawOutput) ? 'error' : 'completed',
      result: normalizedResult,
    });
  }
}

function processPersistedWebSearchCall(
  payload: PersistedWebSearchCallPayload,
  timestamp: number,
  turn: TurnAccumulator,
): void {
  const callId = payload.call_id;
  if (!callId) return;

  touchTurn(turn, timestamp);
  const input = normalizeCodexToolInput('web_search_call', {
    action: payload.action ?? {},
  });

  const existing = turn.toolCalls.find(tool => tool.id === callId);
  if (existing) return;

  const isTerminal = payload.status === 'completed' || payload.status === 'failed'
    || payload.status === 'error' || payload.status === 'cancelled';

  turn.toolCalls.push({
    id: callId,
    name: 'WebSearch',
    input,
    status: isTerminal ? (payload.status === 'completed' ? 'completed' : 'error') : 'running',
    ...(isTerminal ? { result: 'Search complete' } : {}),
  });
  turn.contentBlocks.push({ type: 'tool_use', toolId: callId });
}

function processPersistedPayload(
  payload: PersistedPayload,
  timestamp: number,
  turn: TurnAccumulator,
  messages: ChatMessage[],
  msgIndex: number,
): { turn: TurnAccumulator; msgIndex: number } {
  if (!payload?.type) {
    return { turn, msgIndex };
  }

  switch (payload.type) {
    case 'message': {
      const messagePayload = payload as PersistedMessagePayload;
      const text = extractMessageText(messagePayload.content);
      if (messagePayload.role === 'user') {
        if (isCodexSystemMessage(text)) {
          break;
        }

        msgIndex = flushTurn(turn, messages, msgIndex);
        turn = newTurn();

        if (text) {
          const displayContent = extractCodexDisplayContent(text);
          messages.push({
            id: `codex-msg-${msgIndex}`,
            role: 'user',
            content: text,
            ...(displayContent !== undefined ? { displayContent } : {}),
            timestamp: timestamp || Date.now(),
          });
          msgIndex += 1;
        }
      } else if (messagePayload.role === 'assistant') {
        touchTurn(turn, timestamp);
        turn.assistantText = text;
        if (text) {
          setTextBlock(turn, text);
        }
        msgIndex = flushTurn(turn, messages, msgIndex);
        turn = newTurn();
      }
      break;
    }

    case 'reasoning': {
      const reasoningPayload = payload as PersistedReasoningPayload;
      const text = extractReasoningText(reasoningPayload);
      touchTurn(turn, timestamp);
      appendThinkingBlock(turn, text);
      break;
    }

    case 'function_call':
    case 'custom_tool_call':
      processPersistedToolCall(payload as PersistedToolCallPayload, timestamp, turn);
      break;

    case 'function_call_output':
    case 'custom_tool_call_output':
      processPersistedToolOutput(payload as PersistedToolCallOutputPayload, timestamp, turn);
      break;

    case 'web_search_call':
      processPersistedWebSearchCall(payload as PersistedWebSearchCallPayload, timestamp, turn);
      break;

    default:
      break;
  }

  return { turn, msgIndex };
}

export function findCodexSessionFile(
  threadId: string,
  root: string = path.join(os.homedir(), '.codex', 'sessions'),
): string | null {
  if (!threadId || !fs.existsSync(root)) {
    return null;
  }

  const directPath = path.join(root, `${threadId}.jsonl`);
  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
        return fullPath;
      }
    }
  }

  return null;
}

export function parseCodexSessionFile(filePath: string): ChatMessage[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  return parseCodexSessionContent(content);
}

export function parseCodexSessionContent(content: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turn = newTurn();
  let msgIndex = 0;

  const lines = content.split('\n').filter(line => line.trim());

  for (const line of lines) {
    let parsed: { timestamp?: string; type?: string; event?: CodexEvent; payload?: PersistedPayload };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type === 'event' && parsed.event) {
      const event = parsed.event;

      switch (event.type) {
        case 'turn.started':
          if (turn.assistantText || turn.thinkingText || turn.toolCalls.length > 0) {
            msgIndex = flushTurn(turn, messages, msgIndex);
          }
          turn = newTurn();
          break;

        case 'item.started':
        case 'item.updated':
        case 'item.completed':
          if (event.item) {
            processLegacyItem(event.type, event.item, turn);
          }
          break;

        case 'turn.completed':
          msgIndex = flushTurn(turn, messages, msgIndex);
          turn = newTurn();
          break;

        case 'turn.failed':
          turn.interrupted = true;
          msgIndex = flushTurn(turn, messages, msgIndex);
          turn = newTurn();
          break;

        default:
          break;
      }

      continue;
    }

    const timestamp = parseTimestamp(parsed.timestamp);

    if (parsed.type === 'event_msg' && parsed.payload?.type === 'agent_reasoning') {
      touchTurn(turn, timestamp);
      appendThinkingBlock(turn, extractReasoningText(parsed.payload));
      continue;
    }

    if (parsed.type === 'response_item') {
      const next = processPersistedPayload(parsed.payload, timestamp, turn, messages, msgIndex);
      turn = next.turn;
      msgIndex = next.msgIndex;
    }
  }

  flushTurn(turn, messages, msgIndex);

  return messages;
}
