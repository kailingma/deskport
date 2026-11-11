# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One person, the owner of an always-on Linux desktop, reaching that machine while away from it. They open deskport from an iPhone (Safari), an iPad, or a laptop browser. Typical jobs: check on or steer a long-running coding agent in tmux, run a quick command, look at or click something on the real desktop, copy text between the two machines.

## Product Purpose

deskport puts the machine's live physical screen and a persistent terminal in one browser tab, served from the machine itself. Success is opening a URL on any device, passing Cloudflare Access, and being in control within a few seconds, with the terminal exactly where it was left.

## Positioning

It mirrors the real logged-in GNOME session (the monitor as it is), not a separate virtual desktop, and the terminal is a tmux session that survives disconnects. It is single-machine and self-hosted: no relay service, no account system of its own, no install on the client.

## Operating Context

- Used in short visits from a phone on the move and longer sessions from a laptop or iPad.
- The host runs GNOME on Wayland; the screen arrives over RDP from GNOME desktop sharing through guacd.
- The terminal attaches to tmux session `web` (configurable); the same session can be attached locally.
- Access is gated by Cloudflare Access and the server re-checks the Access JWT on every request and WebSocket.

## Capabilities and Constraints

- Two views: Screen (view and control, clipboard both ways, Super and Ctrl+Alt+Del, full screen) and Terminal (xterm.js, reconnects with backoff).
- No build step: plain ES modules, vendor files served from node_modules. CSP is `'self'` only, so fonts and assets must ship from the repo.
- iPhone Safari has no Fullscreen API for pages and no Keyboard Lock; iPad Safari supports element fullscreen; Keyboard Lock is Chrome-only.
- The repo stays machine-neutral: no hostnames, domains, emails or account IDs in tracked files.

## Brand Commitments

Name is lowercase "deskport". No logo beyond the current monitor mark, which is not binding.

## Evidence on Hand

None. No users besides the owner, no metrics, no testimonials. Do not invent any.

## Product Principles

- The remote screen and the terminal are the content; chrome gets out of their way.
- Every control must be usable with a thumb on a phone and with a keyboard on a laptop.
- Connection state is always visible and honest.
- Nothing about the owner's machine or accounts lives in the repo.
