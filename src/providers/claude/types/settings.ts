/** Claude provider settings and Claude Code compatibility types. */

import {
  type EnvSnippet,
  getDefaultBlockedCommands,
  type KeyboardNavigationSettings,
  type PlatformBlockedCommands,
  type SlashCommand,
  type TabBarPosition,
} from '../../../core/types/settings';
import type { Locale } from '../../../i18n/types';
import type { ClaudeModel, EffortLevel, ThinkingBudget } from './models';

/**
 * Platform-specific Claude CLI paths.
 * @deprecated Use HostnameCliPaths instead. Kept for migration from older versions.
 */
export interface PlatformCliPaths {
  macos: string;
  linux: string;
  windows: string;
}

/** Platform key for CLI paths. Used for migration only. */
export type CliPlatformKey = keyof PlatformCliPaths;

/**
 * Map process.platform to CLI platform key.
 * @deprecated Used for migration only.
 */
export function getCliPlatformKey(): CliPlatformKey {
  switch (process.platform) {
    case 'darwin':
      return 'macos';
    case 'win32':
      return 'windows';
    default:
      return 'linux';
  }
}

/**
 * Hostname-keyed CLI paths for per-device configuration.
 * Each device stores its path using its hostname as key.
 * This allows settings to sync across devices without conflicts.
 */
export type HostnameCliPaths = Record<string, string>;

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'plan' | 'normal';

/**
 * Legacy permission format (pre-CC compatibility).
 * @deprecated Use CCPermissions instead
 */
export interface LegacyPermission {
  toolName: string;
  pattern: string;
  approvedAt: number;
  scope: 'session' | 'always';
}

/**
 * CC-compatible permission rule string.
 * Format: "Tool(pattern)" or "Tool" for all
 * Examples: "Bash(git *)", "Read(*.md)", "WebFetch(domain:github.com)"
 */
export type PermissionRule = string & { readonly __brand: 'PermissionRule' };

/**
 * Create a PermissionRule from a string.
 * @internal Use legacyPermissionToCCRule instead.
 */
export function createPermissionRule(rule: string): PermissionRule {
  return rule as PermissionRule;
}

/**
 * CC-compatible permissions object.
 * Stored in .claude/settings.json for interoperability with Claude Code CLI.
 */
export interface CCPermissions {
  /** Rules that auto-approve tool actions */
  allow?: PermissionRule[];
  /** Rules that auto-deny tool actions (highest persistent priority) */
  deny?: PermissionRule[];
  /** Rules that always prompt for confirmation */
  ask?: PermissionRule[];
  /** Default permission mode */
  defaultMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'plan';
  /** Additional directories to include in permission scope */
  additionalDirectories?: string[];
}

/**
 * CC-compatible settings stored in .claude/settings.json.
 * These settings are shared with Claude Code CLI.
 */
export interface CCSettings {
  /** JSON Schema reference */
  $schema?: string;
  /** Tool permissions (CC format) */
  permissions?: CCPermissions;
  /** Model override */
  model?: string;
  /** Environment variables (object format) */
  env?: Record<string, string>;
  /** MCP server settings */
  enableAllProjectMcpServers?: boolean;
  enabledMcpjsonServers?: string[];
  disabledMcpjsonServers?: string[];
  /** Plugin enabled state (CC format: { "plugin-id": true/false }) */
  enabledPlugins?: Record<string, boolean>;
  /** Allow additional properties for CC compatibility */
  [key: string]: unknown;
}

/**
 * Claudian-specific settings stored in .claude/claudian-settings.json.
 * These settings are NOT shared with Claude Code CLI.
 */
export interface ClaudianSettings {
  // User preferences
  userName: string;

  // Security (Claudian-specific, CC uses permissions.deny instead)
  enableBlocklist: boolean;
  allowExternalAccess: boolean;
  blockedCommands: PlatformBlockedCommands;
  permissionMode: PermissionMode;

  // Model & thinking (Claudian uses enum, CC uses full model ID string)
  model: ClaudeModel;
  thinkingBudget: ThinkingBudget;  // Legacy token budget for custom models
  effortLevel: EffortLevel;  // Effort level for adaptive thinking models
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;  // Model for auto title generation (empty = auto)
  enableChrome: boolean;  // Enable Chrome extension support (passes --chrome flag)
  enableBangBash: boolean;  // Enable ! bash mode for direct command execution
  enableOpus1M: boolean;  // Show Opus 1M model variant (opus[1m])
  enableSonnet1M: boolean;  // Show Sonnet 1M model variant (sonnet[1m])

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  allowedExportPaths: string[];
  persistentExternalContextPaths: string[];  // Paths that persist across all sessions

  // Environment (string format, CC uses object format in settings.json)
  environmentVariables: string;
  envSnippets: EnvSnippet[];
  /**
   * Custom context window limits for models configured via environment variables.
   * Keys are model IDs (from ANTHROPIC_MODEL, ANTHROPIC_DEFAULT_*_MODEL env vars).
   * Values are token counts in range [1000, 10000000].
   * Empty object means all models use default context limits (200k).
   */
  customContextLimits: Record<string, number>;

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;

  // Internationalization
  locale: Locale;  // UI language setting

