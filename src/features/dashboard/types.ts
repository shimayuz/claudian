export const VIEW_TYPE_TMUX = 'claudian-tmux-dashboard';
export const VIEW_TYPE_AUTOMATION = 'claudian-automation-dashboard';

export interface TmuxSession {
  id: string;
  name: string;
  created: Date;
  windows: number;
  attached: boolean;
  hasClaudeProcess: boolean;
}

export interface AutomationProcess {
  pid: number;
  command: string;
  prompt: string;
  startTime: string;
  status: 'running' | 'completed' | 'error';
}

export interface ScheduledTask {
  id: string;
  schedule: string;
  command: string;
  status: 'active' | 'paused' | 'error';
}
