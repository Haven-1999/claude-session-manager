import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { SessionList } from './components/session-list.js';
import { SessionInfo } from './components/session-info.js';

interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: 'running' | 'disconnected' | 'stopped';
  createdAt: number;
  lastActiveAt: number;
}

class App {
  private ws: WebSocket | null = null;
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private sessions: SessionSummary[] = [];
  private currentSessionId: string | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private sessionList: SessionList;
  private sessionInfo: SessionInfo;
  private isTauri: boolean;

  constructor() {
    this.isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI__;

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
      },
    });
    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);

    const container = document.getElementById('terminal-container')!;
    this.terminal.open(container);
    this.fitAddon.fit();

    this.sessionList = new SessionList(document.getElementById('session-list')!, {
      onSelect: (id) => this.switchSession(id),
      onNew: () => this.createNewSession(),
    });

    this.sessionInfo = new SessionInfo(document.getElementById('session-info')!);

    window.addEventListener('resize', () => {
      this.fitAddon.fit();
      this.sendResize();
    });

    document.getElementById('btn-new')!.addEventListener('click', () => this.createNewSession());

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
  }

  private async loadSessions(): Promise<void> {
    const res = await fetch('/api/sessions');
    this.sessions = await res.json();
    this.sessionList.render(this.sessions, this.currentSessionId);
    if (this.sessions.length > 0 && !this.currentSessionId) {
      this.switchSession(this.sessions[0].id);
    }
  }

  private switchSession(id: string): void {
    if (this.currentSessionId === id) return;
    this.disconnect();
    this.currentSessionId = id;
    this.sessionList.render(this.sessions, id);
    const session = this.sessions.find((s) => s.id === id);
    if (session) this.sessionInfo.render(session);
    this.connect(id);
  }

  private async createNewSession(): Promise<void> {
    try {
      const name = prompt('Session name:', `session-${Date.now()}`);
      if (!name) return;
      const cwd = prompt('Working directory:', '/tmp');
      if (!cwd) return;

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
      this.sessionList.render(this.sessions, this.currentSessionId);
      this.switchSession(session.id);
    } catch (e) {
      console.error('createNewSession error:', e);
      alert('Error creating session. Check console for details.');
    }
  }

  private connect(sessionId: string): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?sessionId=${sessionId}`;
    this.ws = new WebSocket(wsUrl);

    this.showOverlay('Connecting...');

    this.ws.onopen = () => {
      this.hideOverlay();
      this.reconnectDelay = 1000;
      this.sendResize();
      this.startHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'output') {
          this.terminal.write(msg.data);
        } else if (msg.type === 'status') {
          this.updateSessionStatus(sessionId, msg.status);
        } else if (msg.type === 'pong') {
          // heartbeat ok
        }
      } catch {
        // ignore
      }
    };

    this.ws.onclose = () => {
      this.stopHeartbeat();
      this.scheduleReconnect(sessionId);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };

    this.terminal.onData((data) => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
  }

  private disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(sessionId: string): void {
    this.showOverlay(`Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect(sessionId);
    }, this.reconnectDelay);
  }

  private sendResize(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const dims = this.fitAddon.proposeDimensions();
    if (dims) {
      this.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
  }

  private heartbeatTimer: number | null = null;
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

  private updateSessionStatus(id: string, status: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (s) {
      s.status = status as any;
      this.sessionList.render(this.sessions, this.currentSessionId);
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
