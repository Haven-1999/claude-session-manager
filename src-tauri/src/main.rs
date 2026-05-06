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
        if let tauri::RunEvent::Exit = event {
            let state = app_handle.state::<tunnel::TunnelState>();
            tunnel::kill_tunnel(&state);
        }
    });
}
