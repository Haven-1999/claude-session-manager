#!/usr/bin/env node
'use strict';

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const isCI = process.env.CI === 'true' || process.env.CI === '1';
const nodePtyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');

function log(msg) { console.log(`\x1b[36m[postinstall]\x1b[0m ${msg}`); }
function warn(msg) { console.warn(`\x1b[33m[postinstall]\x1b[0m ${msg}`); }
function error(msg) { console.error(`\x1b[31m[postinstall]\x1b[0m ${msg}`); }

function testNodePty() {
  const result = spawnSync(process.execPath, [
    '-e',
    "const pty=require('node-pty');const p=pty.spawn('/bin/echo',['ok']);p.onData(()=>{});setTimeout(()=>{p.kill();process.exit(0)},500);",
  ], { timeout: 5000, stdio: 'pipe', cwd: path.join(__dirname, '..') });
  return result.status === 0;
}

function hasBuildTools() {
  if (process.platform === 'darwin') {
    return spawnSync('xcode-select', ['-p'], { stdio: 'pipe' }).status === 0;
  }
  return spawnSync('which', ['gcc'], { stdio: 'pipe' }).status === 0;
}

function hasPythonFallback() {
  const result = spawnSync('python3', [
    '-c', 'import pty,os;m,s=pty.openpty();os.close(m);os.close(s);print("ok")',
  ], { timeout: 5000, stdio: 'pipe' });
  return result.status === 0 && result.stdout?.toString().trim() === 'ok';
}

function main() {
  if (isCI) return;
  if (process.platform === 'win32') return;

  // Rebuild better-sqlite3 if needed
  const sqliteDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
  if (fs.existsSync(sqliteDir)) {
    const sqliteResult = spawnSync(process.execPath, [
      '-e', "require('better-sqlite3')",
    ], { timeout: 5000, stdio: 'pipe', cwd: path.join(__dirname, '..') });
    if (sqliteResult.status !== 0) {
      log('Rebuilding better-sqlite3...');
      try {
        execSync('npm rebuild better-sqlite3', {
          stdio: 'inherit', cwd: path.join(__dirname, '..'), timeout: 120000,
        });
      } catch {
        error('Failed to rebuild better-sqlite3. Run: npm rebuild better-sqlite3');
      }
    }
  }

  if (!fs.existsSync(nodePtyDir)) return;

  log('Verifying node-pty native module...');

  if (testNodePty()) {
    log('node-pty: OK');
    return;
  }

  warn('node-pty prebuilt binary not working, attempting rebuild...');

  if (hasBuildTools()) {
    try {
      execSync('npm rebuild node-pty', {
        stdio: 'inherit',
        cwd: path.join(__dirname, '..'),
        timeout: 120000,
      });
    } catch (e) {
      // rebuild failed, continue to fallback check
    }

    if (testNodePty()) {
      log('node-pty rebuilt and verified: OK');
      return;
    }
  }

  // node-pty doesn't work - check if Python fallback is available
  if (hasPythonFallback()) {
    warn('node-pty unavailable, but Python PTY fallback is ready.');
    warn('The server will work normally using python3 for PTY allocation.');
    return; // Don't exit(1) - fallback is fine
  }

  // Neither works
  error('node-pty failed and python3 PTY fallback not available.');
  error('Please install python3, or fix node-pty:');
  error('  Option 1: Install python3 (macOS: already included, Linux: apt install python3)');
  error('  Option 2: bash scripts/setup.sh (auto-fixes node-pty)');
  error('  Option 3: nvm install 20 && nvm use 20 && rm -rf node_modules && npm install');
  process.exit(1);
}

main();
