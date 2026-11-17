//! The terminal on Linux: a tmux client in a pseudo-terminal per connection,
//! attached to the persistent session (DESKPORT_TMUX_SESSION, default `web`).
//! tmux redraws the screen on attach, so there is nothing to replay.

use super::{Attached, End};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use tokio::sync::mpsc;

pub fn tmux_session() -> String {
    std::env::var("DESKPORT_TMUX_SESSION").unwrap_or_else(|_| "web".into())
}

/// Whether the machine has a terminal to offer: tmux is installed.
pub fn available() -> bool {
    Command::new("tmux").arg("-V").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false)
}

pub struct Conn {
    master: File,
    child: Child,
    read_only: bool,
}

impl Conn {
    pub fn resize(&self, cols: u16, rows: u16) {
        if self.read_only { return; }
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
        unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
    }

    pub fn end(&self) -> End {
        End::Exited
    }

    /// Ends the tmux client; the session keeps running.
    pub fn detach(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn tmux_args(session: &str, cwd: &str, read_only: bool) -> Vec<String> {
    if read_only {
        vec!["attach-session".into(), "-E".into(), "-t".into(), format!("={session}"), "-f".into(), "read-only,ignore-size".into()]
    } else {
        ["new-session", "-A", "-s", session, "-c", cwd].map(String::from).to_vec()
    }
}

fn spawn_tmux(session: &str, cwd: &str, read_only: bool) -> std::io::Result<Conn> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ws = libc::winsize { ws_row: 30, ws_col: 100, ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null(), &ws) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) };
    let mut cmd = Command::new("tmux");
    cmd.args(tmux_args(session, cwd, read_only)).current_dir(cwd);
    cmd.env_clear();
    for (k, v) in std::env::vars_os() {
        if !crate::sys::is_secret(&k.to_string_lossy()) {
            cmd.env(&k, &v);
        }
    }
    cmd.env("TERM", "xterm-256color").env("COLORTERM", "truecolor");
    cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave));
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    Ok(Conn { master: File::from(master), child, read_only })
}

pub fn attach(cwd: &str, read_only: bool) -> std::io::Result<Attached> {
    let session = tmux_session();
    let conn = spawn_tmux(&session, cwd, read_only)?;
    // The pseudo-terminal is read on its own thread. The channel holds a few
    // chunks; while flow control pauses, nothing is taken from it, the thread
    // blocks, and tmux sees a slow client.
    let (out_tx, output) = mpsc::channel::<Vec<u8>>(4);
    let mut reader = conn.master.try_clone()?;
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (input, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let mut writer = conn.master.try_clone()?;
    std::thread::spawn(move || {
        while let Ok(b) = in_rx.recv() {
            if writer.write_all(&b).is_err() {
                break;
            }
        }
    });
    let label = format!("tmux session \"{session}\" (pid {})", conn.child.id());
    Ok(Attached { output, input, replay: Vec::new(), label, conn })
}

#[cfg(test)]
mod tests {
    #[test]
    fn read_only_attaches_without_starting_or_resizing_a_session() {
        assert_eq!(super::tmux_args("test", "/", true), ["attach-session", "-E", "-t", "=test", "-f", "read-only,ignore-size"]);
        assert_eq!(super::tmux_args("test", "/", false)[0], "new-session");
    }
}
