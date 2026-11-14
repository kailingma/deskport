# Setting up deskport

This guide takes a Linux desktop from nothing to a deskport URL behind Cloudflare Access. It was written against Ubuntu 26.04 with GNOME 50 on Wayland; any GNOME release with RDP desktop sharing (`grdctl`) should work.

You need:

- A GNOME session that stays logged in (deskport shares the real screen, so someone has to be logged in to it).
- Node.js 22 or newer, `tmux`, `openssl`, Docker with compose.
- A domain on Cloudflare, and Cloudflare Zero Trust (the free plan is enough).

The examples use `desk.example.com` for the hostname and `myteam.cloudflareaccess.com` for the Zero Trust team domain. Replace both.

## 1. Install

```bash
git clone <this repo> ~/code/deskport
cd ~/code/deskport
npm install
npm test
```

`node-pty` compiles a native module during `npm install`. If it fails, install `build-essential` and `python3` and run `npm install` again.

## 2. Turn on GNOME desktop sharing

```bash
./scripts/setup-rdp.sh
```

The script:

1. Creates `~/.config/deskport/` (mode 700).
2. Writes a self-signed TLS certificate (`rdp-tls.crt`, `rdp-tls.key`) for the RDP server.
3. Writes `rdp.env` (mode 600) with the username `deskport` and a random password.
4. Points GNOME desktop sharing at those, on port 3390, with port negotiation and view-only mode off.
5. Enables and restarts `gnome-remote-desktop.service` as a user service.
6. Sets up the headless RDP settings the separate desktop uses (port 3391, same credentials). It writes them with `gsettings` rather than `grdctl --headless rdp enable`, because that command also starts `gnome-remote-desktop-headless.service`, which stops the desktop sharing from step 5.

Port 3390 is used because GNOME's system-level remote login daemon may already hold 3389. Set `RDP_PORT` before running the script to choose another, and put the same value in `deskport.env`.

Check it is listening:

```bash
ss -ltn | grep 3390
```

GNOME's RDP server listens on every interface. It is protected by the password and TLS, but deskport only needs it on loopback, so block 3390 in a firewall if the machine sits on a network you don't trust:

```bash
sudo ufw deny 3390/tcp
```

## 3. Start guacd

guacd converts RDP into the Guacamole protocol the browser speaks. It runs in Docker with host networking and listens on 127.0.0.1:4822 only.

```bash
docker compose -f deploy/docker-compose.yml up -d
```

It restarts with Docker (`restart: unless-stopped`).

## 4. Try it locally

```bash
npm run dev
```

This serves http://127.0.0.1:7900 with the Cloudflare Access checks switched off. It refuses to bind anything but loopback. Open it in a browser on the same machine: the Screen tab should show your desktop and the Terminal tab a tmux session called `web`. Stop it with Ctrl+C before continuing.

## 5. Create the tunnel

