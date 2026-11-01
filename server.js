/**
 * Wink Murder — real-time game server
 * ------------------------------------
 * A companion app for the in-person "wink assassin" party game (a Mafia twist).
 * The app is the source of truth for: who is alive/dead, role assignment,
 * accusation/voting rounds, and win conditions. The winking/killing itself
 * happens physically in the room.
 *
 * Tech: Express (serves /public) + Socket.IO (real-time state).
 * Games live in memory only — perfect for ephemeral party sessions.
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, games: games.size }));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REVEAL_SECONDS = 15;      // silent role-reveal window
const JOIN_SECONDS = 20;        // "join the accusation?" window
const MAX_PLAYERS = 30;

// Distinct, high-contrast colors assigned to players in order.
const COLORS = [
  { name: 'Red',     hex: '#ef4444' },
  { name: 'Blue',    hex: '#3b82f6' },
  { name: 'Green',   hex: '#22c55e' },
  { name: 'Amber',   hex: '#f59e0b' },
  { name: 'Purple',  hex: '#a855f7' },
  { name: 'Pink',    hex: '#ec4899' },
  { name: 'Cyan',    hex: '#06b6d4' },
  { name: 'Orange',  hex: '#f97316' },
  { name: 'Lime',    hex: '#84cc16' },
  { name: 'Teal',    hex: '#14b8a6' },
  { name: 'Indigo',  hex: '#6366f1' },
  { name: 'Rose',    hex: '#f43f5e' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Violet',  hex: '#8b5cf6' },
  { name: 'Sky',     hex: '#0ea5e9' },
  { name: 'Fuchsia', hex: '#d946ef' },
  { name: 'Yellow',  hex: '#eab308' },
  { name: 'Mint',    hex: '#2dd4bf' },
  { name: 'Coral',   hex: '#fb7185' },
  { name: 'Slate',   hex: '#64748b' },
];

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/** @type {Map<string, Game>} */
const games = new Map();

function makeCode() {
  // 4-char, no ambiguous chars (0/O/1/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (games.has(code));
  return code;
}

function newGame(hostSocketId) {
  return {
    code: makeCode(),
    hostId: hostSocketId,          // player.id of the host
    phase: 'lobby',                // lobby | reveal | playing | accusation | ended
    players: [],                   // Player[]
    config: { murdererCount: 1 },
    revealEndsAt: null,
    round: null,                   // accusation round state
    winner: null,                  // 'innocents' | 'murderers'
    log: [],                       // human-readable event feed
    timers: {},                    // active setTimeout handles (not serialized)
    createdAt: Date.now(),
  };
}

function newPlayer(socketId, name, isHost) {
  return {
    id: socketId,
    name,
    color: null,
    isHost,
    role: null,       // 'murderer' | 'innocent'
    alive: true,
    connected: true,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const alivePlayers = (g) => g.players.filter((p) => p.alive);
const aliveMurderers = (g) => g.players.filter((p) => p.alive && p.role === 'murderer');
const aliveInnocents = (g) => g.players.filter((p) => p.alive && p.role === 'innocent');

function assignColor(game) {
  const taken = new Set(game.players.map((p) => p.color && p.color.hex));
  const free = COLORS.find((c) => !taken.has(c.hex));
  // Fall back to a generated color if we somehow run out.
  return free || { name: `C${game.players.length + 1}`, hex: `hsl(${(game.players.length * 47) % 360} 70% 55%)` };
}

function pushLog(game, text) {
  game.log.unshift({ t: Date.now(), text });
  if (game.log.length > 40) game.log.pop();
}

function clearTimers(game) {
  Object.values(game.timers).forEach((h) => clearTimeout(h));
  game.timers = {};
}

/**
 * Build the state view for a specific viewer. Other players' roles are hidden
 * until the game ends — each viewer only ever learns their own role mid-game.
 */
function viewFor(game, viewerId) {
  const ended = game.phase === 'ended';
  return {
    code: game.code,
    phase: game.phase,
    hostId: game.hostId,
    youId: viewerId,
    config: game.config,
    revealEndsAt: game.revealEndsAt,
    winner: game.winner,
    log: game.log,
    counts: {
      alive: alivePlayers(game).length,
      murderersAlive: aliveMurderers(game).length,
      innocentsAlive: aliveInnocents(game).length,
      total: game.players.length,
    },
    round: game.round
      ? (() => {
          const viewer = getPlayer(game, viewerId);
          const isAccuser = viewerId === game.round.accuserId;
          const isSuspect = viewerId === game.round.suspectId;
          const eligible = !!(viewer && viewer.alive && !isAccuser && !isSuspect);
          return {
            accuserId: game.round.accuserId,
            suspectId: game.round.suspectId,
            endsAt: game.round.endsAt,
            voters: game.round.voters,                 // accuser + everyone who joined
            isAccuser,
            isSuspect,
            eligible,                                   // may still tap Yes/No
            youJoined: game.round.voters.includes(viewerId),
            youResponded: game.round.responded.includes(viewerId),
          };
        })()
      : null,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      alive: p.alive,
      connected: p.connected,
      // role visible only for yourself, or for everyone once the game ends
      role: ended || p.id === viewerId ? p.role : null,
      you: p.id === viewerId,
    })),
  };
}

