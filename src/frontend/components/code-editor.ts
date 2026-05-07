// @ts-ignore
import { EditorView, basicSetup } from 'https://esm.sh/codemirror@6.0.1';
// @ts-ignore
import { oneDark } from 'https://esm.sh/@codemirror/theme-one-dark@6.1.2';

interface EditorTab {
  path: string;
  view: any;
  originalContent: string;
  isDirty: boolean;
}

export class CodeEditorPanel {
  private tabs: EditorTab[] = [];
  private activeIndex = -1;
  private container: HTMLElement;
  private tabBar: HTMLElement;
  private pathEl: HTMLElement;
  private editorEl: HTMLElement;
  private saveBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  onSave?: (path: string, content: string) => Promise<void> | void;
  onClose?: () => void;

  constructor(parent: HTMLElement) {
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

    this.tabBar = this.container.querySelector('.code-editor-tabs')!;
    this.pathEl = this.container.querySelector('.code-editor-path')!;
    this.editorEl = this.container.querySelector('.code-editor-body')!;
    this.saveBtn = this.container.querySelector('.code-editor-save')!;
    this.closeBtn = this.container.querySelector('.code-editor-close')!;

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

  async open(path: string, content: string) {
    const existing = this.tabs.findIndex(t => t.path === path);
    if (existing !== -1) {
      this.switchTab(existing);
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

    const tab: EditorTab = {
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
  }

  hide() {
    this.container.classList.add('hidden');
  }

  isOpen() {
    return !this.container.classList.contains('hidden');
  }

  private switchTab(index: number) {
    if (index === this.activeIndex || index < 0 || index >= this.tabs.length) return;

    if (this.activeIndex !== -1) {
      this.tabs[this.activeIndex].view.dom.style.display = 'none';
    }
    this.activeIndex = index;
    this.tabs[this.activeIndex].view.dom.style.display = '';
    this.editorEl.appendChild(this.tabs[this.activeIndex].view.dom);
    this.updateUI();
  }

  private closeTab(index: number) {
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
    } else {
      const newIndex = Math.min(index, this.tabs.length - 1);
      this.activeIndex = -1; // force switch
      this.switchTab(newIndex);
    }
    this.renderTabs();
  }

  private handleClose() {
    if (this.activeIndex === -1) return;
    this.closeTab(this.activeIndex);
  }

  private async handleSave() {
    if (this.activeIndex === -1) return;
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
    } catch (e) {
      this.saveBtn.textContent = 'Save';
      this.saveBtn.disabled = false;
      throw e;
    }
  }

  private updateUI() {
    if (this.activeIndex === -1) return;
    const tab = this.tabs[this.activeIndex];
    this.pathEl.textContent = tab.path + (tab.isDirty ? ' *' : '');
    this.saveBtn.textContent = tab.isDirty ? 'Save *' : 'Save';
  }

  private renderTabs() {
    this.tabBar.innerHTML = '';
    this.tabs.forEach((tab, i) => {
      const el = document.createElement('div');
      el.className = `code-editor-tab ${i === this.activeIndex ? 'active' : ''}`;
      el.textContent = tab.path.split('/').pop()! + (tab.isDirty ? ' *' : '');
      el.title = tab.path;
      el.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).classList.contains('tab-close')) return;
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

  private async loadLanguage(filePath: string): Promise<any | null> {
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
    } catch {
      // ignore language load errors, fall back to plain text
    }
    return null;
  }
}
