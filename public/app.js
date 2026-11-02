/* Wink Murder — client */
(function () {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const screens = ['home', 'lobby', 'reveal', 'play', 'accuse', 'end'];

  let state = null;        // latest game state from server
  let revealFlipped = false;
  let timerRAF = null;

  // ---- persistent session (survives reloads / dropped connections) ----
  const LS_KEY = 'winkmurder.session';
  const saveSession = (code, pid) => { try { localStorage.setItem(LS_KEY, JSON.stringify({ code, pid })); } catch (e) {} };
  const loadSession = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } };
  const clearSession = () => { try { localStorage.removeItem(LS_KEY); } catch (e) {} };

  // ---------------- screen routing ----------------
  function show(name) {
    screens.forEach((s) => $('screen-' + s).classList.toggle('active', s === name));
  }

  function toast(text, type = '') {
    const el = $('toast');
    el.textContent = text;
    el.className = 'toast show ' + type;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.className = 'toast ' + type), 2600);
  }

  const me = () => (state ? state.players.find((p) => p.you) : null);
  const amHost = () => state && me() && state.hostId === me().id;

  // ---------------- sound + vibration ----------------
  let muted = false;
  try { muted = localStorage.getItem('winkmurder.muted') === '1'; } catch (e) {}
  let actx = null;
  function audioCtx() {
    if (!actx) { try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; } }
    return actx;
  }
  // Mobile browsers start the audio context "suspended" until a user gesture.
  function unlockAudio() { const ac = audioCtx(); if (ac && ac.state === 'suspended') ac.resume().catch(() => {}); }
  document.addEventListener('pointerdown', unlockAudio);

  // One synthesized note (no audio files needed).
  function tone(freq, startAt, dur, type, gainVal, slideTo) {
    const ac = audioCtx(); if (!ac) return;
    const t0 = ac.currentTime + startAt;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gainVal || 0.15, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.03);
  }
  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }

  const SFX = {
    // a hand goes up — two rising attention beeps
    hand: () => { buzz([90, 50, 90]); tone(660, 0, 0.12, 'triangle', 0.2); tone(990, 0.13, 0.17, 'triangle', 0.22); },
    // someone dies — low ominous drop
    death: () => { buzz([330]); tone(300, 0, 0.5, 'sawtooth', 0.18, 90); },
    // a murderer is caught — bright triumphant arpeggio
    murderer_caught: () => { buzz([70, 40, 70, 40, 160]); tone(523, 0, 0.12, 'square', 0.14); tone(659, 0.12, 0.12, 'square', 0.14); tone(784, 0.24, 0.26, 'square', 0.16); },
    // innocents win — rising major fanfare (C E G C) with a held final note
    win_innocents: () => {
      buzz([120, 80, 120, 80, 240]);
      [[523, 0, 0.16], [659, 0.16, 0.16], [784, 0.32, 0.16], [1046, 0.48, 0.5]].forEach(([f, s, d]) => tone(f, s, d, 'triangle', 0.17));
    },
    // murderers win — dark descending sting with a low held note
    win_murderers: () => {
      buzz([300, 120, 300]);
      [[392, 0, 0.18], [311, 0.18, 0.18], [233, 0.36, 0.22]].forEach(([f, s, d]) => tone(f, s, d, 'sawtooth', 0.16));
      tone(130, 0.52, 0.7, 'sawtooth', 0.16);
      tone(196, 0.52, 0.7, 'triangle', 0.1);
    },
  };
  function playSfx(type) { if (muted) return; unlockAudio(); const fn = SFX[type]; if (fn) { try { fn(); } catch (e) {} } }

  function applyMuteUI() {
    const b = $('sound-toggle');
    b.textContent = muted ? '🔇' : '🔊';
    b.classList.toggle('muted', muted);
  }
  $('sound-toggle').onclick = () => {
    muted = !muted;
    try { localStorage.setItem('winkmurder.muted', muted ? '1' : '0'); } catch (e) {}
    applyMuteUI();
    if (!muted) playSfx('hand'); // quick confirmation blip when turning on
  };
  applyMuteUI();

  // ---------------- home ----------------
  $('btn-create').onclick = () => {
    const name = $('home-name').value.trim();
    if (!name) return ($('home-err').textContent = 'Enter your name first.');
    socket.emit('create_game', { name }, (res) => {
      if (!res.ok) $('home-err').textContent = res.error || 'Could not create game.';
      else saveSession(res.code, res.pid);
    });
  };

  $('btn-join').onclick = () => {
    const name = $('home-name').value.trim();
    const code = $('home-code').value.trim().toUpperCase();
    if (!name) return ($('home-err').textContent = 'Enter your name first.');
    if (!code) return ($('home-err').textContent = 'Enter a game code.');
    socket.emit('join_game', { code, name }, (res) => {
      if (!res.ok) $('home-err').textContent = res.error || 'Could not join.';
      else saveSession(res.code, res.pid);
    });
  };

  $('home-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ---------------- lobby ----------------
  $('btn-leave').onclick = () => { socket.emit('leave_game'); clearSession(); location.reload(); };
  $('murderer-plus').onclick = () => adjustMurderers(1);
  $('murderer-minus').onclick = () => adjustMurderers(-1);
  function adjustMurderers(delta) {
    if (!state) return;
    const max = Math.max(1, state.players.length - 1);
    let n = Math.min(max, Math.max(1, state.config.murdererCount + delta));
    socket.emit('set_config', { murdererCount: n });
  }
  $('btn-start').onclick = () => socket.emit('start_game');

  // ---------------- reveal ----------------
  $('role-card').onclick = () => {
    revealFlipped = !revealFlipped;
    $('role-card').classList.toggle('flipped', revealFlipped);
  };

  // ---------------- playing ----------------
  $('btn-dead').onclick = () => {
    if (confirm('Confirm you were killed? You will be out of the game.')) socket.emit('report_death');
  };
  $('btn-raise').onclick = () => {
    // Open the suspect picker — you must point at one person.
    $('raise-actions').classList.add('hidden');
    $('accuse-picker').classList.remove('hidden');
    const meId = me() && me().id;
    const candidates = state.players.filter((p) => p.alive && p.id !== meId);
    $('accuse-picker-players').innerHTML = candidates.map((p) => playerCard(p, { selectable: true })).join('');
    $('accuse-picker-players').querySelectorAll('.player.selectable').forEach((el) => {
      el.onclick = () => {
        const nm = el.querySelector('.pname').textContent;
        if (confirm(`Accuse ${nm} of being the murderer? Everyone will be asked to join you.`)) {
          socket.emit('raise_hand', { suspectId: el.dataset.id });
        }
      };
    });
  };
  $('btn-cancel-raise').onclick = () => {
    $('accuse-picker').classList.add('hidden');
    $('raise-actions').classList.remove('hidden');
  };

  // ---------------- accusation ----------------
  $('btn-join-yes').onclick = () => socket.emit('join_vote', { join: true });
  $('btn-join-no').onclick = () => socket.emit('join_vote', { join: false });

  // ---------------- end ----------------
  $('btn-again').onclick = () => socket.emit('play_again');
  $('btn-home').onclick = () => { socket.emit('leave_game'); clearSession(); location.reload(); };

  // ---------------- socket events ----------------
  socket.on('toast', (d) => toast(d.text, d.type));
  socket.on('sfx', (d) => playSfx(d && d.type));
  socket.on('state', (s) => { state = s; render(); });
  socket.on('connect_error', () => toast('Connection problem…', 'error'));
  socket.on('disconnect', () => toast('Reconnecting…', 'error'));

  // On every (re)connect, try to reclaim our seat from the saved session.
  socket.on('connect', () => {
    const s = loadSession();
    if (!s || !s.code || !s.pid) return;
    socket.emit('resume_game', { code: s.code, pid: s.pid }, (res) => {
      if (res && res.ok) toast('Reconnected', 'ok');
      else if (res && res.reset) { clearSession(); state = null; show('home'); }
    });
  });

  // Host removed us from the lobby.
  socket.on('kicked', () => { clearSession(); state = null; show('home'); toast('The host removed you from the game.', 'error'); });

  // ---------------- rendering ----------------
  function render() {
    if (!state) return;
    switch (state.phase) {
      case 'lobby': renderLobby(); show('lobby'); break;
      case 'reveal': renderReveal(); show('reveal'); break;
      case 'playing': renderPlay(); show('play'); break;
      case 'accusation': renderAccuse(); show('accuse'); break;
      case 'ended': renderEnd(); show('end'); break;
      default: show('home');
    }
    startTimerLoop();
  }

  function playerCard(p, opts = {}) {
    const classes = ['player'];
    if (!p.alive) classes.push('dead');
    if (p.you) classes.push('you');
    if (p.isHost) classes.push('host-tag');
    if (!p.connected) classes.push('offline');
    if (opts.selectable) classes.push('selectable');
    const roleMini = opts.showRole && p.role
      ? `<div class="role-mini ${p.role}">${p.role === 'murderer' ? '🔪 Murderer' : '🟢 Innocent'}</div>`
      : '';
    const offlineTag = !p.connected ? '<div class="role-mini" style="color:var(--muted)">offline…</div>' : '';
    const kickBtn = opts.kickable ? `<button class="kick" data-kick="${p.id}" title="Remove">✕</button>` : '';
    return `<div class="${classes.join(' ')}" ${opts.selectable ? `data-id="${p.id}"` : ''}>
      <span class="dot" style="background:${p.color ? p.color.hex : '#888'}"></span>
      <div style="min-width:0">
        <div class="pname">${escapeHtml(p.name)}${p.you ? ' (you)' : ''}</div>
        ${roleMini}${offlineTag}
      </div>
      ${kickBtn}
    </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- lobby ----
  function renderLobby() {
    $('lobby-code').textContent = state.code;
    const host = amHost();
    $('lobby-players').innerHTML = state.players.map((p) => playerCard(p, { kickable: host && !p.you })).join('');
    if (host) {
      $('lobby-players').querySelectorAll('.kick').forEach((el) => {
        el.onclick = (ev) => {
          ev.stopPropagation();
          socket.emit('kick_player', { playerId: el.dataset.kick });
        };
      });
    }
    document.querySelectorAll('.host-only').forEach((el) => el.classList.toggle('hidden', !host));
    document.querySelectorAll('.waiting-only').forEach((el) => el.classList.toggle('hidden', host));

    $('murderer-count').textContent = state.config.murdererCount;
    const n = state.players.length;
    const m = state.config.murdererCount;
    $('balance-hint').textContent = n < 3
      ? `Need at least 3 players (you have ${n}).`
      : `${m} murderer${m > 1 ? 's' : ''} vs ${n - m} innocent${n - m > 1 ? 's' : ''}.`;
    $('btn-start').disabled = n < 3;
    $('lobby-hint').textContent = n < 3
      ? `Share code ${state.code}. Need ${3 - n} more player${3 - n > 1 ? 's' : ''}.`
      : `${n} players in. Share code ${state.code} for more.`;
  }

  // ---- reveal ----
  function renderReveal() {
    const p = me();
    if (!p || !p.role) return;
    const front = $('role-front');
    front.className = 'role-face role-front ' + p.role;
    if (p.role === 'murderer') {
      $('role-emoji').textContent = '🔪';
      $('role-name').textContent = 'MURDERER';
      $('role-desc').textContent = 'Kill with a wink. Don\'t get caught. Survive until murderers equal the innocents.';
    } else {
      $('role-emoji').textContent = '🟢';
      $('role-name').textContent = 'INNOCENT';
      $('role-desc').textContent = 'Spot the wink. Raise your hand and vote out the murderer — but be sure.';
    }
  }

  // ---- playing ----
  function renderPlay() {
    const p = me();
    const pill = $('play-role-pill');
    if (p && p.role) {
      pill.className = 'role-pill ' + p.role;
      pill.textContent = p.role === 'murderer' ? '🔪 You are the Murderer' : '🟢 You are Innocent';
    }
    const c = state.counts;
    $('play-counts').innerHTML = `<b>${c.alive}</b> alive<br>${c.murderersAlive} 🔪 · ${c.innocentsAlive} 🟢`;

    const alive = p && p.alive;
    $('alive-block').classList.toggle('hidden', !alive);
    $('dead-block').classList.toggle('hidden', alive);
    // reset the raise/accuse picker to its default state each time
    $('accuse-picker').classList.add('hidden');
    $('raise-actions').classList.remove('hidden');

    $('play-players').innerHTML = state.players.map((p) => playerCard(p)).join('');
    $('play-feed').innerHTML = state.log.slice(0, 8).map((l) => `<div class="feed-item">${escapeHtml(l.text)}</div>`).join('');
  }

  // ---- accusation (single join window; accuser already named the suspect) ----
  function renderAccuse() {
    const r = state.round;
    if (!r) return;
    const accuser = state.players.find((p) => p.id === r.accuserId);
    const suspect = state.players.find((p) => p.id === r.suspectId);
    const p = me();
    const alive = p && p.alive;

    ['join-block', 'join-waiting', 'suspect-block', 'bystander-block'].forEach((id) => $(id).classList.add('hidden'));

    // Accused card
    if (suspect) {
      $('accused-dot').style.background = suspect.color ? suspect.color.hex : '#888';
      $('accused-name').textContent = suspect.name;
      $('accused-by').textContent = `accused by ${accuser ? accuser.name : 'someone'}`;
    }
    $('accuse-title').textContent = '🙋 An accusation!';
    $('accuse-sub').textContent = `${r.voters.length} backing it so far. Decide fast.`;

    if (r.isSuspect) {
      // You are the one being accused — you can't vote on yourself.
      $('suspect-block').classList.remove('hidden');
      $('suspect-block').innerHTML = `<b>You've been accused!</b><br>Keep your cool — if you're innocent, the accusers go down, not you.`;
    } else if (r.isAccuser) {
      $('join-waiting').classList.remove('hidden');
      $('join-waiting').innerHTML = `You accused <b>${suspect ? suspect.name : '—'}</b>. Waiting for others to join…`;
    } else if (!alive) {
      $('bystander-block').classList.remove('hidden');
      $('bystander-block').textContent = 'You are out — watching this accusation.';
    } else if (r.youResponded) {
      $('join-waiting').classList.remove('hidden');
      $('join-waiting').textContent = r.youJoined ? 'You joined. Waiting for the window to close…' : 'You sat out. Watching it play out…';
    } else {
      $('join-block').classList.remove('hidden');
    }
  }

  // ---- end ----
  function renderEnd() {
    const w = state.winner;
    $('end-hero').className = 'end-hero ' + w;
    $('end-emoji').textContent = w === 'innocents' ? '🟢' : '🔪';
    $('end-title').textContent = w === 'innocents' ? 'Innocents Win!' : 'Murderers Win!';
    const last = state.log.find((l) => l.text.includes('win'));
    $('end-reason').textContent = last ? last.text.replace(/^🏁\s*/, '') : '';
    $('end-players').innerHTML = state.players.map((p) => playerCard(p, { showRole: true })).join('');
    const host = amHost();
    document.querySelectorAll('#screen-end .host-only').forEach((el) => el.classList.toggle('hidden', !host));
    document.querySelectorAll('#screen-end .waiting-only').forEach((el) => el.classList.toggle('hidden', host));
  }

  // ---------------- countdown timers ----------------
  function startTimerLoop() {
    cancelAnimationFrame(timerRAF);
    const tick = () => {
      if (!state) return;
      if (state.phase === 'reveal' && state.revealEndsAt) {
        updateRing($('reveal-timer'), state.revealEndsAt, 15);
      } else if (state.phase === 'accusation' && state.round && state.round.endsAt) {
        updateRing($('accuse-timer'), state.round.endsAt, 20);
      } else {
        return; // nothing to animate
      }
      timerRAF = requestAnimationFrame(tick);
    };
    timerRAF = requestAnimationFrame(tick);
  }

  function updateRing(el, endsAt, total) {
    const remMs = Math.max(0, endsAt - Date.now());
    const rem = Math.ceil(remMs / 1000);
    el.textContent = rem;
    const frac = Math.max(0, Math.min(1, remMs / (total * 1000)));
    el.style.setProperty('--deg', (frac * 360) + 'deg');
  }
})();
