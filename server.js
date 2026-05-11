/**
 * ============================================================
 *  BLINDFOLD TOWER  —  server.js
 *  Single-file Node.js server (Colyseus + Matter.js + Express)
 *  Node >= 18 required.  No TypeScript build step needed.
 * ============================================================
 *
 *  BUG FIX (v1 → v2):
 *  @colyseus/schema v2 (installed as 2.x) removed the per-property
 *  decorator syntax:  type("number")(Class.prototype, "field")
 *  That syntax produced undefined MapSchema/ArraySchema fields,
 *  causing "Cannot read properties of undefined (reading 'size')"
 *  and WebSocket close 4216/1005 on first room join.
 *
 *  Fix requires two things:
 *    1. Use defineTypes(Class, { field: 'type' }) — registers the schema
 *    2. Initialise MapSchema / ArraySchema in the constructor — mandatory
 *       in v2; without new MapSchema() the property stays undefined.
 */

"use strict";

// ─── Dependencies ────────────────────────────────────────────
const express    = require("express");
const path       = require("path");
const cors       = require("cors");
const Matter     = require("matter-js");
const { Server, Room } = require("@colyseus/core");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { Schema, MapSchema, ArraySchema, defineTypes } = require("@colyseus/schema");

// ─── Config ──────────────────────────────────────────────────
const PORT            = process.env.PORT || 2567;
const TICK_HZ         = 30;
const TICK_MS         = 1000 / TICK_HZ;
const GRAVITY_Y       = 1.5;
const FLOOR_Y         = 550;
const STABLE_VEL      = 0.08;  // px/tick threshold for "at rest"
const STABLE_MS       = 1500;  // ms block must be at rest to count as stable
const DEAD_Y          = 620;   // blocks below this Y are removed
const MAX_CHAT_LEN    = 200;
const RECONN_SECS     = 30;
const ROUNDS_PER_GAME = 3;
const ROUND_SEC       = 90;

// ─── Room ID Generator (6-character alphanumeric codes) ──────
function generateRoomCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// ─── Schemas ─────────────────────────────────────────────────

class BlockState extends Schema {
  constructor() {
    super();
    this.x       = 0;
    this.y       = 0;
    this.angle   = 0;
    this.w       = 60;
    this.h       = 30;
    this.settled = false;
    this.ownerId = "";
  }
}
defineTypes(BlockState, {
  x: "number", y: "number", angle: "number",
  w: "number", h: "number",
  settled: "boolean", ownerId: "string",
});

class PlayerState extends Schema {
  constructor() {
    super();
    this.id         = "";
    this.name       = "";
    this.isBlind    = false;
    this.isReady    = false;
    this.isHost     = false;
    this.score      = 0;
    this.blindCount = 0;
    this.pendingX   = 0;
    this.pendingW   = 60;
    this.pendingH   = 30;
    this.hasPending = false;
  }
}
defineTypes(PlayerState, {
  id: "string", name: "string",
  isBlind: "boolean", isReady: "boolean", isHost: "boolean",
  score: "number", blindCount: "number",
  pendingX: "number", pendingW: "number", pendingH: "number",
  hasPending: "boolean",
});

class ChatMsg extends Schema {
  constructor() {
    super();
    this.from = "";
    this.text = "";
    this.ts   = 0;
  }
}
defineTypes(ChatMsg, { from: "string", text: "string", ts: "number" });

class GameState extends Schema {
  constructor() {
    super();
    // CRITICAL: Must instantiate MapSchema/ArraySchema here.
    // defineTypes alone registers the type but leaves the property
    // undefined — accessing .size/.set/.forEach on undefined throws.
    this.players      = new MapSchema();
    this.blocks       = new MapSchema();
    this.chat         = new ArraySchema();
    this.phase        = "lobby";
    this.round        = 0;
    this.roundMax     = ROUNDS_PER_GAME;
    this.timerMs      = 0;
    this.blindId      = "";
    this.lastGuidance = "";
    this.stableHeight = 0;
  }
}
defineTypes(GameState, {
  phase: "string", round: "number", roundMax: "number", timerMs: "number",
  blindId: "string", lastGuidance: "string", stableHeight: "number",
  players: { map: PlayerState },
  blocks:  { map: BlockState  },
  chat:    [ ChatMsg ],
});

