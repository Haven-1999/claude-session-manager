# Appearance Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add terminal font size control and dark/light theme toggle to CSM, with preferences persisted in `localStorage`.

**Architecture:** A central `Settings` class manages read/write from `localStorage` and broadcasts changes. `App` subscribes to changes and updates xterm.js terminals and CodeMirror editor in real time. Light theme is implemented via CSS variable overrides on `body[data-theme="light"]` with no new dependencies.

**Tech Stack:** TypeScript, vanilla DOM, xterm.js, CodeMirror 6, `localStorage`

---

### File Map

| File | Responsibility |
|------|----------------|
| `src/frontend/settings.ts` | **Create.** Settings model, schema, localStorage I/O, change events, defaults. |
| `src/frontend/styles.css` | **Modify.** Add `[data-theme="light"]` variable overrides for all CSS custom properties. |
| `src/frontend/index.html` | **Modify.** Add `data-theme="dark"` on `<body>`, add top-bar buttons (Aa-, Aa+, theme toggle, Settings). |
| `src/frontend/components/code-editor.ts` | **Modify.** Add `setTheme(isDark: boolean)` to swap CodeMirror theme extensions dynamically. |
| `src/frontend/app.ts` | **Modify.** Load settings on boot; wire top-bar buttons; update terminal fontSize and theme on all instances; wire settings modal. |

---

### Task 1: Create Settings Module

**Files:**
- Create: `src/frontend/settings.ts`

**Purpose:** Single source of truth for user appearance preferences. Reads/writes `localStorage` under key `csm:settings`. Emits `change` events so `App` can react without polling.

- [ ] **Step 1: Write `src/frontend/settings.ts`**

```ts
export type ThemeMode = 'dark' | 'light';

export interface AppSettings {
  theme: ThemeMode;
  terminalFontSize: number;
}

const STORAGE_KEY = 'csm:settings';

const DEFAULTS: AppSettings = {
  theme: 'dark',
  terminalFontSize: 14,
};

export class Settings {
  private _data: AppSettings;
  private listeners: Set<(data: AppSettings) => void> = new Set();

  constructor() {
    this._data = this.load();
  }

  get data(): Readonly<AppSettings> {
    return this._data;
  }

  set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    this._data = { ...this._data, [key]: value };
    this.save();
    for (const cb of this.listeners) {
      cb(this._data);
    }
  }

  reset(): void {
    this._data = { ...DEFAULTS };
    this.save();
    for (const cb of this.listeners) {
      cb(this._data);
    }
  }

  onChange(cb: (data: AppSettings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private load(): AppSettings {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        return {
          theme: parsed.theme === 'light' ? 'light' : 'dark',
          terminalFontSize:
            typeof parsed.terminalFontSize === 'number'
              ? Math.min(22, Math.max(10, parsed.terminalFontSize))
              : DEFAULTS.terminalFontSize,
        };
      }
    } catch {
      // ignore corrupt storage
    }
    return { ...DEFAULTS };
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
    } catch {
      // ignore quota errors
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/frontend/settings.ts
git commit -m "feat: add Settings module for appearance preferences"
```

---

### Task 2: Add Light Theme CSS Variables

**Files:**
- Modify: `src/frontend/styles.css`

**Purpose:** Define light-mode color overrides that map 1:1 to existing dark CSS variables.

- [ ] **Step 1: Append light theme overrides to `src/frontend/styles.css`**

Insert at the end of the file (after the last rule):

```css
/* Light Theme Overrides */
body[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f6f8fa;
  --bg-tertiary: #eaeef2;
  --bg-hover: #d0d7de;
  --fg-primary: #1f2328;
  --fg-secondary: #656d76;
  --fg-muted: #8c959f;
  --accent: #0969da;
  --accent-hover: #0550ae;
  --border: #d0d7de;
  --success: #1a7f37;
  --warning: #9a6700;
  --error: #cf222e;
  --shadow: 0 1px 3px rgba(31, 35, 40, 0.12);
}

body[data-theme="light"] .terminal-panel .xterm {
  background: #ffffff;
}

body[data-theme="light"] .code-editor-body {
  background: #ffffff;
}
```

