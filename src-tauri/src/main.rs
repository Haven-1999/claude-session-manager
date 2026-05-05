// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tunnel;

use std::sync::Mutex;
use tauri::command;

#[command]
fn open_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .navigate("tauri://localhost/index.html".parse().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn navigate_to_url(window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    window
        .navigate(url.parse().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
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
            navigate_to_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