// ─── Utilities ───────────────────────────────────────────────

function sanitizeChat(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))
    .trim()
    .slice(0, MAX_CHAT_LEN);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

let _uid = 0;
function uid() { return `b${Date.now()}_${++_uid}`; }

// Fair blind rotation: pick player with fewest blind turns; ties broken randomly
function pickNextBlind(players, currentBlindId) {
  const eligible = [...players.values()].filter(p => p.id !== currentBlindId);
  if (!eligible.length) return [...players.values()][0]?.id ?? null;
  const minCount = Math.min(...eligible.map(p => p.blindCount));
  const pool = eligible.filter(p => p.blindCount === minCount);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

// Rate limiter: max N messages per second per client ID
class RateLimit {
  constructor(maxPerSec) { this._max = maxPerSec; this._window = {}; }
  allow(id) {
    const sec = Math.floor(Date.now() / 1000);
    if (!this._window[id] || this._window[id].sec !== sec)
      this._window[id] = { sec, count: 0 };
    return ++this._window[id].count <= this._max;
  }
}

// ─── TowerRoom ───────────────────────────────────────────────

class TowerRoom extends Room {

  onCreate(options) {
    this.setState(new GameState());

    // Physics world — server-only
    this._engine    = Matter.Engine.create({ gravity: { y: GRAVITY_Y } });
    this._bodies    = {};   // blockId → Matter.Body
    this._stableFor = {};   // blockId → accumulated ms at rest

    // Static floor and walls
    Matter.Composite.add(this._engine.world, [
      Matter.Bodies.rectangle(400, FLOOR_Y + 25, 800, 50, { isStatic: true, label: "floor" }),
      Matter.Bodies.rectangle(-25,  300, 50, 700, { isStatic: true }),
      Matter.Bodies.rectangle(825,  300, 50, 700, { isStatic: true }),
    ]);

    this._chatRL    = new RateLimit(2);
    this._roundTimer = null;
    this._physTick  = null;
    this._hostId    = null;

    // ── Message handlers ─────────────────────────────────────

    this.onMessage("ready", (client) => {
      const p = this.state.players.get(client.sessionId);
      if (p) p.isReady = !p.isReady;
    });

    this.onMessage("host_start", (client) => {
      if (client.sessionId !== this._hostId) return;
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size < 2) return;  // PITFALL-GUARD: min 2 players
      this._startGame();
    });

    this.onMessage("spawn_block", (client, data) => {
      if (this.state.phase !== "playing") return;
      if (client.sessionId !== this.state.blindId) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.hasPending) return;  // PITFALL-GUARD: no double-spawn
      p.pendingX   = clamp(typeof data.x === "number" ? data.x : 400, 50, 750);
      p.pendingW   = clamp(typeof data.w === "number" ? data.w : 60,  20, 120);
      p.pendingH   = clamp(typeof data.h === "number" ? data.h : 30,  15, 60);
      p.hasPending = true;
    });

    this.onMessage("move_block", (client, data) => {
      if (this.state.phase !== "playing") return;
      if (client.sessionId !== this.state.blindId) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.hasPending) return;  // PITFALL-GUARD: must have pending block
      const dx = clamp(typeof data.dx === "number" ? data.dx : 0, -50, 50);
      p.pendingX = clamp(p.pendingX + dx, 50, 750);
    });

    this.onMessage("drop_block", (client) => {
      if (this.state.phase !== "playing") return;
      if (client.sessionId !== this.state.blindId) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || !p.hasPending) return;  // PITFALL-GUARD: idempotent — no double-drop

      const id   = uid();
      const body = Matter.Bodies.rectangle(p.pendingX, 30, p.pendingW, p.pendingH, {
        restitution: 0.05, friction: 0.8, frictionAir: 0.01, label: id,
      });
      Matter.Composite.add(this._engine.world, body);
      this._bodies[id]    = body;
      this._stableFor[id] = 0;

      const bs     = new BlockState();
      bs.x         = p.pendingX;
      bs.y         = 30;
      bs.w         = p.pendingW;
      bs.h         = p.pendingH;
      bs.ownerId   = client.sessionId;
      this.state.blocks.set(id, bs);

      p.hasPending = false;
      p.pendingX = p.pendingW = p.pendingH = 0;
    });

    this.onMessage("chat", (client, data) => {
      if (!this._chatRL.allow(client.sessionId)) return;  // rate limit
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const text = sanitizeChat(typeof data.text === "string" ? data.text : "");
      if (!text) return;
      const msg = new ChatMsg();
      msg.from = sanitizeChat(p.name).slice(0, 20);
      msg.text = text;
      msg.ts   = Date.now();
      this.state.chat.push(msg);
      while (this.state.chat.length > 50) this.state.chat.splice(0, 1);
    });

    // Guidance: sighted player sends text → stored in state so blind player
    // always has latest on reconnect/re-render (PITFALL-GUARD: context loss fix)
    this.onMessage("guidance", (client, data) => {
      if (this.state.phase !== "playing") return;
      if (client.sessionId === this.state.blindId) return;
      const text = sanitizeChat(typeof data.text === "string" ? data.text : "");
      if (text) this.state.lastGuidance = text;
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────

  onJoin(client, options) {
    const name = sanitizeChat((options && options.name) || "Player").slice(0, 20) || "Player";
    const p    = new PlayerState();
    p.id       = client.sessionId;
    p.name     = name;
    if (this.state.players.size === 0) {
      p.isHost     = true;
      this._hostId = client.sessionId;
    }
    this.state.players.set(client.sessionId, p);
  }

  async onLeave(client, consented) {
    if (!consented) {
      try {
        await this.allowReconnection(client, RECONN_SECS);  // 30s window
        return;
      } catch { /* timed out — clean up below */ }
    }

    // Promote a new host if needed
    if (client.sessionId === this._hostId) {
      const others = [...this.state.players.keys()].filter(id => id !== client.sessionId);
      if (others.length) {
        this._hostId = others[0];
        this.state.players.get(this._hostId).isHost = true;
      }
    }

    // Re-assign blind if the blind player left mid-round
    if (client.sessionId === this.state.blindId && this.state.phase === "playing") {
      this.state.players.delete(client.sessionId);
      this._assignNextBlind();
    } else {
      this.state.players.delete(client.sessionId);
    }

    // Solo player remaining → end game
    if (this.state.players.size < 2 && this.state.phase === "playing") {
      this._endGame();
    }
  }

  onDispose() {
    this._stopPhysics();
    if (this._roundTimer) clearTimeout(this._roundTimer);
  }

  // ── Round management ──────────────────────────────────────

  _startGame() {
    this.state.round = 0;
    this.state.players.forEach(p => { p.score = 0; p.blindCount = 0; });
    this._startRound();
  }

  _startRound() {
    this.state.round++;
    if (this.state.round > ROUNDS_PER_GAME) { this._endGame(); return; }
    this._clearBlocks();
    this._assignNextBlind();
    this.state.phase        = "playing";
    this.state.timerMs      = ROUND_SEC * 1000;
    this.state.lastGuidance = "";
    this.state.stableHeight = 0;
    this._startPhysics();
    this._roundTimer = setTimeout(() => this._endRound(), ROUND_SEC * 1000);
  }

  _endRound() {
    this._stopPhysics();
    if (this._roundTimer) { clearTimeout(this._roundTimer); this._roundTimer = null; }
    const height = this._computeStableHeight();
    const blind  = this.state.players.get(this.state.blindId);
    if (blind) blind.score += height;
    this.state.stableHeight = height;
    this.state.phase = "roundEnd";
    setTimeout(() => this._startRound(), 4000);
  }

  _endGame() {
    this._stopPhysics();
    if (this._roundTimer) { clearTimeout(this._roundTimer); this._roundTimer = null; }
    this._clearBlocks();
    this.state.phase = "end";
  }

  _assignNextBlind() {
    const nextId = pickNextBlind(this.state.players, this.state.blindId);
    this.state.players.forEach(p => { p.isBlind = false; });
    if (nextId) {
      const np = this.state.players.get(nextId);
      if (np) { np.isBlind = true; np.blindCount++; this.state.blindId = nextId; }
    }
  }

  _clearBlocks() {
    Object.values(this._bodies).forEach(b => Matter.Composite.remove(this._engine.world, b));
    this._bodies    = {};
    this._stableFor = {};
    this.state.blocks.clear();
    this.state.players.forEach(p => { p.hasPending = false; });
  }

  // ── Physics tick ─────────────────────────────────────���────

  _startPhysics() {
    if (this._physTick) return;
    this._physTick = setInterval(() => this._tick(), TICK_MS);
  }

  _stopPhysics() {
    if (this._physTick) { clearInterval(this._physTick); this._physTick = null; }
  }

  _tick() {
    if (this.state.phase !== "playing") return;
    Matter.Engine.update(this._engine, TICK_MS);

    const toRemove = [];
    for (const [id, body] of Object.entries(this._bodies)) {
      const bs = this.state.blocks.get(id);
      if (!bs) continue;
      if (body.position.y > DEAD_Y) { toRemove.push(id); continue; }

      bs.x     = Math.round(body.position.x * 10) / 10;
      bs.y     = Math.round(body.position.y * 10) / 10;
      bs.angle = Math.round(body.angle * 1000) / 1000;

      const speed = Math.hypot(body.velocity.x, body.velocity.y);
      if (speed < STABLE_VEL) {
        this._stableFor[id] = (this._stableFor[id] || 0) + TICK_MS;
      } else {
        this._stableFor[id] = 0;
        bs.settled = false;
      }
      if (this._stableFor[id] >= STABLE_MS) bs.settled = true;
    }

    toRemove.forEach(id => {
      Matter.Composite.remove(this._engine.world, this._bodies[id]);
      delete this._bodies[id];
      delete this._stableFor[id];
      this.state.blocks.delete(id);
    });

    this.state.stableHeight = this._computeStableHeight();
    this.state.timerMs = Math.max(0, this.state.timerMs - TICK_MS);
  }

  _computeStableHeight() {
    let minY = FLOOR_Y;
    for (const bs of this.state.blocks.values()) {
      if (bs.settled && bs.y < minY) minY = bs.y;
    }
    return Math.max(0, Math.round(FLOOR_Y - minY));
  }
}

// ─── Express + Colyseus bootstrap ────────────────────────────

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, "client")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "client", "index.html")));

const gameServer = new Server({
  transport: new WebSocketTransport({ server: require("http").createServer(app) }),
});

// Define "tower" room WITH custom 6-character room code generator
gameServer.define("tower", TowerRoom);

// Override room spawning to use custom ID generator
gameServer.onBeforeCreate = async (options) => {
  options.name = "tower";
};

// Create a handler to generate the room ID
const originalDefine = gameServer.define.bind(gameServer);
gameServer.define = function(name, handler, options = {}) {
  options.generateRoomIdFn = generateRoomCode;
  return originalDefine(name, handler, options);
};

// Re-define tower room with custom ID generator
gameServer.define("tower", TowerRoom, {
  generateRoomIdFn: generateRoomCode,
});

gameServer.listen(PORT).then(() => {
  console.log(`\n🗼 Blindfold Tower running on http://localhost:${PORT}`);
  console.log(`   Colyseus Monitor: http://localhost:${PORT}/colyseus\n`);
}).catch(err => { console.error("Failed to start:", err); process.exit(1); });
