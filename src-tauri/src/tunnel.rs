use crate::config::AppConfig;
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{command, State};

pub struct TunnelState {
    pub child: Mutex<Option<Child>>,
}

#[command]
pub fn start_tunnel(config: AppConfig, state: State<TunnelState>) -> Result<(), String> {
    // Stop any existing tunnel first
    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
        }
    }

    let mut cmd = Command::new("ssh");
    cmd.arg("-N")
        .arg("-o")
        .arg("ServerAliveInterval=30")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
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
    cmd.stdout(Stdio::null()).stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ssh tunnel: {}", e))?;

    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);

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
