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
const crypto = require('crypto');
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

// Reconnection grace windows. A player identity is a stable token stored in the
// browser, so a dropped socket (screen lock, network blip, tab switch) can
// reclaim its seat instead of vanishing.
const HOST_GRACE_MS = +process.env.HOST_GRACE_MS || 15000;    // before handing off a dropped host
const LOBBY_GRACE_MS = +process.env.LOBBY_GRACE_MS || 45000;  // drop a lobby player who doesn't return
const EMPTY_GRACE_MS = +process.env.EMPTY_GRACE_MS || 180000; // delete a game nobody's connected to

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

const makePid = () => crypto.randomUUID();

function newGame(hostPid) {
  return {
    code: makeCode(),
    hostId: hostPid,               // player.id (stable pid) of the host
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

function newPlayer(pid, socketId, name, isHost) {
  return {
    id: pid,             // stable identity, survives reconnects
    socketId,            // current socket (null while disconnected)
    name,
    color: null,
    isHost,
    role: null,          // 'murderer' | 'innocent'
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
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', viewFor(game, p.id));
  }
}

/** Fire a sound/vibration cue on every player's device at once. */
function emitSfx(game, type) {
  for (const p of game.players) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('sfx', { type });
  }
}

function findGameBySocketId(socketId) {
  for (const g of games.values()) {
    if (g.players.some((p) => p.socketId === socketId)) return g;
  }
  return null;
}

function getPlayerBySocketId(game, socketId) {
  return game.players.find((p) => p.socketId === socketId) || null;
}

function getPlayer(game, id) {
  return game.players.find((p) => p.id === id) || null;
}

/** Delete a game once nobody has been connected for a while (orphan cleanup). */
function scheduleEmptyCleanup(game) {
  if (game.players.some((p) => p.connected)) {
    if (game.timers.empty) { clearTimeout(game.timers.empty); delete game.timers.empty; }
    return;
  }
  if (game.timers.empty) return;
  game.timers.empty = setTimeout(() => {
    clearTimers(game);
    games.delete(game.code);
  }, EMPTY_GRACE_MS);
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
    emitSfx(game, 'murderer_caught');
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
    emitSfx(game, 'death');
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
  // Resolve the game + player that THIS socket currently belongs to.
  const ctx = () => {
    const game = findGameBySocketId(socket.id);
    return { game, player: game ? getPlayerBySocketId(game, socket.id) : null };
  };

  // --- Host creates a game -------------------------------------------------
  socket.on('create_game', ({ name }, cb) => {
    name = (name || '').trim().slice(0, 20) || 'Host';
    const pid = makePid();
    const game = newGame(pid);
    const host = newPlayer(pid, socket.id, name, true);
    host.color = assignColor(game);
    game.players.push(host);
    games.set(game.code, game);
    socket.join(game.code);
    pushLog(game, `🎮 ${name} created the game.`);
    ack(cb, { ok: true, code: game.code, pid });
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

    const pid = makePid();
    const player = newPlayer(pid, socket.id, name, false);
    player.color = assignColor(game);
    game.players.push(player);
    socket.join(game.code);
    if (game.timers.empty) { clearTimeout(game.timers.empty); delete game.timers.empty; }
    pushLog(game, `➕ ${name} joined.`);
    ack(cb, { ok: true, code: game.code, pid });
    broadcast(game);
  });

  // --- Reclaim a seat after a reload/disconnect ----------------------------
  socket.on('resume_game', ({ code, pid }, cb) => {
    code = (code || '').trim().toUpperCase();
    const game = games.get(code);
    if (!game) return ack(cb, { ok: false, reset: true, error: 'That game no longer exists.' });
    const player = getPlayer(game, pid);
    if (!player) return ack(cb, { ok: false, reset: true, error: 'Your spot is gone.' });

    player.socketId = socket.id;
    player.connected = true;
    socket.join(game.code);
    // Cancel any pending removal / cleanup for this returning player.
    if (game.timers['rm_' + pid]) { clearTimeout(game.timers['rm_' + pid]); delete game.timers['rm_' + pid]; }
    if (game.timers.empty) { clearTimeout(game.timers.empty); delete game.timers.empty; }
    pushLog(game, `🔌 ${player.name} reconnected.`);
    ack(cb, { ok: true, code: game.code, pid });
    broadcast(game);
  });

  // --- Host sets murderer count -------------------------------------------
  socket.on('set_config', ({ murdererCount }) => {
    const { game, player } = ctx();
    if (!game || !player || game.hostId !== player.id || game.phase !== 'lobby') return;
    const max = Math.max(1, game.players.length - 1);
    const n = Math.min(max, Math.max(1, parseInt(murdererCount, 10) || 1));
    game.config.murdererCount = n;
    broadcast(game);
  });

  // --- Host starts the game: assign roles, run reveal window --------------
  socket.on('start_game', () => {
    const { game, player } = ctx();
    if (!game || !player || game.hostId !== player.id || game.phase !== 'lobby') return;
    const connectedCount = game.players.filter((p) => p.connected).length;
    if (connectedCount < 3) {
      socket.emit('toast', { type: 'error', text: 'Need at least 3 connected players to start.' });
      return;
    }

    // Only deal into connected players — drop any lobby ghosts first.
    game.players = game.players.filter((p) => p.connected);
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
    const { game, player } = ctx();
    if (!game || !player || game.phase !== 'playing') return;
    if (!player.alive) return;
    player.alive = false;
    pushLog(game, `💀 ${player.name} was killed. ✖️ Arms crossed.`);
    emitSfx(game, 'death');
    checkWin(game);
    broadcast(game);
  });

  // --- Host can also mark / revive someone (backup control) ---------------
  socket.on('mark_dead', ({ playerId }) => {
    const { game, player } = ctx();
    if (!game || !player || game.hostId !== player.id) return;
    if (game.phase !== 'playing') return;
    const target = getPlayer(game, playerId);
    if (!target || !target.alive) return;
    target.alive = false;
    pushLog(game, `💀 ${target.name} was marked out by the host.`);
    emitSfx(game, 'death');
    checkWin(game);
    broadcast(game);
  });

  // --- Host removes a player (e.g. a lobby ghost) -------------------------
  socket.on('kick_player', ({ playerId }) => {
    const { game, player } = ctx();
    if (!game || !player || game.hostId !== player.id || game.phase !== 'lobby') return;
    const target = getPlayer(game, playerId);
    if (!target || target.id === player.id) return;
    if (target.socketId) io.to(target.socketId).emit('kicked');
    game.players = game.players.filter((p) => p.id !== playerId);
    if (game.timers['rm_' + playerId]) { clearTimeout(game.timers['rm_' + playerId]); delete game.timers['rm_' + playerId]; }
    pushLog(game, `🚫 ${target.name} was removed by the host.`);
    broadcast(game);
  });

  // --- Raise hand → name ONE suspect → open an accusation round -----------
  socket.on('raise_hand', ({ suspectId }) => {
    const { game, player: accuser } = ctx();
    if (!game || !accuser || game.phase !== 'playing') return;
    if (!accuser.alive) return;
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
    emitSfx(game, 'hand');
    broadcast(game);

    clearTimeout(game.timers.round);
    game.timers.round = setTimeout(() => resolveRound(game), JOIN_SECONDS * 1000);
  });

  // --- Respond to the join prompt (yes/no) --------------------------------
  socket.on('join_vote', ({ join }) => {
    const { game, player: p } = ctx();
    if (!game || !p || game.phase !== 'accusation' || !game.round) return;
    if (!p.alive) return;
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
    const { game, player } = ctx();
    if (!game || !player || game.hostId !== player.id) return;
    clearTimers(game);
    // Drop anyone who left during the last game.
    game.players = game.players.filter((p) => p.connected);
    if (!game.players.some((p) => p.id === game.hostId) && game.players[0]) {
      game.hostId = game.players[0].id;
      game.players[0].isHost = true;
    }
    game.phase = 'lobby';
    game.round = null;
    game.winner = null;
    game.revealEndsAt = null;
    game.log = [];
    game.players.forEach((p) => { p.role = null; p.alive = true; });
    pushLog(game, '🔄 New round — back to the lobby.');
    broadcast(game);
  });

  // --- Explicit "Leave" button --------------------------------------------
  socket.on('leave_game', () => {
    const { game, player: p } = ctx();
    if (!game || !p) return;
    removePlayer(game, p, 'left');
  });

  // --- Dropped connection (blip, lock, closed tab) ------------------------
  socket.on('disconnect', () => {
    const { game, player: p } = ctx();
    if (!game || !p) return;
    p.connected = false;
    p.socketId = null;
    pushLog(game, `🔌 ${p.name} lost connection.`);

    // Hand off the host only if they don't return within the grace window.
    if (game.hostId === p.id && !game.timers.hostmig) {
      game.timers.hostmig = setTimeout(() => {
        delete game.timers.hostmig;
        const cur = getPlayer(game, p.id);
        if (game.hostId !== p.id || (cur && cur.connected)) return; // came back / changed
        const next = game.players.find((x) => x.connected);
        if (next) {
          game.hostId = next.id;
          next.isHost = true;
          if (cur) cur.isHost = false;
          pushLog(game, `👑 ${next.name} is now the host.`);
          broadcast(game);
        }
      }, HOST_GRACE_MS);
    }

    // In the lobby, drop a player who doesn't come back within the grace window.
    if (game.phase === 'lobby' && !game.timers['rm_' + p.id]) {
      game.timers['rm_' + p.id] = setTimeout(() => {
        delete game.timers['rm_' + p.id];
        const cur = getPlayer(game, p.id);
        if (cur && !cur.connected && game.phase === 'lobby') removePlayer(game, cur, 'left');
      }, LOBBY_GRACE_MS);
    }

    scheduleEmptyCleanup(game);
    broadcast(game);
  });
});

/** Remove a player from a game, migrating host and cleaning up as needed. */
function removePlayer(game, p, verb) {
  game.players = game.players.filter((x) => x.id !== p.id);
  if (game.timers['rm_' + p.id]) { clearTimeout(game.timers['rm_' + p.id]); delete game.timers['rm_' + p.id]; }
  pushLog(game, `➖ ${p.name} ${verb}.`);

  if (game.hostId === p.id) {
    const next = game.players.find((x) => x.connected) || game.players[0];
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
  scheduleEmptyCleanup(game);
  broadcast(game);
}

server.listen(PORT, () => {
  console.log(`\n  🔪 Wink Murder running at http://localhost:${PORT}\n`);
});
