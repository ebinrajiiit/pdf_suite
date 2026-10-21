// Desktop shell for Signet.
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

/// A name that is safe to use as a file name, or nothing.
///
/// Both commands below take a name from the open document and write a file
/// with it. Separators, parent traversal and control characters are removed
/// rather than escaped, because no legitimate name needs them and a
/// half-escaped path is how this kind of thing goes wrong.
fn safe_file_name(name: &str) -> Option<String> {
    let kept: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.'))
        .collect();
    let trimmed = kept.trim_matches(['.', ' ']).to_owned();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn strips_anything_that_could_be_a_path() {
        assert_eq!(
            safe_file_name("minutes.pdf").as_deref(),
            Some("minutes.pdf")
        );
        assert_eq!(
            safe_file_name("../../etc/passwd").as_deref(),
            Some("etcpasswd")
        );
        assert_eq!(safe_file_name("a/b/c.docx").as_deref(), Some("abc.docx"));
    }

    #[test]
    fn refuses_a_name_with_nothing_left_in_it() {
        assert_eq!(safe_file_name(""), None);
        assert_eq!(safe_file_name("..."), None);
        assert_eq!(safe_file_name("/../"), None);
        assert_eq!(safe_file_name("   "), None);
    }

    #[test]
    fn keeps_the_names_people_actually_use() {
        assert_eq!(
            safe_file_name("Minutes 12-2026 (final).pdf").as_deref(),
            Some("Minutes 12-2026 final.pdf")
        );
    }
}

/// Hands a document to whatever this machine prints PDFs with.
///
/// A webview has no print dialog of its own — WKWebView does not implement
/// `window.print()` at all — so the shell writes the document to its own
/// temporary directory and asks the system to open it. The user prints from the
/// viewer they already have, which also means vector output rather than a
/// rasterised page.
///
/// The file goes to the OS temporary directory rather than anywhere the user
/// chose, is named after the document, and nothing here reaches the network.
#[tauri::command]
async fn print_document(name: String, bytes: Vec<u8>) -> Result<String, String> {
    // The name comes from the open document, so it is sanitised rather than
    // trusted: it decides a path.
    let file = safe_file_name(&name).unwrap_or_else(|| "document.pdf".to_owned());
    let path = std::env::temp_dir().join(file);

    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(&path);
        c
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]).arg(&path);
        c
    };
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&path);
        c
    };

    command
        .spawn()
        .map_err(|e| format!("could not open {} to print: {e}", path.display()))?;
    Ok(path.display().to_string())
}

/// Where LibreOffice lives, if it does. Fixed list, searched in order.
///
/// A path from the user is not accepted: "tell me where your converter is" is
/// a fine way to get an app to run anything at all (ADR 0007).
fn find_soffice() -> Option<PathBuf> {
    let candidates: Vec<PathBuf> = vec![
        #[cfg(target_os = "macos")]
        PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        #[cfg(target_os = "windows")]
        PathBuf::from("C:\\Program Files\\LibreOffice\\program\\soffice.exe"),
        #[cfg(target_os = "windows")]
        PathBuf::from("C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"),
        PathBuf::from("/usr/bin/soffice"),
        PathBuf::from("/usr/local/bin/soffice"),
        PathBuf::from("/usr/lib/libreoffice/program/soffice"),
        PathBuf::from("/snap/bin/libreoffice"),
    ];

    candidates.into_iter().find(|path| path.exists())
}

/// Whether this machine can convert Office documents at all.
#[tauri::command]
async fn can_convert_office() -> bool {
    find_soffice().is_some()
}

