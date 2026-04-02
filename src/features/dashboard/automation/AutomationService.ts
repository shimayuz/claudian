import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AutomationProcess, ScheduledTask } from '../types';

const exec = promisify(execFile);

export class AutomationService {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async listProcesses(): Promise<AutomationProcess[]> {
    try {
      const { stdout } = await exec('ps', ['aux'], { timeout: 5000 });
      const results: AutomationProcess[] = [];
      for (const line of stdout.split('\n')) {
        if (!line.includes('claude') || !line.includes(' -p ')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 11) continue;
        const pid = parseInt(parts[1], 10);
        const command = parts.slice(10).join(' ');
        const pMatch = command.match(/-p\s+["']?([^"'\n]+)["']?/);
        results.push({
          pid,
          command,
          prompt: pMatch ? pMatch[1].slice(0, 100) : command.slice(0, 100),
          startTime: parts[8] || '',
          status: 'running',
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  async listScheduledTasks(): Promise<ScheduledTask[]> {
    try {
      const { stdout } = await exec('crontab', ['-l'], { timeout: 5000 });
      const results: ScheduledTask[] = [];
      for (const line of stdout.split('\n')) {
        const t = line.trim();
        if (t.startsWith('#') || !t || !t.includes('claude')) continue;
        const m = t.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
        if (m) {
          results.push({ id: crypto.randomUUID(), schedule: m[1], command: m[2], status: 'active' });
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  startPolling(interval: number, cb: (data: { processes: AutomationProcess[]; tasks: ScheduledTask[] }) => void): void {
    this.stopPolling();
    const poll = async (): Promise<void> => {
      const [processes, tasks] = await Promise.all([this.listProcesses(), this.listScheduledTasks()]);
      cb({ processes, tasks });
    };
    void poll();
    this.pollTimer = setInterval(() => void poll(), interval);
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}
