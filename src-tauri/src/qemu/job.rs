//! The teardown guarantee: a Windows **Job Object** with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
//!
//! ## Why not just `kill()`
//!
//! The named risk in `docs/plans/phase-5-tauri-desktop-app.md` §7 is *orphaned
//! `qemu-system-xtensa.exe`* — on window close, on app crash, and after
//! repeated start/stop. `scripts/dev-lab.mjs` already learned the first half of
//! this and reaches for `taskkill /T`, and `session.ts` learned that
//! `ChildProcess.kill` on Windows is `TerminateProcess` and returns before the
//! process is gone.
//!
//! But every one of those is a *code path*, and a code path only runs if the
//! code runs. The failure this module is for is the one where it does not: the
//! app is killed with `Stop-Process`, or WebView2 takes the process down, or a
//! panic unwinds past every `Drop`. No `kill()` anywhere can cover that,
//! because there is nothing left to execute it.
//!
//! A job object can, because the kernel does it. Every handle to the job is
//! held by this process; when this process dies **for any reason**, its handles
//! close, the job's last handle closes, and Windows terminates everything
//! inside it. That is a property, not a best effort.
//!
//! ## One job per session, not one for the app
//!
//! Putting *this* process into a job would close the assignment window
//! described below entirely — a child is a member of its parent's job from the
//! instant `CreateProcess` returns. It would also enrol every WebView2 helper
//! process Tauri spawns, and make "kill the job" mean "kill the app". One job
//! per QEMU session keeps the blast radius at exactly the process this module
//! is responsible for, and still gives the crash guarantee, because the job
//! handle dies with the process that holds it either way.
//!
//! ## The window that is not closed, stated rather than glossed
//!
//! `CreateProcess` returns a running process; `AssignProcessToJobObject` runs
//! after it. Between those two calls — microseconds — the child is not yet in
//! the job, and a hard kill of this process in that window leaves QEMU behind.
//! Closing it needs `CREATE_SUSPENDED` and a resume, and
//! `std::process::Command` hands back no thread handle to resume with, so it
//! would mean calling `CreateProcessW` here directly, with its own command-line
//! quoting. That is a real cost for a window that requires the app to be killed
//! inside a few microseconds of a spawn. Measured instead: §4 of the T3
//! finding kills the app mid-boot repeatedly and counts survivors.

use std::process::Child;

/// A kill-on-close job object holding one QEMU process.
///
/// On non-Windows this is a stub that records nothing and does nothing; the
/// caller's `Child::kill()` path is the whole story there. We ship Windows
/// (plan §8) but the crate still has to compile portably.
pub struct ProcessJob {
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

// The handle is an opaque kernel object, owned by this struct and closed
// exactly once in `Drop`. `*mut c_void` is not `Send` by default; a Windows
// HANDLE is.
#[cfg(windows)]
unsafe impl Send for ProcessJob {}
#[cfg(windows)]
unsafe impl Sync for ProcessJob {}

impl ProcessJob {
    /// Create an anonymous job whose members die when the last handle closes.
    #[cfg(windows)]
    pub fn create() -> Result<Self, String> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: null attributes (so the handle is NOT inheritable — a handle
        // leaked into another process would keep the job alive past our death
        // and defeat the entire point) and a null name (anonymous).
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(format!(
                "CreateJobObjectW failed (GetLastError {})",
                unsafe { GetLastError() }
            ));
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a correctly sized, correctly typed
        // JOBOBJECT_EXTENDED_LIMIT_INFORMATION for the info class named.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let error = unsafe { GetLastError() };
            // SAFETY: `handle` is a valid job handle we just created.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle) };
            return Err(format!(
                "SetInformationJobObject(KILL_ON_JOB_CLOSE) failed (GetLastError {error})"
            ));
        }
        Ok(Self { handle })
    }

    /// Non-Windows: no job, no guarantee, and the caller is told so by the type
    /// being infallible rather than by a comment.
    #[cfg(not(windows))]
    pub fn create() -> Result<Self, String> {
        Ok(Self {})
    }

    /// Put `child` in the job. From here on the OS owns its lifetime.
    #[cfg(windows)]
    pub fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        // SAFETY: `child` is alive for the duration of the call, so its raw
        // handle is valid; `self.handle` is a job handle created above.
        let ok = unsafe { AssignProcessToJobObject(self.handle, child.as_raw_handle() as _) };
        if ok == 0 {
            return Err(format!(
                "AssignProcessToJobObject failed (GetLastError {})",
                unsafe { GetLastError() }
            ));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    pub fn assign(&self, _child: &Child) -> Result<(), String> {
        Ok(())
    }

    /// Kill every process in the job, now.
    ///
    /// The deliberate stop path. `Drop` would do it too — that is the crash
    /// guarantee — but an explicit `stop_emulator` should not depend on when a
    /// `Drop` happens to run, and `TerminateJobObject` is synchronous in the
    /// sense that matters: by the time it returns the kernel has signalled
    /// every member. `session.ts` still waits for the exit to be *observed*
    /// before claiming the process is gone, and so does the caller here.
    #[cfg(windows)]
    pub fn terminate(&self) {
        // SAFETY: valid job handle; exit code is arbitrary.
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(self.handle, 1) };
    }

    #[cfg(not(windows))]
    pub fn terminate(&self) {}

    /// True when this job can actually enforce anything.
    ///
    /// Reported in the session info rather than assumed, because "no orphaned
    /// processes" is a claim the app makes to whoever runs it.
    pub const fn enforced(&self) -> bool {
        cfg!(windows)
    }
}

impl Drop for ProcessJob {
    fn drop(&mut self) {
        #[cfg(windows)]
        // SAFETY: `self.handle` was created in `create()`, is not inheritable,
        // and is closed exactly once — here. Closing the last handle is what
        // makes KILL_ON_JOB_CLOSE fire.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_can_be_created_and_closed() {
        let job = ProcessJob::create().expect("a job object");
        assert_eq!(job.enforced(), cfg!(windows));
        drop(job);
    }

    /// The property, exercised against a process that is not QEMU so the test
    /// is fast and needs no bundled resources: a child in a kill-on-close job
    /// dies when the last job handle closes, with nobody calling `kill()`.
    #[cfg(windows)]
    #[test]
    fn closing_the_last_handle_kills_the_member() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let job = ProcessJob::create().unwrap();
        let mut child = Command::new("cmd")
            .args(["/C", "pause"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("cmd.exe is on PATH on Windows");
        job.assign(&child).expect("assign");

        drop(job); // no kill() anywhere below this line

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match child.try_wait().unwrap() {
                Some(_) => break,
                None if Instant::now() > deadline => {
                    let _ = child.kill();
                    panic!("the job's member survived the last handle closing");
                }
                None => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}
