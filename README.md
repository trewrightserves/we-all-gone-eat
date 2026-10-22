# We All Gone Eat 🍗 — Online Multiplayer Game

Tré's original party voting game (designed Oct 20, 2020), built for the phone:
one Leader locks a secret pick from a 4-Square Card, the crowd votes, the
majority rules. First to the target score wins. Long-distance friendly — every
player joins on their own phone browser with a 4-letter room code. No installs,
no accounts, no app store.

## Run it locally

```bash
cd app
npm install   # one dependency: ws
npm start     # serves on http://localhost:3000
```

Open `http://localhost:3000` in a browser. To test with phones on the same
Wi-Fi, use the computer's LAN address (e.g. `http://192.168.1.20:3000`).
One player creates a room and shares the 4-letter code; everyone else joins
with the code. 3–8 players.

Optional environment variables:

| Variable        | Default | Purpose                                        |
|-----------------|---------|------------------------------------------------|
| `PORT`          | `3000`  | Port the server listens on (hosts set this).   |
| `DISCUSSION_MS` | `60000` | Filibuster discussion length (60s real games). |
| `REPOLL_MS`     | `15000` | Re-poll window after a Filibuster (15s).       |

## How a game flows

1. **Lobby** — host creates the room, everyone joins by code, host sets the
   House Rules (below) and starts.
2. **Leader pick** — the Leader (rotating in join order) is dealt a card and
   secretly locks one of the 4 squares. The pick lives only on the server;
   it is never sent to other phones before the reveal.
3. **Crowd vote** — everyone else taps a square. When the table is in, the
   tally shows as counts only (never who voted what).
4. **Coin window** — before the reveal, players may spend their one-time
   coins (each player holds one of each per game):
   - **Filibuster** 🗣️ — 60-second discussion timer for the table, then a
     15-second re-poll where any crowd player may change their vote free.
   - **Switch Sides** 🔀 — change your own vote.
   - **Phone a Friend** 📞 — the server issues a one-time poll link. Text it
     to anybody; they open it, see the card, tap a square, and their pick
     returns privately to the asker, who may then change their vote once.
   - **Man on an Island** 🏝️ — if you're the only vote on a square, the game
     privately nudges you that your Switch Sides coin can still save you.
5. **Reveal** — the Leader's pick flips, and everyone sees their points:
   Leader **+3** if the top-voted square matches the pick. Crowd **+1** for
   landing on the top-voted square ("majority"), **+1** for matching the
   Leader, **+2** for both.
6. **Win** — first to the target at a win check wins. If two or more players
   are tied at the top at/above the target, a **Lightning Round** decides it:
   a fresh card, the tied players and the Leader vote, and the rest of the
   table's votes break any tie that survives. Repeat on a new card if needed.
7. **Winner screen** — a result card in the game's own words, with copy-text
   and a rendered share image.

Dropped connections are safe: rejoin with the same name (the phone remembers
your seat token) and your score, coins, and seat are restored.

## House Rules (host sets these in the lobby)

Defaults are the locked v1 rules. The alternate positions are the OA/Luna
slate from the design simulations — Tré has not ruled on them yet, so they're
toggles, labeled in the game:

1. **Win check** — *Immediate* (default) vs *End of rotation*.
2. **Split rounds** — on a tied top vote, the Leader misses the 3 either way;
   tied-top voters *still get the majority point* (default) vs *Split! pays
   nobody the majority point*.
3. **Coin limit** — *One coin per player per round* (default) vs *One coin
   per round for the whole table*.
4. **Switch Sides timing** — *After the tally is shown* (default) vs *Before
   the tally is shown* (played during voting; the Island nudge only exists in
   the after-tally mode, since there is no tally to be stranded on yet).
5. **Target score** — 7 (default), 10, 12, or 15.

## Deploy (Render / Railway / Fly-style hosts)

The server is a single Node process that serves the client and the WebSocket
game traffic on the same port, and reads `PORT` from the environment — it
fits any host that runs a Node web service:

- **Render** — New → Web Service → connect the repo → Build `npm install`,
  Start `npm start`. Free tier sleeps when idle; the first player to open the
  link wakes it (allow ~30s).
- **Railway** — New Project → deploy from repo; it detects Node and runs
  `npm start`. No configuration needed.
- **Fly.io** — `fly launch` in this folder (accept the Node defaults), then
  `fly deploy`. Make sure the app is set to a single machine — rooms live in
  server memory, so all players must land on the same process (true of all
  three hosts at single-instance scale).

State is in-memory by design (v1): restarting the server clears live rooms.
No database, no environment secrets, nothing else to configure.

## Files

```
server.js          Game server: HTTP + WebSocket, all state and scoring
deck.js            The full 100-card deck + winner result-card texts
public/index.html  The entire phone client (no build step, no CDN)
test/e2e-test.js   Scripted 4-player end-to-end test (two full games)
test/last-run.log  Latest passing test output (46 assertions)
```

## Test

```bash
npm test   # spawns the server with fast timers and plays two scripted games
```

The test asserts exact scoring (majority/match/split math), coin behavior
(Filibuster re-poll, Switch Sides, Phone a Friend answered over HTTP),
secrecy of the Leader's pick, reconnection, and a tie forced into a
Lightning Round with a declared winner.
