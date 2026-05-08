// @ts-ignore
import { EditorView, basicSetup } from 'https://esm.sh/codemirror@6.0.1';
// @ts-ignore
import { oneDark } from 'https://esm.sh/@codemirror/theme-one-dark@6.1.2';
export class CodeEditorPanel {
    tabs = [];
    activeIndex = -1;
    container;
    tabBar;
    pathEl;
    editorEl;
    saveBtn;
    closeBtn;
    onSave;
    onClose;
    isDark = true;
    constructor(parent) {
        this.container = document.createElement('div');
        this.container.className = 'code-editor-panel hidden';
        this.container.innerHTML = `
      <div class="code-editor-header">
        <div class="code-editor-tabs"></div>
        <div class="code-editor-actions">
          <button class="code-editor-save">Save</button>
          <button class="code-editor-close">Close</button>
        </div>
      </div>
      <div class="code-editor-path"></div>
      <div class="code-editor-body"></div>
    `;
        parent.appendChild(this.container);
        this.tabBar = this.container.querySelector('.code-editor-tabs');
        this.pathEl = this.container.querySelector('.code-editor-path');
        this.editorEl = this.container.querySelector('.code-editor-body');
        this.saveBtn = this.container.querySelector('.code-editor-save');
        this.closeBtn = this.container.querySelector('.code-editor-close');
        this.saveBtn.addEventListener('click', () => this.handleSave());
        this.closeBtn.addEventListener('click', () => this.handleClose());
        // Cmd+S / Ctrl+S
        this.container.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault();
                this.handleSave();
            }
        });
    }
    async open(path, content) {
        const existing = this.tabs.findIndex(t => t.path === path);
        if (existing !== -1) {
            this.switchTab(existing);
            this.tabs[this.activeIndex].view.focus();
            return;
        }
        const langModule = await this.loadLanguage(path);
        const view = new EditorView({
            doc: content,
            extensions: [
                basicSetup,
                oneDark,
                EditorView.theme({
                    '&': { height: '100%' },
                    '.cm-scroller': { overflow: 'auto' },
                }),
                ...(langModule ? [langModule] : []),
            ],
            parent: this.editorEl,
        });
        const tab = {
            path,
            view,
            originalContent: content,
            isDirty: false,
        };
        // Hide current tab view if any
        if (this.activeIndex !== -1) {
            const current = this.tabs[this.activeIndex];
            current.view.dom.style.display = 'none';
        }
        this.tabs.push(tab);
        this.activeIndex = this.tabs.length - 1;
        this.renderTabs();
        this.updateUI();
        this.container.classList.remove('hidden');
        tab.view.focus();
    }
    hide() {
        this.container.classList.add('hidden');
    }
    isOpen() {
        return !this.container.classList.contains('hidden');
    }
    async setTheme(isDark) {
        if (this.isDark === isDark)
            return;
        this.isDark = isDark;
        const activePath = this.activeIndex >= 0 ? this.tabs[this.activeIndex].path : null;
        const newTabs = [];
        for (const tab of this.tabs) {
            const content = tab.view.state.doc.toString();
            tab.view.destroy();
            const langModule = await this.loadLanguage(tab.path);
            const themeExt = isDark
                ? oneDark
                : EditorView.theme({
                    '&': { backgroundColor: '#ffffff', color: '#1f2328', height: '100%' },
                    '.cm-scroller': { overflow: 'auto', backgroundColor: '#ffffff' },
                    '.cm-gutters': { backgroundColor: '#f6f8fa', color: '#656d76', borderRight: '1px solid #d0d7de' },
                    '.cm-activeLineGutter': { backgroundColor: '#eaeef2' },
                    '.cm-activeLine': { backgroundColor: '#eaeef2' },
                    '.cm-selectionBackground': { backgroundColor: '#b4d7ff' },
                    '.cm-cursor': { borderLeftColor: '#0969da' },
                });
            const view = new EditorView({
                doc: content,
                extensions: [
                    basicSetup,
                    themeExt,
                    EditorView.theme({
                        '&': { height: '100%' },
                        '.cm-scroller': { overflow: 'auto' },
                    }),
                    ...(langModule ? [langModule] : []),
                ],
                parent: this.editorEl,
            });
            const newTab = {
                path: tab.path,
                view,
                originalContent: tab.originalContent,
                isDirty: tab.isDirty,
            };
            newTabs.push(newTab);
            if (tab.path !== activePath) {
                view.dom.style.display = 'none';
            }
        }
        this.tabs = newTabs;
        this.activeIndex = activePath ? this.tabs.findIndex(t => t.path === activePath) : -1;
        if (this.activeIndex >= 0) {
            this.editorEl.appendChild(this.tabs[this.activeIndex].view.dom);
            this.tabs[this.activeIndex].view.focus();
        }
        this.updateUI();
    }
    switchTab(index) {
        if (index === this.activeIndex || index < 0 || index >= this.tabs.length)
            return;
        if (this.activeIndex !== -1) {
            this.tabs[this.activeIndex].view.dom.style.display = 'none';
        }
        this.activeIndex = index;
        this.tabs[this.activeIndex].view.dom.style.display = '';
        this.editorEl.appendChild(this.tabs[this.activeIndex].view.dom);
        this.updateUI();
    }
    closeTab(index) {
        const tab = this.tabs[index];
        if (tab.isDirty) {
            if (!confirm(`"${tab.path}" has unsaved changes. Close anyway?`)) {
                return;
            }
        }
        tab.view.destroy();
        this.tabs.splice(index, 1);
        if (this.tabs.length === 0) {
            this.activeIndex = -1;
            this.hide();
            this.onClose?.();
        }
        else {
            const newIndex = Math.min(index, this.tabs.length - 1);
            this.activeIndex = -1; // force switch
            this.switchTab(newIndex);
        }
        this.renderTabs();
    }
    handleClose() {
        if (this.activeIndex === -1)
            return;
        this.closeTab(this.activeIndex);
    }
    async handleSave() {
        if (this.activeIndex === -1)
            return;
        const tab = this.tabs[this.activeIndex];
        const content = tab.view.state.doc.toString();
        this.saveBtn.textContent = 'Saving...';
        this.saveBtn.disabled = true;
        try {
            await this.onSave?.(tab.path, content);
            tab.originalContent = content;
            tab.isDirty = false;
            this.saveBtn.textContent = 'Saved!';
            setTimeout(() => {
                this.saveBtn.textContent = 'Save';
                this.saveBtn.disabled = false;
            }, 1500);
            this.renderTabs();
        }
        catch (e) {
            this.saveBtn.textContent = 'Save';
            this.saveBtn.disabled = false;
            throw e;
        }
    }
    updateUI() {
        if (this.activeIndex === -1)
            return;
        const tab = this.tabs[this.activeIndex];
        this.pathEl.textContent = tab.path + (tab.isDirty ? ' *' : '');
        this.saveBtn.textContent = tab.isDirty ? 'Save *' : 'Save';
    }
    renderTabs() {
        this.tabBar.innerHTML = '';
        this.tabs.forEach((tab, i) => {
            const el = document.createElement('div');
            el.className = `code-editor-tab ${i === this.activeIndex ? 'active' : ''}`;
            el.textContent = tab.path.split('/').pop() + (tab.isDirty ? ' *' : '');
            el.title = tab.path;
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('tab-close'))
                    return;
                this.switchTab(i);
            });
            const close = document.createElement('span');
            close.className = 'tab-close';
            close.textContent = '×';
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                this.closeTab(i);
            });
            el.appendChild(close);
            this.tabBar.appendChild(el);
        });
    }
    async loadLanguage(filePath) {
        const ext = filePath.split('.').pop()?.toLowerCase();
        try {
            if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-javascript@6.2.1');
                return mod.javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'tsx' || ext === 'jsx' });
            }
            if (ext === 'rs') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-rust@6.0.1');
                return mod.rust();
            }
            if (ext === 'py') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-python@6.1.3');
                return mod.python();
            }
            if (ext === 'json') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-json@6.0.1');
                return mod.json();
            }
            if (ext === 'html' || ext === 'htm') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-html@6.4.7');
                return mod.html();
            }
            if (ext === 'css') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-css@6.2.1');
                return mod.css();
            }
            if (ext === 'md' || ext === 'markdown') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-markdown@6.2.4');
                return mod.markdown();
            }
            if (ext === 'c' || ext === 'cpp' || ext === 'h' || ext === 'hpp') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-cpp@6.0.2');
                return mod.cpp();
            }
            if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-shell@6.0.1');
                return mod.shell();
            }
            if (ext === 'sql') {
                // @ts-ignore
                const mod = await import('https://esm.sh/@codemirror/lang-sql@6.5.4');
                return mod.sql();
            }
        }
        catch {
            // ignore language load errors, fall back to plain text
        }
        return null;
    }
}
