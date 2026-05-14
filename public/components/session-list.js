const UNCATEGORIZED_TAG_ID = 'uncategorized';
const EXPAND_STATE_KEY = 'csm:tag-expand-state';
export class SessionList {
    container;
    handlers;
    managementMode = false;
    expandState = {};
    activeContextMenu = null;
    constructor(container, handlers) {
        this.container = container;
        this.handlers = handlers;
        this.loadExpandState();
        document.addEventListener('click', () => this.closeContextMenu());
    }
    render(sessions, tags, activeId) {
        this.container.innerHTML = '';
        if (this.managementMode) {
            this.renderManagementMode(tags, sessions);
            return;
        }
        // Header
        const header = document.createElement('div');
        header.className = 'tag-header';
        header.innerHTML = `
      <span class="tag-header-label">TAGS</span>
      <button class="tag-manage-btn">+ 管理</button>
    `;
        header.querySelector('.tag-manage-btn').addEventListener('click', () => {
            this.managementMode = true;
            this.render(sessions, tags, activeId);
        });
        this.container.appendChild(header);
        // Group sessions by tag
        const sessionsByTag = new Map();
        for (const tag of tags) {
            sessionsByTag.set(tag.id, []);
        }
        for (const s of sessions) {
            const tagId = s.tagId || UNCATEGORIZED_TAG_ID;
            if (!sessionsByTag.has(tagId)) {
                sessionsByTag.set(tagId, []);
            }
            sessionsByTag.get(tagId).push(s);
        }
        // Initialize expand state for new tags
        let firstUserTag = true;
        for (const tag of tags) {
            if (!(tag.id in this.expandState)) {
                if (tag.id === UNCATEGORIZED_TAG_ID) {
                    this.expandState[tag.id] = false;
                }
                else if (firstUserTag) {
                    this.expandState[tag.id] = true;
                }
                else {
                    // Auto-expand if it contains the active session
                    const tagSessions = sessionsByTag.get(tag.id) || [];
                    this.expandState[tag.id] = activeId ? tagSessions.some((s) => s.id === activeId) : false;
                }
            }
            if (tag.id !== UNCATEGORIZED_TAG_ID)
                firstUserTag = false;
        }
        // Render tag groups
        for (const tag of tags) {
            const tagSessions = sessionsByTag.get(tag.id) || [];
            const isExpanded = this.expandState[tag.id] ?? false;
            const group = document.createElement('div');
            group.className = 'tag-group';
            const groupHeader = document.createElement('div');
            groupHeader.className = 'tag-group-header';
            groupHeader.innerHTML = `
        <span class="tag-arrow">${isExpanded ? '▼' : '▶'}</span>
        <span class="tag-group-name">${this.escapeHtml(tag.name)}</span>
        <span class="tag-count">(${tagSessions.length})</span>
      `;
            groupHeader.addEventListener('click', () => {
                this.expandState[tag.id] = !this.expandState[tag.id];
                this.saveExpandState();
                this.render(sessions, tags, activeId);
            });
            group.appendChild(groupHeader);
            if (isExpanded) {
                const sessionsList = document.createElement('div');
                sessionsList.className = 'tag-sessions';
                for (const s of tagSessions) {
                    const el = this.createSessionItem(s, activeId, tags);
                    sessionsList.appendChild(el);
                }
                group.appendChild(sessionsList);
            }
            this.container.appendChild(group);
        }
        // New session button
        const btn = document.createElement('button');
        btn.className = 'sidebar-new-btn';
        btn.textContent = '+ New Session';
        btn.addEventListener('click', () => this.handlers.onNew());
        this.container.appendChild(btn);
    }
    createSessionItem(s, activeId, tags) {
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
        // Right-click context menu
        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e, s, tags);
        });
        // Double-click rename
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
        return el;
    }
    showContextMenu(e, session, tags) {
        this.closeContextMenu();
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        // Rename
        const renameItem = document.createElement('div');
        renameItem.className = 'context-menu-item';
        renameItem.textContent = '重命名';
        renameItem.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.closeContextMenu();
            const el = this.container.querySelector(`[data-id="${session.id}"]`);
            if (el)
                el.dispatchEvent(new MouseEvent('dblclick'));
        });
        menu.appendChild(renameItem);
        // Move to submenu
        const otherTags = tags.filter(t => t.id !== (session.tagId || UNCATEGORIZED_TAG_ID));
        if (otherTags.length > 0) {
            const moveItem = document.createElement('div');
            moveItem.className = 'context-menu-item has-submenu';
            moveItem.textContent = '移动到';
            const submenu = document.createElement('div');
            submenu.className = 'context-submenu';
            for (const tag of otherTags) {
                const tagItem = document.createElement('div');
                tagItem.className = 'context-menu-item';
                tagItem.textContent = tag.name;
                if (tag.id === UNCATEGORIZED_TAG_ID) {
                    tagItem.style.color = 'var(--fg-muted)';
                }
                tagItem.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.closeContextMenu();
                    this.handlers.onMoveSession(session.id, tag.id);
                });
                submenu.appendChild(tagItem);
            }
            moveItem.appendChild(submenu);
            menu.appendChild(moveItem);
        }
        // Delete
        const deleteItem = document.createElement('div');
        deleteItem.className = 'context-menu-item danger';
        deleteItem.textContent = '删除';
        deleteItem.addEventListener('click', (ev) => {
            ev.stopPropagation();
            this.closeContextMenu();
            if (confirm(`Delete session "${session.name}"?`)) {
                this.handlers.onDelete(session.id);
            }
        });
        menu.appendChild(deleteItem);
        document.body.appendChild(menu);
        this.activeContextMenu = menu;
        // Adjust position if overflowing
        requestAnimationFrame(() => {
            const rect = menu.getBoundingClientRect();
            if (rect.right > window.innerWidth) {
                menu.style.left = `${window.innerWidth - rect.width - 8}px`;
            }
            if (rect.bottom > window.innerHeight) {
                menu.style.top = `${window.innerHeight - rect.height - 8}px`;
            }
        });
    }
    closeContextMenu() {
        if (this.activeContextMenu) {
            this.activeContextMenu.remove();
            this.activeContextMenu = null;
        }
    }
    renderManagementMode(tags, sessions) {
        // Header
        const header = document.createElement('div');
        header.className = 'tag-header management';
        header.innerHTML = `
      <span class="tag-header-label" style="color:var(--accent);font-weight:bold;">TAG 管理</span>
      <button class="tag-manage-close-btn">✕ 关闭</button>
    `;
        header.querySelector('.tag-manage-close-btn').addEventListener('click', () => {
            this.managementMode = false;
            this.render(sessions, tags, null);
        });
        this.container.appendChild(header);
        // Add new tag input
        const addRow = document.createElement('div');
        addRow.className = 'tag-add-row';
        addRow.innerHTML = `
      <input type="text" class="tag-add-input" placeholder="输入新 Tag 名称...">
      <button class="tag-add-btn">+</button>
    `;
        const addInput = addRow.querySelector('.tag-add-input');
        const addBtn = addRow.querySelector('.tag-add-btn');
        const doAdd = async () => {
            const name = addInput.value.trim();
            if (!name)
                return;
            addInput.value = '';
            await this.handlers.onCreateTag(name);
        };
        addBtn.addEventListener('click', doAdd);
        addInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                doAdd();
        });
        this.container.appendChild(addRow);
        // List tags
        for (const tag of tags) {
            const sessionCount = sessions.filter((s) => (s.tagId || UNCATEGORIZED_TAG_ID) === tag.id).length;
            const row = document.createElement('div');
            row.className = 'tag-manage-item';
            if (tag.id === UNCATEGORIZED_TAG_ID) {
                row.innerHTML = `
          <span class="tag-manage-name muted">${this.escapeHtml(tag.name)}</span>
          <span class="tag-manage-hint">不可编辑</span>
        `;
            }
            else {
                row.innerHTML = `
          <span class="tag-manage-name">${this.escapeHtml(tag.name)}</span>
          <div class="tag-manage-actions">
            <button class="tag-rename-btn">重命名</button>
            <button class="tag-delete-btn">删除</button>
          </div>
        `;
                row.querySelector('.tag-rename-btn').addEventListener('click', () => {
                    this.startInlineRename(row, tag, tags, sessions);
                });
                row.querySelector('.tag-delete-btn').addEventListener('click', () => {
                    this.showDeleteConfirm(row, tag, sessionCount, tags, sessions);
                });
            }
            this.container.appendChild(row);
        }
    }
    startInlineRename(row, tag, tags, sessions) {
        row.innerHTML = `
      <input type="text" class="tag-rename-input" value="${this.escapeHtml(tag.name)}">
      <div class="tag-manage-actions">
        <button class="tag-confirm-btn">✓</button>
        <button class="tag-cancel-btn">✕</button>
      </div>
    `;
        const input = row.querySelector('.tag-rename-input');
        input.focus();
        input.select();
        const doRename = async () => {
            const newName = input.value.trim();
            if (newName && newName !== tag.name) {
                await this.handlers.onRenameTag(tag.id, newName);
            }
            else {
                this.managementMode = true;
                this.render(sessions, tags, null);
            }
        };
        row.querySelector('.tag-confirm-btn').addEventListener('click', doRename);
        row.querySelector('.tag-cancel-btn').addEventListener('click', () => {
            this.managementMode = true;
            this.render(sessions, tags, null);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')
                doRename();
            if (e.key === 'Escape') {
                this.managementMode = true;
                this.render(sessions, tags, null);
            }
        });
    }
    showDeleteConfirm(row, tag, sessionCount, tags, sessions) {
        const confirm = document.createElement('div');
        confirm.className = 'tag-delete-confirm';
        confirm.innerHTML = `
      <div class="tag-delete-title">删除 Tag "${this.escapeHtml(tag.name)}"？</div>
      <div class="tag-delete-info">该 Tag 下有 ${sessionCount} 个会话</div>
      <div class="tag-delete-actions">
        <button class="tag-delete-move">移入未分类</button>
        <button class="tag-delete-all">连同删除</button>
      </div>
    `;
        confirm.querySelector('.tag-delete-move').addEventListener('click', async () => {
            await this.handlers.onDeleteTag(tag.id, 'move_uncategorized');
        });
        confirm.querySelector('.tag-delete-all').addEventListener('click', async () => {
            await this.handlers.onDeleteTag(tag.id, 'delete_sessions');
        });
        row.after(confirm);
    }
    loadExpandState() {
        try {
            const saved = localStorage.getItem(EXPAND_STATE_KEY);
            if (saved)
                this.expandState = JSON.parse(saved);
        }
        catch { }
    }
    saveExpandState() {
        try {
            localStorage.setItem(EXPAND_STATE_KEY, JSON.stringify(this.expandState));
        }
        catch { }
    }
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
