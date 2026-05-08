# Appearance Settings Design

## Overview
Add terminal font size control and dark/light theme toggle to Claude Session Manager, with user preferences persisted in `localStorage`.

## Requirements
- Terminal font size adjustable (10px–22px, default 14px)
- Dark / Light theme toggle (no system-follow option)
- Preferences persist across sessions via `localStorage`
- Theme applies to entire app: UI chrome, terminal, code editor

## UI Layout

Top bar buttons (right side, after Debug):
```
[ + New Session ] [ Debug ] [ Aa- ] [ Aa+ ] [ ☀/🌙 ] [ Settings ]
```

- **Aa- / Aa+**: Decrease / increase terminal font size by 1px. Range clamped to 10–22. Hover tooltip shows current size.
- **☀/🌙**: Single-click toggle between dark and light. Icon reflects current mode.
- **Settings**: Opens a modal panel with:
  - Theme: radio buttons `Dark` / `Light`
  - Terminal Font Size: range slider + numeric input (10–22)
  - Reset to Defaults button

Settings modal reuses existing `.modal-overlay` / `.modal` styles.

## Theme System

### CSS Variables
Dark variables remain as `:root` defaults. Light overrides via `body[data-theme="light"]` selector.

```css
/* styles.css */
:root {
  --bg-primary: #0d1117;
  /* ... existing dark variables ... */
}

body[data-theme="light"] {
  --bg-primary: #ffffff;
  --bg-secondary: #f6f8fa;
  /* ... light equivalents for all variables ... */
}
```

On page load, JS reads `localStorage` and sets `data-theme` on `<body>` before any paint to prevent flash.

### Terminal Theme
xterm.js theme object has dark colors hardcoded in `app.ts`. Light theme colors defined in parallel; `terminal.setOption('theme', lightTheme)` applied when switching.

### Editor Theme
CodeMirror 6 uses `oneDark` for dark mode. For light mode, remove `oneDark` and apply a custom `EditorView.theme()` extension with light background/foreground colors. No new npm dependencies.

## Persistence

Storage key: `csm:settings`

```ts
interface AppSettings {
  theme: 'dark' | 'light';
  terminalFontSize: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  terminalFontSize: 14,
};
```

- Read on `App` constructor start; apply immediately.
- Write on any change.

## Font Size Update Flow

1. User clicks Aa+/Aa- or changes slider.
2. New size written to `localStorage`.
3. For each active terminal: `terminal.options.fontSize = newSize` then `fitAddon.fit()`.
4. For new terminals created after change, size read from settings at construction time.

## Files Changed

| File | Change |
|------|--------|
| `src/frontend/styles.css` | Add `[data-theme="light"]` variable overrides |
| `src/frontend/settings.ts` | **New.** Settings model, localStorage read/write, defaults |
| `src/frontend/app.ts` | Load settings on init; bind top-bar buttons; update terminal/editor on change |
| `src/frontend/components/code-editor.ts` | Add `setTheme(isDark)` to swap CM extensions |
| `src/frontend/index.html` | Add Aa-/Aa+/theme/settings buttons to top bar |
| `src/frontend/components/session-info.ts` | Ensure light-mode contrast (no hardcoded dark colors) |

## Out of Scope
- System preference detection
- Per-session font size
- Editor font size separate from terminal
- Animations during theme switch
