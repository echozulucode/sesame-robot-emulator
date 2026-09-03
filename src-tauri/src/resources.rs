//! Where the bundled files are, at runtime — Phase 5 T2.
//!
//! ## The one rule
//!
//! **`app.path()` only.** Never a path relative to the current directory,
//! never a path derived from `CARGO_MANIFEST_DIR`, never a walk up from the
//! executable. `packages/sesame-qemu/src/config.ts` computes `REPO_ROOT` from
//! `import.meta.url` and hangs `DEFAULT_QEMU_PATH` and `DEFAULT_IMAGE_PATH` off
//! it — correct for a Node process inside a checkout, and meaningless inside an
//! installed `.exe`, where there is no checkout. Everything here goes through
//! [`tauri::path::PathResolver::resolve`] with [`BaseDirectory::Resource`],
//! which on Windows is the directory the executable itself sits in.
//!
//! The failure this prevents is late: a hardcoded path works in `tauri dev`,
//! survives every test on the developer's machine, and breaks for the first
//! time on the machine the app was built for.
//!
//! ## What is here and what is not
//!
//! T2 makes files locatable and *provably* locatable. It does not spawn
//! anything and does not open a socket — that is T3, which consumes
//! [`QEMU_EXE`] and [`FLASH_IMAGE`] through [`resolve`].
//!
//! ## Layout, and why it mirrors the QEMU install
//!
//! ```text
//! $RESOURCE/qemu/bin/qemu-system-xtensa.exe
//! $RESOURCE/qemu/share/qemu/*.bin          <- BIOS/ROM images
//! $RESOURCE/images/distro-v1-esp32-cli-oled.flash.bin
//! $RESOURCE/hardware/*.json
//! ```
//!
//! `bin/` and `share/qemu/` keep their relative offset because that is how QEMU
//! finds its own data directory: `os_find_datadir()` looks for `../share/qemu`
//! next to the executable. Flattening the two into one directory would build
//! fine, install fine, and then fail at boot with "Could not open option rom",
//! which T3 would have to diagnose from scratch.
//!
//! ## The image file name is load-bearing
//!
//! `capabilitiesForImage()` in `packages/sesame-qemu/src/config.ts` decides
//! `oledFramebuffer` — and therefore whether the OLED pane may claim `observed`
//! pixels — with `path.basename(imagePath).includes('cli-oled')`, and an
//! unrecognised name gets the conservative answer. The bundled target below
//! keeps the source file name **exactly**, so a bundled path classifies the
//! same way a repository path does. Renaming it in `tauri.conf.json` would
//! silently downgrade a correctness surface rather than break a build.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{path::BaseDirectory, Manager, Runtime};

/// One file `tauri.conf.json` asked the bundler to ship.
#[derive(Debug, Clone, Copy)]
pub struct BundledResource {
    /// Path under the resource directory, forward-slashed, as configured.
    pub target: &'static str,
    /// The source path the bundler copied from, relative to `src-tauri/`.
    /// Reported so a mismatch names the file that has to be looked at.
    pub source: &'static str,
    /// `len()` of the source at build time. `None` when it was absent then.
    pub expected_bytes: Option<u64>,
}

// `BUNDLED`, derived from bundle.resources. See build.rs for why it is
// generated rather than typed.
include!(concat!(env!("OUT_DIR"), "/resource_manifest.rs"));

/// The emulator binary. T3 spawns this.
pub const QEMU_EXE: &str = "qemu/bin/qemu-system-xtensa.exe";

/// The flash image T3 boots — the OLED-hook build, and the default in
/// `packages/sesame-qemu`. See the module docs on why the name matters.
pub const FLASH_IMAGE: &str = "images/distro-v1-esp32-cli-oled.flash.bin";

