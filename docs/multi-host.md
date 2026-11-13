# Multiple hosts (planned)

> Superseded in part (2026-11-12): hosts will dial out to a hub instead of the controller dialling each host's tunnel. See [roadmap.md](roadmap.md). The groundwork listed under "What exists now" still applies.

deskport is built so that several machines can each run it, and one web UI can show and control all of them. Only the groundwork exists today: nothing in the UI changes, and requests for another machine are refused with 501 Not Implemented. This page describes the design the groundwork is for.

## Roles

- **Host**: any machine running the deskport server. Each host keeps everything it has today: its own screen sources, terminal, separate desktop, systemd units, Cloudflare Tunnel and Access application. A host works on its own whether or not other hosts exist.
- **UI**: the web page. Every host can serve it (the default), or not (`DESKPORT_UI=0`, for a machine that is only ever reached through another host).
- **Controller**: a host whose UI also lists other hosts and connects to them. Any host can be a controller; it needs a list of the others in `hosts.json`.

## How a controller reaches another host

The browser talks only to the controller's origin. The controller forwards requests for other hosts:

```
browser ──▶ controller  /h/<id>/api/...   ──▶ host <id>  /api/...
                        /h/<id>/ws/screen ──▶            /ws/screen
                        /h/<id>/ws/term   ──▶            /ws/term
```

The alternative, the browser opening each host's URL directly, was rejected. Each host sits behind its own Access application, so the browser would need a separate sign-in and cookie per host. Its WebSockets would also be cross-origin, which deskport refuses on purpose (`sameOrigin` in `hub/auth.js`), and the Content Security Policy only allows `connect-src 'self'`. Forwarding keeps one sign-in and leaves every host's security checks as they are.

The controller authenticates to other hosts with a Cloudflare Access **service token** (a client ID and secret sent as `CF-Access-Client-Id` / `CF-Access-Client-Secret`). Each host's Access application needs a Service Auth policy for that token, and each host's server needs to accept the service token's JWT, which has no `email` claim. The signed-in person's email would travel in a header the controller sets, and each host would log it next to the token's identity.

## What exists now

| Piece | Where | What it does today |
| --- | --- | --- |
| Host identity | `config.self` in `hub/config.js` | `DESKPORT_HOST_ID` (default: the hostname as a slug) and `DESKPORT_HOST_NAME` (default: the hostname). |
| Host description | `GET /api/host` | This host's id, name, version, whether it serves the UI, and its capabilities (screen sources, terminal). A controller will read this from each host. |
| Host list | `GET /api/hosts`, `hosts.json` | This host, plus any listed in `~/.config/deskport/hosts.json` with status `not-implemented`. |
| Host-addressed paths | `routeFor()` in `hub/hosts.js`, `hub/server.js` | `/h/<id>/api/...` and `/h/<id>/ws/...` work for this host's own id (and `local`); other known ids get 501, unknown ids 404. |
| Optional UI | `DESKPORT_UI=0`, `hub/ui.js` | Serves only the API and WebSockets. |
| Client host object | `web/js/host.js` | Every API call and WebSocket in the page goes through `host.api()`, `host.ws()` and `host.json()`. `createHost({ id })` already builds `/h/<id>` URLs. |

The server is split along the same lines: `hub/api.js` (the JSON API of one host), `hub/ui.js` (the page and its libraries), `hub/hosts.js` (identity, the host list and path routing) and `hub/server.js` (auth, headers and wiring).

`hosts.json` format:

```json
[
  { "id": "laptop", "name": "Laptop", "url": "https://laptop-deskport.example.com" }
]
```

Ids are lower-case letters, digits and dashes, unique, and not `local` or this host's own id. URLs must be https. Bad entries are skipped with a log line.

## What is left

1. **Forwarding** in the controller: an HTTP proxy for `/h/<id>/api/*` and a WebSocket proxy for `/h/<id>/ws/*` to the host's `url`, adding the service token headers. The screen WebSocket should pass frames through unchanged; the remote host already shrinks and re-encodes its own picture.
2. **Service-token auth** on every host: accept Access JWTs for a configured service token (`CF_ACCESS_SERVICE_TOKEN_ID` or its common name), and take the person's email from the forwarded header only when the request carries that token.
3. **Health**: the controller polls each host's `/api/host` and reports `online`, `offline` or `unauthorized` in `/api/hosts` instead of `not-implemented`.
4. **UI**: a host switcher (a select in the top bar next to Show, and a list in the More sheet on phones) that creates the views with `createHost({ id })`. Screen and Terminal would reconnect to the chosen host. The status badge and the page title would name the host.
5. **Per-host settings**: picture and source settings belong to the host being viewed, so the settings store would key them by host id (`deskport.settings.<id>`). Appearance and terminal look would stay per device.
6. **Remembered host**: the last viewed host per device, next to the last viewed tab.
