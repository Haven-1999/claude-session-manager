// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tunnel;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::command;
use tauri::Manager;

#[command]
fn open_settings(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.close();
    if let Some(existing) = app.get_webview_window("csm") {
        let _ = existing.close();
    }
    tauri::WebviewWindowBuilder::new(
        &app, "main", tauri::WebviewUrl::App(PathBuf::from("index.html")))
        .title("Claude Session Manager")
        .inner_size(1200.0, 800.0)
        .devtools(true)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn open_csm_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    println!("[TAURI] open_csm_window called with url: {}", url);
    if let Some(existing) = app.get_webview_window("csm") {
        println!("[TAURI] Closing existing csm window");
        let _ = existing.close();
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    println!("[TAURI] Parsed URL: {:?}", parsed);
    let win = tauri::WebviewWindowBuilder::new(&app, "csm", tauri::WebviewUrl::External(parsed))
        .title("Claude Session Manager")
        .inner_size(1200.0, 800.0)
        .devtools(true)
        .build()
        .map_err(|e| e.to_string())?;
    println!("[TAURI] Created csm window with label: {:?}", win.label());
    Ok(())
}

#[command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn request_attention() {
    // Dock bounce (best-effort)
    // macOS native notification via osascript — works even when Tauri is backgrounded
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(r#"display notification "Claude has finished replying." with title "Claude Session Manager""#)
        .spawn();
}

fn main() {
    let app = tauri::Builder::default()
        .manage(tunnel::TunnelState {
            child: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::save_config,
            tunnel::start_tunnel,
            tunnel::stop_tunnel,
            tunnel::check_connection,
            open_settings,
            open_csm_window,
            close_window,
            request_attention,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<tunnel::TunnelState>();
                tunnel::kill_tunnel(&state);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        match event {
            tauri::RunEvent::Ready => {
                println!("[TAURI] App ready, checking config...");
                if let Some(cfg) = config::get_config(app_handle.clone()) {
                    println!("[TAURI] Config found, auto-starting tunnel to {}:{} -> localhost:{}",
                        cfg.ssh_host, cfg.remote_csm_port, cfg.local_port);
                    let app_clone = app_handle.clone();
                    let cfg_clone = cfg.clone();
                    let local_port = cfg.local_port;
                    std::thread::spawn(move || {
                        let state = app_clone.state::<tunnel::TunnelState>();
                        match tunnel::start_tunnel_inner(&cfg_clone, &*state, &app_clone) {
                            Ok(_) => {
                                println!("[TAURI] Tunnel started, waiting for port {} to be ready...", local_port);
                                for i in 0..30 {
                                    if tunnel::check_connection(local_port) {
                                        println!("[TAURI] Port ready, opening CSM window");
                                        let url = format!("http://localhost:{}", local_port);
                                        let _ = open_csm_window(app_clone, url);
                                        return;
                                    }
                                    std::thread::sleep(std::time::Duration::from_millis(500));
                                }
                                println!("[TAURI] Port {} did not become ready in 15s", local_port);
                            }
                            Err(e) => {
                                println!("[TAURI] Auto-start tunnel failed: {}", e);
                            }
                        }
                    });
                } else {
                    println!("[TAURI] No config found, staying on setup page");
                }
            }
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<tunnel::TunnelState>();
                tunnel::kill_tunnel(&state);
            }
            _ => {}
        }
    });
}
