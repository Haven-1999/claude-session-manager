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
