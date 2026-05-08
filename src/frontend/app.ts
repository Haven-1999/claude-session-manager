import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SessionList } from './components/session-list.js';
import { SessionInfo } from './components/session-info.js';
import { CodeEditorPanel } from './components/code-editor.js';
import { FileLinkProvider } from './components/file-link-provider.js';
import { Settings } from './settings.js';

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
}

interface TerminalEntry {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLElement;
  onDataDisposable: { dispose: () => void } | null;
}

class App {
  private ws: WebSocket | null = null;
  private terminals = new Map<string, TerminalEntry>();
  private activeSessionId: string | null = null;
  private sessions: SessionSummary[] = [];
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private sessionList: SessionList;
  private sessionInfo: SessionInfo;
  private isTauri: boolean;
  private heartbeatTimer: number | null = null;
  private notificationTimer: number | null = null;
  private windowFocused = true;
  private resizeDebounceTimer: number | null = null;
  private codeEditor: CodeEditorPanel;
  private debugEl: HTMLElement;
  private debugLines: string[] = [];
  private settings: Settings;

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
    });

    this.sessionInfo = new SessionInfo(document.getElementById('session-info-content')!);

    this.codeEditor = new CodeEditorPanel(document.getElementById('code-editor-content')!);
    this.codeEditor.onClose = () => {
      document.getElementById('code-editor')!.classList.add('hidden');
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

    // Apply initial settings after all components are initialized
    this.applySettings(this.settings.data);

    window.addEventListener('resize', () => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = window.setTimeout(() => {
        this.resizeDebounceTimer = null;
        this.fitActiveTerminal();
      }, 150);
    });
    window.addEventListener('blur', () => { this.windowFocused = false; });
    window.addEventListener('focus', () => { this.windowFocused = true; });
    document.addEventListener('paste', (e) => this.handlePaste(e), true);

    document.getElementById('btn-new')!.addEventListener('click', () => this.showCreateModal());
    document.getElementById('btn-debug')!.addEventListener('click', () => this.toggleDebugPanel());

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

  private createTerminal(sessionId: string): TerminalEntry {
    const panels = document.getElementById('terminal-panels')!;
    const container = document.createElement('div');
    container.className = 'terminal-panel';
    container.id = `terminal-panel-${sessionId}`;
    panels.appendChild(container);

    const isDark = this.settings.data.theme === 'dark';
    const xtermTheme = isDark
      ? {
          background: '#0d1117',
          foreground: '#e6edf3',
          cursor: '#58a6ff',
          selectionBackground: '#264f78',
          black: '#0d1117',
          red: '#f85149',
          green: '#3fb950',
          yellow: '#d29922',
          blue: '#58a6ff',
          magenta: '#bc8cff',
          cyan: '#39c5cf',
          white: '#e6edf3',
          brightBlack: '#484f58',
          brightRed: '#ff7b72',
          brightGreen: '#56d364',
          brightYellow: '#e3b341',
          brightBlue: '#79c0ff',
          brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd',
          brightWhite: '#ffffff',
        }
      : {
          background: '#ffffff',
          foreground: '#1f2328',
          cursor: '#0969da',
          selectionBackground: '#b4d7ff',
          black: '#1f2328',
          red: '#cf222e',
          green: '#1a7f37',
          yellow: '#9a6700',
          blue: '#0969da',
          magenta: '#8250df',
          cyan: '#1b7c83',
          white: '#656d76',
          brightBlack: '#656d76',
          brightRed: '#cf222e',
          brightGreen: '#1a7f37',
          brightYellow: '#9a6700',
          brightBlue: '#0969da',
          brightMagenta: '#8250df',
          brightCyan: '#1b7c83',
          brightWhite: '#1f2328',
        };

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: this.settings.data.terminalFontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      allowProposedApi: true,
      convertEol: true,
      screenReaderMode: false,
      unicodeVersion: '11',
      theme: xtermTheme,
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

    const onDataDisposable = terminal.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN && this.activeSessionId === sessionId) {
        this.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    return { terminal, fitAddon, container, onDataDisposable };
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
        this.sessionList.render([], null);
        this.sessionInfo.render(null);
        return;
      }
      this.sessions = await res.json();
      this.logDebug('Loaded ' + this.sessions.length + ' sessions in ' + elapsed + 'ms');
      this.sessionList.render(this.sessions, this.activeSessionId);
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
      this.sessionList.render([], null);
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
    this.sessionList.render(this.sessions, id);
    const session = this.sessions.find((s) => s.id === id);
    if (session) this.sessionInfo.render(session);
    this.showSessionTerminal(id);
    this.connect(id);
  }

  private showCreateModal(): void {
    const existing = document.querySelector('.modal-overlay');
    if (existing) existing.remove();

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
    nameInput.focus();
    nameInput.select();

    const close = () => overlay.remove();

    overlay.querySelector('#modal-cancel')!.addEventListener('click', close);
    overlay.querySelector('#modal-create')!.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const cwd = cwdInput.value.trim();
      if (!name || !cwd) return;
      close();
      await this.doCreateSession(name, cwd);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') cwdInput.focus();
    });
    cwdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        (overlay.querySelector('#modal-create') as HTMLButtonElement).click();
      }
    });
  }

  private async doCreateSession(name: string, cwd: string): Promise<void> {
    this.logDebug(`Creating session: name=${name}, cwd=${cwd}`);
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cwd }),
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
      this.sessionList.render(this.sessions, this.activeSessionId);
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
        this.sessionList.render(this.sessions, this.activeSessionId);
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
          this.sessionList.render([], null);
          this.sessionInfo.render(null);
        }
      } else {
        this.sessionList.render(this.sessions, this.activeSessionId);
      }
    } catch (e) {
      console.error('deleteSession error:', e);
    }
  }

  private connect(sessionId: string): void {
    this.logDebug('connect() called for ' + sessionId + ', active=' + this.activeSessionId);
    if (this.activeSessionId !== sessionId) {
      this.logDebug('connect() aborted: activeSessionId mismatch');
      return;
    }
    this.logDebug('location=' + window.location.href + ' proto=' + window.location.protocol + ' host=' + window.location.host);
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;
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
        // Only clear on reconnect when terminal already has content
        const buf = (entry.terminal as any).buffer;
        if (buf && buf.active && buf.active.length > 0) {
          entry.terminal.write('\x1bc');
        }
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

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.activeSessionId !== sessionId) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          this.logDebug(`output: ${msg.data?.length || 0} chars`);
          const entry = this.terminals.get(sessionId);
          if (entry) {
            entry.terminal.write(msg.data);
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
          // heartbeat ok
        }
      } catch {
        // ignore
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
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 15000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
      }
    }, 3000);
  }

  private updateSessionStatus(id: string, status: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.status = status as any;
      this.sessionList.render(this.sessions, this.activeSessionId);
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

    const xtermTheme = isDark
      ? {
          background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
          selectionBackground: '#264f78', black: '#0d1117', red: '#f85149',
          green: '#3fb950', yellow: '#d29922', blue: '#58a6ff',
          magenta: '#bc8cff', cyan: '#39c5cf', white: '#e6edf3',
          brightBlack: '#484f58', brightRed: '#ff7b72', brightGreen: '#56d364',
          brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
          brightCyan: '#56d4dd', brightWhite: '#ffffff',
        }
      : {
          background: '#ffffff', foreground: '#1f2328', cursor: '#0969da',
          selectionBackground: '#b4d7ff', black: '#1f2328', red: '#cf222e',
          green: '#1a7f37', yellow: '#9a6700', blue: '#0969da',
          magenta: '#8250df', cyan: '#1b7c83', white: '#656d76',
          brightBlack: '#656d76', brightRed: '#cf222e', brightGreen: '#1a7f37',
          brightYellow: '#9a6700', brightBlue: '#0969da', brightMagenta: '#8250df',
          brightCyan: '#1b7c83', brightWhite: '#1f2328',
        };

    for (const entry of this.terminals.values()) {
      (entry.terminal as any).options.fontSize = data.terminalFontSize;
      (entry.terminal as any).options.theme = xtermTheme;
      requestAnimationFrame(() => entry.fitAddon.fit());
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
      document.getElementById('code-editor')!.classList.remove('hidden');
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

  private async handlePaste(e: ClipboardEvent): Promise<void> {
    if (!e.clipboardData) {
      this.logDebug('Paste: no clipboardData');
      return;
    }

    // Use items API for better compatibility across browsers
    const items = e.clipboardData.items;
    if (!items || items.length === 0) {
      this.logDebug('Paste: no clipboard items');
      return;
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
      return;
    }

    // Skip if focus is inside CodeMirror editor
    const target = e.target as HTMLElement;
    if (target?.closest('.cm-editor')) return;

    e.preventDefault();

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
          const inputData = result.path + ' ';
          this.ws.send(JSON.stringify({ type: 'input', data: inputData }));
        }
      } catch (err) {
        showAlert('Error uploading image: ' + (err as Error).message);
      }
    }
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