- [ ] **Step 2: Verify there are no hardcoded colors in existing rules that would break light mode**

Search for literal hex codes in `styles.css` that are not part of `var()` declarations. The existing rules should already use CSS variables. If any hardcoded dark colors remain (e.g. `#0d1117`, `#161b22`), replace them with the corresponding variable:
- `#0d1117` → `var(--bg-primary)`
- `#161b22` → `var(--bg-secondary)`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/styles.css
git commit -m "feat: add light theme CSS variable overrides"
```

---

### Task 3: Add Top-Bar Buttons and Body data-theme Attribute

**Files:**
- Modify: `src/frontend/index.html`

**Purpose:** Add controls to the top bar and ensure `<body>` starts with the correct `data-theme`.

- [ ] **Step 1: Update `<body>` tag and top-bar buttons in `src/frontend/index.html`**

Change:
```html
<body>
  <div id="app">
    <header class="top-bar">
      <span class="logo">Claude Session Manager</span>
      <div class="actions">
        <button id="btn-new">+ New Session</button>
        <button id="btn-debug">Debug</button>
      </div>
    </header>
```

To:
```html
<body data-theme="dark">
  <div id="app">
    <header class="top-bar">
      <span class="logo">Claude Session Manager</span>
      <div class="actions">
        <button id="btn-new">+ New Session</button>
        <button id="btn-debug">Debug</button>
        <button id="btn-font-dec" title="Decrease font size">Aa-</button>
        <button id="btn-font-inc" title="Increase font size">Aa+</button>
        <button id="btn-theme" title="Toggle theme">☀</button>
        <button id="btn-settings">Settings</button>
      </div>
    </header>
```

- [ ] **Step 2: Add settings modal markup (hidden by default)**

Insert inside `<div id="app">`, after the `</div>` of `.main-layout` and before the closing `</div>` of `#app`:

```html
    <div id="settings-modal" class="modal-overlay hidden">
      <div class="modal" style="width: 360px;">
        <h3>Settings</h3>
        <div class="field">
          <label>Theme</label>
          <div style="display: flex; gap: 12px; margin-top: 6px;">
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; font-weight: 400; font-size: 13px;">
              <input type="radio" name="theme" value="dark" checked> Dark
            </label>
            <label style="display: flex; align-items: center; gap: 4px; cursor: pointer; font-weight: 400; font-size: 13px;">
              <input type="radio" name="theme" value="light"> Light
            </label>
          </div>
        </div>
        <div class="field">
          <label for="settings-font-size">Terminal Font Size</label>
          <div style="display: flex; align-items: center; gap: 10px;">
            <input type="range" id="settings-font-size" min="10" max="22" value="14" style="flex: 1;">
            <span id="settings-font-value" style="min-width: 28px; text-align: right; font-family: Menlo, monospace;">14</span>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" id="settings-reset">Reset to Defaults</button>
          <button class="btn-primary" id="settings-close">Close</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: Commit**

```bash
git add src/frontend/index.html
git commit -m "feat: add top-bar appearance controls and settings modal"
```

---

### Task 4: Code Editor Theme Switching

**Files:**
- Modify: `src/frontend/components/code-editor.ts`

**Purpose:** Allow the editor to swap between dark (`oneDark`) and light (custom theme) CodeMirror extensions dynamically. Each tab must be rebuilt with the correct theme when switched.

- [ ] **Step 1: Add light theme extension and `setTheme` method to `CodeEditorPanel`**

Add an import at the top (already using `@ts-ignore` pattern):

```ts
// @ts-ignore
import { EditorView, basicSetup } from 'https://esm.sh/codemirror@6.0.1';
// @ts-ignore
import { oneDark } from 'https://esm.sh/@codemirror/theme-one-dark@6.1.2';
```

(These imports already exist; keep them.)

Add a class-level property:

```ts
  private isDark = true;
