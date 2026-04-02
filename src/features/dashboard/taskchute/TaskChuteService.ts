import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, basename } from 'path';

export interface TaskChuteRoutine {
  taskId: string;
  title: string;
  scheduledTime: string;
  routineType: 'daily' | 'weekly';
  status: 'pending' | 'running' | 'completed';
  startTime?: string;
  elapsedMinutes?: number;
}

export interface TaskChuteSummary {
  date: string;
  weekday: string;
  routines: TaskChuteRoutine[];
  totalTasks: number;
  completedTasks: number;
  runningTask: TaskChuteRoutine | null;
  completionRate: number;
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Reads TaskChute Plus data from an Obsidian vault.
 * Path: {vaultPath}/02_Configs/Plugins/TaskChute/TaskChute/
 */
export class TaskChuteService {
  private vaultPath: string;
  private basePath: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.basePath = join(vaultPath, '02_Configs', 'Plugins', 'TaskChute', 'TaskChute');
  }

  isAvailable(): boolean {
    return existsSync(join(this.basePath, 'Task'));
  }

  async getSummary(): Promise<TaskChuteSummary> {
    const now = new Date();
    const today = this.formatDate(now);
    const dayOfWeek = now.getDay();

    const routines = this.loadRoutines(dayOfWeek);
    const runningTasks = this.loadRunningTasks();
    const completedToday = this.loadCompletedToday(today);

    // Mark status
    for (const r of routines) {
      const isRunning = runningTasks.some(rt => rt.taskId === r.taskId || rt.title === r.title);
      const isCompleted = completedToday.some(ct => ct.taskId === r.taskId || ct.title === r.title);

      if (isRunning) {
        r.status = 'running';
        const rt = runningTasks.find(rt => rt.taskId === r.taskId || rt.title === r.title);
        if (rt?.startTime) {
          r.startTime = rt.startTime;
          r.elapsedMinutes = Math.floor((Date.now() - new Date(rt.startTime).getTime()) / 60000);
        }
      } else if (isCompleted) {
        r.status = 'completed';
      }
    }

    const completedCount = routines.filter(r => r.status === 'completed').length;
    const runningRoutine = routines.find(r => r.status === 'running') ?? null;

    return {
      date: today,
      weekday: `${WEEKDAYS[dayOfWeek]}(${WEEKDAY_EN[dayOfWeek]})`,
      routines,
      totalTasks: routines.length,
      completedTasks: completedCount,
      runningTask: runningRoutine,
      completionRate: routines.length > 0 ? completedCount / routines.length : 0,
    };
  }

  private loadRoutines(dayOfWeek: number): TaskChuteRoutine[] {
    const taskDir = join(this.basePath, 'Task');
    if (!existsSync(taskDir)) return [];

    const routines: TaskChuteRoutine[] = [];
    let files: string[];
    try { files = readdirSync(taskDir).filter(f => f.endsWith('.md')); }
    catch { return []; }

    for (const file of files) {
      try {
        const content = readFileSync(join(taskDir, file), 'utf-8');
        const fm = this.parseFrontmatter(content);

        if (fm.isRoutine !== true && fm.isRoutine !== 'true') continue;
        if (fm.routine_enabled !== true && fm.routine_enabled !== 'true') continue;

        // End date check
        if (fm.routine_end) {
          const endDate = new Date(String(fm.routine_end));
          if (endDate < new Date()) continue;
        }

        // Weekday filter
        const type = String(fm.routine_type || 'daily') as 'daily' | 'weekly';
        if (type === 'weekly') {
          const weekdays = fm.weekdays ?? fm.routine_weekday;
          if (weekdays !== undefined) {
            const days = Array.isArray(weekdays) ? weekdays : [weekdays];
            if (!days.includes(dayOfWeek) && !days.includes(String(dayOfWeek))) continue;
          }
        }

        routines.push({
          taskId: String(fm.taskId ?? ''),
          title: basename(file, '.md'),
          scheduledTime: String(fm.scheduled_time ?? '00:00'),
          routineType: type,
          status: 'pending',
        });
      } catch { continue; }
    }

    routines.sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
    return routines;
  }

  private loadRunningTasks(): Array<{ taskId: string; title: string; startTime: string }> {
    const runningPath = join(this.basePath, 'Log', 'running-task.json');
    if (!existsSync(runningPath)) return [];
    try {
      const data = JSON.parse(readFileSync(runningPath, 'utf-8'));
      if (!Array.isArray(data)) return [];
      return data.map((t: Record<string, unknown>) => ({
        taskId: String(t.taskId ?? ''),
        title: String(t.taskTitle ?? ''),
        startTime: String(t.startTime ?? ''),
      }));
    } catch { return []; }
  }

  private loadCompletedToday(today: string): Array<{ taskId: string; title: string }> {
    const year = today.slice(0, 4);
    const recordPath = join(this.basePath, 'Log', 'records', year, `record-${today}.md`);
    if (!existsSync(recordPath)) return [];

    try {
      const content = readFileSync(recordPath, 'utf-8');
      const results: Array<{ taskId: string; title: string }> = [];

      // Parse YAML frontmatter records array
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return [];

      const fmContent = fmMatch[1];
      // Extract records entries
      const recordsSection = fmContent.split(/^records:\s*$/m)[1];
      if (!recordsSection) return [];

      const entries = recordsSection.split(/^\s+-\s*$/m).filter(Boolean);
      for (const entry of entries) {
        const taskIdMatch = entry.match(/taskId:\s*"?([^"\n]+)"?/);
        const titleMatch = entry.match(/taskTitle:\s*"?([^"\n]+)"?/);
        if (taskIdMatch || titleMatch) {
          results.push({
            taskId: taskIdMatch?.[1] ?? '',
            title: titleMatch?.[1] ?? '',
          });
        }
      }
      return results;
    } catch { return []; }
  }

  private parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    const result: Record<string, unknown> = {};
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^(\w[\w_]*)\s*:\s*(.+)/);
      if (kv) {
        let val: unknown = kv[2].trim();
        if (val === 'true') val = true;
        else if (val === 'false') val = false;
        else if (/^\d+$/.test(val as string)) val = parseInt(val as string, 10);
        else if (typeof val === 'string' && val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        result[kv[1]] = val;
      }
    }
    return result;
  }

  private formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
}
