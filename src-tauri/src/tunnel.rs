use crate::config::AppConfig;
use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{command, AppHandle, Emitter, Manager, State};

pub struct TunnelState {
    pub child: Mutex<Option<Child>>,
    pub monitor_running: Mutex<bool>,
    pub config: Mutex<Option<AppConfig>>,
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
    // 1. If the port is healthy, reuse the existing tunnel
    if http_health_check(config.local_port) {
        println!("[TAURI] Port {} is healthy, reusing existing tunnel.", config.local_port);
        return Ok(());
    }

    // 2. Port is not healthy — kill any stale process and rebuild tunnel
    println!("[TAURI] Port {} is not healthy, rebuilding tunnel...", config.local_port);

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
        .arg("ServerAliveCountMax=3")
        .arg("-o")
        .arg("TCPKeepAlive=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=15")
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
    start_tunnel_inner(&config, &state, &app)?;
    // Save config for monitor
    {
        let mut guard = state.config.lock().map_err(|e| e.to_string())?;
        *guard = Some(config);
    }
    Ok(())
}

#[command]
pub fn stop_tunnel(state: State<TunnelState>) -> Result<(), String> {
    stop_monitor(&state);
    kill_tunnel(&state);
    {
        let mut guard = state.config.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }
    Ok(())
}

#[command]
pub fn start_tunnel_monitor(
    state: State<'_, TunnelState>,
    app: AppHandle,
) -> Result<(), String> {
    let config: AppConfig;
    {
        let guard = state.config.lock().map_err(|e| e.to_string())?;
        config = guard.clone().ok_or("No tunnel config found. Connect first.")?;
    }

    // Stop any existing monitor
    stop_monitor(&state);

    // Start new monitor
    {
        let mut guard = state.monitor_running.lock().map_err(|e| e.to_string())?;
        *guard = true;
    }

    std::thread::spawn(move || {
        monitor_tunnel(config, app);
    });

    println!("[TAURI] Tunnel monitor started");
    Ok(())
}

fn http_health_check(local_port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", local_port);
    match TcpStream::connect_timeout(
        &addr.parse().expect("valid socket addr"),
        Duration::from_secs(2),
    ) {
        Ok(mut stream) => {
            let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let req = format!("HEAD /api/sessions HTTP/1.1\r\nHost: localhost:{}\r\nConnection: close\r\n\r\n", local_port);
            if stream.write_all(req.as_bytes()).is_err() {
                return false;
            }
            let mut buf = [0u8; 32];
            match stream.read(&mut buf) {
                Ok(n) if n > 0 => {
                    let response = String::from_utf8_lossy(&buf[..n]);
                    response.contains("HTTP/1.1 200") || response.contains("HTTP/1.1 401")
                }
                _ => false,
            }
        }
        Err(_) => false,
    }
}

#[command]
pub fn check_connection(local_port: u16) -> bool {
    http_health_check(local_port)
}

pub fn monitor_tunnel(
    config: AppConfig,
    app: AppHandle,
) {
    let mut consecutive_failures = 0u32;
    let mut rebuild_delay = 2u64;
    loop {
        std::thread::sleep(Duration::from_secs(10));

        if http_health_check(config.local_port) {
            if consecutive_failures > 0 {
                println!("[TAURI] Tunnel health check recovered");
                let _ = app.emit("tunnel-reconnected", ());
            }
            consecutive_failures = 0;
            rebuild_delay = 2;
            continue;
        }

        consecutive_failures += 1;
        println!("[TAURI] Tunnel health check failed ({}/2)", consecutive_failures);

        if consecutive_failures >= 2 {
            println!("[TAURI] Tunnel deemed dead, auto-rebuilding...");
            let _ = app.emit("tunnel-disconnected", ());
            consecutive_failures = 0;

            let state = app.state::<TunnelState>();
            std::thread::sleep(Duration::from_secs(rebuild_delay));
            match start_tunnel_inner(&config, &state, &app) {
                Ok(()) => {
                    println!("[TAURI] Tunnel rebuilt successfully");
                    let _ = app.emit("tunnel-reconnected", ());
                    rebuild_delay = 2;
                }
                Err(e) => {
                    println!("[TAURI] Tunnel rebuild failed: {}", e);
                    rebuild_delay = std::cmp::min(rebuild_delay * 2, 60);
                }
            }
        }
    }
}

pub fn stop_monitor(state: &TunnelState) {
    let mut guard = state.monitor_running.lock().unwrap();
    *guard = false;
}
