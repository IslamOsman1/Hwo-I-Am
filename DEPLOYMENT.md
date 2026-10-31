# Render deployment — 1 November 2026

- Public service: https://menana-trivia.onrender.com
- Health endpoint: https://menana-trivia.onrender.com/health
- Dashboard: https://dashboard.render.com/web/srv-dbj6dj0u01pc73eje6o0
- Repository: https://github.com/IslamOsman1/Hwo-I-Am (main)
- Source directory: `server/`
- Runtime: Node, build `npm ci`, start `npm start`
- Environment: `NODE_ENV=production`, `DATA_DIR=./storage`
- Plan: Free, 512 MB / 0.1 CPU. No paid resources created.
- WebSocket: `wss://menana-trivia.onrender.com/ws`

Free-instance storage is ephemeral. Rooms may be lost across restarts/deploys;
reconnection is verified while the server retains the room. Cold starts can delay
the first connection; the Android app allows 90 seconds.

Public smoke test passed: health reports 340 questions; two real WSS clients
create/join, ready, answer privately, review 20/0 → 10/10 after host correction,
reject guest correction, retain original text/time, rank by correct-answer speed,
finish and resume. Full-score mode returns 20/20. Signaling relay also passed.
Run again from the full local app workspace:

```sh
node tools/trivia_remote_smoke.mjs https://menana-trivia.onrender.com
```

`TURN_URLS` and `TURN_SECRET` have not been configured: they require a real coturn
service with the same shared secret. No placeholder credentials were installed.
A two-phone cross-network audio/video call has not been verified.
