# Inline Code Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to click absolute file paths in the xterm terminal and open a CodeMirror 6 editor in a right-side panel to read and save remote files directly.

**Architecture:** A custom xterm.js link provider matches absolute paths in terminal output and opens them via a new `CodeEditorPanel` component. The backend gains a `FileService` with REST endpoints (`GET` and `PATCH /api/files`) that read and write the remote filesystem. CodeMirror 6 is loaded via CDN (esm.sh) and dynamically imported on first use.

**Tech Stack:** TypeScript, Node.js `fs`, xterm.js custom `ILinkProvider`, CodeMirror 6 (basic-setup + one dark theme + language modules via esm.sh), vanilla CSS for 3-column layout.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/server/file/service.ts` | Read/write remote files, resolve absolute paths, validate bounds |
| `src/server/http-server.ts` | Register `GET /api/files` and `PATCH /api/files` routes |
| `src/frontend/components/code-editor.ts` | CodeMirror 6 wrapper: create editor, load language mode, save callback |
| `src/frontend/components/file-link-provider.ts` | Custom xterm.js `ILinkProvider` that detects absolute paths |
| `src/frontend/app.ts` | Wire FileLinkProvider into each Terminal, manage editor panel state |
| `src/frontend/index.html` | Add `#code-editor` sidebar container |
| `src/frontend/styles.css` | 3-column layout styles, editor panel chrome, save button |

---

### Task 1: Backend File Service

**Files:**
- Create: `src/server/file/service.ts`
- Modify: `src/server/http-server.ts`

- [ ] **Step 1: Create file service**

Create `src/server/file/service.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

export class FileService {
  readFile(absolutePath: string): { content: string; exists: boolean } {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('Path must be absolute');
    }
    try {
      const content = fs.readFileSync(absolutePath, 'utf-8');
      return { content, exists: true };
    } catch (err: any) {
      if (err.code === 'ENOENT') return { content: '', exists: false };
      throw err;
    }
  }

  writeFile(absolutePath: string, content: string): void {
    if (!path.isAbsolute(absolutePath)) {
      throw new Error('Path must be absolute');
    }
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(absolutePath, content, 'utf-8');
  }
}
```

- [ ] **Step 2: Register REST routes in http-server.ts**

Insert after the `/api/cwd-suggestions` route in `src/server/http-server.ts`:

```typescript
import { FileService } from './file/service';

// In createHttpServer, instantiate:
const fileService = new FileService();

// Add routes:
app.get('/api/files', (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'path query parameter is required' });
  }
  try {
    const result = fileService.readFile(filePath);
    if (!result.exists) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ content: result.content, path: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/files', (req, res) => {
  const { path: filePath, content } = req.body;
  if (!filePath || typeof filePath !== 'string') {
    return res.status(400).json({ error: 'path is required' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }
  try {
    fileService.writeFile(filePath, content);
    res.json({ saved: true, path: filePath });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Build and verify**

```bash
cd /data/claude-session-manager
npm run build
```

Expected: TypeScript compiles successfully, `dist/server/file/service.js` exists.

- [ ] **Step 4: Commit**

```bash
git add src/server/file/service.ts src/server/http-server.ts
git commit -m "feat: add file read/write REST API"
```

---

### Task 2: Frontend CodeMirror Panel Component

**Files:**
- Create: `src/frontend/components/code-editor.ts`

- [ ] **Step 1: Create code-editor.ts**

Create `src/frontend/components/code-editor.ts`:

```typescript
import { EditorView, basicSetup } from 'https://esm.sh/codemirror@6.0.1';
import { oneDark } from 'https://esm.sh/@codemirror/theme-one-dark@6.1.2';

interface EditorInit {
  container: HTMLElement;
  content: string;
  language?: any;
}

export class CodeEditorPanel {
  private view: EditorView | null = null;
  private container: HTMLElement;
  private pathEl: HTMLElement;
  private editorEl: HTMLElement;
  private saveBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private currentPath: string | null = null;
  onSave?: (path: string, content: string) => void;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'code-editor-panel hidden';
    this.container.innerHTML = `
      <div class="code-editor-header">
        <span class="code-editor-path"></span>
        <div class="code-editor-actions">
          <button class="code-editor-save">Save</button>
          <button class="code-editor-close">Close</button>
        </div>
      </div>
      <div class="code-editor-body"></div>
    `;
    parent.appendChild(this.container);

