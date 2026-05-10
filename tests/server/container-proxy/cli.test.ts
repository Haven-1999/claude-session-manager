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
