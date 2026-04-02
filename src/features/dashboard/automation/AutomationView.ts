import { ItemView, type WorkspaceLeaf, setIcon } from 'obsidian';
import { VIEW_TYPE_AUTOMATION, type AutomationProcess, type ScheduledTask } from '../types';
import { AutomationService } from './AutomationService';
import { TaskChuteService, type TaskChuteSummary, type TaskChuteRoutine } from '../taskchute/TaskChuteService';

export class AutomationView extends ItemView {
  private service = new AutomationService();
  private taskchute: TaskChuteService | null = null;
  private tcSectionEl!: HTMLElement;
  private processesEl!: HTMLElement;
  private tasksEl!: HTMLElement;
  private pollInterval: number;
  private vaultPath: string;

  constructor(leaf: WorkspaceLeaf, pollInterval = 10000, vaultPath = '') {
    super(leaf);
    this.pollInterval = pollInterval;
    this.vaultPath = vaultPath;
  }

  getViewType(): string { return VIEW_TYPE_AUTOMATION; }
  getDisplayText(): string { return 'Dashboard'; }
  getIcon(): string { return 'layout-dashboard'; }

  async onOpen(): Promise<void> {
    // Resolve vault path
    if (!this.vaultPath) {
      const adapter = this.app.vault.adapter as { getBasePath?: () => string };
      this.vaultPath = adapter.getBasePath?.() ?? '';
    }

    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('claudian-auto-root');

    // Header
    const header = root.createDiv('claudian-auto-header');
    const ic = header.createSpan('claudian-auto-icon');
    setIcon(ic, 'layout-dashboard');
    header.createSpan({ text: 'Dashboard', cls: 'claudian-auto-title' });
    const refreshBtn = header.createSpan('claudian-auto-refresh');
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => void this.refresh());

    // ── TaskChute Section ──
    this.taskchute = new TaskChuteService(this.vaultPath);
    if (this.taskchute.isAvailable()) {
      const tcSection = root.createDiv('claudian-auto-section claudian-tc-section');
      const tcHdr = tcSection.createDiv('claudian-auto-section-hdr');
      setIcon(tcHdr.createSpan(), 'check-square');
      tcHdr.createSpan({ text: 'TaskChute ルーチン' });
      this.tcSectionEl = tcSection.createDiv('claudian-tc-content');
      void this.refreshTaskChute();
    }

    // ── Processes Section ──
    const procSection = root.createDiv('claudian-auto-section');
    const procHdr = procSection.createDiv('claudian-auto-section-hdr');
    setIcon(procHdr.createSpan(), 'activity');
    procHdr.createSpan({ text: 'Running Processes' });
    this.processesEl = procSection.createDiv('claudian-auto-cards');

    // ── Tasks Section ──
    const taskSection = root.createDiv('claudian-auto-section');
    const taskHdr = taskSection.createDiv('claudian-auto-section-hdr');
    setIcon(taskHdr.createSpan(), 'clock');
    taskHdr.createSpan({ text: 'Scheduled Tasks' });
    this.tasksEl = taskSection.createDiv('claudian-auto-cards');

    // Start polling
    this.service.startPolling(this.pollInterval, ({ processes, tasks }) => {
      this.renderProcesses(processes);
      this.renderTasks(tasks);
    });

