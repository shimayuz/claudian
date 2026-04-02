import { ItemView, type WorkspaceLeaf, setIcon } from 'obsidian';
import { VIEW_TYPE_AUTOMATION, type AutomationProcess, type ScheduledTask } from '../types';
import { AutomationService } from './AutomationService';

export class AutomationView extends ItemView {
  private service = new AutomationService();
  private processesEl!: HTMLElement;
  private tasksEl!: HTMLElement;
  private pollInterval: number;

  constructor(leaf: WorkspaceLeaf, pollInterval = 10000) {
    super(leaf);
    this.pollInterval = pollInterval;
  }

  getViewType(): string { return VIEW_TYPE_AUTOMATION; }
  getDisplayText(): string { return 'Automation Dashboard'; }
  getIcon(): string { return 'cpu'; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('claudian-auto-root');

    const header = root.createDiv('claudian-auto-header');
    const ic = header.createSpan('claudian-auto-icon');
    setIcon(ic, 'cpu');
    header.createSpan({ text: 'Automation Dashboard', cls: 'claudian-auto-title' });
    const refreshBtn = header.createSpan('claudian-auto-refresh');
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => void this.refresh());

    // Processes section
    const procSection = root.createDiv('claudian-auto-section');
    const procHdr = procSection.createDiv('claudian-auto-section-hdr');
    setIcon(procHdr.createSpan(), 'activity');
    procHdr.createSpan({ text: 'Running Processes' });
    this.processesEl = procSection.createDiv('claudian-auto-cards');

    // Tasks section
    const taskSection = root.createDiv('claudian-auto-section');
    const taskHdr = taskSection.createDiv('claudian-auto-section-hdr');
    setIcon(taskHdr.createSpan(), 'clock');
    taskHdr.createSpan({ text: 'Scheduled Tasks' });
    this.tasksEl = taskSection.createDiv('claudian-auto-cards');

    this.service.startPolling(this.pollInterval, ({ processes, tasks }) => {
      this.renderProcesses(processes);
      this.renderTasks(tasks);
    });
  }

  async onClose(): Promise<void> { this.service.stopPolling(); }

  private renderProcesses(list: AutomationProcess[]): void {
    this.processesEl.empty();
    if (list.length === 0) { this.processesEl.createDiv({ text: 'No running claude -p processes.', cls: 'claudian-auto-empty' }); return; }
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
    if (list.length === 0) { this.tasksEl.createDiv({ text: 'No scheduled Claude tasks.', cls: 'claudian-auto-empty' }); return; }
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
    const [processes, tasks] = await Promise.all([this.service.listProcesses(), this.service.listScheduledTasks()]);
    this.renderProcesses(processes);
    this.renderTasks(tasks);
  }
}
