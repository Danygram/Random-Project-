/* Wink Murder — client */
(function () {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const screens = ['home', 'lobby', 'reveal', 'play', 'accuse', 'imp-words', 'imp-play', 'imp-vote', 'end'];

  let state = null;        // latest game state from server
  let revealFlipped = false;
  let impFlipped = false;
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

  // ---------------- word impostor: lobby config ----------------
  document.querySelectorAll('#game-select .mode-tab').forEach((el) => {
    el.onclick = () => socket.emit('set_mode', { mode: el.dataset.mode });
  });
  document.querySelectorAll('#imp-config .mode-tab[data-variant]').forEach((el) => {
    el.onclick = () => socket.emit('set_impostor_config', { variant: el.dataset.variant });
  });
  document.querySelectorAll('#imp-config .mode-tab[data-wpp]').forEach((el) => {
    el.onclick = () => socket.emit('set_impostor_config', { wordsPerPerson: +el.dataset.wpp });
  });
  $('imp-plus').onclick = () => adjustImpostors(1);
  $('imp-minus').onclick = () => adjustImpostors(-1);
  function adjustImpostors(delta) {
    if (!state) return;
    const max = Math.min(2, Math.max(1, state.players.length - 1));
    const n = Math.min(max, Math.max(1, state.impostor.impostorCount + delta));
    socket.emit('set_impostor_config', { impostorCount: n });
  }
  $('reveal-cat-toggle').onchange = (e) => socket.emit('set_impostor_config', { revealCategory: e.target.checked });
  $('btn-start-imp-cats').onclick = () => socket.emit('start_impostor');
  $('btn-collect-words').onclick = () => socket.emit('collect_words');

  // ---------------- word impostor: submission ----------------
  $('btn-submit-words').onclick = () => {
    const words = Array.from(document.querySelectorAll('#word-inputs input')).map((i) => i.value.trim()).filter(Boolean);
    socket.emit('submit_words', { words });
  };
  $('btn-start-imp-custom').onclick = () => socket.emit('start_impostor');
  $('btn-cancel-collect').onclick = () => socket.emit('cancel_collect');

  // ---------------- word impostor: play ----------------
  $('imp-card').onclick = () => { impFlipped = !impFlipped; $('imp-card').classList.toggle('flipped', impFlipped); };
  $('btn-next-round').onclick = () => socket.emit('imp_next_round');
  $('btn-proceed-vote').onclick = () => { if (confirm('Proceed to voting now?')) socket.emit('imp_proceed_to_voting'); };
  $('btn-end-voting').onclick = () => { if (confirm('End voting and reveal the result?')) socket.emit('imp_end_voting'); };

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
      case 'imp_words': renderImpWords(); show('imp-words'); break;
      case 'imp_play': renderImpPlay(); show('imp-play'); break;
      case 'imp_vote': renderImpVote(); show('imp-vote'); break;
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
    // fresh cards for the next game
    revealFlipped = false; impFlipped = false;
    $('role-card').classList.remove('flipped');
    $('imp-card').classList.remove('flipped');
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

    const n = state.players.length;
    const mode = state.mode;
    $('lobby-hint').textContent = n < 3
      ? `Share code ${state.code}. Need ${3 - n} more player${3 - n > 1 ? 's' : ''}.`
      : `${n} players in. Share code ${state.code} for more.`;

    // Host: game selector + the right config card
    if (host) {
      document.querySelectorAll('#game-select .mode-tab').forEach((el) => el.classList.toggle('active', el.dataset.mode === mode));
      $('wink-config').classList.toggle('hidden', mode !== 'wink');
      $('imp-config').classList.toggle('hidden', mode !== 'impostor');
      if (mode === 'wink') renderWinkConfig(n);
      else renderImpConfig(n);
    } else {
      $('waiting-note').textContent = mode === 'impostor'
        ? 'Host is setting up 🕵️ Word Impostor…'
        : 'Host is setting up 🔪 Wink Murder…';
    }
  }

  function renderWinkConfig(n) {
    const m = state.config.murdererCount;
    $('murderer-count').textContent = m;
    $('balance-hint').textContent = n < 3
      ? `Need at least 3 players (you have ${n}).`
      : `${m} murderer${m > 1 ? 's' : ''} vs ${n - m} innocent${n - m > 1 ? 's' : ''}.`;
    $('btn-start').disabled = n < 3;
  }

  const CATEGORIES = [
    { id: 'animals', name: 'Animals', emoji: '🐾' },
    { id: 'food', name: 'Food & Drink', emoji: '🍔' },
    { id: 'places', name: 'Places', emoji: '🌍' },
    { id: 'sports', name: 'Sports', emoji: '⚽' },
    { id: 'screen', name: 'Movies & TV', emoji: '🎬' },
    { id: 'jobs', name: 'Jobs', emoji: '💼' },
  ];

  function renderImpConfig(n) {
    const imp = state.impostor;
    document.querySelectorAll('#imp-config .mode-tab[data-variant]').forEach((el) => el.classList.toggle('active', el.dataset.variant === imp.variant));
    document.querySelectorAll('#imp-config .mode-tab[data-wpp]').forEach((el) => el.classList.toggle('active', +el.dataset.wpp === imp.wordsPerPerson));
    $('imp-count').textContent = imp.impostorCount;
    $('imp-cats-block').classList.toggle('hidden', imp.variant !== 'categories');
    $('imp-custom-block').classList.toggle('hidden', imp.variant !== 'custom');

    // category chips
    $('cat-grid').innerHTML = CATEGORIES.map((c) =>
      `<div class="cat-chip ${imp.categories.includes(c.id) ? 'sel' : ''}" data-cat="${c.id}"><span class="cat-emoji">${c.emoji}</span>${c.name}</div>`
    ).join('');
    $('cat-grid').querySelectorAll('.cat-chip').forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.cat;
        const sel = new Set(state.impostor.categories);
        if (sel.has(id)) sel.delete(id); else sel.add(id);
        socket.emit('set_impostor_config', { categories: Array.from(sel) });
      };
    });
    $('reveal-cat-toggle').checked = !!imp.revealCategory;
    const cats = imp.categories.length;
    $('imp-cats-hint').textContent = `${cats} selected${cats < 3 ? ` — pick ${3 - cats} more` : ''}.`;
    $('btn-start-imp-cats').disabled = n < 3 || cats < 3 || imp.impostorCount >= n;
    $('btn-collect-words').disabled = n < 3;
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

  // ---- word impostor: submission ----
  function renderImpWords() {
    const imp = state.impostor;
    const need = imp.wordsPerPerson;
    $('imp-words-sub').textContent = `Enter ${need} words — keep them secret!`;
    const done = imp.youSubmitted;
    $('imp-words-form').classList.toggle('hidden', done);
    $('imp-words-done').classList.toggle('hidden', !done);
    if (!done && $('word-inputs').children.length !== need) {
      $('word-inputs').innerHTML = Array.from({ length: need }, (_, i) =>
        `<input maxlength="40" placeholder="Word ${i + 1}" autocomplete="off" />`).join('');
    }
    $('imp-words-progress').textContent = `${imp.submittedCount} of ${imp.connectedCount} players ready.`;
    const host = amHost();
    document.querySelectorAll('#screen-imp-words .host-only').forEach((el) => el.classList.toggle('hidden', !host));
    if (host) $('btn-start-imp-custom').disabled = imp.submittedCount < imp.connectedCount;
  }

  // ---- word impostor: play (word card + rounds) ----
  function renderImpPlay() {
    const imp = state.impostor;
    $('imp-round').textContent = imp.round;
    $('imp-play-counts').innerHTML = `<b>${state.players.length}</b> players<br>${imp.impostorCount} impostor${imp.impostorCount > 1 ? 's' : ''}`;
    const front = $('imp-card-front');
    if (imp.youAreImpostor) {
      front.className = 'role-face role-front murderer';
      $('imp-emoji').textContent = '🕵️';
      $('imp-word').textContent = 'IMPOSTOR';
      $('imp-desc').innerHTML = imp.yourCategory
        ? `You don't know the word. Blend in!<br><b>Category: ${escapeHtml(imp.yourCategory)}</b>`
        : `You don't know the word. Listen to the clues and blend in!`;
    } else {
      front.className = 'role-face role-front innocent';
      $('imp-emoji').textContent = '💬';
      $('imp-word').textContent = imp.yourWord || '—';
      $('imp-desc').textContent = 'Give a one-word clue that fits. Find who is faking.';
    }
    const host = amHost();
    document.querySelectorAll('#screen-imp-play .host-only').forEach((el) => el.classList.toggle('hidden', !host));
    document.querySelectorAll('#screen-imp-play .waiting-only').forEach((el) => el.classList.toggle('hidden', host));
    $('imp-play-feed').innerHTML = state.log.slice(0, 6).map((l) => `<div class="feed-item">${escapeHtml(l.text)}</div>`).join('');
  }

  // ---- word impostor: vote ----
  function renderImpVote() {
    const imp = state.impostor;
    $('imp-vote-sub').textContent = `Tap your pick. ${imp.voteCount}/${imp.connectedCount} voted.`;
    $('imp-vote-progress').textContent = imp.youVoted ? 'You voted — tap another to change it.' : 'Pick who you think is the impostor.';
    $('imp-vote-players').innerHTML = state.players.map((p) => {
      const card = playerCard(p, { selectable: true });
      return imp.yourVote === p.id ? card.replace('class="player selectable', 'class="player selectable you') : card;
    }).join('');
    $('imp-vote-players').querySelectorAll('.player.selectable').forEach((el) => {
      el.onclick = () => socket.emit('imp_cast_vote', { targetId: el.dataset.id });
    });
    const host = amHost();
    document.querySelectorAll('#screen-imp-vote .host-only').forEach((el) => el.classList.toggle('hidden', !host));
  }

  // ---- end ----
  function renderEnd() {
    if (state.mode === 'impostor') return renderImpEnd();
    $('end-impostor-reveal').classList.add('hidden');
    $('end-players').classList.remove('hidden');
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

  function renderImpEnd() {
    const w = state.winner; // 'crew' | 'impostors'
    const r = state.impostor.reveal || {};
    $('end-hero').className = 'end-hero ' + (w === 'crew' ? 'innocents' : 'murderers');
    $('end-emoji').textContent = w === 'crew' ? '🎉' : '🕵️';
    $('end-title').textContent = w === 'crew' ? 'Crew Win!' : 'Impostors Win!';
    $('end-reason').textContent = w === 'crew' ? 'The impostor was caught.' : 'The impostor slipped away.';

    let html = `<div class="reveal-word-card">
      <div class="sub">The word was</div>
      <div class="big-word">${escapeHtml(r.word || '—')}</div>`;
    if (r.category) html += `<div class="sub">Category: ${escapeHtml(r.category)}</div>`;
    if (r.authorName) html += `<div class="sub">Suggested by ${escapeHtml(r.authorName)}</div>`;
    html += `<div class="sub" style="margin-top:8px">Impostor${(r.impostorNames || []).length > 1 ? 's' : ''}: <b>${(r.impostorNames || []).map(escapeHtml).join(', ') || '—'}</b></div></div>`;

    // vote tally
    const impSet = new Set(r.impostorNames || []);
    html += '<div class="eyebrow" style="margin:4px 0 6px">Votes</div>';
    html += (r.tally || []).slice().sort((a, b) => b.votes - a.votes).map((t) => {
      const p = state.players.find((pl) => pl.id === t.id) || {};
      return `<div class="tally-row">
        <span class="dot" style="width:16px;height:16px;background:${p.color ? p.color.hex : '#888'}"></span>
        <span>${escapeHtml(t.name)}${impSet.has(t.name) ? ' 🕵️' : ''}</span>
        <span class="votes">${t.votes} vote${t.votes === 1 ? '' : 's'}</span>
      </div>`;
    }).join('');

    $('end-impostor-reveal').innerHTML = html;
    $('end-impostor-reveal').classList.remove('hidden');
    $('end-players').classList.add('hidden');
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
