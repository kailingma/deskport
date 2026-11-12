# Old clients, as far back as Windows XP

Research only; nothing here is built. Two different questions hide in "works on Windows XP": opening deskport from an XP machine, and controlling an XP machine with deskport.

## Opening deskport from Windows XP

What stands in the way, from the network inwards:

1. **TLS and the hostname.** deskport is reached through Cloudflare, which serves the hostname by SNI. Internet Explorer on XP sends no SNI and speaks TLS 1.0 only, so it cannot reach the site at all. Browsers that bring their own TLS stack (Chrome up to 49, Firefox up to 52 ESR, and current forks) send SNI and speak TLS 1.2.
2. **Certificates.** Chrome on XP uses Windows' certificate store, which on XP has not been updated for years. Cloudflare's edge certificates chain to roots XP may not have, which shows as a certificate error. Firefox and its forks carry their own roots, but Firefox 52's are from 2018. I did not check which roots Cloudflare's current certificates need against either.
3. **Cloudflare Access.** The sign-in page is Cloudflare's, not deskport's. Whether it works in a 2016 browser is up to Cloudflare. I did not test it.
4. **The page.** deskport targets current browsers and has no build step. It needs ES modules (Chrome 61, Firefox 60), `?.` and `??` (Chrome 80, Firefox 72), `<dialog>`, `oklch()` colours (Chrome 111), and xterm.js 6. Chrome 49 and Firefox 52 fail on the first module script. guacamole-common-js itself is plain ES5 and needs only WebSocket and canvas, which IE 10 and later have, but XP stops at IE 8.

### Options, cheapest first

- **A current browser built for XP.** Supermium is a Chromium fork that supports XP since its version 121; its builds in 2026 are on Chromium 144. It runs today's page unchanged, so only points 1 to 3 remain (it has its own TLS; whether it carries current root certificates needs checking). This needs no work in deskport and is the realistic route.
- **A legacy page** at, say, `/legacy`: the same views compiled down (esbuild with `--target=chrome49,firefox52`), plain colours instead of `oklch()`, no `<dialog>`, and xterm.js 4 or a plain `<pre>` terminal. guacamole-common-js can stay. This is a second page to maintain, and it still depends on points 1 to 3.
- **No JavaScript at all.** The server could send the screen as an MJPEG stream (`multipart/x-mixed-replace`), which even IE-era browsers show, with clicks sent as image-map form posts. Slow and crude, and IE on XP still cannot get past point 1.

## Controlling a Windows XP machine

This fits the multi-host design ([multi-host.md](multi-host.md)) better. deskport cannot run on XP (it needs Node 22, guacd is Linux-only, and cloudflared's Go toolchain dropped XP), but guacd can connect to XP's own Remote Desktop server from a Linux host. XP offers only the original RDP security layer, so the connection needs guacd's `security=rdp` instead of `any` (guacd's negotiation fails against Windows Server 2003 with `any`). In deskport that would be a screen source pointing at another RDP address, with its own credentials and `security=rdp`. It would add nothing to the XP machine and keep it off the internet, reachable only from the deskport host.

## Sources

- [Supermium on Wikipedia](https://wikipedia.com/wiki/Supermium) and its [PortableApps listing](https://portableapps.com/apps/internet/supermium-portable)
- [DigiCert: SNI browser support](https://knowledge.digicert.com/general-information/iis-8-sni-browser-support)
- [Cloudflare: Introducing Universal SSL](https://ghost.blog.cloudflare.com/introducing-universal-ssl)
- [GUACAMOLE-932: RDP to Windows Server 2003 fails security negotiation](https://issues.apache.org/jira/browse/GUACAMOLE-932)
- [guacamole-server RDP settings](https://apache.googlesource.com/guacamole-server/+/6940875e6e16c6e4034b2c59a8748a1ac1bca305/src/protocols/rdp/settings.c)
