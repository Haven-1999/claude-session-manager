# Mac Local Browser Runtime Design

## Goal

Add a documented Mac local runtime path for CSM without changing the existing Linux server runtime. A Mac user can clone the repository, install dependencies, build the existing Node.js backend/frontend, start CSM locally, and open the emitted `127.0.0.1` URL in Safari or Chrome.

## Non-goals

- Do not change backend, frontend, or Tauri runtime code.
- Do not revive or redesign the Tauri desktop app.
- Do not mix Mac-local sessions with Linux-server sessions.
- Do not add a Mac-specific wrapper command unless runtime testing later shows it is needed.

## Architecture

CSM keeps one backend architecture. The difference is only where it runs:

- **Mac local runtime:** Node.js CSM runs on the Mac. `node-pty` starts the Mac's local `claude` CLI. CSM stores metadata in the Mac user's default `~/.csm/sessions.db`, and Claude Code continues using the Mac user's local `~/.claude` data. The browser connects to `http://127.0.0.1:<port>`.
- **Linux server runtime:** Node.js CSM runs on the Linux server. `node-pty` starts the server's `claude` CLI. Browser clients connect to the server address exactly as they do today.

The two runtimes are intentionally separate because each manages the files, shell, Claude CLI, and session data on the machine where the backend is running.

## Mac Local User Flow

The README should document this as the first quick-start path:

```bash
git clone https://github.com/Haven-1999/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
npm start
```

The existing CLI defaults are appropriate for Mac local use:

- `--host` defaults to `127.0.0.1`, so the service is not exposed to the LAN.
- The port auto-selects from `9000-9099` when omitted.
- `--data-dir` defaults to `~/.csm`.
- `--claude-path` defaults to `claude`, with an existing override if the CLI is not on `PATH`.

The user opens the exact URL printed by startup output, such as `http://127.0.0.1:9000`.

## Documentation Changes

Update README wording so the product is described as runnable in either Mac-local or Linux-server mode, not only as a Linux server tool. The quick-start section should list:

1. Mac local browser runtime.
2. Linux server direct runtime.
3. Docker single-container runtime.
4. Docker plus `csm-proxy` multi-instance runtime.

The Mac section should state prerequisites:

- Node.js 20+.
- Claude Code CLI installed and authenticated.
- macOS build tools may be required by native dependencies such as `node-pty` and `better-sqlite3`.

Rename or adjust the existing "Mac 端访问" section so it no longer implies Mac is only a remote browser client. It should distinguish:

- Mac local access: open `127.0.0.1` after starting CSM on the Mac.
- Mac access to Linux server: open the server URL after starting CSM on Linux.

Keep the optional SSH forwarding guidance under the Linux-server path.

## Error Handling and Support Guidance

No runtime error handling changes are needed. The README should guide users to existing options:

- If the startup port differs from examples, use the printed URL.
- If `claude` is not found, install Claude Code CLI or use `npm start -- --claude-path <path>`.
- If `npm install` fails on macOS native dependencies, install Xcode Command Line Tools and retry.

## Testing and Verification

Because the implementation is documentation-only, verification is:

- Review README for clear separation between Mac local and Linux server modes.
- Run `npm run build` as a regression check.
- If available, manually test on macOS by running `npm install`, `npm run build`, `npm start`, and opening the printed local URL.

## Scope Check

This is one focused documentation change. If real macOS testing reveals dependency or runtime failures, those should become a follow-up implementation plan rather than being hidden inside this documentation update.
