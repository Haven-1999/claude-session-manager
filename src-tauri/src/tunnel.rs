use crate::config::AppConfig;
use std::fs::File;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{command, AppHandle, Manager, State};

pub struct TunnelState {
    pub child: Mutex<Option<Child>>,
}

fn ssh_log_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_log_dir()
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
        .join("csm-ssh.log")
}

#[command]
pub fn start_tunnel(
    config: AppConfig,
    state: State<TunnelState>,
    app: AppHandle,
) -> Result<(), String> {
    // Stop any existing tunnel first
    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }

    let log_path = ssh_log_path(&app);
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let log_file = File::create(&log_path)
        .map_err(|e| format!("Failed to create ssh log file: {}", e))?;

    let mut cmd = Command::new("ssh");
    cmd.arg("-N")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-L")
        .arg(format!(
            "{}:localhost:{}",
            config.local_port, config.remote_csm_port
        ))
        .arg("-p")
        .arg(config.ssh_port.to_string());

    if let Some(identity) = config.identity_file {
        if !identity.is_empty() {
            cmd.arg("-i").arg(identity);
        }
    }

    cmd.arg(format!("{}@{}", config.ssh_user, config.ssh_host));
    cmd.stdout(Stdio::null()).stderr(Stdio::from(log_file));

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ssh tunnel: {}", e))?;

    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);

    // Wait briefly then verify the process did not exit immediately
    std::thread::sleep(Duration::from_secs(1));
    if let Some(ref mut c) = *guard {
        match c.try_wait() {
            Ok(Some(status)) => {
                let log_content = std::fs::read_to_string(&log_path).unwrap_or_default();
                return Err(format!(
                    "SSH tunnel exited immediately (status: {}). Log:\n{}",
                    status, log_content
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to check tunnel status: {}", e)),
        }
    }

    Ok(())
}

#[command]
pub fn stop_tunnel(state: State<TunnelState>) -> Result<(), String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
    }
    Ok(())
}

#[command]
pub fn check_connection(local_port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", local_port);
    TcpStream::connect_timeout(
        &addr.parse().expect("valid socket addr"),
        Duration::from_secs(2),
    )
    .is_ok()
}
