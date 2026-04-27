// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod tunnel;

use std::sync::Mutex;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
