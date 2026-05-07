import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SessionList } from './components/session-list.js';
import { SessionInfo } from './components/session-info.js';
import { CodeEditorPanel } from './components/code-editor.js';
import { FileLinkProvider } from './components/file-link-provider.js';

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

  constructor() {
    this.isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__;
    this.debugEl = document.getElementById('debug-panel')!;
    this.logDebug('App starting...');

    this.sessionList = new SessionList(document.getElementById('session-list-content')!, {
      onSelect: (id) => this.switchSession(id),
      onNew: () => this.showCreateModal(),
      onDelete: (id) => this.deleteSession(id),
      onRename: (id, name) => this.renameSession(id, name),
    });

    this.sessionInfo = new SessionInfo(document.getElementById('session-info-content')!);

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

    window.addEventListener('resize', () => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = window.setTimeout(() => {
        this.resizeDebounceTimer = null;
        this.fitActiveTerminal();
      }, 150);
    });
    window.addEventListener('blur', () => { this.windowFocused = false; });
    window.addEventListener('focus', () => { this.windowFocused = true; });
    document.addEventListener('paste', (e) => this.handlePaste(e));

    document.getElementById('btn-new')!.addEventListener('click', () => this.showCreateModal());

    if (this.isTauri) {
      const actions = document.querySelector('.actions')!;
      const settingsBtn = document.createElement('button');
      settingsBtn.id = 'btn-settings';
      settingsBtn.textContent = 'Settings';
      settingsBtn.style.marginLeft = '8px';
      settingsBtn.addEventListener('click', () => this.openSettings());
      actions.appendChild(settingsBtn);
    }

    this.loadSessions();

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

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", "PingFang SC", monospace',
      allowProposedApi: true,
      convertEol: true,
      screenReaderMode: false,
      theme: {
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
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    (terminal as any).registerLinkProvider(new FileLinkProvider(terminal, (filePath) => {
      this.openFileInEditor(filePath);
    }));
    // xterm.js open() requires the container to be visible
    container.style.display = 'block';
    terminal.open(container);
    fitAddon.fit();
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

  private async loadSessions(retry = 3): Promise<void> {
    try {
      this.logDebug('Fetching sessions...');
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        this.logDebug('fetch /api/sessions failed: ' + res.status);
        if (retry > 0) {
          this.logDebug('Retrying loadSessions in 1s...');
          setTimeout(() => this.loadSessions(retry - 1), 1000);
        } else {
          this.sessionList.render([], null);
          this.sessionInfo.render(null);
        }
        return;
      }
      this.sessions = await res.json();
      this.logDebug('Loaded ' + this.sessions.length + ' sessions');
      this.sessionList.render(this.sessions, this.activeSessionId);
      if (this.sessions.length > 0 && !this.activeSessionId) {
        this.logDebug('Auto-switch to first session');
        this.switchSession(this.sessions[0].id);
      } else if (this.sessions.length === 0) {
        this.sessionInfo.render(null);
        this.activeSessionId = null;
      }
    } catch (e) {
      this.logDebug('loadSessions error: ' + (e as Error).message);
      if (retry > 0) {
        this.logDebug('Retrying loadSessions in 1s...');
        setTimeout(() => this.loadSessions(retry - 1), 1000);
      } else {
        this.sessionList.render([], null);
        this.sessionInfo.render(null);
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
          entry.terminal.clear();
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
      this.logDebug('WS error: ' + JSON.stringify(e));
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
    if (!e.clipboardData) return;
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;

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
          const err = await res.json().catch(() => ({ error: 'Unknown error' }));
          showAlert('Failed to upload image: ' + (err.error || res.statusText));
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

  private logDebug(msg: string): void {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    this.debugLines.push(line);
    if (this.debugLines.length > 20) this.debugLines.shift();
    if (this.debugEl) {
      this.debugEl.textContent = this.debugLines.join('\n');
    }
  }

  private async openSettings(): Promise<void> {
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