    // TaskChute refresh on separate timer (every 30s)
    if (this.taskchute?.isAvailable()) {
      this.registerInterval(
        window.setInterval(() => void this.refreshTaskChute(), 30000)
      );
    }
  }

  async onClose(): Promise<void> { this.service.stopPolling(); }

  // ── TaskChute Rendering ──

  private async refreshTaskChute(): Promise<void> {
    if (!this.taskchute || !this.tcSectionEl) return;
    try {
      const summary = await this.taskchute.getSummary();
      this.renderTaskChute(summary);
    } catch { /* ignore */ }
  }

  private renderTaskChute(s: TaskChuteSummary): void {
    this.tcSectionEl.empty();

    // Date and progress bar
    const infoRow = this.tcSectionEl.createDiv('claudian-tc-info');
    infoRow.createSpan({ text: `${s.date} ${s.weekday}`, cls: 'claudian-tc-date' });
    const pctText = `${s.completedTasks}/${s.totalTasks} (${Math.round(s.completionRate * 100)}%)`;
    infoRow.createSpan({ text: pctText, cls: 'claudian-tc-progress-text' });

    // Progress bar
    const bar = this.tcSectionEl.createDiv('claudian-tc-bar');
    const fill = bar.createDiv('claudian-tc-bar-fill');
    fill.style.width = `${Math.round(s.completionRate * 100)}%`;

    // Running task highlight
    if (s.runningTask) {
      const running = this.tcSectionEl.createDiv('claudian-tc-running');
      const runIcon = running.createSpan('claudian-tc-running-icon');
      setIcon(runIcon, 'play');
      running.createSpan({ text: s.runningTask.title, cls: 'claudian-tc-running-title' });
      if (s.runningTask.elapsedMinutes !== undefined) {
        const h = Math.floor(s.runningTask.elapsedMinutes / 60);
        const m = s.runningTask.elapsedMinutes % 60;
        const elapsed = h > 0 ? `${h}h ${m}m` : `${m}m`;
        running.createSpan({ text: elapsed, cls: 'claudian-tc-running-time' });
      }
    }

    // Routine list
    const table = this.tcSectionEl.createDiv('claudian-tc-list');
    for (const r of s.routines) {
      const row = table.createDiv('claudian-tc-row');

      const statusIcon = r.status === 'completed' ? '✅'
        : r.status === 'running' ? '▶️'
        : '⬜';
      row.createSpan({ text: statusIcon, cls: 'claudian-tc-status' });
      row.createSpan({ text: r.scheduledTime, cls: 'claudian-tc-time' });
      row.createSpan({ text: r.title, cls: 'claudian-tc-title' });

      if (r.status === 'running') row.addClass('claudian-tc-row-active');
      if (r.status === 'completed') row.addClass('claudian-tc-row-done');
    }

    if (s.routines.length === 0) {
      table.createDiv({ text: '今日のルーチンはありません', cls: 'claudian-auto-empty' });
    }
  }

  // ── Process/Task Rendering ──

  private renderProcesses(list: AutomationProcess[]): void {
    this.processesEl.empty();
    if (list.length === 0) {
      this.processesEl.createDiv({ text: 'No running claude -p processes.', cls: 'claudian-auto-empty' });
      return;
    }
    for (const p of list) {
      const card = this.processesEl.createDiv('claudian-auto-card');
      const hdr = card.createDiv('claudian-auto-card-hdr');
      setIcon(hdr.createSpan(), 'play-circle');
      hdr.createSpan({ text: `PID ${p.pid}`, cls: 'claudian-auto-pid' });
      hdr.createSpan({ text: 'running', cls: 'claudian-badge claudian-badge-green' });
      card.createDiv({ cls: 'claudian-auto-card-body' }).textContent = p.prompt;
      if (p.startTime) card.createDiv({ text: `Started: ${p.startTime}`, cls: 'claudian-auto-card-meta' });
    }
  }

  private renderTasks(list: ScheduledTask[]): void {
    this.tasksEl.empty();
    if (list.length === 0) {
      this.tasksEl.createDiv({ text: 'No scheduled Claude tasks.', cls: 'claudian-auto-empty' });
      return;
    }
    for (const t of list) {
      const card = this.tasksEl.createDiv('claudian-auto-card');
      const hdr = card.createDiv('claudian-auto-card-hdr');
      setIcon(hdr.createSpan(), 'clock');
      hdr.createSpan({ text: t.schedule, cls: 'claudian-auto-schedule' });
      hdr.createSpan({ text: t.status, cls: `claudian-badge claudian-badge-${t.status === 'active' ? 'blue' : 'red'}` });
      card.createDiv({ cls: 'claudian-auto-card-body' }).textContent = t.command;
    }
  }

  private async refresh(): Promise<void> {
    await this.refreshTaskChute();
    const [processes, tasks] = await Promise.all([
      this.service.listProcesses(),
      this.service.listScheduledTasks(),
    ]);
    this.renderProcesses(processes);
    this.renderTasks(tasks);
  }
}
