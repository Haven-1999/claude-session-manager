// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tunnel;

use std::sync::Mutex;
use tauri::command;
use tauri_utils::config::WebviewUrl;

#[command]
fn open_settings(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.close();
    if let Some(existing) = app.get_webview_window("csm") {
        let _ = existing.close();
    }
    tauri::WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .title("Claude Session Manager")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn open_csm_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("csm") {
        let _ = existing.close();
    }
    let parsed: tauri::Url = url.parse().map_err(|e| e.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, "csm", WebviewUrl::External(parsed))
        .title("Claude Session Manager")
        .inner_size(1200.0, 800.0)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn close_window(window: tauri::WebviewWindow) -> Result<(), String> {
    window.close().map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
