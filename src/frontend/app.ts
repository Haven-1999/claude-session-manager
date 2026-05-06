import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SessionList } from './components/session-list.js';
import { SessionInfo } from './components/session-info.js';
import { CodeEditorPanel } from './components/code-editor.js';
import { FileLinkProvider } from './components/file-link-provider.js';

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

  constructor() {
    this.isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__;

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

    window.addEventListener('resize', () => {
      if (this.resizeDebounceTimer) clearTimeout(this.resizeDebounceTimer);
      this.resizeDebounceTimer = window.setTimeout(() => {
        this.resizeDebounceTimer = null;
        this.fitActiveTerminal();
      }, 150);
    });
    window.addEventListener('blur', () => { this.windowFocused = false; });
    window.addEventListener('focus', () => { this.windowFocused = true; });

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
    terminal.open(container);
    fitAddon.fit();

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
    }

    let entry = this.terminals.get(sessionId);
    if (!entry) {
      entry = this.createTerminal(sessionId);
      this.terminals.set(sessionId, entry);
    }

    entry.container.classList.add('active');
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

  private async loadSessions(): Promise<void> {
    try {
      console.log('[CSM] Loading sessions...');
      const res = await fetch('/api/sessions');
      if (!res.ok) {
        console.error('[CSM] fetch /api/sessions failed:', res.status, res.statusText);
        this.sessionList.render([], null);
        this.sessionInfo.render(null);
        return;
      }
      this.sessions = await res.json();
      console.log('[CSM] Loaded sessions:', this.sessions.length);
      this.sessionList.render(this.sessions, this.activeSessionId);
      if (this.sessions.length > 0 && !this.activeSessionId) {
        this.switchSession(this.sessions[0].id);
      } else if (this.sessions.length === 0) {
        this.sessionInfo.render(null);
        this.activeSessionId = null;
      }
    } catch (e) {
      console.error('[CSM] loadSessions error:', e);
      this.sessionList.render([], null);
      this.sessionInfo.render(null);
    }
  }

  private switchSession(id: string): void {
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
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, cwd }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        alert('Failed to create session: ' + (err.error || res.statusText));
        return;
      }
      const session: SessionSummary = await res.json();
      this.sessions.unshift(session);
      this.sessionList.render(this.sessions, this.activeSessionId);
      this.switchSession(session.id);
    } catch (e) {
      console.error('createNewSession error:', e);
      alert('Error creating session. Check console for details.');
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
    if (this.activeSessionId !== sessionId) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;
    this.ws = new WebSocket(wsUrl);
    const ws = this.ws;

    this.showOverlay('Connecting...');

    ws.onopen = () => {
      if (this.ws !== ws || this.activeSessionId !== sessionId) return;
      console.log('[CSM] WebSocket open for session', sessionId);
      this.hideOverlay();
      this.reconnectDelay = 1000;
      // Force status to running since we are connected
      this.updateSessionStatus(sessionId, 'running');
      // Ensure terminal dimensions are correct before telling PTY
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
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws || this.activeSessionId !== sessionId) return;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          console.log('[CSM] output received, length:', msg.data?.length || 0);
          const entry = this.terminals.get(sessionId);
          if (entry) {
            entry.terminal.write(msg.data);
          }
          // Defensive: if we are receiving output, we must be connected
          const s = this.sessions.find((x) => x.id === sessionId);
          if (s && s.status === 'disconnected') {
            this.updateSessionStatus(sessionId, 'running');
          }
          this.scheduleNotification();
        } else if (msg.type === 'status') {
          console.log('[CSM] status received:', msg.status);
          this.updateSessionStatus(sessionId, msg.status);
        } else if (msg.type === 'pong') {
          // heartbeat ok
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.scheduleReconnect(sessionId);
    };

    ws.onerror = () => {
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.activeSessionId) return;
    const entry = this.terminals.get(this.activeSessionId);
    if (!entry) return;
    const dims = entry.fitAddon.proposeDimensions();
    const cols = dims?.cols ?? 120;
    const rows = dims?.rows ?? 30;
    console.log('[CSM] sendResize:', { cols, rows, hasDims: !!dims });
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
      this.fitActiveTerminal();
    });
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

new App();
