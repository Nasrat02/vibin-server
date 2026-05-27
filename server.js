const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
  res.end('VIBIN PRO MAX - Multiplayer Server Running');
});

const wss = new WebSocket.Server({ server });

// lobbies: Map<lobbyCode, { host, guest, started, lastActivity }>
const lobbies = new Map();

function generateCode() {
  return Math.random().toString(36).substr(2, 5).toUpperCase();
}

function broadcast(lobby, msg, excludeSocket = null) {
  const data = JSON.stringify(msg);
  [lobby.host, lobby.guest].forEach(ws => {
    if (ws && ws !== excludeSocket && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Clean up dead lobbies every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, lobby] of lobbies.entries()) {
    if (now - lobby.lastActivity > 5 * 60 * 1000) {
      lobbies.delete(code);
      console.log(`Cleaned up lobby ${code}`);
    }
  }
}, 60 * 1000);

wss.on('connection', (ws) => {
  ws.lobbyCode = null;
  ws.role = null; // 'host' or 'guest'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    // ── CREATE LOBBY ──────────────────────────────────────────
    if (type === 'create_lobby') {
      let code = generateCode();
      while (lobbies.has(code)) code = generateCode();

      lobbies.set(code, {
        host: ws,
        guest: null,
        started: false,
        lastActivity: Date.now(),
        config: msg.config || {}
      });

      ws.lobbyCode = code;
      ws.role = 'host';
      send(ws, { type: 'lobby_created', code });
      console.log(`Lobby created: ${code}`);
    }

    // ── JOIN LOBBY ────────────────────────────────────────────
    else if (type === 'join_lobby') {
      const code = (msg.code || '').toUpperCase().trim();
      const lobby = lobbies.get(code);

      if (!lobby) {
        send(ws, { type: 'error', message: 'Lobby not found' }); return;
      }
      if (lobby.guest) {
        send(ws, { type: 'error', message: 'Lobby full' }); return;
      }
      if (lobby.started) {
        send(ws, { type: 'error', message: 'Game already started' }); return;
      }

      lobby.guest = ws;
      lobby.lastActivity = Date.now();
      ws.lobbyCode = code;
      ws.role = 'guest';

      send(ws, { type: 'lobby_joined', code });
      // Tell host guest arrived, relay their chosen character
      send(lobby.host, { type: 'guest_joined', guestName: msg.playerName || 'Guest', guestChar: msg.guestChar || 'nasrat' });
      console.log(`Guest joined lobby: ${code}`);
    }

    // ── START GAME (host only) ────────────────────────────────
    else if (type === 'start_game') {
      const lobby = lobbies.get(ws.lobbyCode);
      if (!lobby || ws.role !== 'host') return;
      if (!lobby.guest) {
        send(ws, { type: 'error', message: 'Waiting for a second player' }); return;
      }
      lobby.started = true;
      lobby.lastActivity = Date.now();
      // Send start signal with role assignments
      send(lobby.host, { type: 'game_start', role: 'host', config: msg.config });
      send(lobby.guest, { type: 'game_start', role: 'guest', config: msg.config });
      console.log(`Game started in lobby: ${ws.lobbyCode}`);
    }

    // ── GAME STATE RELAY ──────────────────────────────────────
    // Host sends full authoritative game state every tick
    else if (type === 'game_state') {
      const lobby = lobbies.get(ws.lobbyCode);
      if (!lobby || ws.role !== 'host') return;
      lobby.lastActivity = Date.now();
      broadcast(lobby, msg, ws); // relay to guest only
    }

    // ── PLAYER INPUT (guest sends input, host applies it) ─────
    else if (type === 'player_input') {
      const lobby = lobbies.get(ws.lobbyCode);
      if (!lobby || ws.role !== 'guest') return;
      lobby.lastActivity = Date.now();
      broadcast(lobby, msg, ws); // relay to host only
    }

    // ── SKILL USE ─────────────────────────────────────────────
    else if (type === 'skill_use') {
      const lobby = lobbies.get(ws.lobbyCode);
      if (!lobby) return;
      lobby.lastActivity = Date.now();
      broadcast(lobby, { ...msg, fromRole: ws.role }, ws);
    }

    // ── CHAT ─────────────────────────────────────────────────
    else if (type === 'chat') {
      const lobby = lobbies.get(ws.lobbyCode);
      if (!lobby) return;
      const safe = (msg.text || '').substr(0, 80).replace(/</g, '&lt;');
      broadcast(lobby, { type: 'chat', text: safe, fromRole: ws.role });
    }

    // ── PING ─────────────────────────────────────────────────
    else if (type === 'ping') {
      send(ws, { type: 'pong' });
    }
  });

  ws.on('close', () => {
    const code = ws.lobbyCode;
    if (!code) return;
    const lobby = lobbies.get(code);
    if (!lobby) return;

    // Notify the other player
    if (ws.role === 'host') {
      send(lobby.guest, { type: 'opponent_left', message: 'Host disconnected' });
      lobbies.delete(code);
    } else {
      lobby.guest = null;
      lobby.started = false;
      send(lobby.host, { type: 'opponent_left', message: 'Guest disconnected' });
    }
    console.log(`Player left lobby: ${code}`);
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`VIBIN Multiplayer Server running on port ${PORT}`);
});
