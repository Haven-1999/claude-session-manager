# Host Container Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `csm-proxy` a host-side forwarding tool that exposes an already-running CSM container's internal `9090` port through an automatically allocated Linux host port.

**Architecture:** Keep CSM itself running inside containers, so `node-pty`, Claude CLI, and CSM data stay in the container environment. The host-side `csm-proxy` command must not import CSM server/session modules; it only inspects Docker, finds a free host port, and starts an HTTP/WebSocket reverse proxy to `<container-ip>:9090`.

**Tech Stack:** Node.js 20+, TypeScript, Docker CLI via `execFile`, Node `http`/`net`, `ws`, Vitest.

---

## File Structure

- `src/container-proxy.ts`: CLI entrypoint. Require `--container` for `expose`, parse host/data/target-port/port-range, print forwarding details.
- `src/server/container-proxy/types.ts`: Types for Docker container info, expose options, proxy records. Remove direct CSM app result types.
- `src/server/container-proxy/manager.ts`: Pure forwarding orchestration. No imports from `src/server/http-server`, `src/server/session`, or `src/server/csm-app`.
- `src/server/container-proxy/proxy-server.ts`: Existing HTTP/WebSocket proxy implementation remains the runtime server.
- `tests/server/container-proxy/manager.test.ts`: Verify missing container is rejected and non-running containers are rejected.
- `tests/server/container-proxy/cli.test.ts`: Verify CLI help and `expose` without `--container` error.
- `README.md`: Document host-side forwarding to existing containers and clarify the command must run on the Linux host.
- Delete `src/server/csm-app.ts` if it is only used by the reverted no-container startup change.

---

### Task 1: Remove no-container CSM startup path

**Files:**
- Modify: `src/server/container-proxy/types.ts`
- Modify: `src/server/container-proxy/manager.ts`
- Modify: `src/index.ts`
- Delete: `src/server/csm-app.ts`
- Test: `tests/server/container-proxy/manager.test.ts`

- [ ] **Step 1: Write the failing manager tests**

Replace `tests/server/container-proxy/manager.test.ts` with:

```ts
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainerProxyManager } from '../../../src/server/container-proxy/manager';
import type { ContainerInfo } from '../../../src/server/container-proxy/types';

class FakeDockerClient {
  constructor(private container: ContainerInfo) {}

  async inspectContainer(): Promise<ContainerInfo> {
    return this.container;
  }
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'csm-proxy-manager-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('ContainerProxyManager', () => {
  it('requires a container name for expose', async () => {
    const manager = new ContainerProxyManager(new FakeDockerClient({
      id: 'unused',
      name: 'unused',
      state: 'running',
      ipAddress: '127.0.0.1',
    }));

    await expect(manager.expose({
      host: '127.0.0.1',
      targetPort: 9090,
      portRange: { start: 19300, end: 19302 },
      dataDir: dir,
    })).rejects.toThrow('Missing required --container for expose');
  });

  it('rejects containers that are not running', async () => {
    const manager = new ContainerProxyManager(new FakeDockerClient({
      id: 'abc123',
      name: 'csm-alice',
      state: 'exited',
      ipAddress: '127.0.0.1',
    }));

    await expect(manager.expose({
      containerName: 'csm-alice',
      host: '127.0.0.1',
      targetPort: 9090,
      portRange: { start: 19310, end: 19312 },
      dataDir: dir,
    })).rejects.toThrow('Docker container is not running: csm-alice (exited)');
  });
});
```

- [ ] **Step 2: Run the focused manager test to verify it fails**

Run:

```bash
npm test -- tests/server/container-proxy/manager.test.ts
```

Expected: FAIL because `ExposeOptions` still expects no-container CSM startup fields or `manager.expose()` starts CSM instead of rejecting missing `containerName`.

- [ ] **Step 3: Update types to remove CSM app coupling**

In `src/server/container-proxy/types.ts`, ensure the file contains no import from `../csm-app`, remove `StartedCsmResult`, and keep `ExposeOptions` as:

