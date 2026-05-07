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
    if let Some(_existing) = app.get_webview_window("csm") {
        println!("[TAURI] Existing csm window found, skipping");
        return Ok(());
    }
    let parsed = tauri::Url::parse(&url).map_err(|e| e.to_string())?;
    println!("[TAURI] Parsed URL: {:?}", parsed);
    let win = tauri::WebviewWindowBuilder::new(&app, "csm", tauri::WebviewUrl::External(parsed))
        .title("Claude Session Manager")
        .inner_size(1200.0, 800.0)
        .devtools(true)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.show();
    let _ = win.set_focus();
    println!("[TAURI] Created csm window with label: {:?}", win.label());
    Ok(())
}

#[command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn test_http(url: String) -> Result<String, String> {
    println!("[TAURI] test_http called with url: {}", url);
    match std::process::Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", &url])
        .output()
    {
        Ok(output) => {
            let code = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            println!("[TAURI] test_http curl result: code={}, stderr={}", code, stderr);
            Ok(format!("HTTP {}", code))
        }
        Err(e) => {
            println!("[TAURI] test_http curl failed: {}", e);
            Err(format!("curl failed: {}", e))
        }
    }
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
            monitor_running: Mutex::new(false),
            config: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            config::get_config,
            config::save_config,
            tunnel::start_tunnel,
            tunnel::stop_tunnel,
            tunnel::check_connection,
            tunnel::start_tunnel_monitor,
            open_settings,
            open_csm_window,
            close_window,
            request_attention,
            test_http,
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
                println!("[TAURI] App ready, staying on setup page");
            }
            tauri::RunEvent::Exit => {
                let state = app_handle.state::<tunnel::TunnelState>();
                tunnel::kill_tunnel(&state);
            }
            _ => {}
        }
    });
}
