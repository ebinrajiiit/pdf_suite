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

fn main() {
    tauri::Builder::default()
        // Local file dialogs and local file access, which is how documents get in
        // and out. Scoped by capabilities/default.json.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("the PDF suite window failed to start");
}
