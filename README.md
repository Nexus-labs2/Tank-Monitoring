# Tank Monitor — Deployment Guide

## Architecture

```
Node 1 (ESP32+LoRa+ToF+relay, on tank)
   ⇅ LoRa
Node 2 (ESP32+LoRa+WiFi, bridge)
   ⇅ HTTPS
Backend (Node.js/Express/Socket.IO, on Render)
   ⇅ WebSocket
Frontend (React, on Render)
```

## 1. Deploy the backend first

1. Push the `backend/` folder to its own GitHub repo (or a subfolder Render can target).
2. On Render: **New → Web Service** → connect the repo.
   - Root directory: `backend`
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free tier is fine to start.
3. Once deployed, note the URL Render gives you, e.g. `https://tank-monitor-backend.onrender.com`.

**Free-tier gotcha:** Render's free web services spin down after ~15 min idle and take 30-60s to wake on the next request. Node 2's HTTP calls will just fail/timeout during that wake-up window — not a big deal for a hobby build, but worth knowing before you assume the ESP32 code is broken.

## 2. Deploy the frontend

1. In `frontend/.env.example`, copy to `.env` and set `VITE_BACKEND_URL` to the backend URL from step 1. On Render itself, set this as an environment variable in the dashboard instead of committing a `.env` file.
2. Push the `frontend/` folder to a repo.
3. On Render: **New → Static Site** (or Web Service if you prefer server-rendering, but a static site is enough here since Vite builds static assets).
   - Root directory: `frontend`
   - Build command: `npm install && npm run build`
   - Publish directory: `dist`
   - Add environment variable: `VITE_BACKEND_URL` = your backend URL.

## 3. Flash the firmware

1. In `Node2_ReceiverUnit.ino`, set `WIFI_SSID`, `WIFI_PASSWORD`, and `BACKEND_HOST` to your backend's Render URL.
2. In `Node1_TankUnit.ino`, calibrate `TANK_HEIGHT_MM` / `TANK_FULL_OFFSET_MM` as before.
3. Flash both boards, power them up, and open Serial Monitor on both to confirm:
   - Node 1: `TX -> L:.. ,D:..,P:..,M:..` every 5s.
   - Node 2: `RX <- ...` followed by `POST /api/telemetry -> 200`.
4. Open the frontend URL — you should see the tank fill animate and the status pill go green ("Live").

## Notes on what's still an MVP simplification

- Backend state is in-memory — a Render restart or the free-tier sleep cycle wipes the fill-history buffer client-side too (it's kept in React state, not persisted). Fine for live monitoring; if you want historical graphs later, that needs a real database.
- `WiFiClientSecure::setInsecure()` skips TLS certificate validation on the ESP32 side — standard shortcut for hobby projects hitting HTTPS, but flag it if you ever handle sensitive data over this link.
- Manual relay overrides expire after 15 minutes on Node 1 itself (not just in the UI) so a lost WiFi connection can't leave a pump stuck on indefinitely.
