// Desktop shell for the PDF suite.
//
// It carries no document logic: the same web UI runs inside it, and every
// operation still happens on this machine. What the shell adds, as Phase 2 and 3
// land, is the work a browser cannot do — native Tesseract for batch folders,
// LibreOffice for Office conversion, and PKCS#11 for USB signing tokens.
//
// There is deliberately no HTTP capability. docs/PRIVACY.md allows exactly four
// network calls and none of them are implemented yet, so the shell cannot make
// any. Adding one means an ADR and a line in that table, not just a plugin.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

/// Reads a document the user chose in a native dialog.
///
/// This is two commands rather than `tauri-plugin-fs` on purpose. The plugin
/// enforces a path scope, which for a document editor would have to be most of
/// the user's home directory — a broad grant that reads as if it were a narrow
/// one. Two commands that do exactly one thing each are a smaller surface to
/// audit, and every path they see came from a dialog the user just clicked.
#[tauri::command]
async fn read_document(path: PathBuf) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))
}

/// Writes a document to the path the user chose.
#[tauri::command]
async fn write_document(path: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn main() {
    tauri::Builder::default()
        // Native open and save dialogs. WKWebView has no File System Access API,
        // so without these the desktop app would fall back to a hidden file
        // input and browser downloads.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_document, write_document])
        .run(tauri::generate_context!())
        .expect("the PDF suite window failed to start");
}
