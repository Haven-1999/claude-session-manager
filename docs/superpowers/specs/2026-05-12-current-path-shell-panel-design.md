---
title: Current Path Shell Panel Design
---

# Current Path Shell Panel Design

## Goal

Add an embedded shell terminal for the currently selected Claude session's working directory. The shell is a companion terminal for quick filesystem commands and diagnostics; it does not create a new Claude session and does not affect Claude resume/output-buffer behavior.

## User behavior

- Add a visible web UI button for the active session, labeled for opening the current path terminal.
- Clicking the button expands a shell panel below the main Claude terminal.
- Clicking the button again collapses the panel without closing the shell process.
- Re-expanding restores the same shell state and terminal buffer.
- The panel has a draggable divider so the user can adjust its height.
- The shell starts in the active session's `cwd`.

## Architecture

### Frontend

`src/frontend/app.ts` owns the shell panel because it already owns terminal creation, active session switching, WebSocket lifecycle, and xterm fit/resize behavior.

Add a separate terminal entry for the companion shell, independent from the existing Claude session terminal map. The shell entry tracks:

- xterm instance
- fit addon
- panel container
- WebSocket connection
- visibility state
- current height
- active session id/cwd used to start the shell

The shell panel is rendered inside the main terminal area below the existing terminal panels. The existing terminal stays the primary panel; when the shell panel is visible, available height is shared between the main terminal and shell panel. The divider updates the shell height and triggers `fit()`/resize messages for both terminals.

### Backend

Add a shell-specific WebSocket route, `/shell-ws?sessionId=...`, in addition to the existing Claude WebSocket route. The route:

- resolves `sessionId` through `SessionManager`
- rejects missing or unknown sessions
- spawns a normal shell process in the session's `cwd`
- forwards browser input to the shell PTY
- forwards shell output to the browser
- handles resize messages
- cleans up the shell PTY when the browser connection closes

This route is intentionally separate from `/ws` so the Claude-specific resume/session-id/output-buffer logic stays unchanged.

## Data flow

1. User selects an existing Claude session.
2. User clicks the shell button.
3. Frontend creates or reveals the shell panel for that session.
4. Frontend opens `/shell-ws?sessionId=<activeSessionId>`.
5. Backend looks up the session and starts the default shell in `session.cwd`.
6. xterm input is sent as `{ type: 'input', data }`.
7. PTY output is sent back as `{ type: 'output', data }`.
8. Fit/resizing sends `{ type: 'resize', cols, rows }`.
9. Collapsing the panel hides it without closing the WebSocket or PTY.

## Session switching

The shell panel belongs to the active session that opened it. If the user switches Claude sessions while the panel is open, the frontend should hide the shell panel for the previous session and let the user open a shell for the newly active session. This keeps the visible shell aligned with the visible Claude terminal.

## Error handling

- If there is no active session, the shell button is disabled or shows an alert.
- If the backend cannot find the session, the WebSocket closes and the frontend shows a short error in the shell panel or alert.
- If spawning the shell fails, the backend closes the WebSocket with an error code and the frontend reports failure.
- Collapsing the panel is not an error path and must not close the process.

## Testing

- Unit/integration test the backend shell WebSocket behavior where practical: missing session, unknown session, resize/input handling, and process cleanup on close.
- Frontend verification by building TypeScript.
- Manual browser verification:
  - Open an existing session.
  - Click the shell button and confirm the shell starts in the active session's cwd.
  - Run a command such as `pwd`.
  - Collapse and re-expand; confirm shell state remains.
  - Drag the divider and confirm both terminals remain usable.
  - Switch sessions and confirm the shell panel does not misleadingly show the previous session as current.
