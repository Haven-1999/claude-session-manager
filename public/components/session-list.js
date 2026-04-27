export class SessionList {
    container;
    handlers;
    constructor(container, handlers) {
        this.container = container;
        this.handlers = handlers;
    }
    render(sessions, activeId) {
        this.container.innerHTML = '';
        sessions.forEach((s) => {
            const el = document.createElement('div');
            el.className = `session-item ${s.id === activeId ? 'active' : ''}`;
            el.innerHTML = `
        <span class="status-dot ${s.status}"></span>
        <span class="session-name">${this.escapeHtml(s.name)}</span>
      `;
            el.addEventListener('click', () => this.handlers.onSelect(s.id));
            this.container.appendChild(el);
        });
        const btn = document.createElement('button');
        btn.textContent = '+ New Session';
        btn.style.cssText = 'margin: 8px; padding: 6px; width: calc(100% - 16px); background: var(--bg-tertiary); color: var(--fg-primary); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;';
        btn.addEventListener('click', () => this.handlers.onNew());
        this.container.appendChild(btn);
    }
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