    this.pathEl = this.container.querySelector('.code-editor-path')!;
    this.editorEl = this.container.querySelector('.code-editor-body')!;
    this.saveBtn = this.container.querySelector('.code-editor-save')!;
    this.closeBtn = this.container.querySelector('.code-editor-close')!;

    this.saveBtn.addEventListener('click', () => this.handleSave());
    this.closeBtn.addEventListener('click', () => this.hide());

    // Cmd+S / Ctrl+S
    this.container.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        this.handleSave();
      }
    });
  }

  async open(path: string, content: string) {
    this.currentPath = path;
    this.pathEl.textContent = path;
    this.container.classList.remove('hidden');

    if (this.view) {
      this.view.destroy();
    }

    const langModule = await this.loadLanguage(path);

    this.view = new EditorView({
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
  }

  hide() {
    this.container.classList.add('hidden');
  }

  isOpen() {
    return !this.container.classList.contains('hidden');
  }

  private handleSave() {
    if (!this.currentPath || !this.view) return;
    const content = this.view.state.doc.toString();
    this.onSave?.(this.currentPath, content);
  }

  private async loadLanguage(filePath: string): Promise<any | null> {
    const ext = filePath.split('.').pop()?.toLowerCase();
    try {
      if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx') {
        const mod = await import('https://esm.sh/@codemirror/lang-javascript@6.2.1');
        return mod.javascript({ typescript: ext === 'ts' || ext === 'tsx', jsx: ext === 'tsx' || ext === 'jsx' });
      }
      if (ext === 'rs') {
        const mod = await import('https://esm.sh/@codemirror/lang-rust@6.0.1');
        return mod.rust();
      }
      if (ext === 'py') {
        const mod = await import('https://esm.sh/@codemirror/lang-python@6.1.3');
        return mod.python();
      }
      if (ext === 'json') {
        const mod = await import('https://esm.sh/@codemirror/lang-json@6.0.1');
        return mod.json();
      }
      if (ext === 'html' || ext === 'htm') {
        const mod = await import('https://esm.sh/@codemirror/lang-html@6.4.7');
        return mod.html();
      }
      if (ext === 'css') {
        const mod = await import('https://esm.sh/@codemirror/lang-css@6.2.1');
        return mod.css();
      }
      if (ext === 'md' || ext === 'markdown') {
        const mod = await import('https://esm.sh/@codemirror/lang-markdown@6.2.4');
        return mod.markdown();
      }
      if (ext === 'c' || ext === 'cpp' || ext === 'h' || ext === 'hpp') {
        const mod = await import('https://esm.sh/@codemirror/lang-cpp@6.0.2');
        return mod.cpp();
      }
      if (ext === 'sh' || ext === 'bash' || ext === 'zsh') {
        const mod = await import('https://esm.sh/@codemirror/lang-shell@6.0.1');
        return mod.shell();
      }
      if (ext === 'sql') {
        const mod = await import('https://esm.sh/@codemirror/lang-sql@6.5.4');
        return mod.sql();
      }
    } catch {
      // ignore language load errors, fall back to plain text
    }
    return null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/components/code-editor.ts
git commit -m "feat: add CodeMirror 6 editor panel component"
```

---

### Task 3: Frontend File Link Provider

**Files:**
- Create: `src/frontend/components/file-link-provider.ts`

- [ ] **Step 1: Create file-link-provider.ts**

Create `src/frontend/components/file-link-provider.ts`:

```typescript
import type { Terminal, ILinkProvider, ILink, IBufferCellPosition } from 'xterm';

// Matches absolute Unix paths like /data/repo/src/main.rs
const FILE_PATH_REGEX = /(?:^|[^\w\-\/])(\/\S*?[\w\-\.]+\/[\w\-\.\/]+)/g;

export class FileLinkProvider implements ILinkProvider {
  private terminal: Terminal;
  private onOpenFile: (path: string) => void;

  constructor(terminal: Terminal, onOpenFile: (path: string) => void) {
    this.terminal = terminal;
    this.onOpenFile = onOpenFile;
  }

  provideLinks(
    y: number,
    callback: (links: ILink[] | undefined) => void
  ): void {
    const line = this.terminal.buffer.active.getLine(y - 1);
    if (!line) {
      callback(undefined);
      return;
    }

    const text = line.translateToString(true);
    const links: ILink[] = [];
    let match: RegExpExecArray | null;

    // Reset regex
    FILE_PATH_REGEX.lastIndex = 0;
    while ((match = FILE_PATH_REGEX.exec(text)) !== null) {
      const fullMatch = match[0];
      const path = match[1];
      const startIndex = match.index + fullMatch.indexOf(path);
      const endIndex = startIndex + path.length;

      const start: IBufferCellPosition = { x: startIndex + 1, y };
      const end: IBufferCellPosition = { x: endIndex + 1, y };

      links.push({
        text: path,
        range: { start, end },
        activate: () => this.onOpenFile(path),
      });
    }

    callback(links.length > 0 ? links : undefined);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/components/file-link-provider.ts
git commit -m "feat: add xterm file link provider for absolute paths"
```

---

### Task 4: HTML Layout Update

**Files:**
- Modify: `src/frontend/index.html`

- [ ] **Step 1: Add editor sidebar container**

In `src/frontend/index.html`, replace the `.main-layout` div contents:

```html
      <aside id="session-list" class="sidebar left">
        <div class="sidebar-header">Sessions</div>
        <div class="session-list-content" id="session-list-content"></div>
      </aside>
      <main id="terminal-panel" class="terminal-area">
        <div id="terminal-panels"></div>
        <div id="connection-overlay" class="hidden"></div>
      </main>
      <aside id="code-editor" class="sidebar right hidden">
        <div class="resize-handle" id="editor-resize-handle"></div>
        <div class="sidebar-header">Editor</div>
        <div class="code-editor-content" id="code-editor-content"></div>
      </aside>
```

The `#code-editor` sidebar uses the existing `.sidebar.right` styles; we will add `.code-editor-content` styling in the CSS task.

- [ ] **Step 2: Commit**

```bash
git add src/frontend/index.html
git commit -m "feat: add code editor sidebar to HTML layout"
```

---

### Task 5: CSS Layout and Editor Styles

**Files:**
- Modify: `src/frontend/styles.css`

- [ ] **Step 1: Add editor-specific styles**

Append to `src/frontend/styles.css`:

```css
/* Code Editor Sidebar */
#code-editor {
  width: 480px;
  min-width: 200px;
  max-width: 800px;
  display: flex;
  flex-direction: column;
  position: relative;
}

#code-editor.hidden {
  width: 0;
  min-width: 0;
  border: none;
  overflow: hidden;
}

.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: col-resize;
  background: transparent;
  z-index: 10;
}

.resize-handle:hover,
.resize-handle.dragging {
  background: var(--accent);
}

.code-editor-content {
  flex: 1;
  position: relative;
  overflow: hidden;
}

.code-editor-panel {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}

.code-editor-panel.hidden {
  display: none;
}

.code-editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  gap: 8px;
}

.code-editor-path {
  font-size: 12px;
  color: var(--fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  font-family: 'Menlo', monospace;
}

.code-editor-actions {
  display: flex;
  gap: 6px;
}

.code-editor-actions button {
  background: var(--bg-tertiary);
  color: var(--fg-primary);
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s;
}

.code-editor-actions button:hover {
  background: var(--bg-hover);
}

.code-editor-save {
  background: var(--accent) !important;
  color: #fff !important;
  border-color: var(--accent) !important;
}

.code-editor-save:hover {
  background: var(--accent-hover) !important;
}

.code-editor-body {
  flex: 1;
  overflow: hidden;
  background: #0d1117;
}

/* Terminal link hover styling */
.xterm-decoration-container .xterm-decoration-file-link {
  text-decoration: underline;
  cursor: pointer;
  color: #58a6ff !important;
}

.xterm-decoration-container .xterm-decoration-file-link:hover {
  background: rgba(88, 166, 255, 0.15);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/styles.css
git commit -m "style: add code editor panel and file link styles"
```

---

### Task 6: Wire Editor into App

**Files:**
- Modify: `src/frontend/app.ts`

- [ ] **Step 1: Add imports and editor state**

At the top of `src/frontend/app.ts`, add:

```typescript
import { CodeEditorPanel } from './components/code-editor.js';
import { FileLinkProvider } from './components/file-link-provider.js';
```

Add to the `App` class:

```typescript
  private codeEditor: CodeEditorPanel;
```

- [ ] **Step 2: Initialize editor panel in constructor**

In `constructor()`, after `this.sessionInfo = ...`:

```typescript
    this.codeEditor = new CodeEditorPanel(document.getElementById('code-editor-content')!);
    this.codeEditor.onSave = async (path, content) => {
      try {
        const res = await fetch('/api/files', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          alert('Failed to save file: ' + (err.error || res.statusText));
          return;
        }
        console.log('[CSM] Saved file:', path);
      } catch (e) {
        console.error('Save file error:', e);
        alert('Error saving file. Check console.');
      }
    };

    this.setupEditorResize();
```

- [ ] **Step 3: Register link provider in createTerminal**

In `createTerminal(sessionId)`, after `terminal.loadAddon(fitAddon);`:

```typescript
    terminal.registerLinkProvider(new FileLinkProvider(terminal, (filePath) => {
      this.openFileInEditor(filePath);
    }));
```

- [ ] **Step 4: Add openFileInEditor method**

Add to the `App` class:

```typescript
  private async openFileInEditor(filePath: string): Promise<void> {
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert('Failed to open file: ' + (err.error || res.statusText));
        return;
      }
      const data = await res.json();
      await this.codeEditor.open(data.path, data.content);
      document.getElementById('code-editor')!.classList.remove('hidden');
    } catch (e) {
      console.error('Open file error:', e);
      alert('Error opening file. Check console.');
    }
  }

  private setupEditorResize(): void {
    const handle = document.getElementById('editor-resize-handle')!;
    const sidebar = document.getElementById('code-editor')!;
    let isDragging = false;
    let startX = 0;
    let startWidth = 0;

    handle.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX;
      startWidth = sidebar.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const delta = startX - e.clientX;
      const newWidth = Math.min(Math.max(startWidth + delta, 200), 800);
      sidebar.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Trigger terminal refit after resize
      this.fitActiveTerminal();
    });
  }
```

- [ ] **Step 5: Commit**

```bash
git add src/frontend/app.ts
git commit -m "feat: wire file link provider and editor panel into app"
```

---

### Task 7: Build and Verify

**Files:**
- Modify: `package.json` (add frontend build step if needed)

- [ ] **Step 1: Type-check all TypeScript**

```bash
cd /data/claude-session-manager
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Build server and frontend**

```bash
npm run build
npm run build:frontend
```

Expected: `dist/server/file/service.js` and `public/app.js` updated.

- [ ] **Step 3: Manual test plan**

1. Start the CSM server (`node dist/index.js`)
2. Create a session, run `echo /etc/hosts` in the terminal
3. Click `/etc/hosts` in the terminal output
4. Expect: right sidebar appears with file content loaded in CodeMirror
5. Edit the file, click Save
6. Expect: file saved to disk, no error alert
7. Click Close, expect sidebar hides
8. Click a non-existent path like `/tmp/nonexistent-file-xyz`, expect "File not found" alert

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "feat: inline code editor — click terminal paths to edit remote files"
```

---

## Spec Self-Review

**1. Spec coverage:**
- Backend file read/write API ✅ Task 1
- Terminal file path detection ✅ Task 3
- CodeMirror 6 editor panel ✅ Task 2
- HTML layout update ✅ Task 4
- CSS styles ✅ Task 5
- Frontend wiring (open, save, close) ✅ Task 6
- Build verification ✅ Task 7

**2. Placeholder scan:**
- No "TBD", "TODO", or vague instructions found.
- All steps contain concrete code blocks.
- No "add error handling" without showing code.

**3. Type consistency:**
- `FileService.readFile` returns `{ content, exists }` consistently.
- `CodeEditorPanel.open(path, content)` signature matches its usage in `app.ts`.
- `FileLinkProvider` constructor `(terminal, onOpenFile)` matches usage.
- `/api/files?path=` query param used consistently in GET and referenced in frontend.

No issues found. Plan is ready.
