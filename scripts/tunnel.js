#!/usr/bin/env node
/**
 * CSM Tunnel Manager - Lightweight SSH tunnel daemon for Claude Session Manager
 *
 * Usage:
 *   node scripts/tunnel.js start    # foreground mode (logs to console)
 *   node scripts/tunnel.js daemon   # background mode (logs to ~/.csm/tunnel.log)
 *   node scripts/tunnel.js stop     # stop running tunnel
 *   node scripts/tunnel.js status   # show tunnel status
 *   node scripts/tunnel.js config   # interactive config setup
 */

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const CSM_DIR = path.join(os.homedir(), '.csm');
const CONFIG_PATH = path.join(CSM_DIR, 'tunnel.json');
const LOG_PATH = path.join(CSM_DIR, 'tunnel.log');
const PID_PATH = path.join(CSM_DIR, 'tunnel.pid');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch {}
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  if (!fs.existsSync(CSM_DIR)) fs.mkdirSync(CSM_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function expandHome(p) {
  if (p && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ask(question) {
  return new Promise((resolve) => {
    process.stdout.write(question + ' ');
    process.stdin.once('data', (data) => resolve(data.toString().trim()));
  });
}

async function setupConfig() {
  const config = loadConfig() || {};
  const host = await ask(`SSH Host${config.ssh_host ? ` [${config.ssh_host}]` : ''}:`);
  if (host) config.ssh_host = host;
  const user = await ask(`SSH User${config.ssh_user ? ` [${config.ssh_user}]` : ''}:`);
  if (user) config.ssh_user = user;
  const port = await ask(`SSH Port [${config.ssh_port || 22}]:`);
  if (port) config.ssh_port = parseInt(port, 10);
  const remote = await ask(`Remote CSM Port [${config.remote_csm_port || 8080}]:`);
  if (remote) config.remote_csm_port = parseInt(remote, 10);
  const local = await ask(`Local Port [${config.local_port || 18080}]:`);
  if (local) config.local_port = parseInt(local, 10);
  const identity = await ask(`Identity File [${config.identity_file || '~/.ssh/id_rsa'}]:`);
  if (identity) config.identity_file = identity;

  saveConfig(config);
  log('Config saved to ' + CONFIG_PATH);
  process.exit(0);
}

function buildSshArgs(config) {
  const args = [
    '-N',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'TCPKeepAlive=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-L', `${config.local_port}:localhost:${config.remote_csm_port}`,
    '-p', String(config.ssh_port || 22),
  ];
  if (config.identity_file) {
    args.push('-i', expandHome(config.identity_file));
  }
  args.push(`${config.ssh_user}@${config.ssh_host}`);
  return args;
}

function httpHealthCheck(port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/sessions',
      method: 'HEAD',
      timeout: 3000,
    }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 401);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function killProcessOnPort(port) {
  return new Promise((resolve) => {
    exec(`lsof -ti :${port}`, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(); return; }
      const pids = stdout.trim().split('\n');
      let done = 0;
      for (const pid of pids) {
        exec(`kill -9 ${pid}`, () => {
          done++;
          if (done >= pids.length) resolve();
        });
      }
    });
  });
}

