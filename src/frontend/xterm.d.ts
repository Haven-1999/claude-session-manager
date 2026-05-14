declare module 'xterm' {
  export class Terminal {
    constructor(options?: any);
    readonly textarea: HTMLTextAreaElement | undefined;
    loadAddon(addon: any): void;
    open(element: HTMLElement): void;
    write(data: string | Uint8Array): void;
    onData(callback: (data: string) => void): { dispose: () => void };
    resize(cols: number, rows: number): void;
    clear(): void;
  }
}

declare module 'xterm-addon-fit' {
  export class FitAddon {
    fit(): void;
    proposeDimensions(): { cols: number; rows: number } | undefined;
  }
}
