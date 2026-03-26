export type { PluginInfo as ClaudianPlugin, PluginScope } from '../../../core/types';

export interface InstalledPluginEntry {
  scope: 'user' | 'project';
  installPath: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  gitCommitSha?: string;
  projectPath?: string;
}

export interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, InstalledPluginEntry[]>;
}
