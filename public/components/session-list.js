export class SessionList {
    container;
    handlers;
    constructor(container, handlers) {
        this.container = container;
        this.handlers = handlers;
    }
    render(sessions, activeId) {
        this.container.innerHTML = '';
        if (sessions.length === 0) {
            this.container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📂</div>
          <div>No sessions yet</div>
          <div style="font-size: 12px; margin-top: 4px;">Click "+ New Session" to start</div>
        </div>
      `;
            const btn = document.createElement('button');
            btn.className = 'sidebar-new-btn';
            btn.textContent = '+ New Session';
            btn.addEventListener('click', () => this.handlers.onNew());
            this.container.appendChild(btn);
            return;
        }
        sessions.forEach((s) => {
            const el = document.createElement('div');
            el.className = `session-item ${s.id === activeId ? 'active' : ''}`;
            el.dataset.id = s.id;
            el.innerHTML = `
        <span class="status-dot ${s.status}"></span>
        <span class="session-name">${this.escapeHtml(s.name)}</span>
        <button class="delete-btn" title="Delete">×</button>
      `;
            el.addEventListener('click', (e) => {
                if (e.target.closest('.delete-btn'))
                    return;
                this.handlers.onSelect(s.id);
            });
            el.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                if (confirm(`Delete session "${s.name}"?`)) {
                    this.handlers.onDelete(s.id);
                }
            });
            el.addEventListener('dblclick', () => {
                const nameEl = el.querySelector('.session-name');
                const currentName = s.name;
                const input = document.createElement('input');
                input.value = currentName;
                input.style.cssText = 'flex:1; background:var(--bg-primary); border:1px solid var(--accent); color:var(--fg-primary); padding:2px 6px; border-radius:4px; font-size:13px; outline:none;';
                nameEl.replaceWith(input);
                input.focus();
                input.select();
                const finish = () => {
                    const newName = input.value.trim() || currentName;
                    this.handlers.onRename(s.id, newName);
                };
                input.addEventListener('blur', finish);
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        input.blur();
                    }
                    else if (e.key === 'Escape') {
                        input.value = currentName;
                        input.blur();
                    }
                });
            });
            this.container.appendChild(el);
        });
        const btn = document.createElement('button');
        btn.className = 'sidebar-new-btn';
        btn.textContent = '+ New Session';
        btn.addEventListener('click', () => this.handlers.onNew());
        this.container.appendChild(btn);
    }
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