```ts
export interface ExposeOptions {
  containerName?: string;
  host: string;
  targetPort: number;
  portRange: PortRange;
  dataDir: string;
}
```

- [ ] **Step 4: Update manager to require a container and only start the proxy**

In `src/server/container-proxy/manager.ts`, remove `startCsmApp` imports and make `expose()` return only `ProxyRecord`:

```ts
async expose(options: ExposeOptions): Promise<ProxyRecord> {
  if (!options.containerName) {
    throw new Error('Missing required --container for expose');
  }

  const container = await this.docker.inspectContainer(options.containerName);
  if (container.state !== 'running') {
    throw new Error(`Docker container is not running: ${options.containerName} (${container.state})`);
  }

  const registry = new ProxyRegistry(options.dataDir);
  const hostPort = await findAvailablePort(options.portRange, options.host);

  await startContainerProxy({
    host: options.host,
    hostPort,
    targetHost: container.ipAddress,
    targetPort: options.targetPort,
  });

  const record: ProxyRecord = {
    id: randomUUID(),
    containerId: container.id,
    containerName: container.name,
    containerIp: container.ipAddress,
    host: options.host,
    hostPort,
    targetPort: options.targetPort,
    url: browserUrl(options.host, hostPort),
    createdAt: Date.now(),
    status: 'running',
  };

  registry.save(record);
  return record;
}
```

- [ ] **Step 5: Restore `src/index.ts` to standalone CSM startup**

Remove `startCsmApp` / `stopCsmApp` imports. Restore the original direct imports and startup flow:

```ts
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createHttpServer } from './server/http-server';
import { SessionManager } from './server/session/manager';
import { MemoryService } from './server/memory/service';
```

Ensure `main()` creates `MemoryService`, `SessionManager`, calls `createHttpServer()`, then `server.listen()` as before.

- [ ] **Step 6: Delete the unused reusable CSM app module**

Run:

```bash
rm src/server/csm-app.ts
```

Expected: file is removed because host-side proxy must not import CSM server/session modules.

- [ ] **Step 7: Run manager test to verify it passes**

Run:

```bash
npm test -- tests/server/container-proxy/manager.test.ts
```

Expected: PASS, 2 tests passed.

---

### Task 2: Make CLI require `--container` and avoid CSM options

**Files:**
- Modify: `src/container-proxy.ts`
- Test: `tests/server/container-proxy/cli.test.ts`

- [ ] **Step 1: Write CLI tests for required container**

Update `tests/server/container-proxy/cli.test.ts` so the suite contains:

```ts
import { execFile } from 'child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('node', ['dist/container-proxy.js', ...args], (error, stdout, stderr) => {
      resolve({
        code: typeof (error as { code?: number } | null)?.code === 'number' ? (error as { code: number }).code : 0,
        stdout,
        stderr,
      });
    });
  });
}

describe('csm-proxy CLI', () => {
  it('prints help', async () => {
    const result = await runCli(['help']);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('csm-proxy expose --container <name>');
  });

  it('rejects expose without a container', async () => {
    const result = await runCli(['expose']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Missing required --container for expose');
  });

  it('rejects unknown options', async () => {
    const result = await runCli(['expose', '--unknown']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown option: --unknown');
  });

  it('rejects missing option values', async () => {
    const result = await runCli(['expose', '--container']);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Missing value for --container');
  });
});
```

- [ ] **Step 2: Build and run the CLI tests to verify they fail before code changes**

Run:

```bash
npm run build && npm test -- tests/server/container-proxy/cli.test.ts
```

Expected: FAIL if help still advertises no-container mode or CLI still accepts no-container CSM startup.

- [ ] **Step 3: Simplify CLI options**

In `src/container-proxy.ts`, remove `claudePath` and `auth` from `CliOptions`, `parseArgs()`, and `manager.expose()` calls. Keep only:

```ts
interface CliOptions {
  command: string;
  containerName?: string;
  host: string;
  dataDir: string;
  targetPort: number;
  portRange: PortRange;
}
```