  // CLI paths
  claudeCliPath: string;  // Legacy: single CLI path (for backwards compatibility)
  claudeCliPathsByHost: HostnameCliPaths;  // Per-device paths keyed by hostname (preferred)
  loadUserClaudeSettings: boolean;  // Load ~/.claude/settings.json (may override permissions)

  // State (merged from data.json)
  lastClaudeModel?: ClaudeModel;
  lastCustomModel?: ClaudeModel;
  lastEnvHash?: string;

  // Slash commands (loaded separately from .claude/commands/)
  slashCommands: SlashCommand[];

  // UI preferences
  maxTabs: number;  // Maximum number of chat tabs (3-10, default 3)
  tabBarPosition: TabBarPosition;  // Where to show tab bar ('input' or 'header')
  enableAutoScroll: boolean;  // Enable auto-scroll during streaming (default: true)
  openInMainTab: boolean;  // Open chat panel in main editor area instead of sidebar

  // Slash commands
  hiddenSlashCommands: string[];  // Command names to hide from dropdown (user preference)
}

/** Default Claudian-specific settings. */
export const DEFAULT_SETTINGS: ClaudianSettings = {
  // User preferences
  userName: '',

  // Security
  enableBlocklist: true,
  allowExternalAccess: false,
  blockedCommands: getDefaultBlockedCommands(),
  permissionMode: 'yolo',

  // Model & thinking
  model: 'haiku',
  thinkingBudget: 'off',
  effortLevel: 'high',
  enableAutoTitleGeneration: true,
  titleGenerationModel: '',  // Empty = auto (ANTHROPIC_DEFAULT_HAIKU_MODEL or claude-haiku-4-5)
  enableChrome: false,  // Disabled by default
  enableBangBash: false,  // Disabled by default
  enableOpus1M: false,  // Disabled by default
  enableSonnet1M: false,  // Disabled by default

  // Content settings
  excludedTags: [],
  mediaFolder: '',
  systemPrompt: '',
  allowedExportPaths: ['~/Desktop', '~/Downloads'],
  persistentExternalContextPaths: [],

  // Environment
  environmentVariables: '',
  envSnippets: [],
  customContextLimits: {},

  // UI settings
  keyboardNavigation: {
    scrollUpKey: 'w',
    scrollDownKey: 's',
    focusInputKey: 'i',
  },

  // Internationalization
  locale: 'en',  // Default to English

  // CLI paths
  claudeCliPath: '',  // Legacy field (empty = not migrated)
  claudeCliPathsByHost: {},  // Per-device paths keyed by hostname
  loadUserClaudeSettings: true,  // Default on for compatibility

  lastClaudeModel: 'haiku',
  lastCustomModel: '',
  lastEnvHash: '',

  // Slash commands (loaded separately)
  slashCommands: [],

  // UI preferences
  maxTabs: 3,  // Default to 3 tabs (safe resource usage)
  tabBarPosition: 'input',  // Default to input mode (current behavior)
  enableAutoScroll: true,  // Default to auto-scroll enabled
  openInMainTab: false,  // Default to sidebar (current behavior)

  // Slash commands
  hiddenSlashCommands: [],  // No commands hidden by default
};

/** Default CC-compatible settings. */
export const DEFAULT_CC_SETTINGS: CCSettings = {
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  permissions: {
    allow: [],
    deny: [],
    ask: [],
  },
};

/** Default CC permissions. */
export const DEFAULT_CC_PERMISSIONS: CCPermissions = {
  allow: [],
  deny: [],
  ask: [],
};

/**
 * Convert a legacy permission to CC permission rule format.
 * Examples:
 *   { toolName: "Bash", pattern: "git *" } → "Bash(git *)"
 *   { toolName: "Read", pattern: "/path/to/file" } → "Read(/path/to/file)"
 *   { toolName: "WebSearch", pattern: "*" } → "WebSearch"
 */
export function legacyPermissionToCCRule(legacy: LegacyPermission): PermissionRule {
  const pattern = legacy.pattern.trim();

  // If pattern is empty, wildcard, or JSON object (old format), just use tool name
  if (!pattern || pattern === '*' || pattern.startsWith('{')) {
    return createPermissionRule(legacy.toolName);
  }

  return createPermissionRule(`${legacy.toolName}(${pattern})`);
}

/**
 * Convert legacy permissions array to CC permissions object.
 * Only 'always' scope permissions are converted (session = ephemeral).
 */
export function legacyPermissionsToCCPermissions(
  legacyPermissions: LegacyPermission[]
): CCPermissions {
  const allow: PermissionRule[] = [];

  for (const perm of legacyPermissions) {
    if (perm.scope === 'always') {
      allow.push(legacyPermissionToCCRule(perm));
    }
  }

  return {
    allow: [...new Set(allow)],  // Deduplicate
    deny: [],
    ask: [],
  };
}

/**
 * Parse a CC permission rule into tool name and pattern.
 * Examples:
 *   "Bash(git *)" → { tool: "Bash", pattern: "git *" }
 *   "Read" → { tool: "Read", pattern: undefined }
 *   "WebFetch(domain:github.com)" → { tool: "WebFetch", pattern: "domain:github.com" }
 */
export function parseCCPermissionRule(rule: PermissionRule): {
  tool: string;
  pattern?: string;
} {
  const match = rule.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) {
    return { tool: rule };
  }

  const [, tool, pattern] = match;
  return { tool, pattern };
}
