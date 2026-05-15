import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { oneDarkTheme, oneLightTheme } from './xterm-themes.js';
import { SessionList } from './components/session-list.js';
import type { TagSummary } from './components/session-list.js';
import { SessionInfo } from './components/session-info.js';
import { CodeEditorPanel } from './components/code-editor.js';
import { FileLinkProvider } from './components/file-link-provider.js';
import { Settings } from './settings.js';
import { shellPanelHeightForDrag } from './shell-resize.js';

function showAlert(message: string): void {
  const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
  if (!isTauri) {
    window.alert(message);
    return;
  }
  // Tauri WebView blocks window.alert — use custom DOM modal
  const existing = document.querySelector('.alert-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'alert-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:200;';
  overlay.innerHTML = `
    <div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:20px;width:360px;max-width:90vw;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
      <div style="font-size:14px;color:#e6edf3;margin-bottom:16px;white-space:pre-wrap;">${message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
      <div style="display:flex;justify-content:flex-end;">
        <button id="alert-ok" style="background:#58a6ff;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;">OK</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#alert-ok')!.addEventListener('click', () => overlay.remove());
}

interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: 'running' | 'disconnected' | 'stopped';
  createdAt: number;
  lastActiveAt: number;
  tagId: string;
}

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  onDataDisposable: { dispose: () => void } | null;
  receivedChunks: number;
}

interface ShellTerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  ws: WebSocket | null;
  isOpen: boolean;
  isReady: boolean;
}

class App {
  private ws: WebSocket | null = null;
  private terminals = new Map<string, TerminalEntry>();
  private activeSessionId: string | null = null;
  private sessions: SessionSummary[] = [];
  private tags: TagSummary[] = [];
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private sessionList: SessionList;
  private sessionInfo: SessionInfo;
  private isTauri: boolean;
  private heartbeatTimer: number | null = null;
  private pongTimeoutTimer: number | null = null;
  private lastPingTime = 0;
  private notificationTimer: number | null = null;
  private originalTitle = document.title;
  private windowFocused = true;
  private resizeDebounceTimer: number | null = null;
  private codeEditor: CodeEditorPanel;
  private debugEl: HTMLElement;
  private debugLines: string[] = [];
  private settings: Settings;
  private shellTerminal: ShellTerminalEntry | null = null;
  private shellSessionId: string | null = null;
  private shellVisible = false;
  private shellConnecting = false;
  private shellReconnectTimer: number | null = null;

  constructor() {
    this.settings = new Settings();
    this.settings.onChange((data) => this.applySettings(data));

    this.isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__;
    this.debugEl = document.getElementById('debug-panel')!;

    if (!this.debugEl) {
      console.warn('[CSM] debug-panel element not found — DOM may be stale');
    }

    this.sessionList = new SessionList(document.getElementById('session-list-content')!, {
      onSelect: (id) => this.switchSession(id),
      onNew: () => this.showCreateModal(),
      onDelete: (id) => this.deleteSession(id),
      onRename: (id, name) => this.renameSession(id, name),
      onMoveSession: (sessionId, tagId) => this.moveSession(sessionId, tagId),
      onCreateTag: (name) => this.createTag(name),
      onRenameTag: (id, name) => this.renameTag(id, name),
      onDeleteTag: (id, action) => this.deleteTag(id, action),
    });

    this.sessionInfo = new SessionInfo(document.getElementById('session-info-content')!);

    this.codeEditor = new CodeEditorPanel(document.getElementById('code-editor-content')!);
    this.codeEditor.onClose = () => {
      const editor = document.getElementById('code-editor')!;
      editor.classList.add('hidden');
      editor.classList.remove('open');
      editor.style.width = '';
      this.fitActiveTerminal();
    };
    this.codeEditor.onSave = async (path, content) => {
      try {
        const res = await fetch('/api/files', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, content }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          showAlert('Failed to save file: ' + (err.error || res.statusText));
          return;
        }
        console.log('[CSM] Saved file:', path);
      } catch (e) {
        console.error('Save file error:', e);
        showAlert('Error saving file. Check console.');
      }
    };

    this.setupEditorResize();
    this.setupShellResize();
    this.setupSidebarResize();

    // Apply initial settings after all components are initialized
    this.applySettings(this.settings.data);

    window.addEventListener('resize', () => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = window.setTimeout(() => {
        this.resizeDebounceTimer = null;
        this.fitActiveTerminal();
        this.fitShellTerminal();
      }, 150);
    });
    window.addEventListener('blur', () => { this.windowFocused = false; });
    window.addEventListener('focus', () => {
      this.windowFocused = true;
      document.title = this.originalTitle;
    });
    document.addEventListener('paste', (e) => this.handlePaste(e), true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const editor = document.getElementById('code-editor')!;
        if (!editor.classList.contains('hidden') && this.codeEditor.onClose) {
          this.codeEditor.onClose();
        }
      }
    });

    // Request notification permission on first user interaction
    const requestNotify = () => {
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      document.removeEventListener('click', requestNotify);
    };
    document.addEventListener('click', requestNotify);

    document.getElementById('btn-new')!.addEventListener('click', () => this.showCreateModal());
    document.getElementById('btn-debug')!.addEventListener('click', () => this.toggleDebugPanel());
    document.getElementById('btn-shell')!.addEventListener('click', () => this.toggleShellPanel());
    document.getElementById('shell-collapse')!.addEventListener('click', () => this.hideShellPanel());

    document.getElementById('btn-theme')!.addEventListener('click', () => {
      const next = this.settings.data.theme === 'dark' ? 'light' : 'dark';
      this.settings.set('theme', next);
    });
    document.getElementById('btn-settings')!.addEventListener('click', () => {
      if (this.isTauri) {
        this.openTauriSettings();
      } else {
        this.showSettingsModal();
      }
    });
    document.getElementById('btn-menu')!.addEventListener('click', () => {
      const sidebar = document.getElementById('session-list')!;
      if (sidebar.classList.contains('open')) {
        this.closeLeftDrawer();
      } else {
        this.openLeftDrawer();
      }
    });

    if (this.isTauri) {
      this.setupTauriTunnelListeners().then(() => {
        this.loadSessions();
      });
    } else {
      this.loadSessions();
    }

    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }

  private getShellTerminal(): ShellTerminalEntry {
    if (!this.shellTerminal) {
      this.shellTerminal = this.createShellTerminal();
    }
    return this.shellTerminal;
  }

  private createShellTerminal(): ShellTerminalEntry {
    const container = document.getElementById('shell-terminal')!;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: this.settings.data.terminalFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
      convertEol: true,
      screenReaderMode: false,
      unicodeVersion: '11',
      theme: this.settings.data.theme === 'dark' ? oneDarkTheme : oneLightTheme,
      bellStyle: 'visual',
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    container.style.display = 'block';
    terminal.open(container);
    const entry: ShellTerminalEntry = {
      terminal,
      fitAddon,
      container,
      ws: null,
      isOpen: false,
      isReady: false,
    };

    // IME deduplication (same workaround as session terminal)
    const textarea = terminal.textarea!;
    let isComposing = false;
    let imeFlushTimer: number | null = null;
    let imeBufferedData: string | null = null;

    textarea.addEventListener('compositionstart', () => { isComposing = true; });
    textarea.addEventListener('compositionend', () => {
      isComposing = false;
      if (imeBufferedData !== null && imeFlushTimer === null) {
        imeFlushTimer = window.setTimeout(() => {
          imeFlushTimer = null;
          if (imeBufferedData !== null) {
            if (entry.ws?.readyState === WebSocket.OPEN && this.shellVisible && entry.isReady) {
              entry.ws.send(JSON.stringify({ type: 'input', data: imeBufferedData }));
            }
            imeBufferedData = null;
          }
        }, 30);
      }
    });

    terminal.onData((data) => {
      if (entry.ws?.readyState === WebSocket.OPEN && this.shellVisible && entry.isReady) {
        if (isComposing) {
          imeBufferedData = data;
          return;
        }
        if (imeFlushTimer !== null) {
          imeBufferedData = data;
          return;
        }
        entry.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
    return entry;
  }

  private showShellPanel(): void {
    const panel = document.getElementById('shell-panel')!;
    panel.classList.remove('hidden');
    const shellTerminal = this.getShellTerminal();
    this.shellVisible = true;
    shellTerminal.isOpen = true;
    this.updateShellTitle();
    this.fitShellTerminal();
    this.connectShell();
  }

  private hideShellPanel(): void {
    const panel = document.getElementById('shell-panel')!;
    panel.classList.add('hidden');
    this.shellVisible = false;
    if (this.shellTerminal) {
      this.shellTerminal.isOpen = false;
    }
    this.disconnectShell();
  }

  private toggleShellPanel(): void {
    if (this.shellVisible) {
      this.hideShellPanel();
    } else {
      this.showShellPanel();
    }
  }

  private updateShellTitle(): void {
    const title = document.getElementById('shell-title')!;
    const session = this.sessions.find((s) => s.id === this.activeSessionId);
    title.textContent = session ? `Current Path Shell · ${session.cwd}` : 'Current Path Shell';
  }

  private connectShell(): void {
    if (!this.shellVisible || !this.activeSessionId) return;
    const shellTerminal = this.getShellTerminal();
    if (this.shellConnecting) return;
    if (this.shellSessionId === this.activeSessionId && shellTerminal.ws?.readyState === WebSocket.OPEN) return;

    this.disconnectShell();
    this.shellSessionId = this.activeSessionId;
    this.shellConnecting = true;
    shellTerminal.isReady = false;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/shell-ws?sessionId=${this.activeSessionId}`;
    const ws = new WebSocket(url);
    shellTerminal.ws = ws;

    ws.onopen = () => {
      if (shellTerminal.ws !== ws) return;
      this.shellConnecting = false;
      shellTerminal.isReady = true;
      this.fitShellTerminal();
      (shellTerminal.terminal as any).focus();
      this.sendShellResize();
    };

    ws.onmessage = (event) => {
      if (shellTerminal.ws !== ws) return;
      const raw = typeof event.data === 'string' ? event.data : '';
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'output') {
          shellTerminal.terminal.write(msg.data);
        } else if (msg.type === 'pong') {
          // noop
        }
      } catch {
        // Ignore malformed shell messages.
      }
    };

    ws.onclose = () => {
      if (shellTerminal.ws !== ws) return;
      shellTerminal.ws = null;
      shellTerminal.isReady = false;
      this.shellConnecting = false;
      if (this.shellVisible && this.activeSessionId === this.shellSessionId) {
        this.scheduleShellReconnect();
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private disconnectShell(): void {
    if (this.shellReconnectTimer) {
      clearTimeout(this.shellReconnectTimer);
      this.shellReconnectTimer = null;
    }
    this.shellConnecting = false;
    if (this.shellTerminal) {
      this.shellTerminal.isReady = false;
      if (this.shellTerminal.ws) {
        const ws = this.shellTerminal.ws;
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        this.shellTerminal.ws = null;
      }
    }
  }

  private scheduleShellReconnect(): void {
    if (this.shellReconnectTimer) return;
    this.shellReconnectTimer = window.setTimeout(() => {
      this.shellReconnectTimer = null;
      if (this.shellVisible && this.activeSessionId === this.shellSessionId) {
        this.connectShell();
      }
    }, 1000);
  }

  private fitShellTerminal(): void {
    if (!this.shellVisible || !this.shellTerminal) return;
    this.shellTerminal.fitAddon.fit();
    this.sendShellResize();
  }

  private sendShellResize(): void {
    if (!this.shellTerminal?.ws || this.shellTerminal.ws.readyState !== WebSocket.OPEN || !this.shellVisible) return;
    const dims = this.shellTerminal.fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 120;
    const rows = dims?.rows ?? 30;
    this.shellTerminal.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  private createTerminal(sessionId: string): TerminalEntry {
    const panels = document.getElementById('terminal-panels')!;
    const container = document.createElement('div');
    container.className = 'terminal-panel';
    container.id = `terminal-panel-${sessionId}`;
    panels.appendChild(container);

    const xtermTheme = this.settings.data.theme === 'dark' ? oneDarkTheme : oneLightTheme;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: this.settings.data.terminalFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      minimumContrastRatio: 4.5,
      allowProposedApi: true,
      convertEol: true,
      screenReaderMode: false,
      unicodeVersion: '11',
      theme: xtermTheme,
      bellStyle: 'visual',
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    (terminal as any).registerLinkProvider(new FileLinkProvider(terminal, (filePath) => {
      this.openFileInEditor(filePath);
    }));
    // xterm.js renderer needs the container visible during open() to init canvas properly
    container.style.display = 'block';
    terminal.open(container);
    container.classList.remove('active');
    container.style.display = 'none';
    container.style.zIndex = '';

    // Workaround for xterm.js IME duplication: when switching input methods during
    // composition, xterm.js fires triggerDataEvent multiple times. Buffer all onData
    // during composition (don't start timer yet), then on compositionend start a short
    // timer — any further onData updates the buffer. Timer fires → send only the last value.
    const textarea = terminal.textarea!;
    let isComposing = false;
    let imeFlushTimer: number | null = null;
    let imeBufferedData: string | null = null;

    textarea.addEventListener('compositionstart', () => { isComposing = true; });
    textarea.addEventListener('compositionend', () => {
      isComposing = false;
      if (imeBufferedData !== null && imeFlushTimer === null) {
        imeFlushTimer = window.setTimeout(() => {
          imeFlushTimer = null;
          if (imeBufferedData !== null) {
            if (this.ws?.readyState === WebSocket.OPEN && this.activeSessionId === sessionId) {
              this.ws.send(JSON.stringify({ type: 'input', data: imeBufferedData }));
            }
            imeBufferedData = null;
          }
        }, 30);
      }
    });

    const onDataDisposable = terminal.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN && this.activeSessionId === sessionId) {
        if (isComposing) {
          imeBufferedData = data;
          return;
        }
        if (imeFlushTimer !== null) {
          imeBufferedData = data;
          return;
        }
        this.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    (terminal as any).onBell(() => {
      this.scheduleNotification();
    });

    return { terminal, fitAddon, container, onDataDisposable, receivedChunks: 0 };
  }

  private showSessionTerminal(sessionId: string): TerminalEntry {
    // Hide all terminals
    for (const [, entry] of this.terminals) {
      entry.container.classList.remove('active');
      entry.container.style.display = 'none';
      entry.container.style.zIndex = '';
    }

    let entry = this.terminals.get(sessionId);
    if (!entry) {
      entry = this.createTerminal(sessionId);
      this.terminals.set(sessionId, entry);
    }

    entry.container.classList.add('active');
    entry.container.style.display = 'block';
    entry.container.style.zIndex = '1';
    requestAnimationFrame(() => {
      entry!.fitAddon.fit();
      const terminal = entry!.terminal as any;
      terminal.refresh(0, terminal.rows - 1);
      requestAnimationFrame(() => {
        if (this.activeSessionId === sessionId) {
          this.sendResize();
        }
      });
    });
    return entry;
  }

  private fitActiveTerminal(): void {
    if (!this.activeSessionId) return;
    const entry = this.terminals.get(this.activeSessionId);
    if (entry) {
      entry.fitAddon.fit();
      this.sendResize();
    }
  }

  private isMobile(): boolean {
    return window.innerWidth < 768;
  }

  private openLeftDrawer(): void {
    const sidebar = document.getElementById('session-list')!;
    sidebar.classList.add('open');
    if (!document.querySelector('.drawer-backdrop')) {
      const backdrop = document.createElement('div');
      backdrop.className = 'drawer-backdrop';
      backdrop.addEventListener('click', () => this.closeLeftDrawer());
      document.body.appendChild(backdrop);
    }
  }

  private closeLeftDrawer(): void {
    const sidebar = document.getElementById('session-list')!;
    sidebar.classList.remove('open');
    const backdrop = document.querySelector('.drawer-backdrop');
    if (backdrop) backdrop.remove();
  }

  private async loadSessions(retries = 2): Promise<void> {
    this.logDebug('loadSessions: location=' + window.location.href);
    const start = performance.now();
    try {
      this.logDebug('Fetching sessions...');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch('/api/sessions', { signal: controller.signal });
      clearTimeout(timeout);
      const elapsed = Math.round(performance.now() - start);
      if (!res.ok) {
        this.logDebug('fetch /api/sessions HTTP ' + res.status + ' after ' + elapsed + 'ms');
        this.sessionList.render([], [], null);
        this.sessionInfo.render(null);
        return;
      }
      this.sessions = await res.json();
      // Load tags
      try {
        const tagsRes = await fetch('/api/tags');
        if (tagsRes.ok) {
          this.tags = await tagsRes.json();
        }
      } catch {}
      this.logDebug('Loaded ' + this.sessions.length + ' sessions in ' + elapsed + 'ms');
      this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
      if (this.shellVisible) {
        this.updateShellTitle();
      }

      if (this.sessions.length > 0 && !this.activeSessionId) {
        this.logDebug('Auto-switch to first session');
        this.switchSession(this.sessions[0].id);
      } else if (this.sessions.length === 0) {
        this.sessionInfo.render(null);
        this.activeSessionId = null;
      }
    } catch (e) {
      const elapsed = Math.round(performance.now() - start);
      const err = e as Error;
      const isTimeout = err.name === 'AbortError';
      const hint = isTimeout ? ' (timeout — tunnel may be slow)' : '';
      this.logDebug('loadSessions error after ' + elapsed + 'ms: ' + err.name + ': ' + err.message + hint);
      if (retries > 0) {
        this.logDebug('Retrying loadSessions in 1s... (' + retries + ' left)');
        setTimeout(() => this.loadSessions(retries - 1), 1000);
        return;
      }
      this.sessionList.render([], [], null);
      this.sessionInfo.render(null);
      if (isTimeout) {
        this.showOverlay('Connection timed out. SSH tunnel may be unstable. Click Settings to reconnect.');
      }
      // Diagnostic: try fetching root to see if tunnel is completely dead
      const diagController = new AbortController();
      const diagTimeout = setTimeout(() => diagController.abort(), 3000);
      fetch('/', { method: 'HEAD', signal: diagController.signal })
        .then(r => {
          clearTimeout(diagTimeout);
          this.logDebug('Diagnostic root fetch: HTTP ' + r.status);
        })
        .catch(e2 => {
          clearTimeout(diagTimeout);
          this.logDebug('Diagnostic root fetch failed: ' + (e2 as Error).name + ': ' + (e2 as Error).message);
        });
      // Diagnostic: test via Rust backend curl
      if (this.isTauri) {
        try {
          const tauri = (window as any).__TAURI__;
          const invoke = tauri?.core?.invoke || tauri?.invoke;
          if (invoke) {
            invoke('test_http', { url: window.location.origin + '/api/sessions' })
              .then((res: string) => this.logDebug('Rust test_http: ' + res))
              .catch((err: Error) => this.logDebug('Rust test_http error: ' + err.message));
          }
        } catch (e3) {
          this.logDebug('Rust test_http invoke failed: ' + (e3 as Error).message);
        }
      }
    }
  }

  private switchSession(id: string): void {
    this.logDebug('switchSession: ' + id + ' (current=' + this.activeSessionId + ')');
    if (this.activeSessionId === id) return;
    this.disconnect();
    this.activeSessionId = id;
    this.sessionList.render(this.sessions, this.tags, id);
    const session = this.sessions.find((s) => s.id === id);
    if (session) this.sessionInfo.render(session);
    this.showSessionTerminal(id);
    this.connect(id);
    this.updateShellTitle();
    if (this.shellVisible) {
      this.connectShell();
    }
    if (this.isMobile()) {
      this.closeLeftDrawer();
    }
  }

  private showCreateModal(): void {
    const existing = document.querySelector('.modal-overlay');
    if (existing) existing.remove();

    const tagOptions = this.tags.map(t =>
      `<option value="${t.id}"${t.id === 'uncategorized' ? '' : ''}>${this.escapeHtml(t.name)}</option>`
    ).join('');
    const defaultTag = this.tags.find(t => t.id !== 'uncategorized')?.id || 'uncategorized';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <h3>Create New Session</h3>
        <div class="field">
          <label>Session Name</label>
          <input type="text" id="modal-name" value="session-${Date.now()}" placeholder="My Session">
        </div>
        <div class="field">
          <label>Working Directory</label>
          <input type="text" id="modal-cwd" value="/tmp" placeholder="/tmp">
          <div id="cwd-completions" class="cwd-completions hidden"></div>
        </div>
        <div class="field">
          <label>Tag</label>
          <select id="modal-tag" class="modal-select">${tagOptions}</select>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" id="modal-cancel">Cancel</button>
          <button class="btn-primary" id="modal-create">Create</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const nameInput = overlay.querySelector('#modal-name') as HTMLInputElement;
    const cwdInput = overlay.querySelector('#modal-cwd') as HTMLInputElement;
    const tagSelect = overlay.querySelector('#modal-tag') as HTMLSelectElement;
    const completionsEl = overlay.querySelector('#cwd-completions') as HTMLElement;
    tagSelect.value = defaultTag;
    nameInput.focus();
    nameInput.select();

    // Tab completion for cwd
    let completionTimer: number | null = null;
    cwdInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const partial = cwdInput.value;
        if (!partial) return;
        try {
          const res = await fetch(`/api/path-completions?partial=${encodeURIComponent(partial)}`);
          if (!res.ok) return;
          const dirs: string[] = await res.json();
          if (dirs.length === 0) return;
          if (dirs.length === 1) {
            cwdInput.value = dirs[0] + '/';
            completionsEl.classList.add('hidden');
          } else {
            // Find common prefix
            let prefix = dirs[0];
            for (const d of dirs) {
              while (!d.startsWith(prefix)) {
                prefix = prefix.slice(0, -1);
              }
            }
            if (prefix.length > partial.length) {
              cwdInput.value = prefix;
            }
            // Show completions
            completionsEl.innerHTML = dirs.map(d => `<div class="cwd-completion-item">${this.escapeHtml(d)}</div>`).join('');
            completionsEl.classList.remove('hidden');
            // Click to select
            completionsEl.querySelectorAll('.cwd-completion-item').forEach((item, i) => {
              item.addEventListener('click', () => {
                cwdInput.value = dirs[i] + '/';
                completionsEl.classList.add('hidden');
                cwdInput.focus();
              });
            });
            // Auto-hide after 3s
            if (completionTimer) clearTimeout(completionTimer);
            completionTimer = window.setTimeout(() => {
              completionsEl.classList.add('hidden');
            }, 3000);
          }
        } catch {}
      } else {
        completionsEl.classList.add('hidden');
      }
    });

    const close = () => {
      if (completionTimer) clearTimeout(completionTimer);
      overlay.remove();
    };

    overlay.querySelector('#modal-cancel')!.addEventListener('click', close);
    overlay.querySelector('#modal-create')!.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const cwd = cwdInput.value.trim();
      const tagId = tagSelect.value;
      if (!name || !cwd) return;
      close();
      await this.doCreateSession(name, cwd, tagId);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cwdInput.focus();
    });
  }

  private async doCreateSession(name: string, cwd: string, tagId?: string): Promise<void> {
    this.logDebug(`Creating session: name=${name}, cwd=${cwd}, tagId=${tagId}`);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cwd, tagId }),
      });
      this.logDebug(`Create session response: ${res.status}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        this.logDebug(`Create session failed: ${err.error || res.statusText}`);
        showAlert('Failed to create session: ' + (err.error || res.statusText));
        return;
      }
      const session: SessionSummary = await res.json();
      this.logDebug(`Session created: ${session.id}`);
      this.sessions.unshift(session);
      this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
      this.switchSession(session.id);
    } catch (e) {
      const msg = (e as Error).message;
      this.logDebug('Create session exception: ' + msg);
      showAlert('Error creating session: ' + msg);
    }
  }

  private async renameSession(id: string, name: string): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return;
      const s = this.sessions.find((x) => x.id === id);
      if (s) {
        s.name = name;
        this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
        if (this.activeSessionId === id) {
          this.sessionInfo.render(s);
        }
      }
    } catch (e) {
      console.error('renameSession error:', e);
    }
  }

  private async deleteSession(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (!res.ok) return;

      // Clean up terminal
      const entry = this.terminals.get(id);
      if (entry) {
        if (entry.onDataDisposable) entry.onDataDisposable.dispose();
        entry.container.remove();
        this.terminals.delete(id);
      }

      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.activeSessionId === id) {
        this.disconnect();
        this.activeSessionId = null;
        if (this.sessions.length > 0) {
          this.switchSession(this.sessions[0].id);
        } else {
          this.sessionList.render([], [], null);
          this.sessionInfo.render(null);
        }
      } else {
        this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
      }
    } catch (e) {
      console.error('deleteSession error:', e);
    }
  }

  private async moveSession(sessionId: string, tagId: string): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId }),
      });
      if (!res.ok) return;
      const s = this.sessions.find(x => x.id === sessionId);
      if (s) {
        s.tagId = tagId;
        this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
      }
    } catch (e) {
      console.error('moveSession error:', e);
    }
  }

  private async createTag(name: string): Promise<void> {
    try {
      const res = await fetch('/api/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        showAlert('Failed to create tag: ' + (err.error || res.statusText));
        return;
      }
      await this.refreshTags();
    } catch (e) {
      console.error('createTag error:', e);
    }
  }

  private async renameTag(id: string, name: string): Promise<void> {
    try {
      const res = await fetch(`/api/tags/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        showAlert('Failed to rename tag: ' + (err.error || res.statusText));
        return;
      }
      await this.refreshTags();
    } catch (e) {
      console.error('renameTag error:', e);
    }
  }

  private async deleteTag(id: string, action: 'move_uncategorized' | 'delete_sessions'): Promise<void> {
    try {
      const res = await fetch(`/api/tags/${id}?action=${action}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        showAlert('Failed to delete tag: ' + (err.error || res.statusText));
        return;
      }
      if (action === 'delete_sessions') {
        this.sessions = this.sessions.filter(s => s.tagId !== id);
        if (this.activeSessionId && !this.sessions.find(s => s.id === this.activeSessionId)) {
          this.disconnect();
          this.activeSessionId = null;
          if (this.sessions.length > 0) {
            this.switchSession(this.sessions[0].id);
            return;
          }
        }
      } else {
        for (const s of this.sessions) {
          if (s.tagId === id) s.tagId = 'uncategorized';
        }
      }
      await this.refreshTags();
    } catch (e) {
      console.error('deleteTag error:', e);
    }
  }

  private async refreshTags(): Promise<void> {
    try {
      const res = await fetch('/api/tags');
      if (res.ok) {
        this.tags = await res.json();
      }
    } catch {}
    this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
  }

  private connect(sessionId: string): void {
    this.logDebug('connect() called for ' + sessionId + ', active=' + this.activeSessionId);
    if (this.activeSessionId !== sessionId) {
      this.logDebug('connect() aborted: activeSessionId mismatch');
      return;
    }
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.logDebug('connect() skipped: existing WebSocket is still active');
      return;
    }
    this.logDebug('location=' + window.location.href + ' proto=' + window.location.protocol + ' host=' + window.location.host);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const entry = this.terminals.get(sessionId);
    const replayFrom = entry?.receivedChunks ?? 0;
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}&replayFrom=${replayFrom}`;
    this.logDebug('WS URL: ' + wsUrl);

    // Preflight: verify HTTP layer is reachable before opening WS
    // Use AbortController instead of AbortSignal.timeout for older WebKit compatibility
    const preflightController = new AbortController();
    const preflightTimeout = setTimeout(() => preflightController.abort(), 5000);
    fetch('/api/sessions', { method: 'HEAD', signal: preflightController.signal }).then((r) => {
      clearTimeout(preflightTimeout);
      this.logDebug('WS preflight HTTP ' + r.status);
    }).catch((e) => {
      clearTimeout(preflightTimeout);
      const err = e as Error;
      this.logDebug('WS preflight failed: ' + err.name + ' — ' + err.message);
    });

    try {
      this.ws = new WebSocket(wsUrl);
    } catch (e) {
      this.logDebug('WebSocket constructor error: ' + (e as Error).message);
      return;
    }
    const ws = this.ws;

    this.showOverlay('Connecting...');

    ws.onopen = () => {
      if (this.ws !== ws || this.activeSessionId !== sessionId) return;
      this.logDebug(`WS open: ${sessionId}`);
      this.hideOverlay();
      this.reconnectDelay = 1000;
      this.updateSessionStatus(sessionId, 'running');
      const entry = this.terminals.get(sessionId);
      if (entry) {
        requestAnimationFrame(() => {
          if (this.ws !== ws || this.activeSessionId !== sessionId) return;
          entry.fitAddon.fit();
          this.sendResize();
          this.startHeartbeat();
        });
      } else {
        this.sendResize();
        this.startHeartbeat();
      }
      // Single retry in case backend missed the first resize
      setTimeout(() => {
        if (this.ws === ws && this.activeSessionId === sessionId) {
          this.logDebug('Retry resize');
          this.sendResize();
        }
      }, 1200);
    };

    ws.onmessage = async (event) => {
      if (this.ws !== ws || this.activeSessionId !== sessionId) return;
      let raw = event.data;
      const dataType = typeof raw;
      if (dataType !== 'string') {
        this.logDebug(`WS received non-string data: type=${dataType} ${raw instanceof Blob ? 'Blob(size=' + raw.size + ')' : ''}`);
        if (raw instanceof Blob) {
          try {
            raw = await raw.text();
          } catch (e) {
            this.logDebug('Blob.text() failed: ' + (e as Error).message);
            return;
          }
        } else if (raw instanceof ArrayBuffer) {
          raw = new TextDecoder().decode(raw);
        } else {
          return;
        }
      }
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'output') {
          this.logDebug(`output: ${msg.data?.length || 0} chars`);
          const entry = this.terminals.get(sessionId);
          if (entry) {
            entry.terminal.write(msg.data);
            entry.receivedChunks += 1;
          }
          const s = this.sessions.find((x) => x.id === sessionId);
          if (s && s.status === 'disconnected') {
            this.updateSessionStatus(sessionId, 'running');
          }
          this.scheduleNotification();
        } else if (msg.type === 'status') {
          this.logDebug(`status: ${msg.status}`);
          this.updateSessionStatus(sessionId, msg.status);
        } else if (msg.type === 'pong') {
          if (this.pongTimeoutTimer) {
            clearTimeout(this.pongTimeoutTimer);
            this.pongTimeoutTimer = null;
          }
          const rtt = this.lastPingTime ? Date.now() - this.lastPingTime : 0;
          this.logDebug(`pong received, rtt=${rtt}ms`);
        }
      } catch (e) {
        this.logDebug('WS JSON parse error: ' + (e as Error).message + ' raw=' + String(raw).slice(0, 200));
      }
    };

    ws.onclose = (ev) => {
      this.logDebug('WS close code=' + ev.code + ' reason=' + ev.reason);
      this.stopHeartbeat();
      this.scheduleReconnect(sessionId);
    };

    ws.onerror = (e) => {
      const state = ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] || 'UNKNOWN';
      this.logDebug('WS error (readyState=' + state + '): ' + JSON.stringify(e));
      // Diagnostic: test if the server is reachable at all via Rust curl
      if (this.isTauri && ws.readyState === WebSocket.CLOSED) {
        try {
          const tauri = (window as any).__TAURI__;
          const invoke = tauri?.core?.invoke || tauri?.invoke;
          if (invoke) {
            invoke('test_http', { url: wsUrl.replace('ws:', 'http:') })
              .then((res: string) => this.logDebug('Rust WS diag: ' + res))
              .catch((err: Error) => this.logDebug('Rust WS diag error: ' + err.message));
          }
        } catch (e3) {
          this.logDebug('Rust WS diag invoke failed: ' + (e3 as Error).message);
        }
      }
      ws.close();
    };
  }

  private disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const ws = this.ws;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(sessionId: string): void {
    // Don't reconnect if user has already switched to a different session
    if (this.activeSessionId !== sessionId) {
      return;
    }
    this.showOverlay(`Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = window.setTimeout(() => {
      if (this.activeSessionId !== sessionId) {
        this.hideOverlay();
        return;
      }
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect(sessionId);
    }, this.reconnectDelay);
  }

  private sendResize(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.activeSessionId) {
      this.logDebug('sendResize skipped: ws not ready');
      return;
    }
    let cols = 120;
    let rows = 30;
    const entry = this.terminals.get(this.activeSessionId);
    if (entry) {
      const dims = entry.fitAddon.proposeDimensions();
      cols = dims?.cols ?? 120;
      rows = dims?.rows ?? 30;
    }
    this.logDebug(`sendResize: ${cols}x${rows} (hasEntry=${!!entry})`);
    this.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.lastPingTime = Date.now();
        this.ws.send(JSON.stringify({ type: 'ping' }));
        this.pongTimeoutTimer = window.setTimeout(() => {
          this.logDebug('PONG TIMEOUT — server->client path may be blocked');
        }, 20000);
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = null;
    }
  }

  private scheduleNotification(): void {
    if (this.notificationTimer) {
      clearTimeout(this.notificationTimer);
      this.notificationTimer = null;
    }
    this.notificationTimer = window.setTimeout(() => {
      this.notificationTimer = null;
      const hidden = document.visibilityState === 'hidden' || !this.windowFocused;
      if (hidden) {
        if (Notification.permission === 'granted') {
          try {
            new Notification('Claude Session Manager', {
              body: 'Claude has finished replying.',
            });
          } catch {
            // Web Notification may not work in Tauri WebView
          }
        }
        if (this.isTauri) {
          try {
            const tauri = (window as any).__TAURI__;
            if (tauri?.core?.invoke) {
              tauri.core.invoke('request_attention');
            }
          } catch (e) {
            console.error('request_attention error:', e);
          }
        }
        document.title = '● ' + this.originalTitle;
      }
    }, 3000);
  }

  private updateSessionStatus(id: string, status: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.status = status as any;
      this.sessionList.render(this.sessions, this.tags, this.activeSessionId);
      if (this.activeSessionId === id) {
        this.sessionInfo.render(s);
      }
    }
  }

  private applySettings(data: Readonly<{ theme: 'dark' | 'light'; terminalFontSize: number }>): void {
    const isDark = data.theme === 'dark';
    document.body.setAttribute('data-theme', data.theme);
    const themeBtn = document.getElementById('btn-theme')!;
    themeBtn.textContent = isDark ? '☀' : '🌙';
    themeBtn.title = isDark ? 'Switch to Light' : 'Switch to Dark';

    const xtermTheme = isDark ? oneDarkTheme : oneLightTheme;

    for (const entry of this.terminals.values()) {
      (entry.terminal as any).options.fontSize = data.terminalFontSize;
      (entry.terminal as any).options.theme = xtermTheme;
      requestAnimationFrame(() => entry.fitAddon.fit());
    }

    if (this.shellTerminal) {
      (this.shellTerminal.terminal as any).options.fontSize = data.terminalFontSize;
      (this.shellTerminal.terminal as any).options.theme = xtermTheme;
      requestAnimationFrame(() => this.fitShellTerminal());
    }

    if (this.codeEditor) {
      this.codeEditor.setTheme(isDark).catch(console.error);
    }
  }

  private showSettingsModal(): void {
    const modal = document.getElementById('settings-modal')!;
    const closeBtn = document.getElementById('settings-close')!;
    const resetBtn = document.getElementById('settings-reset')!;
    const fontSlider = document.getElementById('settings-font-size') as HTMLInputElement;
    const fontValue = document.getElementById('settings-font-value')!;
    const themeRadios = modal.querySelectorAll<HTMLInputElement>('input[name="theme"]');

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

  private showOverlay(text: string): void {
    const el = document.getElementById('connection-overlay')!;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  private hideOverlay(): void {
    document.getElementById('connection-overlay')!.classList.add('hidden');
  }

  private async openFileInEditor(filePath: string): Promise<void> {
    let resolvedPath = filePath;

    // Strategy A: resolve relative path against active session cwd
    if (!resolvedPath.startsWith('/')) {
      const session = this.sessions.find((s) => s.id === this.activeSessionId);
      if (session) {
        resolvedPath = session.cwd.replace(/\/$/, '') + '/' + resolvedPath;
        this.logDebug(`Resolved relative path: ${filePath} -> ${resolvedPath}`);
      }
    }

    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(resolvedPath)}`);
      if (!res.ok) {
        if (res.status === 404) {
          // Strategy C: prompt user to confirm/edit path
          const userPath = await this.showPathPrompt(resolvedPath, filePath);
          if (userPath && userPath !== resolvedPath) {
            return this.openFileInEditor(userPath);
          }
        }
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        showAlert('Failed to open file: ' + (err.error || res.statusText));
        return;
      }
      const data = await res.json();
      await this.codeEditor.open(data.path, data.content);
      const editor = document.getElementById('code-editor')!;
      editor.classList.remove('hidden');
      if (this.isMobile()) {
        editor.classList.add('open');
      }
      this.fitActiveTerminal();
    } catch (e) {
      console.error('Open file error:', e);
      showAlert('Error opening file. Check console.');
    }
  }

  private showPathPrompt(resolvedPath: string, originalPath: string): Promise<string | null> {
    return new Promise((resolve) => {
      const existing = document.querySelector('.modal-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal" style="width: 520px;">
          <h3>Resolve File Path</h3>
          <div style="color: var(--fg-secondary); font-size: 12px; margin-bottom: 12px; line-height: 1.5;">
            Detected: <code style="background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; font-family: Menlo, monospace;">${this.escapeHtml(originalPath)}</code>
          </div>
          <div class="field">
            <label>Full Path</label>
            <input type="text" id="prompt-path" value="${this.escapeHtml(resolvedPath)}" style="font-family: Menlo, monospace;">
          </div>
          <div class="modal-actions">
            <button class="btn-secondary" id="prompt-cancel">Cancel</button>
            <button class="btn-primary" id="prompt-confirm">Open</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const input = overlay.querySelector('#prompt-path') as HTMLInputElement;
      input.focus();
      input.select();

      const close = (path: string | null) => {
        overlay.remove();
        resolve(path);
      };

      overlay.querySelector('#prompt-cancel')!.addEventListener('click', () => close(null));
      overlay.querySelector('#prompt-confirm')!.addEventListener('click', () => close(input.value.trim()));
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') close(input.value.trim());
      });
    });
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
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
      this.fitActiveTerminal();
    });
  }

  private setupSidebarResize(): void {
    const handle = document.getElementById('sidebar-resize-handle')!;
    const sidebar = document.getElementById('session-list')!;
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
      const delta = e.clientX - startX;
      const newWidth = Math.min(Math.max(startWidth + delta, 160), 480);
      sidebar.style.width = `${newWidth}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.fitActiveTerminal();
    });
  }

  private setupShellResize(): void {
    const handle = document.getElementById('shell-resize-handle')!;
    const panel = document.getElementById('shell-panel')!;
    let isDragging = false;
    let startY = 0;
    let startHeight = 0;

    handle.addEventListener('mousedown', (e) => {
      if (this.shellVisible) {
        isDragging = true;
        startY = e.clientY;
        startHeight = panel.offsetHeight;
        handle.classList.add('dragging');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const newHeight = shellPanelHeightForDrag(startHeight, startY, e.clientY);
      panel.style.flexBasis = `${newHeight}px`;
      this.fitShellTerminal();
    });

    window.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      this.fitShellTerminal();
    });
  }

  private handleShellSessionChange(): void {
    if (!this.shellVisible || !this.activeSessionId) return;
    this.connectShell();
  }

  private handlePaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) {
      this.logDebug('Paste: no clipboardData');
      return Promise.resolve();
    }

    // Use items API for better compatibility across browsers
    const items = e.clipboardData.items;
    if (!items || items.length === 0) {
      this.logDebug('Paste: no clipboard items');
      return Promise.resolve();
    }

    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      this.logDebug(`Paste item[${i}]: kind=${item.kind}, type=${item.type}`);
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0) {
      this.logDebug('Paste: no image files found');
      return Promise.resolve();
    }

    // Skip if focus is inside CodeMirror editor
    const target = e.target as HTMLElement;
    if (target?.closest('.cm-editor')) return Promise.resolve();

    e.preventDefault();

    return (async () => {
      for (const file of files) {
        this.logDebug(`Pasting image: ${file.name} (${file.size} bytes)`);
        try {
          const base64 = await readFileAsBase64(file);
          const res = await fetch('/api/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: this.activeSessionId,
              filename: file.name,
              data: base64,
            }),
          });
          if (!res.ok) {
            const text = await res.text().catch(() => 'no body');
            this.logDebug(`Upload failed: HTTP ${res.status} body=${text.slice(0, 200)}`);
            let errMsg = res.statusText;
            try { errMsg = JSON.parse(text).error || errMsg; } catch {}
            showAlert('Failed to upload image: ' + errMsg);
            continue;
          }
          const result = await res.json();
          this.logDebug(`Image uploaded to: ${result.path}`);

          if (this.ws?.readyState === WebSocket.OPEN && this.activeSessionId) {
            const displayPath = result.path.startsWith('/root/')
              ? result.path.replace(/^\/root\//, '~/')
              : result.path;
            this.ws.send(JSON.stringify({ type: 'input', data: displayPath }));
          }
        } catch (err) {
          showAlert('Error uploading image: ' + (err as Error).message);
        }
      }
    })();
  }

  private toggleDebugPanel(): void {
    this.debugEl.classList.toggle('visible');
  }

  private logDebug(msg: string): void {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.debugLines.push(line);
    if (this.debugLines.length > 20) this.debugLines.shift();
    if (this.debugEl) {
      this.debugEl.textContent = this.debugLines.join('\n');
    } else {
      console.log('[CSM Debug]', line);
    }
  }

  private async openTauriSettings(): Promise<void> {
    try {
      const tauri = (window as any).__TAURI__;
      if (tauri && tauri.core && tauri.core.invoke) {
        await tauri.core.invoke('open_settings');
      } else if (tauri && tauri.invoke) {
        await tauri.invoke('open_settings');
      } else {
        console.warn('Tauri invoke API not found');
      }
    } catch (e) {
      console.error('openSettings error:', e);
    }
  }

  private async setupTauriTunnelListeners(): Promise<void> {
    try {
      let listen: (event: string, handler: (event: any) => void) => Promise<() => void>;
      const tauri = (window as any).__TAURI__;
      if (tauri?.event?.listen) {
        listen = tauri.event.listen.bind(tauri.event);
      } else {
        // @ts-ignore dynamic import from CDN for Tauri v2 event API
        const mod = await import('https://esm.sh/@tauri-apps/api@2.0.0/event');
        listen = mod.listen;
      }

      await listen('tunnel-disconnected', () => {
        this.logDebug('Tauri event: tunnel-disconnected');
        this.disconnect();
        this.showOverlay('SSH tunnel disconnected. Waiting for reconnect...');
      });

      await listen('tunnel-reconnected', () => {
        this.logDebug('Tauri event: tunnel-reconnected');
        this.hideOverlay();
        this.loadSessions();
        if (this.activeSessionId) {
          this.connect(this.activeSessionId);
        }
      });
    } catch (e) {
      this.logDebug('Failed to setup Tauri tunnel listeners: ' + (e as Error).message);
    }
  }
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

new App();