async function runTunnel(config) {
  let ssh = null;
  let consecutiveFailures = 0;
  let rebuildDelay = 2000;

  async function startSsh() {
    if (await httpHealthCheck(config.local_port)) {
      log(`Port ${config.local_port} is healthy, reusing existing tunnel.`);
      return;
    }

    log(`Port ${config.local_port} is not healthy, rebuilding tunnel...`);
    await killProcessOnPort(config.local_port);

    if (ssh) {
      try { ssh.kill('SIGKILL'); } catch {}
      ssh = null;
    }

    const args = buildSshArgs(config);
    log(`Starting SSH: ssh ${args.join(' ')}`);
    ssh = spawn('ssh', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });

    let stderrBuf = '';
    ssh.stderr.on('data', (d) => { stderrBuf += d; });

    await new Promise((r) => setTimeout(r, 1000));

    if (ssh.exitCode !== null || ssh.signalCode) {
      const hint = stderrBuf.includes('Address already in use')
        ? 'Local port is still occupied after cleanup. Try changing the Local Port in Settings (e.g., 18081).'
        : stderrBuf.includes('Connection refused')
        ? 'Remote SSH server refused the connection. Check SSH Host and Port.'
        : stderrBuf.includes('Permission denied') || stderrBuf.includes('authentication')
        ? 'SSH authentication failed. Check your SSH key or user name.'
        : '';
      log(`SSH exited immediately. ${hint}`);
      throw new Error(`SSH tunnel exited immediately. ${stderrBuf} ${hint}`);
    }

    log('SSH tunnel process started');
  }

  await startSsh();

  // Write PID file
  fs.writeFileSync(PID_PATH, String(process.pid));

  // Health check loop
  const interval = setInterval(async () => {
    if (!ssh) return;
    const ok = await httpHealthCheck(config.local_port);
    if (ok) {
      if (consecutiveFailures > 0) {
        log('Tunnel health check recovered');
      }
      consecutiveFailures = 0;
      rebuildDelay = 2000;
      return;
    }

    consecutiveFailures++;
    log(`Tunnel health check failed (${consecutiveFailures}/2)`);

    if (consecutiveFailures >= 2) {
      log('Tunnel deemed dead, auto-rebuilding...');
      consecutiveFailures = 0;
      await new Promise((r) => setTimeout(r, rebuildDelay));
      try {
        await startSsh();
        log('Tunnel rebuilt successfully');
        rebuildDelay = 2000;
      } catch (e) {
        log(`Tunnel rebuild failed: ${e.message}`);
        rebuildDelay = Math.min(rebuildDelay * 2, 60000);
      }
    }
  }, 10000);

  // Cleanup on exit
  function cleanup() {
    clearInterval(interval);
    if (ssh) {
      try { ssh.kill('SIGKILL'); } catch {}
    }
    try { fs.unlinkSync(PID_PATH); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);
}

function startDaemon(config) {
  const out = fs.openSync(LOG_PATH, 'a');
  const err = fs.openSync(LOG_PATH, 'a');
  const child = spawn(process.argv[0], [__filename, 'start'], {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();
  fs.writeFileSync(PID_PATH, String(child.pid));
  console.log(`Tunnel daemon started (PID ${child.pid}). Logs: ${LOG_PATH}`);
  process.exit(0);
}

function stopTunnel() {
  try {
    const pid = fs.readFileSync(PID_PATH, 'utf8').trim();
    try {
      process.kill(parseInt(pid, 10), 'SIGTERM');
    } catch (e) {
      console.log('No tunnel process found.');
    }
    fs.unlinkSync(PID_PATH);
    console.log('Tunnel stopped.');
  } catch {
    console.log('No tunnel PID file found.');
  }
  process.exit(0);
}

function showStatus() {
  try {
    const pid = fs.readFileSync(PID_PATH, 'utf8').trim();
    try {
      process.kill(parseInt(pid, 10), 0);
      console.log(`Tunnel is running (PID ${pid})`);
    } catch {
      console.log('Tunnel PID file exists but process is dead.');
    }
  } catch {
    console.log('Tunnel is not running.');
  }
  process.exit(0);
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === 'config') {
    await setupConfig();
    return;
  }

  if (cmd === 'status') {
    showStatus();
    return;
  }

  if (cmd === 'stop') {
    stopTunnel();
    return;
  }

  if (cmd === 'daemon') {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: node scripts/tunnel.js config');
      process.exit(1);
    }
    startDaemon(config);
    return;
  }

  if (cmd === 'start' || !cmd) {
    const config = loadConfig();
    if (!config) {
      console.error('No config found. Run: node scripts/tunnel.js config');
      process.exit(1);
    }
    log('CSM Tunnel Manager starting...');
    await runTunnel(config);
    return;
  }

  console.log(`Unknown command: ${cmd}`);
  console.log('Usage: node scripts/tunnel.js [start|daemon|stop|status|config]');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
