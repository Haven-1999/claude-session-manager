export class SessionInfo {
  constructor(private container: HTMLElement) {}

  render(session: any): void {
    if (!session) {
      this.container.innerHTML = `
        <div class="empty-state">
          <div style="font-size: 24px; margin-bottom: 8px; opacity: 0.5;">ℹ️</div>
          <div>Select a session to view details</div>
        </div>
      `;
      return;
    }

    this.container.innerHTML = `
      <div class="info-panel">
        <div class="info-row">
          <div style="color: var(--fg-muted); font-size: 11px; margin-bottom: 2px;">Name</div>
          <div style="font-weight: 500; font-size: 14px;">${this.escapeHtml(session.name)}</div>
        </div>
        <div class="info-row">
          <div style="color: var(--fg-muted); font-size: 11px; margin-bottom: 2px;">Working Directory</div>
          <div>${this.escapeHtml(session.cwd)}</div>
        </div>
        <div class="info-row">
          <div style="color: var(--fg-muted); font-size: 11px; margin-bottom: 2px;">Status</div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="status-dot ${session.status}" style="width: 8px; height: 8px; display: inline-block;"></span>
            <span style="text-transform: capitalize;">${session.status}</span>
          </div>
        </div>
        <div class="info-row">
          <div style="color: var(--fg-muted); font-size: 11px; margin-bottom: 2px;">Created</div>
          <div>${new Date(session.createdAt).toLocaleString()}</div>
        </div>
        <div class="info-row">
          <div style="color: var(--fg-muted); font-size: 11px; margin-bottom: 2px;">Last Active</div>
          <div>${new Date(session.lastActiveAt).toLocaleString()}</div>
        </div>
      </div>
    `;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
