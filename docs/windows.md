# deskport-agent on Windows

Roadmap phase 7. The agent in `agent/` builds for Windows (`x86_64-pc-windows-gnu`) and has metrics, the terminal, joining, updates, a runner at logon and uninstall. It has no screen yet; the design for one is at the end. It speaks the same protocol as on Linux ([protocol.md](protocol.md)); the hub treats it like any other machine.

Status (2026-11-16): built and cross-checked on Linux only. **Nothing here has run on Windows yet**, so every Windows-specific path below is written to the documentation of the APIs it uses, not to an observed result. See "What has been checked" before relying on it.

Requirements: Windows 10 version 1809 (build 17763) or later, x86_64. Windows 11 on Arm runs the x86_64 build under emulation (there is no Arm build, see Build). No administrator rights.

## Install and join

On the hub, build the Windows agent once (`npm run build:agent:windows`, see Build), then choose Add machine, Windows. The command, for PowerShell as the user the agent should run as:

```powershell
$env:DESKPORT_JOIN_TOKEN='<join token>'; irm https://<hub>/agent/v1/install.ps1 | iex
```

The hub writes its own address into the script it serves. `irm https://<hub>/agent/v1/install.ps1 | iex` alone asks for the token. To pass options, run it as a script block: `& ([scriptblock]::Create((irm https://<hub>/agent/v1/install.ps1))) <join token> -Name "<name>"`.

`scripts/install-agent.ps1` (served as `/agent/v1/install.ps1`) does the same from a checkout, with `-Binary <path>` to skip the download (`powershell -ExecutionPolicy Bypass -File scripts\install-agent.ps1 ...`; the `irm` form is not subject to the execution policy). It:

1. downloads `/agent/v1/download/windows-x86_64` with the join token into `%LOCALAPPDATA%\Programs\deskport-agent\deskport-agent.exe` (an agent already running there is stopped and its file renamed),
2. runs `deskport-agent join`, which makes the key and registers it with the hub,
3. registers the scheduled task `deskport-agent`: at logon of this user, in this user's session (logon type Interactive, normal rights), no time limit, also on battery, one instance. Its action is `conhost.exe --headless "<exe>" service`. It then starts the task.

If the task cannot be registered, the script puts a shortcut with the same command in the user's Startup folder instead and starts the agent itself.

The binary is not code-signed. SmartScreen or Defender may warn about it or hold it for a scan the first time it runs.

## How it runs

A user session is needed: the terminal's shell runs as the user, and a screen capture later needs the user's desktop. A Windows service runs in session 0 without one, so the agent runs from a scheduled task at logon instead, and runs only while the user is logged on (the equivalent of a systemd user unit without lingering).

`deskport-agent service` is the runner. It drops its console, puts itself in a job object that ends every process in it when the runner ends (so ending the task also ends the agent and its shells), and runs `deskport-agent run` as a child without a window, with its output appended to `%LOCALAPPDATA%\deskport-agent\agent.log` (moved to `agent.log.1` when it is past 1 MB as the agent starts). After `run` exits it restarts it as the systemd unit does: at once after an update (75), never after the hub removed the machine (3), after 5 s otherwise.

`conhost.exe --headless` is there because the agent is a console program: started directly, Task Scheduler would show a console window (or a Windows Terminal tab) for it. `--headless` is the mode Windows' pseudo console starts conhost in. It is not documented for direct use; if it turns out not to hide the window, the fallback is a second build with the Windows subsystem for the runner.

## Updates

As on Linux (agent.md, Updates): the hub offers its `windows-x86_64` build when it is newer, the agent checks it and puts it in place, then exits with 75 and the runner starts the new one. Windows does not let a running program's file be replaced or deleted, but it may be renamed, so the running `deskport-agent.exe` becomes `deskport-agent.<time>.old` and the new file takes its name. The runner deletes `.old` files each time it starts the agent; one still in use (the runner's own, until the next logon) stays until then. The runner itself keeps running the version it started with until the next logon; it only starts and restarts the agent.

## Terminal

There is no tmux on Windows. The agent starts a shell in a pseudo console (ConPTY) and keeps it itself:

