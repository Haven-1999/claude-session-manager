use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{command, AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub ssh_host: String,
    pub ssh_user: String,
    pub ssh_port: u16,
    pub remote_csm_port: u16,
    pub local_port: u16,
    pub identity_file: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            ssh_host: String::new(),
            ssh_user: String::new(),
            ssh_port: 22,
            remote_csm_port: 8080,
            local_port: 18080,
            identity_file: None,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to get config dir: {}", e))?;
    Ok(dir.join("config.json"))
}

#[command]
pub fn get_config(app: AppHandle) -> Option<AppConfig> {
    let path = config_path(&app).ok()?;
    if !path.exists() {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

#[command]
pub fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())?;
    Ok(())
}