Install `cloudflared` (a single binary from Cloudflare's releases page; put it on your `PATH`, for example in `~/.local/bin`). Then:

```bash
cloudflared tunnel login                       # pick the zone in the browser
cloudflared tunnel create deskport             # prints the tunnel ID
cloudflared tunnel route dns deskport desk.example.com
cp deploy/cloudflared.example.yml ~/.cloudflared/deskport.yml
```

Edit `~/.cloudflared/deskport.yml`: put the tunnel ID in `tunnel:` and in the credentials file name, set `credentials-file` to your home directory, and set `hostname` to your hostname.

## 6. Create the Access application

In the Cloudflare dashboard, go to Zero Trust, then Access, then Applications:

1. Add an application of type Self-hosted.
2. Set the application domain to `desk.example.com`.
3. Add a policy with action Allow and an Include rule for your email address (or whatever identity rule you want).
4. Save, then open the application's overview and copy the Application Audience (AUD) tag.

Your team domain is under Zero Trust settings (Custom pages shows it), in the form `myteam.cloudflareaccess.com`.

Write `~/.config/deskport/deskport.env` (mode 600) from the example:

```bash
cp deskport.env.example ~/.config/deskport/deskport.env
chmod 600 ~/.config/deskport/deskport.env
```

Fill in `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, and optionally `DESKPORT_ALLOWED_EMAILS` (a second check on top of the Access policy).

## 7. Run it as services

```bash
./scripts/install-services.sh
sudo loginctl enable-linger "$USER"
```

`install-services.sh` writes three systemd user units into `~/.config/systemd/user/`, and enables and starts the first two:

- `deskport.service` runs `hub/server.js` with the `node` on your `PATH` at install time. For fnm it uses the stable `default` alias path.
- `deskport-tunnel.service` runs `cloudflared` with `~/.cloudflared/deskport.yml` (set `DESKPORT_TUNNEL_CONFIG` to use another file). It is skipped when that file does not exist.
- `deskport-session.service` runs `scripts/desktop-session.sh`, the separate desktop. It is not enabled: deskport starts it the first time someone picks Show: Separate desktop, and it runs until ended from the settings (`systemctl --user stop deskport-session` does the same). It is capped at 3 GB of memory.

Lingering lets user services start at boot without anyone logging in on a terminal. The GNOME session itself still needs a login (or automatic login) for there to be a screen to share.

Re-run `install-services.sh` after moving the repo or changing your default Node version. After a Node major version change, also run `npm rebuild node-pty`.

## 8. Check it

```bash
systemctl --user status deskport deskport-tunnel
curl -sI http://127.0.0.1:7900/          # 403: no Access token
curl -sI https://desk.example.com/       # 302 to the Access login
```

Then open `https://desk.example.com` in a browser, sign in through Access, and both tabs should connect.

## 9. Other machines (optional)

Other machines join this one, the hub, with deskport-agent ([agent.md](agent.md)). An agent cannot sign in as a person, so it needs a way past Access to `/agent/*` only:

1. In Zero Trust, Access, Applications, add a second Self-hosted application with the same domain and the path `agent/*`.
2. Give it one policy with action **Bypass** and an Include rule of Everyone. Access then lets these requests through, and deskport checks them itself: a join token for joining and downloading the agent, and the machine's own key for everything else (protocol.md, "Signed connections"). deskport serves nothing but the agent protocol under `/agent/`.
3. Build the agent on the hub, so the hub can hand it out: install Rust (`curl https://sh.rustup.rs -sSf | sh`), then `npm run build:agent`. The build is a static binary for x86_64 Linux.

Then, for each machine, mint a join token while signed in to the page. Until the page has a button for it (roadmap phase 3), run this in the browser's console on the page: `await (await fetch('/api/join-tokens', { method: 'POST' })).json()`. A token works once, within 15 minutes. On the new machine run

```bash
curl -fsSL https://desk.example.com/agent/v1/install.sh | sh -s -- https://desk.example.com <join token>
```

The machine needs `curl`, and `tmux` for its terminal. It appears in `/api/hosts` and its terminal is at `/h/<id>/ws/term`. The page's machine picker and the button that mints tokens come with roadmap phase 3.

## Troubleshooting

| Symptom | Look at |
| --- | --- |
| Page says "Forbidden: sign in through Cloudflare Access" | `journalctl --user -u deskport` shows why the token was refused (wrong AUD, wrong team domain, email not allowed). |
| Screen shows "Could not connect" | `docker logs deskport-guacd`, then `systemctl --user status gnome-remote-desktop`. The RDP credentials in `rdp.env` must match what `grdctl status --show-credentials` reports. |
| Screen is the lock screen | That is the real screen. Unlock it from the browser. |
| Terminal keeps reconnecting | `journalctl --user -u deskport`; `node-pty` may need `npm rebuild node-pty` after a Node upgrade. |
| Public URL returns 502 or 1033 | `journalctl --user -u deskport-tunnel`; the tunnel is down or points at the wrong port. |
