//! The terminal on Windows: a shell in a pseudo console (ConPTY, Windows 10
//! 1809 or later). There is no tmux, so the agent keeps the session itself:
//! one shell that outlives its connections, the last 256 KB of its output
//! replayed to each new connection, and the same output copied to every
//! connection at once. When the shell exits, its connections close and the
//! next one starts a new shell. The shell is DESKPORT_TERM_SHELL (a command
//! line), else pwsh.exe when it is on PATH, else powershell.exe.

use super::fanout::Fanout;
use super::{Attached, End};
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};
use std::sync::{Arc, Mutex};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{COORD, ClosePseudoConsole, CreatePseudoConsole, HPCON, ResizePseudoConsole};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, INFINITE, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

const TAIL: usize = 256 * 1024;
/// Chunks of up to 16 KB a connection may be behind before it is let go.
const QUEUE: usize = 256;

/// ConPTY is part of Windows 10 1809 and later, which this build requires.
pub fn available() -> bool {
    true
}

struct Raw(HANDLE);
unsafe impl Send for Raw {}

struct Session {
    out: Fanout,
    /// None once the shell has exited and the pseudo console is closed.
    hpc: Mutex<Option<HPCON>>,
    input: std::sync::mpsc::Sender<Vec<u8>>,
    label: String,
}

static SESSION: Mutex<Option<Arc<Session>>> = Mutex::new(None);

pub struct Conn {
    session: Arc<Session>,
    id: u64,
}

impl Conn {
    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(h) = *self.session.hpc.lock().unwrap() {
            unsafe { ResizePseudoConsole(h, COORD { X: cols as i16, Y: rows as i16 }) };
        }
    }

    pub fn end(&self) -> End {
        if self.session.out.was_behind(self.id) { End::Behind } else { End::Exited }
    }

    /// The shell keeps running for the next connection.
    pub fn detach(self) {
        self.session.out.unsubscribe(self.id);
    }
}

pub fn shell_command() -> String {
    if let Ok(s) = std::env::var("DESKPORT_TERM_SHELL") {
        if !s.trim().is_empty() {
            return s;
        }
    }
    if crate::sys::which("pwsh") { "pwsh.exe -NoLogo".into() } else { "powershell.exe -NoLogo".into() }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn attach(cwd: &str) -> std::io::Result<Attached> {
    let mut current = SESSION.lock().unwrap();
    for _ in 0..2 {
        let session = match current.as_ref() {
            Some(s) if !s.out.is_closed() => s.clone(),
            _ => {
                let s = spawn(cwd)?;
                *current = Some(s.clone());
                s
            }
        };
        if let Some((id, output, replay)) = session.out.subscribe() {
            let label = session.label.clone();
            let input = session.input.clone();
            return Ok(Attached { output, input, replay, label, conn: Conn { session, id } });
        }
        *current = None;
    }
    Err(std::io::Error::other("the shell exited at once"))
}

fn spawn(cwd: &str) -> std::io::Result<Arc<Session>> {
    let command = shell_command();
    let (mut in_r, mut in_w, mut out_r, mut out_w): (HANDLE, HANDLE, HANDLE, HANDLE) = (null_mut(), null_mut(), null_mut(), null_mut());
    unsafe {
        if CreatePipe(&mut in_r, &mut in_w, null(), 0) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if CreatePipe(&mut out_r, &mut out_w, null(), 0) == 0 {
            let e = std::io::Error::last_os_error();
            CloseHandle(in_r);
            CloseHandle(in_w);
            return Err(e);
        }
        let mut hpc: HPCON = 0;
        let hr = CreatePseudoConsole(COORD { X: 100, Y: 30 }, in_r, out_w, 0, &mut hpc);
        if hr < 0 {
            for h in [in_r, in_w, out_r, out_w] {
                CloseHandle(h);
            }
            return Err(std::io::Error::other(format!("CreatePseudoConsole failed (0x{:08x})", hr as u32)));
        }
        let started = start(&command, cwd, hpc);
        // The pseudo console has its own copies; without closing ours, reading
        // the output would never end.
        CloseHandle(in_r);
        CloseHandle(out_w);
        let process = match started {
            Ok(p) => p,
            Err(e) => {
                ClosePseudoConsole(hpc);
                CloseHandle(in_w);
                CloseHandle(out_r);
                return Err(e);
            }
        };
        let (input, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let session = Arc::new(Session { out: Fanout::new(TAIL, QUEUE), hpc: Mutex::new(Some(hpc)), input, label: format!("{command} in a pseudo console") });

        let mut reader = File::from_raw_handle(out_r);
        let s = session.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 16384];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => s.out.push(&buf[..n]),
                }
            }
            s.out.close();
            eprintln!("terminal: the shell exited");
        });

        let mut writer = File::from_raw_handle(in_w);
        std::thread::spawn(move || {
            while let Ok(b) = in_rx.recv() {
                if writer.write_all(&b).is_err() {
                    break;
                }
            }
        });

        // When the shell exits, closing the pseudo console ends the output.
        let s = session.clone();
        let process = Raw(process);
        std::thread::spawn(move || {
            let process = process;
            WaitForSingleObject(process.0, INFINITE);
            CloseHandle(process.0);
            if let Some(h) = s.hpc.lock().unwrap().take() {
                ClosePseudoConsole(h);
            }
        });
        Ok(session)
    }
}

/// Starts `command` attached to the pseudo console; returns the process handle.
unsafe fn start(command: &str, cwd: &str, hpc: HPCON) -> std::io::Result<HANDLE> {
    unsafe {
        let mut size = 0usize;
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        let mut attrs = vec![0u64; size.div_ceil(8)];
        let list = attrs.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let r = (|| {
            if UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize, hpc as *const core::ffi::c_void, std::mem::size_of::<HPCON>(), null_mut(), null()) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut si: STARTUPINFOEXW = std::mem::zeroed();
            si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            // Without this the shell can take the agent's own redirected
            // output (the log file) instead of the pseudo console.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            si.lpAttributeList = list;
            let mut cmdline = wide(command);
            let env = super::env_block(std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())));
            let dir = wide(cwd);
            let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
            if CreateProcessW(
                null(),
                cmdline.as_mut_ptr(),
                null(),
                null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                env.as_ptr().cast(),
                dir.as_ptr(),
                &si.StartupInfo,
                &mut pi,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            CloseHandle(pi.hThread);
            Ok(pi.hProcess)
        })();
        DeleteProcThreadAttributeList(list);
        r
    }
}
