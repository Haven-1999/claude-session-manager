export class SessionInfo {
    container;
    constructor(container) {
        this.container = container;
    }
    render(session) {
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
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