/// Converts an Office document to PDF with LibreOffice, and returns the PDF.
///
/// Everything happens in a temporary directory of our own: the input is written
/// there, LibreOffice is pointed at it with its own profile so it does not
/// disturb the user's session, and both files are removed afterwards. No
/// network is involved, which is the whole point of doing this locally.
#[tauri::command]
async fn convert_office(name: String, bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    let soffice = find_soffice().ok_or_else(|| {
        "LibreOffice is not installed on this machine. Install it from \
         libreoffice.org and try again."
            .to_owned()
    })?;

    // The name is sanitised rather than trusted: it decides a path.
    let safe = safe_file_name(&name)
        .ok_or_else(|| "that file has no name this can work with".to_owned())?;

    let work = std::env::temp_dir().join(format!("pdf-suite-convert-{}", std::process::id()));
    std::fs::create_dir_all(&work)
        .map_err(|e| format!("could not make a working directory: {e}"))?;
    let input = work.join(&safe);
    std::fs::write(&input, bytes)
        .map_err(|e| format!("could not write {}: {e}", input.display()))?;

    let profile = work.join("profile");
    let status = std::process::Command::new(&soffice)
        .arg("--headless")
        .arg("--norestore")
        .arg(format!(
            "-env:UserInstallation=file://{}",
            profile.display()
        ))
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&work)
        .arg(&input)
        .status()
        .map_err(|e| format!("could not run LibreOffice: {e}"))?;

    let produced = work.join(format!(
        "{}.pdf",
        std::path::Path::new(&safe)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_else(|| safe.clone())
    ));

    let result = std::fs::read(&produced)
        .map_err(|e| format!("LibreOffice finished with status {status} but produced no PDF: {e}"));

    // Whatever happened, the copies go.
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Where a scanner interface lives, if one does.
///
/// SANE's `scanimage` is the only scanning interface a program can drive
/// without linking a platform framework: it is standard on Linux and installs
/// from Homebrew on macOS. Windows has WIA, which PowerShell can drive, and
/// which is handled separately below.
fn find_scanimage() -> Option<PathBuf> {
    [
        "/usr/bin/scanimage",
        "/usr/local/bin/scanimage",
        "/opt/homebrew/bin/scanimage",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.exists())
}

/// Whether this machine offers a way to scan at all.
#[tauri::command]
async fn can_scan() -> bool {
    cfg!(target_os = "windows") || find_scanimage().is_some()
}

/// Scans one page and returns it as a JPEG.
///
/// The scanner's own driver does the work; this only asks for a page and reads
/// the file back. Nothing is uploaded, and the temporary file is removed
/// whether the scan worked or not.
#[tauri::command]
async fn scan_page(dpi: u32) -> Result<Vec<u8>, String> {
    // A sane range: below 75 is unreadable, above 1200 is a very large file
    // for no gain, and the value decides a command-line argument.
    let dpi = dpi.clamp(75, 1200);
    let work = std::env::temp_dir().join(format!("pdf-suite-scan-{}", std::process::id()));
    std::fs::create_dir_all(&work)
        .map_err(|e| format!("could not make a working directory: {e}"))?;
    let out = work.join("page.jpg");

    #[cfg(target_os = "windows")]
    let status = {
        // WIA through PowerShell: the one interface Windows exposes without
        // linking its imaging libraries.
        let script = format!(
            "$d=(New-Object -ComObject WIA.CommonDialog).ShowAcquireImage(); \
             $d.SaveFile('{}')",
            out.display()
        );
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .status()
    };

    #[cfg(not(target_os = "windows"))]
    let status = {
        let scanimage = find_scanimage().ok_or_else(|| {
            "No scanner interface on this machine. Install SANE (scanimage) and try again."
                .to_owned()
        })?;
        std::process::Command::new(scanimage)
            .arg("--format=jpeg")
            .arg(format!("--resolution={dpi}"))
            .arg("--output-file")
            .arg(&out)
            .status()
    };

    let status = status.map_err(|e| format!("could not run the scanner: {e}"))?;
    let result = std::fs::read(&out).map_err(|e| {
        format!("the scanner finished with status {status} but produced no page: {e}")
    });
    let _ = std::fs::remove_dir_all(&work);
    result
}

fn main() {
    tauri::Builder::default()
        // Native open and save dialogs. WKWebView has no File System Access API,
        // so without these the desktop app would fall back to a hidden file
        // input and browser downloads.
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_document,
            write_document,
            print_document,
            can_convert_office,
            convert_office,
            can_scan,
            scan_page
        ])
        .run(tauri::generate_context!())
        .expect("the Signet window failed to start");
}