/// Resolve one bundled resource by its `target` path.
///
/// `target` is forward-slashed because that is how it is written in
/// `tauri.conf.json`; it is split into components here rather than handed to
/// `Path::join` whole, so the resulting `PathBuf` is a normal Windows path
/// rather than a working-by-accident mix of separators.
pub fn resolve<R: Runtime, M: Manager<R>>(manager: &M, target: &str) -> Result<PathBuf, String> {
    let mut relative = PathBuf::new();
    for component in target.split('/') {
        relative.push(component);
    }
    manager
        .path()
        .resolve(&relative, BaseDirectory::Resource)
        // Tauri answers with an extended-length "verbatim" Windows path — the
        // one that starts `\\?\`. Correct, and
        // fine for `File::open` — but T3 puts one of these inside a QEMU
        // `-drive file=<image>` argument and the other into `Command::new`, and
        // the prefix is noise in every diagnostic downstream. `simplified()`
        // removes it only where the shorter form is provably the same path.
        .map(|path| dunce::simplified(&path).to_path_buf())
        .map_err(|e| format!("cannot resolve resource {target}: {e}"))
}

/// One row of [`ResourceReport`].
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceEntry {
    pub target: String,
    pub source: String,
    /// The absolute path `app.path()` produced. Reported verbatim: the whole
    /// point of the report is that nobody has to guess where it looked.
    pub path: String,
    pub exists: bool,
    /// Size on disk, or `None` when it is not there.
    pub bytes: Option<u64>,
    /// Size of the source at build time, or `None` when it was absent then.
    pub expected_bytes: Option<u64>,
    /// Present, and the same size the bundler was given.
    pub ok: bool,
    /// Why not, in one sentence, when `ok` is false.
    pub problem: Option<String>,
}

/// Every bundled resource, where it resolved to, and whether it is there.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceReport {
    /// True only when every entry is `ok`.
    pub ok: bool,
    /// `BaseDirectory::Resource`, resolved. On Windows: the executable's own
    /// directory, whether that is `target/release/` or `C:\Program Files\...`.
    pub resource_dir: String,
    pub total: usize,
    pub present: usize,
    /// Bytes actually found, summed. The bundle's real payload.
    pub bytes: u64,
    pub entries: Vec<ResourceEntry>,
}

/// Resolve and stat every entry of [`BUNDLED`].
pub fn report<R: Runtime, M: Manager<R>>(manager: &M) -> ResourceReport {
    let resource_dir = manager
        .path()
        .resource_dir()
        .map(|p| dunce::simplified(&p).display().to_string())
        .unwrap_or_else(|e| format!("<unresolved: {e}>"));

    let mut entries = Vec::with_capacity(BUNDLED.len());
    let mut present = 0usize;
    let mut bytes = 0u64;

    for resource in BUNDLED {
        let resolved = resolve(manager, resource.target);
        let (path, metadata) = match resolved {
            Ok(path) => {
                let metadata = std::fs::metadata(&path).ok();
                (path.display().to_string(), metadata)
            }
            Err(message) => (message, None),
        };

        let exists = metadata.is_some();
        let found = metadata.as_ref().map(|m| m.len());
        if exists {
            present += 1;
            bytes += found.unwrap_or(0);
        }

        let problem = match (found, resource.expected_bytes) {
            (None, _) => Some(format!(
                "not found. It was configured as {} in bundle.resources; if this is a packaged \
                 build the bundler did not place it, and if this is `cargo run` the build script \
                 did not copy it into the target directory.",
                resource.source
            )),
            (Some(found), Some(expected)) if found != expected => Some(format!(
                "{found} bytes, but {} was {expected} bytes when this build was made. A resource \
                 that is present at the wrong size is worse than one that is absent: nothing \
                 downstream will notice.",
                resource.source
            )),
            (Some(_), None) => Some(format!(
                "present, but {} did not exist when this build was made, so there is no size to \
                 check it against. This build was made from an incomplete checkout.",
                resource.source
            )),
            (Some(_), Some(_)) => None,
        };

        entries.push(ResourceEntry {
            target: resource.target.to_string(),
            source: resource.source.to_string(),
            path,
            exists,
            bytes: found,
            expected_bytes: resource.expected_bytes,
            ok: problem.is_none(),
            problem,
        });
    }

    ResourceReport {
        ok: entries.iter().all(|e| e.ok),
        resource_dir,
        total: entries.len(),
        present,
        bytes,
        entries,
    }
}

/// The report, for the webview.
///
/// An app-defined command, so it needs no entry in `capabilities/default.json`
/// — v2's permission system governs plugin commands, and this app still asks
/// for nothing beyond `core:default`.
#[tauri::command]
pub fn resource_report(app: tauri::AppHandle) -> ResourceReport {
    report(&app)
}
