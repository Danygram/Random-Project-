/* Wink Murder — client */
(function () {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const screens = ['home', 'lobby', 'reveal', 'play', 'accuse', 'end'];

  let state = null;        // latest game state from server
  let revealFlipped = false;
  let timerRAF = null;

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

  // ---------------- home ----------------
  $('btn-create').onclick = () => {
    const name = $('home-name').value.trim();
    if (!name) return ($('home-err').textContent = 'Enter your name first.');
    socket.emit('create_game', { name }, (res) => {
      if (!res.ok) $('home-err').textContent = res.error || 'Could not create game.';
    });
  };

  $('btn-join').onclick = () => {
    const name = $('home-name').value.trim();
    const code = $('home-code').value.trim().toUpperCase();
    if (!name) return ($('home-err').textContent = 'Enter your name first.');
    if (!code) return ($('home-err').textContent = 'Enter a game code.');
    socket.emit('join_game', { code, name }, (res) => {
      if (!res.ok) $('home-err').textContent = res.error || 'Could not join.';
    });
  };

  $('home-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  // ---------------- lobby ----------------
  $('btn-leave').onclick = () => { socket.emit('leave_game'); location.reload(); };
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
    if (confirm('Raise your hand and start a vote? Everyone will be asked to join.')) socket.emit('raise_hand');
  };

  // ---------------- accusation ----------------
  $('btn-join-yes').onclick = () => socket.emit('join_vote', { join: true });
  $('btn-join-no').onclick = () => socket.emit('join_vote', { join: false });

  // ---------------- end ----------------
  $('btn-again').onclick = () => socket.emit('play_again');
  $('btn-home').onclick = () => { socket.emit('leave_game'); location.reload(); };

  // ---------------- socket events ----------------
  socket.on('toast', (d) => toast(d.text, d.type));
  socket.on('state', (s) => { state = s; render(); });
  socket.on('connect_error', () => toast('Connection problem…', 'error'));
  socket.on('disconnect', () => toast('Disconnected from server', 'error'));

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
    return `<div class="${classes.join(' ')}" ${opts.selectable ? `data-id="${p.id}"` : ''}>
      <span class="dot" style="background:${p.color ? p.color.hex : '#888'}"></span>
      <div style="min-width:0">
        <div class="pname">${escapeHtml(p.name)}${p.you ? ' (you)' : ''}</div>
        ${roleMini}
      </div>
    </div>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- lobby ----
  function renderLobby() {
    $('lobby-code').textContent = state.code;
    $('lobby-players').innerHTML = state.players.map((p) => playerCard(p)).join('');
    const host = amHost();
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

    $('play-players').innerHTML = state.players.map((p) => playerCard(p)).join('');
    $('play-feed').innerHTML = state.log.slice(0, 8).map((l) => `<div class="feed-item">${escapeHtml(l.text)}</div>`).join('');
  }

  // ---- accusation ----
  function renderAccuse() {
    const r = state.round;
    if (!r) return;
    const accuser = state.players.find((p) => p.id === r.accuserId);
    const p = me();
    const alive = p && p.alive;

    ['join-block', 'join-waiting', 'vote-block', 'vote-waiting', 'bystander-block'].forEach((id) => $(id).classList.add('hidden'));

    if (r.phase === 'joining') {
      $('accuse-title').textContent = `🙋 ${accuser ? accuser.name : 'Someone'} raised a hand!`;
      $('accuse-sub').textContent = 'Join the vote to help catch the murderer — or sit out and stay safe.';
      if (!alive) {
        $('bystander-block').classList.remove('hidden');
        $('bystander-block').textContent = 'You are out — watching this vote.';
      } else if (r.youResponded) {
        $('join-waiting').classList.remove('hidden');
        $('join-tally').textContent = `${r.voters.length} joined so far.`;
      } else {
        $('join-block').classList.remove('hidden');
      }
    } else if (r.phase === 'voting') {
      $('accuse-title').textContent = '🗳️ Vote now';
      $('accuse-sub').textContent = `${r.voters.length} voter(s). Wrong guess = all voters are out.`;
      if (r.youJoined && alive) {
        if (r.youVoted) {
          $('vote-waiting').classList.remove('hidden');
        } else {
          $('vote-block').classList.remove('hidden');
          const candidates = state.players.filter((pl) => pl.alive);
          $('vote-players').innerHTML = candidates.map((pl) => playerCard(pl, { selectable: true })).join('');
          $('vote-players').querySelectorAll('.player.selectable').forEach((el) => {
            el.onclick = () => {
              if (confirm(`Vote for ${el.querySelector('.pname').textContent.replace(' (you)', '')} as the murderer?`)) {
                socket.emit('cast_vote', { targetId: el.dataset.id });
              }
            };
          });
        }
      } else {
        $('bystander-block').classList.remove('hidden');
        $('bystander-block').textContent = alive ? 'You sat this one out. Watching the vote…' : 'You are out — watching this vote.';
      }
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
        const total = state.round.phase === 'joining' ? 20 : 25;
        updateRing($('accuse-timer'), state.round.endsAt, total);
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