- [ ] **Step 4: Update help text**

Set `printHelp()` to:

```ts
function printHelp(): void {
  console.log(`Usage:
  csm-proxy expose --container <name> [--port-range 9100-9199] [--host 0.0.0.0]
  csm-proxy list [--data-dir ~/.csm]

Examples:
  csm-proxy expose --container csm-alice
  csm-proxy expose --container csm-bob --port-range 9200-9299
`);
}
```

- [ ] **Step 5: Simplify expose output**

Because `manager.expose()` returns only `ProxyRecord`, replace the result branch with:

```ts
console.log(`Container: ${result.containerName}`);
console.log(`Target: ${result.containerIp}:${result.targetPort}`);
console.log(`Host port: ${result.hostPort}`);
console.log(`Open: ${result.url}`);
console.log('Proxy process is running in the foreground. Stop it with Ctrl-C, or run it under systemd/tmux if it should stay alive after logout.');
```

- [ ] **Step 6: Run build and CLI tests**

Run:

```bash
npm run build && npm test -- tests/server/container-proxy/cli.test.ts
```

Expected: PASS, 4 tests passed.

---

### Task 3: Update README for host-side forwarding only

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace no-container wording**

In `README.md`, in the `### 暴露已有容器的 9090 端口` section, remove text that says `csm-proxy expose` without `--container` starts CSM or prints an available port.

Use this wording:

```markdown
`csm-proxy` 运行在 Linux 宿主机上，不运行在 CSM 容器内部。CSM 仍然在各自容器内监听 `9090`；宿主机上的 `csm-proxy` 只负责分配一个主机端口，并把该端口转发到指定容器的 `9090`。

```bash
npm run build
csm-proxy expose --container csm-alice
```
```

- [ ] **Step 2: Ensure output example only shows container mode**

The README output example should be:

```text
Container: csm-alice
Target: 172.17.0.2:9090
Host port: 9137
Open: http://SERVER_IP:9137
Proxy process is running in the foreground. Stop it with Ctrl-C, or run it under systemd/tmux if it should stay alive after logout.
```

- [ ] **Step 3: Add host requirement note**

Add this paragraph after the output example:

```markdown
如果在普通容器内部运行 `csm-proxy`，它只能绑定该容器自己的网络命名空间，不能直接占用 Linux 宿主机端口。因此用于分配宿主机访问端口的 `csm-proxy` 应在 Linux 宿主机上执行。
```

- [ ] **Step 4: Check README for stale no-container wording**

Run:

```bash
grep -n "不指定容器\|No container\|直接启动一份 CSM\|只会从端口池" README.md
```

Expected: no output.

---

### Task 4: Verify proxy is isolated from CSM native dependencies

**Files:**
- Verify: `src/container-proxy.ts`
- Verify: `src/server/container-proxy/*.ts`

- [ ] **Step 1: Search for forbidden imports**

Run:

```bash
grep -R "csm-app\|http-server\|session/\|node-pty\|MemoryService\|SessionManager" src/container-proxy.ts src/server/container-proxy
```

Expected: no output.

- [ ] **Step 2: Run focused proxy tests**

Run:

```bash
npm test -- tests/server/container-proxy
```

Expected: PASS, all container proxy test files pass.

- [ ] **Step 3: Build the project**

Run:

```bash
npm run build
```

Expected: PASS, `tsc` and frontend build complete.

- [ ] **Step 4: Test proxy entrypoint does not load `node-pty` when printing help**

Run:

```bash
node dist/container-proxy.js help
```

Expected: exit 0 and help text prints without `Failed to load native module: pty.node`.

---

## Self-Review

- Spec coverage: The plan keeps CSM inside containers, makes host-side `csm-proxy` only forward to existing containers, requires `--container`, and removes no-container CSM startup.
- Placeholder scan: No TBD/TODO/placeholders remain.
- Type consistency: `ExposeOptions` no longer contains `claudePath` or `auth`; `manager.expose()` returns `ProxyRecord`; CLI output uses `ProxyRecord` fields.
