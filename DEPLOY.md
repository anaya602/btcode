# 🗼 Blindfold Tower — Deployment Guide
**For the deployment team.** Everything you need to run this from zero.

---

## What's In The Package

```
blindfold-tower/
├── server.js          ← Entire backend (Colyseus + Matter.js physics + Express)
├── package.json       ← Dependencies + npm scripts
├── render.yaml        ← One-click Render.com deploy config
└── client/
    └── index.html     ← Entire frontend (Pixi.js + Colyseus client, no build step)
```

**Total: 3 source files, ~1,600 lines of code.**
No TypeScript compilation. No frontend build. Drop it on a server and go.

---

## System Requirements

| Requirement | Minimum |
|---|---|
| Node.js | **18.x or higher** (LTS recommended) |
| npm | 8+ (ships with Node 18) |
| RAM | 256 MB (free tier is fine for < 100 users) |
| Ports | One open TCP port (default: **2567**) |
| OS | Any Linux / macOS / Windows |

---

## Option A — Local / LAN (fastest, zero config)

```bash
# 1. Unzip the package
unzip blindfold-tower.zip
cd blindfold-tower

# 2. Install dependencies (one time only)
npm install

# 3. Start the server
npm start
# → "🗼 Blindfold Tower running on http://localhost:2567"

# 4. Open in browser
#    http://localhost:2567
#
#    Other players on the same LAN:
#    http://<your-local-IP>:2567
#    (find your IP with: ifconfig / ipconfig / ip addr)
```

**Test with multiple clients:** open 3 browser tabs pointing at the same URL.
One player creates a room, others join with the 6-character room code.

---

## Option B — Render.com (free, public URL, persistent)

Render gives a persistent WebSocket server on their free tier — suitable for
teams using this over Zoom.

### Steps

1. **Push to GitHub**
   ```bash
   cd blindfold-tower
   git init
   git add .
   git commit -m "initial"
   # Create a repo on github.com, then:
   git remote add origin https://github.com/YOUR_ORG/blindfold-tower.git
   git push -u origin main
   ```

2. **Create Render Web Service**
   - Go to [render.com](https://render.com) → New → Web Service
   - Connect your GitHub repo
   - Render auto-detects `render.yaml` — click **Deploy**

   Or fill manually:
   | Field | Value |
   |---|---|
   | Environment | Node |
   | Build Command | `npm install` |
   | Start Command | `node server.js` |
   | Instance Type | Free |
   | Port | `10000` (Render sets this via `$PORT` env var) |

3. **Done.** Render gives you a URL like `https://blindfold-tower-xxxx.onrender.com`.
   Share that URL with your team. No other config needed.

> **Free tier note:** Render free web services sleep after 15 minutes of
> inactivity. First request after sleep takes ~30 seconds to wake up.
> Upgrade to Starter ($7/mo) to keep it always-on.

---

## Option C — Any Linux VPS (DigitalOcean, Hetzner, AWS EC2, etc.)

```bash
# On the server:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Upload your zip (scp, rsync, etc.)
scp blindfold-tower.zip user@your-server:~

# On the server:
unzip blindfold-tower.zip
cd blindfold-tower
npm install

# Run with PM2 (keeps it alive after logout)
npm install -g pm2
pm2 start server.js --name blindfold-tower
pm2 save
pm2 startup   # follow instructions to auto-start on reboot
```

**Open firewall port:**
```bash
# Ubuntu/Debian with ufw:
sudo ufw allow 2567/tcp

# Or use nginx as a reverse proxy so players use port 80/443:
# (see Nginx section below)
```

### Optional: Nginx reverse proxy (port 80/443 → 2567)

```nginx
# /etc/nginx/sites-available/blindfold-tower
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:2567;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";   # ← WebSocket required
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/blindfold-tower /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `2567` | TCP port to listen on |
| `NODE_ENV` | _(unset)_ | Set to `production` to suppress Colyseus dev logs |

```bash
# Example override:
PORT=8080 node server.js
# or
export PORT=8080
npm start
```

---

## How The Game Works (Brief for Ops)

| Phase | What Happens |
|---|---|
| **Lobby** | Players join via room code. Host clicks Start when ≥ 2 players. |
| **Playing** | One player is randomly "blindfolded" — their screen goes black. Sighted players guide them via Zoom/voice. Blind player spawns + drops blocks via UI or keyboard. 90-second round timer. |
| **Round End** | Tower height scored (stable blocks only). Auto-advances to next round. |
| **Game End** | 3 rounds total. Final scores shown. Players return to lobby. |

**Roles rotate fairly** — no player is blind twice until everyone has had a turn.

**Reconnection** — players who drop have 30 seconds to reconnect without losing their session.

---

## Keyboard Shortcuts (for the blind player)

| Key | Action |
|---|---|
| `S` | Spawn a new block |
| `A` / `←` | Move pending block left |
| `D` / `→` | Move pending block right |
| `Space` | Drop the block |

---

## Multi-Client Test Procedure

```
1. npm start
2. Tab 1 → http://localhost:2567 → name "Alice" → Create Room → note code e.g. "ABCD12"
3. Tab 2 → http://localhost:2567 → name "Bob"   → Join Room → enter "ABCD12"
4. Tab 3 → http://localhost:2567 → name "Carol" → Join Room → enter "ABCD12"
5. All three click "I'm Ready ✓"
6. Alice (host) clicks "Start Game 🚀"
7. One player goes blind (black screen) — others guide via chat/voice
8. Drop blocks — watch tower grow on sighted screens
9. After 90s, round ends → next blind player assigned
```

**Colyseus live monitor** (local only):
```
http://localhost:2567/colyseus
```
Shows active rooms, player count, and live state diffs — useful for debugging.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error: address already in use` | Another process on port 2567. Run `PORT=2568 npm start` |
| Players can't connect from outside | Check firewall — port 2567 must be open TCP |
| Blocks jitter or desync | Normal on high-latency connections; server is authoritative, clients interpolate |
| Game won't start (button greyed) | Need at least 2 players in the room |
| Render service sleeping | First wake takes ~30s; upgrade plan or ping it every 14 min with a cron |
| `Cannot find module` errors | Run `npm install` inside the `blindfold-tower/` directory |
| WebSocket fails on HTTPS reverse proxy | Ensure nginx passes `Upgrade` and `Connection` headers (see config above) |

---

## File Sizes & Load Estimates

| Component | Size |
|---|---|
| `server.js` | ~19 KB source |
| `client/index.html` | ~22 KB source |
| Pixi.js v7 (CDN) | ~1 MB (cached after first load) |
| Colyseus JS client (CDN) | ~120 KB (cached) |
| Server RAM per room | ~10–15 MB (Matter.js world) |
| **Supported concurrent rooms** | ~20+ on 256 MB RAM |

---

## Upgrading / Maintaining

```bash
# Check for package updates
npm outdated

# Update a specific package
npm install @colyseus/core@latest @colyseus/ws-transport@latest

# Restart with PM2 after update
pm2 restart blindfold-tower
```

No database. No migrations. No persistent storage. All state lives in memory
per room and resets when the room ends.

---

*Built with Node.js 20 · Colyseus 0.15 · Matter.js 0.19 · Pixi.js 7.3*