/** Emit a personalized state to every connected socket in the game room. */
function broadcast(game) {
  for (const p of game.players) {
    if (p.connected) io.to(p.id).emit('state', viewFor(game, p.id));
  }
}

function findGameBySocket(socketId) {
  for (const g of games.values()) {
    if (g.players.some((p) => p.id === socketId)) return g;
  }
  return null;
}

function getPlayer(game, id) {
  return game.players.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
// Win-condition check (runs after every elimination / death)
// ---------------------------------------------------------------------------

function checkWin(game) {
  const m = aliveMurderers(game).length;
  const i = aliveInnocents(game).length;
  if (m === 0) {
    endGame(game, 'innocents', 'All murderers have been eliminated.');
    return true;
  }
  if (m >= i) {
    endGame(game, 'murderers', 'Murderers now equal or outnumber the innocents.');
    return true;
  }
  return false;
}

function endGame(game, winner, reason) {
  clearTimers(game);
  game.phase = 'ended';
  game.winner = winner;
  game.round = null;
  game.revealEndsAt = null;
  pushLog(game, `🏁 ${winner === 'innocents' ? 'Innocents' : 'Murderers'} win — ${reason}`);
}

// ---------------------------------------------------------------------------
// Accusation / voting round
// ---------------------------------------------------------------------------

/**
 * Resolve the accusation. The accuser named ONE suspect; everyone who joined
 * is backing that single accusation.
 *   - Suspect is a murderer  -> that murderer is caught & removed.
 *   - Suspect is innocent     -> ONLY the accusers (accuser + joiners) are out.
 * The named suspect is never "swept" by a wrong guess, and sit-outs are safe.
 */
function resolveRound(game) {
  const round = game.round;
  if (!round) return;
  clearTimeout(game.timers.round);

  const suspect = getPlayer(game, round.suspectId);
  const voterIds = round.voters;

  game.round = null;
  game.phase = 'playing';

  if (suspect && suspect.alive && suspect.role === 'murderer') {
    // Correct! The accused really is a murderer — caught and removed.
    suspect.alive = false;
    pushLog(game, `✅ ${suspect.name} was accused and is a MURDERER — caught and eliminated!`);
    if (!checkWin(game)) pushLog(game, 'A murderer remains. The game continues.');
    broadcast(game);
    return;
  }

  // Wrong! The accused was innocent. Only the INNOCENT accusers are eliminated —
  // a murderer who recklessly joined is NOT swept in, so a wrong guess can never
  // hand the innocents a win. The real murderer stays hidden and in play.
  const eliminated = [];
  for (const id of voterIds) {
    const pl = getPlayer(game, id);
    if (pl && pl.role !== 'murderer') { pl.alive = false; eliminated.push(pl.name); }
  }
  if (eliminated.length) {
    pushLog(game, `❌ ${suspect ? suspect.name : 'The accused'} was INNOCENT. Wrong accusers eliminated: ${eliminated.join(', ')}. The murderer is still out there.`);
  } else {
    pushLog(game, `❌ ${suspect ? suspect.name : 'The accused'} was INNOCENT — no innocent accusers to eliminate. The murderer is still among you.`);
  }
  checkWin(game);
  broadcast(game);
}

/** Close the join window early once every eligible player has responded. */
function maybeCloseJoinWindow(game) {
  const round = game.round;
  if (!round) return;
  const eligibleIds = alivePlayers(game)
    .map((p) => p.id)
    .filter((id) => id !== round.accuserId && id !== round.suspectId);
  const pending = eligibleIds.filter((id) => !round.responded.includes(id));
  if (pending.length === 0) resolveRound(game);
}

// ---------------------------------------------------------------------------
// Socket handlers
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  const ack = (cb, payload) => typeof cb === 'function' && cb(payload);

  // --- Host creates a game -------------------------------------------------
  socket.on('create_game', ({ name }, cb) => {
    name = (name || '').trim().slice(0, 20) || 'Host';
    const game = newGame(socket.id);
    const host = newPlayer(socket.id, name, true);
    host.color = assignColor(game);
    game.players.push(host);
    games.set(game.code, game);
    socket.join(game.code);
    pushLog(game, `🎮 ${name} created the game.`);
    ack(cb, { ok: true, code: game.code });
    broadcast(game);
  });

  // --- Player joins an existing game --------------------------------------
  socket.on('join_game', ({ code, name }, cb) => {
    code = (code || '').trim().toUpperCase();
    name = (name || '').trim().slice(0, 20);
    const game = games.get(code);
    if (!game) return ack(cb, { ok: false, error: 'No game with that code.' });
    if (game.phase !== 'lobby') return ack(cb, { ok: false, error: 'That game has already started.' });
    if (game.players.length >= MAX_PLAYERS) return ack(cb, { ok: false, error: 'That game is full.' });
    if (!name) return ack(cb, { ok: false, error: 'Please enter a name.' });
    if (game.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return ack(cb, { ok: false, error: 'That name is taken — pick another.' });

    const player = newPlayer(socket.id, name, false);
    player.color = assignColor(game);
    game.players.push(player);
    socket.join(game.code);
    pushLog(game, `➕ ${name} joined.`);
    ack(cb, { ok: true, code: game.code });
    broadcast(game);
  });

  // --- Host sets murderer count -------------------------------------------
  socket.on('set_config', ({ murdererCount }) => {
    const game = findGameBySocket(socket.id);
    if (!game || game.hostId !== socket.id || game.phase !== 'lobby') return;
    const max = Math.max(1, game.players.length - 1);
    const n = Math.min(max, Math.max(1, parseInt(murdererCount, 10) || 1));
    game.config.murdererCount = n;
    broadcast(game);
  });

  // --- Host starts the game: assign roles, run reveal window --------------
  socket.on('start_game', () => {
    const game = findGameBySocket(socket.id);
    if (!game || game.hostId !== socket.id || game.phase !== 'lobby') return;
    if (game.players.length < 3) {
      socket.emit('toast', { type: 'error', text: 'Need at least 3 players to start.' });
      return;
    }

    const murdererCount = Math.min(game.config.murdererCount, game.players.length - 1);

    // Shuffle (Fisher–Yates) and deal roles.
    const order = [...game.players];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    order.forEach((p, idx) => {
      p.role = idx < murdererCount ? 'murderer' : 'innocent';
      p.alive = true;
    });

    game.phase = 'reveal';
    game.revealEndsAt = Date.now() + REVEAL_SECONDS * 1000;
    pushLog(game, `🔎 Roles dealt: ${murdererCount} murderer(s), ${game.players.length - murdererCount} innocent(s). ${REVEAL_SECONDS}s to peek — no talking!`);
    broadcast(game);

    clearTimeout(game.timers.reveal);
    game.timers.reveal = setTimeout(() => {
      game.phase = 'playing';
      game.revealEndsAt = null;
      pushLog(game, '👁️ Game on! Watch for the wink.');
      broadcast(game);
    }, REVEAL_SECONDS * 1000);
  });

  // --- A player reports they were killed (winked) -------------------------
  socket.on('report_death', () => {
    const game = findGameBySocket(socket.id);
    if (!game || game.phase !== 'playing') return;
    const p = getPlayer(game, socket.id);
    if (!p || !p.alive) return;
    p.alive = false;
    pushLog(game, `💀 ${p.name} was killed. ✖️ Arms crossed.`);
    if (!checkWin(game)) broadcast(game);
    else broadcast(game);
  });

  // --- Host can also mark someone dead (backup) ---------------------------
  socket.on('mark_dead', ({ playerId }) => {
    const game = findGameBySocket(socket.id);
    if (!game || game.hostId !== socket.id || game.phase !== 'playing') return;
    const p = getPlayer(game, playerId);
    if (!p || !p.alive) return;
    p.alive = false;
    pushLog(game, `💀 ${p.name} was marked dead by the host.`);
    if (!checkWin(game)) broadcast(game);
    else broadcast(game);
  });

  // --- Raise hand → name ONE suspect → open an accusation round -----------
  socket.on('raise_hand', ({ suspectId }) => {
    const game = findGameBySocket(socket.id);
    if (!game || game.phase !== 'playing') return;
    const accuser = getPlayer(game, socket.id);
    if (!accuser || !accuser.alive) return;
    const suspect = getPlayer(game, suspectId);
    if (!suspect || !suspect.alive || suspect.id === accuser.id) {
      socket.emit('toast', { type: 'error', text: 'Pick a living player other than yourself to accuse.' });
      return;
    }

    game.phase = 'accusation';
    game.round = {
      accuserId: accuser.id,
      suspectId: suspect.id,
      voters: [accuser.id],      // the accuser is automatically backing it
      responded: [accuser.id],   // accuser doesn't get the yes/no prompt
      endsAt: Date.now() + JOIN_SECONDS * 1000,
    };
    pushLog(game, `🙋 ${accuser.name} accuses ${suspect.name}! Join the vote?`);
    broadcast(game);

    clearTimeout(game.timers.round);
    game.timers.round = setTimeout(() => resolveRound(game), JOIN_SECONDS * 1000);
  });

  // --- Respond to the join prompt (yes/no) --------------------------------
  socket.on('join_vote', ({ join }) => {
    const game = findGameBySocket(socket.id);
    if (!game || game.phase !== 'accusation' || !game.round) return;
    const p = getPlayer(game, socket.id);
    if (!p || !p.alive) return;
    // The accuser and the accused don't vote on this accusation.
    if (p.id === game.round.accuserId || p.id === game.round.suspectId) return;
    if (game.round.responded.includes(p.id)) return;

    game.round.responded.push(p.id);
    if (join && !game.round.voters.includes(p.id)) {
      game.round.voters.push(p.id);
      pushLog(game, `✋ ${p.name} joined the accusation.`);
    }
    broadcast(game);
    maybeCloseJoinWindow(game);
  });

  // --- Host resets to a fresh lobby (same players, new game) --------------
  socket.on('play_again', () => {
    const game = findGameBySocket(socket.id);
    if (!game || game.hostId !== socket.id) return;
    clearTimers(game);
    game.phase = 'lobby';
    game.round = null;
    game.winner = null;
    game.revealEndsAt = null;
    game.log = [];
    game.players.forEach((p) => { p.role = null; p.alive = true; });
    pushLog(game, '🔄 New round — back to the lobby.');
    broadcast(game);
  });

  // --- Leave / disconnect --------------------------------------------------
  function handleLeave() {
    const game = findGameBySocket(socket.id);
    if (!game) return;
    const p = getPlayer(game, socket.id);
    if (!p) return;

    if (game.phase === 'lobby') {
      // Remove entirely while still in the lobby.
      game.players = game.players.filter((x) => x.id !== socket.id);
      pushLog(game, `➖ ${p.name} left.`);
    } else {
      // Mid-game: keep the seat but mark disconnected.
      p.connected = false;
      pushLog(game, `🔌 ${p.name} disconnected.`);
    }

    // Host migration: hand the host role to the next connected player.
    if (game.hostId === socket.id) {
      const next = game.players.find((x) => x.connected && x.id !== socket.id) || game.players.find((x) => x.id !== socket.id);
      if (next) {
        game.hostId = next.id;
        next.isHost = true;
        pushLog(game, `👑 ${next.name} is now the host.`);
      }
    }

    if (game.players.length === 0) {
      clearTimers(game);
      games.delete(game.code);
      return;
    }
    broadcast(game);
  }

  socket.on('leave_game', handleLeave);
  socket.on('disconnect', handleLeave);
});

server.listen(PORT, () => {
  console.log(`\n  🔪 Wink Murder running at http://localhost:${PORT}\n`);
});
