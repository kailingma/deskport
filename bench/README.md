# Bench

`npm run bench` (or `node bench/run.mjs`) measures the Screen view's encodings and the Terminal at simulated links, and saves the results under `bench/results/`. It is the yardstick for speed changes: a change becomes the default only if the bench shows it at least as good as the current path, and both numbers go into `docs/decisions.md`.

It starts its own server from this checkout on a spare port, with Access checks off and a throwaway tmux session, and stops both at the end. All screen input goes to the separate desktop (`source=session`), which it starts if needed; nothing reaches My monitor.

```
node bench/run.mjs [--label name] [--runs n] [--links loopback,4m,1m]
                   [--cases images,av1,h264,term] [--query extra=params] [--base host:port]
node bench/compare.mjs bench/results/<before>.json bench/results/<after>.json
```

`--query path=direct` measures the direct screen path (architecture.md) for the video cases.

## Links

`lib/link.mjs` is a TCP proxy between the bench's client and the server. It delays each direction by half the round trip, limits each direction to the link's rate (one limit shared by all of a case's sockets), and buffers without limit, as Cloudflare's edge does.

| Link | Rate | Round trip |
| --- | --- | --- |
| `loopback` | none | 0 |
| `4m` | 4 Mbit/s | 150 ms |
| `1m` | 1 Mbit/s | 400 ms |

## Screen cases

`images`, `av1` and `h264`: a 1280 × 720 browser at 96 dpi, quality High, full resolution, Responsiveness, encoder speed 0 and Adapt bitrate for the video encodings. The client connects as the page does (`/ws/screen`, and `/ws/video` for video) and acknowledges each frame when it arrives, so the numbers leave out the browser's decoding and drawing.

| Column | What it is |
| --- | --- |
| key ms, key p90, missed | Keystroke to pixel: from sending a key until the next picture update arrives (a drawing instruction for images, a video frame for video). 12 letters and 12 backspaces typed into the Activities search. Before each key the bench waits until the link has delivered everything and no update came for 300 ms, and updates sooner than one round trip after the key do not count, so an update already queued cannot pass for the key's answer. Missed: no update within 5 s. |
| press ms | The same for a large change: Super, opening or closing the Activities overview, 28 times 350 ms apart, without waiting in between. |
| catch-up ms | After the last press, how long until the link has delivered everything and no update came for 1.5 s (at most 60 s): how far the picture fell behind. |
| motion fps | Picture updates per second during the presses and catch-up. |
| motion, typing, idle KB/min | Bytes the server sent into the link (after WebSocket compression) per minute of each phase. Idle is 5 s with no input. |
| encode ms | Video only: median time from capture to encoded frame, from the server's `stats` messages. guacd and GNOME's RDP encoder do not report this for images. |
| first ms | Socket open to first picture. |

GNOME on the separate desktop draws only one or two frames per overview press, so the motion phase measures large changes, not continuous animation.

## Terminal case

`term`: 15 characters typed at the prompt (key ms is the echo), then `seq 1 50000000` for 3 s and Ctrl+C. Ctrl-c ms is the time until the prompt answers again, flood KB the bytes that crossed the link from the flood's start until then.

## Results

One JSON file per run, `bench/results/<date>-<label>.json`, with the commit, whether the tree was dirty, the server settings that change the path (`DESKPORT_RELAY`, passed on from the bench's environment), the link profiles and every case's raw numbers. The table shows the median over runs. `baseline` is the reference for the current path.
