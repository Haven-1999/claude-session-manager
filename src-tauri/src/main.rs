// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tunnel;

use std::sync::Mutex;
use tauri::command;

#[command]
fn open_settings(window: tauri::WebviewWindow) -> Result<(), String> {
    let js = r#"
        (function() {
            const frame = document.getElementById('app-frame');
            const form = document.getElementById('setup-form');
            if (frame && form) {
                frame.style.display = 'none';
                frame.src = '';
                form.style.display = 'block';
            }
        })();
    "#;
    window.eval(js).map_err(|e| e.to_string())?;
    Ok(())
}

#[command]
fn navigate_to_url(_window: tauri::WebviewWindow, url: String) -> Result<(), String> {
    println!("[navigate_to_url] target={} — iframe handles this now", url);
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
