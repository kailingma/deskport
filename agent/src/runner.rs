//! `deskport-agent service`: the Windows runner. A scheduled task starts it at
//! logon, in the user's session (the terminal and later the screen need
//! one). It runs `deskport-agent run` as a child without a window, writes
//! its output to the log, and restarts it the way the systemd unit does on
//! Linux: at once after an update (status 75), not at all once the hub
//! removed the machine (status 3), after 5 s otherwise.

use std::time::Duration;

#[derive(Debug, PartialEq)]
pub enum Next {
    Restart(Duration),
    Stop,
}

/// What to do after `deskport-agent run` exited with `code`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn next(code: Option<i32>) -> Next {
    match code {
        Some(crate::update::RESTART) => Next::Restart(Duration::ZERO),
        Some(3) => Next::Stop,
        _ => Next::Restart(Duration::from_secs(5)),
    }
}

/// The name of the scheduled task (and of the Startup folder shortcut when
/// the task could not be made).
#[cfg_attr(not(windows), allow(dead_code))]
pub const TASK: &str = "deskport-agent";

/// Where the log goes: %LOCALAPPDATA%\deskport-agent.
#[cfg(windows)]
pub fn log_dir() -> std::path::PathBuf {
    std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(crate::sys::home).join("deskport-agent")
}

#[cfg(windows)]
const LOG_MAX: u64 = 1 << 20;

#[cfg(windows)]
fn open_log() -> std::io::Result<std::fs::File> {
    let dir = log_dir();
    std::fs::create_dir_all(&dir)?;
    let log = dir.join("agent.log");
    if std::fs::metadata(&log).map(|m| m.len() > LOG_MAX).unwrap_or(false) {
        let _ = std::fs::rename(&log, dir.join("agent.log.1"));
    }
    std::fs::OpenOptions::new().create(true).append(true).open(log)
}

/// Puts this process in a job that ends with it, so stopping the task also
/// ends the agent and the shells it started.
#[cfg(windows)]
fn kill_children_with_me() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return;
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        // The handle stays open until this process ends.
        AssignProcessToJobObject(job, GetCurrentProcess());
    }
}

#[cfg(windows)]
pub fn service() -> Result<(), String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    // Started through a console host; nothing here needs a window.
    unsafe { windows_sys::Win32::System::Console::FreeConsole() };
    kill_children_with_me();
    // Read once: after an update the running file has another name.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    crate::config::load()?;
    loop {
        crate::update::remove_old_builds(&exe);
        let mut log = open_log().map_err(|e| format!("log: {e}"))?;
        let stamp = crate::protocol::now_ms() / 1000;
        let _ = writeln!(log, "[{stamp}] service: starting {}", exe.display());
        let child = std::process::Command::new(&exe)
            .arg("run")
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log.try_clone().map_err(|e| e.to_string())?)
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        let code = match child {
            Ok(s) => s.code(),
            Err(e) => {
                let _ = writeln!(log, "service: could not start the agent: {e}");
                None
            }
        };
        let step = next(code);
        let _ = writeln!(log, "service: the agent exited ({code:?}); {step:?}");
        match step {
            Next::Stop => return Ok(()),
            Next::Restart(d) => std::thread::sleep(d),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restarts_like_the_systemd_unit() {
        assert_eq!(next(Some(75)), Next::Restart(Duration::ZERO));
        assert_eq!(next(Some(3)), Next::Stop);
        assert_eq!(next(Some(1)), Next::Restart(Duration::from_secs(5)));
        assert_eq!(next(None), Next::Restart(Duration::from_secs(5)));
    }
}
