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

fn kill_child_group(child: &mut Child) {
    let pid = child.id() as i32;
    let _ = child.kill();
    let _ = child.wait();
    // Ensure the entire process group is terminated (SSH may fork children)
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
}

pub fn kill_tunnel(state: &TunnelState) {
    let mut guard = state.child.lock().unwrap();
    if let Some(mut child) = guard.take() {
        kill_child_group(&mut child);
    }
}

fn kill_process_on_port(port: u16) {
    let output = std::process::Command::new("lsof")
        .args(["-ti", &format!(":{}", port)])
        .output();
    if let Ok(out) = output {
        let pids = String::from_utf8_lossy(&out.stdout);
        for pid in pids.lines().filter(|s| !s.is_empty()) {
            let _ = std::process::Command::new("kill")
                .args(["-9", pid])
                .status();
        }
    }
}

pub fn start_tunnel_inner(
    config: &AppConfig,
    state: &TunnelState,
    app: &AppHandle,
) -> Result<(), String> {
    // 1. If the port is already reachable, reuse the existing tunnel
    if check_connection(config.local_port) {
        println!("[TAURI] Port {} is already reachable, reusing existing tunnel.", config.local_port);
        return Ok(());
    }

    // 2. Stop any tunnel tracked by our own state
    {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            kill_child_group(&mut child);
        }
    }

    // 3. Aggressively clear any stale process holding the local port
    kill_process_on_port(config.local_port);
    std::thread::sleep(Duration::from_millis(300));

    let log_path = ssh_log_path(app);
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

    if let Some(identity) = &config.identity_file {
        if !identity.is_empty() {
            cmd.arg("-i").arg(identity);
        }
    }

    cmd.arg(format!("{}@{}", config.ssh_user, config.ssh_host));
    cmd.stdout(Stdio::null()).stderr(Stdio::from(log_file));

    // Run SSH in its own process group so we can kill the whole tree
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }

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
                let hint = if log_content.contains("Address already in use") {
                    "Local port is still occupied after cleanup. Try changing the Local Port in Settings (e.g., 18081)."
                } else if log_content.contains("Connection refused") {
                    "Remote SSH server refused the connection. Check SSH Host and Port."
                } else if log_content.contains("Permission denied") || log_content.contains("authentication") {
                    "SSH authentication failed. Check your SSH key (Identity File) or user name."
                } else {
                    ""
                };
                return Err(format!(
                    "SSH tunnel exited immediately (status: {}).\nLog:\n{}\n{}",
                    status, log_content, hint
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("Failed to check tunnel status: {}", e)),
        }
    }

    Ok(())
}

#[command]
pub fn start_tunnel(
    config: AppConfig,
    state: State<TunnelState>,
    app: AppHandle,
) -> Result<(), String> {
    start_tunnel_inner(&config, &state, &app)
}

#[command]
pub fn stop_tunnel(state: State<TunnelState>) -> Result<(), String> {
    kill_tunnel(&state);
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
