export class SessionInfo {
  constructor(private container: HTMLElement) {}

  render(session: any): void {
    this.container.innerHTML = `
      <div class="info-panel">
        <h3>Session Info</h3>
        <div class="info-row">Name: <span>${this.escapeHtml(session.name)}</span></div>
        <div class="info-row">CWD: <span>${this.escapeHtml(session.cwd)}</span></div>
        <div class="info-row">Status: <span>${session.status}</span></div>
        <div class="info-row">Created: <span>${new Date(session.createdAt).toLocaleString()}</span></div>
      </div>
    `;
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
