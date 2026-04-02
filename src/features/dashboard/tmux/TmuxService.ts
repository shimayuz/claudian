import { execFile } from 'child_process';
import { promisify } from 'util';
import type { TmuxSession } from '../types';

const exec = promisify(execFile);

export class TmuxService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async isAvailable(): Promise<boolean> {
    try {
      await exec('which', ['tmux'], { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const { stdout } = await exec('tmux', [
        'list-sessions', '-F',
        '#{session_name}:#{session_created}:#{session_windows}:#{session_attached}',
      ], { timeout: 5000 });

      const sessions: TmuxSession[] = [];
      for (const line of stdout.trim().split('\n')) {
        if (!line.trim()) continue;
        const [name, created, windows, attached] = line.split(':');
        const session: TmuxSession = {
          id: name,
          name,
          created: new Date(parseInt(created, 10) * 1000),
          windows: parseInt(windows, 10) || 1,
          attached: attached === '1',
          hasClaudeProcess: false,
        };
        session.hasClaudeProcess = await this.checkClaudeProcess(name);
        sessions.push(session);
      }
      return sessions;
    } catch {
      return [];
    }
  }

  private async checkClaudeProcess(sessionName: string): Promise<boolean> {
    try {
      const { stdout } = await exec('tmux', [
        'list-panes', '-t', sessionName, '-F', '#{pane_pid}',
      ], { timeout: 3000 });
      for (const pid of stdout.trim().split('\n')) {
        if (!pid.trim()) continue;
        try {
          const { stdout: cmd } = await exec('ps', ['-p', pid.trim(), '-o', 'command='], { timeout: 3000 });
          if (cmd.includes('claude')) return true;
        } catch { /* process ended */ }
      }
    } catch { /* ignore */ }
    return false;
  }

  async capturePane(sessionName: string, paneIndex = 0, lines = 100): Promise<string> {
    try {
      const { stdout } = await exec('tmux', [
        'capture-pane', '-t', `${sessionName}:0.${paneIndex}`, '-p', '-S', `-${lines}`,
      ], { timeout: 5000 });
      return stdout;
    } catch {
      return '';
    }
  }

  async sendKeys(sessionName: string, keys: string): Promise<void> {
    try {
      await exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter'], { timeout: 3000 });
    } catch { /* ignore */ }
  }

  startPolling(interval: number, callback: (sessions: TmuxSession[]) => void): void {
    this.stopPolling();
    const poll = async (): Promise<void> => { callback(await this.listSessions()); };
    void poll();
    this.pollTimer = setInterval(() => void poll(), interval);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
