# 🔪 Wink Murder

A real-time **online companion** for the in-person "wink assassin" party game — a twist on Mafia. Everyone's in one room with their own phone. The app handles roles, deaths, accusations, voting and win conditions; the **winking and killing happen physically** in the room.

## How to play

| Step | What happens |
|------|-------------|
| **1. Host** | One person taps **Host a new game** and gets a 4-letter code. |
| **2. Join** | Everyone opens the site, enters a name, and types the code. Each player gets a unique color. |
| **3. Roles** | Host picks how many murderers, then **Start**. Everyone taps their card to flip it and see **Murderer** or **Innocent** — **15 seconds, no talking.** |
| **4. Play (physical)** | The murderer kills by **winking** at someone. The victim **crosses their arms (✖️)** and taps **"I was killed"** so everyone's status updates live. |
| **5. Accuse** | Saw the wink? Tap **🙋 Raise hand**. Everyone gets a **"Join the vote? Yes/No"** prompt. Only those who join can vote — they each pick who they think the murderer is. |
| **6. Resolve** | **Right** → that murderer is caught. **Wrong** → everyone who joined the vote is **eliminated.** No discussion. |

### Win conditions
- **Innocents win** when all murderers are caught/eliminated.
- **Murderers win** when murderers ≥ innocents remaining.

## Run it

```bash
npm install
npm start          # → http://localhost:3000
```

Open the URL on every phone (same Wi-Fi, or deploy the server and share the public link).

## Deploy (get a shareable public link)

It's a standard Node web service (`npm start`, respects `PORT`). No database — games live in memory and clear when empty.

### Render (one click, free) — `render.yaml` included

1. Push this repo to GitHub (done).
2. Go to **render.com → New → Blueprint**, and connect this repo.
3. Render reads `render.yaml`, creates the `wink-murder` web service, builds, and gives you a public URL like `https://wink-murder.onrender.com`.
4. Open that URL on every phone — done.

> **Free-plan note:** the service sleeps after ~15 min idle and the first hit takes ~30s to wake. Fine for casual play. For instant-on, bump `plan: free` → `plan: starter` in `render.yaml`. To host closer to you, change `region` (e.g. `frankfurt`, `singapore`).

Also deploys as-is to **Railway, Fly.io, or any Node host**.

## Tech

- **Server:** Node + Express + Socket.IO (`server.js`) — authoritative game engine. Each player only ever sees **their own role** until the game ends.
- **Client:** vanilla HTML/CSS/JS in `public/` (`index.html`, `style.css`, `app.js`) — mobile-first, no build step.

## Tunable rules (`server.js` top)

| Constant | Default | Meaning |
|----------|---------|---------|
| `REVEAL_SECONDS` | 15 | Silent role-peek window |
| `JOIN_SECONDS` | 20 | "Join the accusation?" window |
| `MAX_PLAYERS` | 30 | Players per game |
| `HOST_GRACE_MS` | 15000 | Grace before a dropped host is handed off |
| `LOBBY_GRACE_MS` | 45000 | Grace before a dropped lobby player is removed |
| `EMPTY_GRACE_MS` | 180000 | Grace before an empty game is deleted |

The three grace values are also read from env vars of the same name.

### Sound & vibration

Every phone fires a synced cue (synthesized via the Web Audio API — no sound files) plus a vibration on key moments:

| Event | Sound | Vibration |
|-------|-------|-----------|
| 🙋 A hand goes up (accusation) | two rising beeps | short double buzz |
| 💀 Someone dies (wink / wrong accusation) | low ominous drop | one long buzz |
| ✅ A murderer is caught | bright triumphant arpeggio | staccato buzz |
| 🏁 Innocents win | rising major fanfare (C–E–G–C) | long celebratory pattern |
| 🏁 Murderers win | dark descending sting + low note | heavy double buzz |

When catching a murderer *ends* the game, only the win fanfare plays (the catch chime is suppressed to avoid overlap). Tap the 🔊 button (bottom-left) to mute; the choice is remembered. Mobile browsers only enable audio after the first tap, so the sound "wakes up" once a player interacts with the page.

### Connection resilience

Each player gets a **stable token** (stored in the browser), so a dropped socket — screen lock, tab switch, network blip, or a full page reload — **reclaims the same seat** instead of vanishing. Players no longer "randomly quit."

- Minimum **3 connected players** to start (lobby ghosts are dropped at start).
- If the **host** drops, the game isn't orphaned: it hands the host role to another connected player after a short grace (and the original host keeps it if they return in time).
- When **everyone** has been disconnected past the grace window, the game is deleted automatically — no orphan rooms.
- The host can **remove** a player from the lobby with the ✕ on their card.
