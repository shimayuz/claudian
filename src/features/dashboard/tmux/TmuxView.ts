import { ItemView, type WorkspaceLeaf, setIcon } from 'obsidian';
import { VIEW_TYPE_TMUX, type TmuxSession } from '../types';
import { TmuxService } from './TmuxService';

export class TmuxView extends ItemView {
  private tmux = new TmuxService();
  private selected: TmuxSession | null = null;
  private listEl!: HTMLElement;
  private outputEl!: HTMLElement;
  private pollInterval: number;

  constructor(leaf: WorkspaceLeaf, pollInterval = 5000) {
    super(leaf);
    this.pollInterval = pollInterval;
  }

  getViewType(): string { return VIEW_TYPE_TMUX; }
  getDisplayText(): string { return 'tmux Dashboard'; }
  getIcon(): string { return 'terminal'; }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('claudian-tmux-root');

    // Header
    const header = root.createDiv('claudian-tmux-header');
    const icon = header.createSpan('claudian-tmux-icon');
    setIcon(icon, 'terminal');
    header.createSpan({ text: 'tmux Sessions', cls: 'claudian-tmux-title' });
    const refreshBtn = header.createSpan('claudian-tmux-refresh');
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => void this.refresh());

    const available = await this.tmux.isAvailable();
    if (!available) {
      root.createDiv({ text: 'tmux is not installed. Install with: brew install tmux', cls: 'claudian-tmux-unavailable' });
      return;
    }

    const main = root.createDiv('claudian-tmux-main');
    this.listEl = main.createDiv('claudian-tmux-sidebar');
    this.outputEl = main.createDiv('claudian-tmux-output');
    this.outputEl.createEl('pre', { text: 'Select a session to view output.', cls: 'claudian-tmux-pre' });

    this.tmux.startPolling(this.pollInterval, (sessions) => {
      this.renderList(sessions);
      if (this.selected) {
        const s = sessions.find(x => x.name === this.selected?.name);
        if (s) void this.showOutput(s);
      }
    });
  }

  async onClose(): Promise<void> { this.tmux.stopPolling(); }

  private renderList(sessions: TmuxSession[]): void {
    this.listEl.empty();
    if (sessions.length === 0) {
      this.listEl.createDiv({ text: 'No tmux sessions.', cls: 'claudian-tmux-empty' });
      return;
    }
    for (const s of sessions) {
      const card = this.listEl.createDiv('claudian-tmux-card');
      if (s.name === this.selected?.name) card.addClass('is-active');

      const row = card.createDiv('claudian-tmux-card-row');
      const ic = row.createSpan('claudian-tmux-card-icon');
      setIcon(ic, 'terminal');
      row.createSpan({ text: s.name, cls: 'claudian-tmux-card-name' });

      const badges = card.createDiv('claudian-tmux-card-badges');
      if (s.attached) badges.createSpan({ text: 'attached', cls: 'claudian-badge claudian-badge-blue' });
      if (s.hasClaudeProcess) badges.createSpan({ text: 'Claude', cls: 'claudian-badge claudian-badge-orange' });

      card.createDiv({ text: `${s.windows} win | ${this.timeAgo(s.created)}`, cls: 'claudian-tmux-card-info' });
      card.addEventListener('click', () => { this.selected = s; this.renderList([]); void this.refresh(); });
    }
  }

  private async showOutput(s: TmuxSession): Promise<void> {
    const output = await this.tmux.capturePane(s.name);
    this.outputEl.empty();

    const hdr = this.outputEl.createDiv('claudian-tmux-output-header');
    hdr.createSpan({ text: s.name, cls: 'claudian-tmux-output-name' });
    if (s.hasClaudeProcess) hdr.createSpan({ text: 'Claude', cls: 'claudian-badge claudian-badge-orange' });

    const pre = this.outputEl.createEl('pre', { cls: 'claudian-tmux-pre' });
    pre.textContent = output || '(empty)';
    pre.scrollTop = pre.scrollHeight;

    const row = this.outputEl.createDiv('claudian-tmux-send');
    const input = row.createEl('input', { cls: 'claudian-tmux-input', attr: { placeholder: 'Send keys...' } });
    const btn = row.createEl('button', { text: 'Send', cls: 'claudian-tmux-send-btn' });
    btn.addEventListener('click', () => {
      const keys = input.value.trim();
      if (!keys) return;
      if (!confirm(`Send to "${s.name}"?\n\n${keys}`)) return;
      void this.tmux.sendKeys(s.name, keys);
      input.value = '';
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) btn.click(); });
  }

  private async refresh(): Promise<void> {
    const sessions = await this.tmux.listSessions();
    this.renderList(sessions);
    if (this.selected) {
      const s = sessions.find(x => x.name === this.selected?.name);
      if (s) await this.showOutput(s);
    }
  }

  private timeAgo(d: Date): string {
    const ms = Date.now() - d.getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
    return d.toLocaleDateString();
  }
}