- One shell per agent, started by the first connection: `DESKPORT_TERM_SHELL` (a command line, for example `cmd.exe` or `wsl.exe`), else `pwsh.exe -NoLogo` when PowerShell 7 is on PATH, else `powershell.exe -NoLogo`. It starts in `DESKPORT_TERM_CWD` (default the user's profile folder) with the agent's environment less the variables starting with `RDP_`, `CF_ACCESS_`, `DESKPORT_` or `GUACD_`.
- The shell outlives connections: closing the page or losing the network leaves it running, and the next connection gets the last 256 KB of output (from the first line break in it, after clearing the page's terminal).
- Several connections see the same shell at once, like several tmux clients; the last resize wins.
- Flow control is per connection, but the shell is never slowed down for one. A connection that falls 256 output chunks (up to 4 MB) behind is closed with 1013 and reconnects with the replay.
- When the shell exits (`exit`), its connections close with 1000, and the next connection starts a new one.
- It differs from tmux in what it cannot do: no windows, panes or tmux status line, no scrollback beyond what the page keeps plus the 256 KB replay, a replay that is the raw output (a full-screen program such as an editor redraws properly only once it repaints), and the shell ends with the agent (at logoff, or when the agent restarts after an update). tmux's own mouse menu and key bindings do not exist.

## Metrics

| Field | Source |
| --- | --- |
| `uptimeS` | `GetTickCount64` |
| `cpu.total`, `cpu.cores` | `NtQuerySystemInformation(SystemProcessorPerformanceInformation)`, 100 ns units turned into 100 Hz ticks: user, 0, system (kernel less idle, DPC and interrupt), idle, 0, interrupt, DPC, 0 |
| `memory` | `GlobalMemoryStatusEx` (total, available); `GetPerformanceInfo` (system cache as `cachedB`, `commitB`, `commitLimitB`) |
| `disks` | `IOCTL_DISK_PERFORMANCE` on `\\.\PhysicalDrive0` and up (opened with no access rights, which needs no administrator): bytes read and written, busy time as uptime less idle time |
| `mounts` | Fixed drives from `GetLogicalDriveStrings` with `GetDiskFreeSpaceEx` (free space available to the user) |
| `net` | `GetIfTable2`: interfaces that are up, not loopback and not filter drivers (Windows lists each filter, such as the QoS packet scheduler, as an interface of its own) |
| `gpus` | `nvidia-smi.exe` when it is on PATH (the NVIDIA driver installs it in `System32`) |
| `top` | Tool Help process snapshot, `GetProcessTimes` and the working set; processes this user cannot open (other users', protected ones) are left out |

There is no load average, pressure or temperature: Windows has no load average or pressure counters, and temperatures need WMI and usually administrator rights. The dashboard shows commit instead of swap when `commitLimitB` is present.

## Files

| Path | What |
| --- | --- |
| `%LOCALAPPDATA%\Programs\deskport-agent\deskport-agent.exe` | The agent (where install.ps1 puts it). |
| `%APPDATA%\deskport-agent\agent.json` | Hub URL, id, name and release key. |
| `%APPDATA%\deskport-agent\agent.key` | The private key seed. Its access list has one entry, full control for the user, and does not inherit from the folder (the Windows equivalent of mode 600). |
| `%LOCALAPPDATA%\deskport-agent\agent.log` | The runner's and the agent's output. |
| `DESKPORT_AGENT_CONFIG_DIR` | Another directory for agent.json and agent.key. |

## Uninstall

`deskport-agent uninstall` deletes the scheduled task and the Startup shortcut if there is one, the settings and log folders, moves its own file to `%TEMP%` (a running program cannot be deleted), removes the program folder when it is empty, and ends the running agent last (a terminal opened through the agent ends with it). Remove the machine on its dashboard so the hub forgets it too.

## Build

```bash
export PATH="$HOME/.cargo/bin:$PATH"
rustup target add x86_64-pc-windows-gnu   # once
npm run build:agent:windows   # agent/target/x86_64-pc-windows-gnu/release/deskport-agent.exe
```

It cross-compiles with cargo-zigbuild through `uvx` (Zig as the C compiler for ring and as the linker), as the aarch64 Linux build does, so it needs no mingw-w64 install. The result (4.2 MB) imports only DLLs that ship with Windows 10: the Universal C Runtime (`api-ms-win-crt-*`), kernel32, ntdll, advapi32, psapi, iphlpapi, ws2_32, bcrypt and bcryptprimitives. A release build took 45 s and peaked at about 0.5 GB with 4 jobs.

An Arm build (`aarch64-pc-windows-gnullvm`) does not link with Zig: the Rust standard library needs `_Unwind_Resume`, which Zig does not provide for that target. llvm-mingw would provide it.

## What has been checked

On Linux only:

- `cargo test` covers the platform-neutral parts the Windows code uses: processor times to ticks, disk busy time, the interface filter, the environment block for the shell, the replay and fan-out of terminal output (tail cut at a line, slow connections let go, closing), the runner's restart rule, renaming and removing old builds, and the key file's security descriptor string.
- The Windows build compiles and links with no warnings; `file` reports a PE32+ console executable for x86-64.
- `install-agent.ps1` parses without errors in PowerShell 7.4 (on Linux), and the `irm` one-liner fetched it from a test hub, bound the arguments and stopped at the Windows version check, as it should on Linux.
- A test hub served `install.ps1` and the `.exe` (401 without a join token, the same bytes with one), and a scripted agent that joined with `os: "windows"` was listed as `windows x86_64` and offered `/agent/v1/download/windows-x86_64`.

Not run anywhere: the binary itself (no Windows machine or Wine here), ConPTY, the metrics calls, the key file's access list, the scheduled task and `conhost --headless`, the update on Windows, uninstall. The first run on a real machine should check, in this order: `deskport-agent version`; the install command; that no window appears at logon; the dashboard's numbers against Task Manager; the terminal (typing, resize, reconnecting, `exit`); `icacls %APPDATA%\deskport-agent\agent.key`; an update (bump the version, build, reconnect); uninstall.

## Screen (design, not built)

The Windows agent would serve the `screen` and `video` streams the way the direct path does on Linux (architecture.md, Direct screen path): the page keeps speaking its subset of Guacamole on `screen` (the tunnel id, size, sync and nop out; key, mouse, size, sync and clipboard in), and the picture goes as H.264 on `video` in the existing framing (a u32 frame number, a keyframe flag, three zero bytes, the Annex B access unit), so the page, its decoder, acknowledgements and rate control (`shim/ratecontrol.js`, which would move into the agent) are unchanged.

- **Capture: DXGI Desktop Duplication** (`IDXGIOutput1::DuplicateOutput`, `AcquireNextFrame`), one output per monitor. It gives frames as D3D11 textures, dirty and moved rectangles, and the pointer's shape and position separately, so the pointer can be drawn by the page as Guacamole's `cursor` is today. It needs no border and works from Windows 8. Windows.Graphics.Capture is the alternative: it can capture single windows and survives some mode changes, but draws a yellow border on Windows 10 and needs WinRT activation; it would be the fallback when duplication is not available (some hybrid-GPU laptops). Duplication reports `DXGI_ERROR_ACCESS_LOST` on a mode change, a full-screen exclusive app or the secure desktop; the agent re-creates it and, while it cannot, tells the page why, as the Linux bridge does for a locked screen.
- **Encode: Media Foundation's H.264 encoder** (`MFTEnumEx` with `MFT_ENUM_FLAG_HARDWARE` first, which finds NVENC, Quick Sync or AMF as MFTs, then the software encoder), with `CODECAPI_AVLowLatencyMode`, CBR, no B-frames and a bitrate changed at run time through `ICodecAPI`, fed NV12 made from the captured BGRA texture by the D3D11 video processor, so frames stay on the GPU. NVENC through its own SDK would give the 200 ms buffer and ultra-low-latency tune the Linux path uses; it is the second step if the MFT's latency is not good enough. AV1 only where a hardware AV1 MFT exists.
- **Input: `SendInput`**: keys from Guacamole keysyms to virtual keys and scan codes (text outside the layout as `KEYEVENTF_UNICODE`), the pointer as absolute coordinates over the virtual desktop (`MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`, 0 to 65535), buttons and the wheel (`WHEEL_DELTA` per Guacamole scroll step).
- **Clipboard**: `AddClipboardFormatListener` on a message-only window for changes, `CF_UNICODETEXT` both ways.
- **Limits** of a process in the user's session at normal rights: it cannot capture or drive the secure desktop (UAC prompts, Ctrl+Alt+Del, the lock screen), and User Interface Privilege Isolation stops its input from reaching programs running as administrator. Both need a service running as SYSTEM that starts a helper in the console session (`WTSQueryUserToken`, `CreateProcessAsUser` on `winsta0\Winlogon`), which also gives a screen before anyone logs on. That is a later step; it needs administrator rights to install.
- **Crates**: the `windows` crate (COM interfaces for D3D11, DXGI and Media Foundation) next to `windows-sys`. Capture, conversion and encoding would run on their own thread, outside the tokio runtime, handing encoded frames over a bounded channel that keeps only the newest when the network is slow, as the pacing rules in CLAUDE.md require.

The measure of done is the bench (`bench/measure-screen.mjs` and `bench/measure-typing.mjs`) against a Windows machine, compared with the Linux direct path.
