import { invoke } from 'https://esm.sh/@tauri-apps/api@2.0.0/core';
import { getCurrentWebviewWindow } from 'https://esm.sh/@tauri-apps/api@2.0.0/webviewWindow';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const connectBtn = $('connect-btn');

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

function clearStatus() {
  statusEl.className = 'status';
  statusEl.textContent = '';
}

function getFormData() {
  return {
    ssh_host: $('host').value.trim(),
    ssh_user: $('user').value.trim(),
    ssh_port: parseInt($('ssh-port').value, 10) || 22,
    remote_csm_port: parseInt($('remote-port').value, 10) || 8080,
    local_port: parseInt($('local-port').value, 10) || 18080,
    identity_file: $('identity').value.trim() || null,
  };
}

function setFormData(config) {
  if (config.ssh_host) $('host').value = config.ssh_host;
  if (config.ssh_user) $('user').value = config.ssh_user;
  if (config.ssh_port) $('ssh-port').value = config.ssh_port;
  if (config.remote_csm_port) $('remote-port').value = config.remote_csm_port;
  if (config.local_port) $('local-port').value = config.local_port;
  if (config.identity_file) $('identity').value = config.identity_file;
}

async function loadExistingConfig() {
  try {
    const config = await invoke('get_config');
    if (config) {
      setFormData(config);
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }
}

async function doConnect(config) {
  clearStatus();
  connectBtn.disabled = true;
  showStatus('Saving configuration...', 'loading');
  console.log('[SETUP] Step 1: save_config', config);

  try {
    await invoke('save_config', { config });
    console.log('[SETUP] save_config OK');
  } catch (e) {
    console.error('[SETUP] save_config failed:', e);
    showStatus('Failed to save config: ' + e, 'error');
    connectBtn.disabled = false;
    return;
  }

  showStatus('Starting SSH tunnel...', 'loading');
  try {
    await invoke('start_tunnel', { config });
    console.log('[SETUP] start_tunnel OK');
  } catch (e) {
    console.error('[SETUP] start_tunnel failed:', e);
    showStatus('Failed to start tunnel: ' + e, 'error');
    connectBtn.disabled = false;
    return;
  }

  showStatus('Waiting for tunnel...', 'loading');
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    const ok = await invoke('check_connection', { localPort: config.local_port });
    console.log('[SETUP] check_connection attempt', i + 1, '=>', ok);
    if (ok) {
      showStatus('Connected! Opening CSM...', 'success');
      const csmUrl = 'http://localhost:' + config.local_port;
      console.log('[SETUP] Step 4: open_csm_window', csmUrl);
      try {
        await invoke('open_csm_window', { url: csmUrl });
        console.log('[SETUP] open_csm_window OK');
        const current = getCurrentWebviewWindow();
        await current.close();
      } catch (e) {
        console.error('[SETUP] Failed to open CSM window:', e);
        showStatus('Failed to open CSM window: ' + e, 'error');
        connectBtn.disabled = false;
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  showStatus('Tunnel failed to become ready within 30s. Check your SSH config.', 'error');
  connectBtn.disabled = false;
}

connectBtn.addEventListener('click', async () => {
  const config = getFormData();
  if (!config.ssh_host || !config.ssh_user) {
    showStatus('SSH Host and User are required.', 'error');
    return;
  }
  await doConnect(config);
});

loadExistingConfig();
