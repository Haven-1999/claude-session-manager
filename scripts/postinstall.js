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

function main() {
  if (!fs.existsSync(nodePtyDir)) return;
  if (isCI) return;
  if (process.platform === 'win32') return;

  log('Verifying node-pty native module...');

  if (testNodePty()) {
    log('node-pty: OK');
    return;
  }

  warn('node-pty prebuilt binary not working, rebuilding from source...');

  if (!hasBuildTools()) {
    error('Build tools not found!');
    if (process.platform === 'darwin') {
      error('Please run: xcode-select --install');
    } else {
      error('Please install gcc and make');
    }
    error('Then re-run: npm install');
    process.exit(1);
  }

  try {
    execSync('npm rebuild node-pty', {
      stdio: 'inherit',
      cwd: path.join(__dirname, '..'),
      timeout: 120000,
    });
  } catch (e) {
    error(`Rebuild failed: ${e.message}`);
    error('Try: nvm install 20 && nvm use 20 && rm -rf node_modules && npm install');
    error('Or run: bash scripts/setup.sh');
    process.exit(1);
  }

  if (testNodePty()) {
    log('node-pty rebuilt and verified: OK');
  } else {
    error('node-pty still not working after rebuild.');
    error('Your Node.js version may be incompatible with node-pty.');
    error('Fix: nvm install 20 && nvm use 20 && rm -rf node_modules && npm install');
    error('Or run: bash scripts/setup.sh (auto-switches Node version)');
    process.exit(1);
  }
}

main();