```

Add a method:

```ts
  setTheme(isDark: boolean): void {
    if (this.isDark === isDark) return;
    this.isDark = isDark;
    // Re-create each tab's EditorView with the new theme
    const activePath = this.activeIndex >= 0 ? this.tabs[this.activeIndex].path : null;
    const newTabs: EditorTab[] = [];
    for (const tab of this.tabs) {
      const content = tab.view.state.doc.toString();
      tab.view.destroy();
      const langModule = this.guessLanguage(tab.path);
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
      const newTab: EditorTab = {
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
    }
    this.updateUI();
  }
```

Extract the language-guessing logic from `loadLanguage` into a synchronous `guessLanguage` helper so `setTheme` can reuse it without re-awaiting CDN imports (languages are already cached by the browser):

Rename `loadLanguage` to `guessLanguage` and make it return a synchronously-resolved promise (or keep `loadLanguage` and call it inside `setTheme` with `await`). Simpler: keep `loadLanguage` as-is, and inside `setTheme` call `await this.loadLanguage(tab.path)` inside an async loop. Since `setTheme` can be `async`, this is fine.

Refactor: change `setTheme` signature to `async setTheme(isDark: boolean): Promise<void>` and `await this.loadLanguage(tab.path)` inside the loop.

- [ ] **Step 2: Update `switchTab` to focus after theme change**

In `switchTab`, after `this.editorEl.appendChild(this.tabs[this.activeIndex].view.dom);`, add:

```ts
    this.tabs[this.activeIndex].view.focus();
```

(Already added in a previous fix; verify it is present.)

- [ ] **Step 3: Commit**

```bash
git add src/frontend/components/code-editor.ts
git commit -m "feat: add dynamic theme switching to code editor"
```

---

### Task 5: Wire Everything Together in `App`

**Files:**
- Modify: `src/frontend/app.ts`

**Purpose:** Boot-time settings load, top-bar button handlers, real-time updates to terminals and editor when settings change.

- [ ] **Step 1: Import `Settings` and add it to `App`**

At the top of `src/frontend/app.ts`, add:

```ts
import { Settings } from './settings.js';
```

Add a class property:

```ts
  private settings: Settings;
```

In the constructor, before `this.logDebug('App starting...');`, add:

```ts
    this.settings = new Settings();
    this.applySettings(this.settings.data);
    this.settings.onChange((data) => this.applySettings(data));
```

- [ ] **Step 2: Add `applySettings` method to `App`**

```ts
  private applySettings(data: Readonly<{ theme: 'dark' | 'light'; terminalFontSize: number }>): void {
    // Theme
    const isDark = data.theme === 'dark';
    document.body.setAttribute('data-theme', data.theme);
    const themeBtn = document.getElementById('btn-theme')!;
    themeBtn.textContent = isDark ? '☀' : '🌙';
    themeBtn.title = isDark ? 'Switch to Light' : 'Switch to Dark';

    // Terminal font size
    for (const entry of this.terminals.values()) {
      entry.terminal.options.fontSize = data.terminalFontSize;
      requestAnimationFrame(() => entry.fitAddon.fit());
    }

    // Editor theme
    this.codeEditor.setTheme(isDark).catch(console.error);
  }
```

- [ ] **Step 3: Wire top-bar font buttons in constructor**

After the `btn-debug` listener, add:

```ts
    document.getElementById('btn-font-dec')!.addEventListener('click', () => {
      const next = Math.max(10, this.settings.data.terminalFontSize - 1);
      this.settings.set('terminalFontSize', next);
    });
    document.getElementById('btn-font-inc')!.addEventListener('click', () => {
      const next = Math.min(22, this.settings.data.terminalFontSize + 1);
      this.settings.set('terminalFontSize', next);
    });
    document.getElementById('btn-theme')!.addEventListener('click', () => {
      const next = this.settings.data.theme === 'dark' ? 'light' : 'dark';
      this.settings.set('theme', next);
    });
    document.getElementById('btn-settings')!.addEventListener('click', () => this.showSettingsModal());
```

- [ ] **Step 4: Add `showSettingsModal` method**

```ts
  private showSettingsModal(): void {
    const modal = document.getElementById('settings-modal')!;
    const closeBtn = document.getElementById('settings-close')!;
    const resetBtn = document.getElementById('settings-reset')!;
    const fontSlider = document.getElementById('settings-font-size') as HTMLInputElement;
    const fontValue = document.getElementById('settings-font-value')!;
    const themeRadios = modal.querySelectorAll<HTMLInputElement>('input[name="theme"]');

    // Sync controls with current settings
    for (const radio of themeRadios) {
      radio.checked = radio.value === this.settings.data.theme;
    }
    fontSlider.value = String(this.settings.data.terminalFontSize);
    fontValue.textContent = String(this.settings.data.terminalFontSize);

    modal.classList.remove('hidden');

    const onThemeChange = (e: Event) => {
      const value = (e.target as HTMLInputElement).value as 'dark' | 'light';
      this.settings.set('theme', value);
    };
    for (const radio of themeRadios) {
      radio.addEventListener('change', onThemeChange);
    }

    const onFontInput = () => {
      const value = parseInt(fontSlider.value, 10);
      fontValue.textContent = String(value);
      this.settings.set('terminalFontSize', value);
    };
    fontSlider.addEventListener('input', onFontInput);

    const closeModal = () => {
      for (const radio of themeRadios) {
        radio.removeEventListener('change', onThemeChange);
      }
      fontSlider.removeEventListener('input', onFontInput);
      resetBtn.removeEventListener('click', onReset);
      closeBtn.removeEventListener('click', closeModal);
      modal.classList.add('hidden');
    };

    const onReset = () => {
      this.settings.reset();
      for (const radio of themeRadios) {
        radio.checked = radio.value === this.settings.data.theme;
      }
      fontSlider.value = String(this.settings.data.terminalFontSize);
      fontValue.textContent = String(this.settings.data.terminalFontSize);
    };

    closeBtn.addEventListener('click', closeModal);
    resetBtn.addEventListener('click', onReset);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }
```

- [ ] **Step 5: Update `createTerminal` to use settings font size**

In `createTerminal`, change:

```ts
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
```

To:

```ts
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: this.settings.data.terminalFontSize,
```

- [ ] **Step 6: Commit**

```bash
git add src/frontend/app.ts
git commit -m "feat: wire appearance settings into App"
```

---

### Task 6: Build and Smoke Test

**Files:**
- All above

- [ ] **Step 1: Build frontend**

```bash
npm run build:frontend
```

Expected: compiles without errors.

- [ ] **Step 2: Build TypeScript**

```bash
npm run build
```

Expected: `dist/` updated, no TypeScript errors.

- [ ] **Step 3: Start server and manual smoke test**

```bash
npm start
```

Open browser to `http://localhost:8080`.

Verify:
1. Page loads in dark mode by default.
2. Click ☀ → UI switches to light, terminal background turns white, editor tabs remain functional.
3. Click ☀ again → returns to dark.
4. Click Aa+ multiple times → terminal font grows; click Aa- → shrinks; min 10, max 22.
5. Click Settings → modal opens with current values. Change font slider → terminal updates live. Change theme radio → UI updates live. Click Reset → reverts to defaults.
6. Refresh browser → previous theme and font size are restored from `localStorage`.

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "feat: appearance settings (theme + terminal font size)"
```

---

### Self-Review

**Spec coverage:**
- ✅ Terminal font size control (Task 1, 5)
- ✅ Dark/Light theme toggle (Task 2, 4, 5)
- ✅ `localStorage` persistence (Task 1, 5)
- ✅ Theme applies to UI, terminal, editor (Tasks 2, 4, 5)
- ✅ No system-follow option (Task 1 schema only has `'dark' | 'light'`)
- ✅ Custom light editor theme without new dependencies (Task 4)

**Placeholder scan:** No TBD, TODO, or vague steps found.

**Type consistency:**
- `Settings.set<K extends keyof AppSettings>(key: K, value: AppSettings[K])` matches `AppSettings` interface.
- `applySettings` receives `Readonly<AppSettings>`.
- `setTheme(isDark: boolean)` matches the boolean derived from `data.theme === 'dark'`.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-08-appearance-settings.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
