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
| `BOT_DELAY_MIN_MS` | `1500` | Fastest a bot acts (pick, vote, ready).      |
| `BOT_DELAY_MAX_MS` | `4000` | Slowest a bot acts — the human-like pause.   |

## Bot players (v2)

Short a few cousins? The host can seat **bot players** from the lobby
(**Add a bot to the table**) and send them back the same way, any time
before the game starts. Bots count toward the 3-player minimum and the
8-player max, so the solo path is: create a room, seat at least 2 bots,
hit Start. They also fill seats in a short-handed friends game.

Each bot has a cookout name (Auntie Bertha, Uncle June Bug, Cousin
Peaches…) and one of four personalities, tagged **BOT · \<personality\>**
everywhere players are listed:

- **Wild Card** — leans toward the least-picked squares and scrambles
  hard; on any given card it can land anywhere.
- **Safe Hands** — rides what it judges the mainstream pick, using a
  card-text popularity heuristic; usually lands on the popular square.
- **Copycat** — watches the table's revealed vote history and orders
  what the table has been eating.
- **Contrarian** — runs from the popular square and takes the lonely
  plate, almost every time.

How they play:

- Bots live entirely on the server and take their turns on a short,
  randomized human-like delay (about 1.5–4s). As Leader, a bot secretly
  locks its own pick with its personality; as crowd, it votes the same
  way. A bot's judgment uses only public information — the card and past
  reveals — never another player's secret pick.
- A bot stranded alone on a square (Man on an Island) answers its own
  nudge: by personality, it sometimes spends its Switch Sides coin to
  move before readying up, so a table never stalls on a bot.
- Bots play Lightning Rounds like anybody else.

Stated simplifications: **bots never use the Filibuster or Phone a
Friend coins** — Switch Sides is the only coin a bot can spend, and
only through the Man on an Island flow. Bots keep their vote during a
Filibuster re-poll. Hosting never falls to a bot, and a room closes on
the normal schedule once the last human leaves — no zombie bot games.

## Group chat + Food Debates deck (v3)

**Group chat.** Every room has its own table talk. Tap **💬 Chat**
(bottom corner) in the lobby or mid-game to open the panel; type, hit
Send or Enter, and everybody in *this* room sees it in real time with
your name on it. The button wears a red badge with your unread count
while the panel is closed. Chat is a pure relay — it carries no game
state and never touches phases, timers, coins, or the Leader's secret
pick.

- **Room-scoped, always.** A message goes to your room and nowhere
  else; it dies when the room closes (rooms are in-memory, so chat is
  too — nothing is stored).
- **History choice:** the room keeps its last **50 messages**, and
  anybody who joins or rejoins is handed that recent talk on arrival,
  so a late cousin can catch up on the argument.
- **Caps and guardrails:** messages are trimmed and capped at
  **300 characters** (the box counts too), empty messages are dropped,
  and each player can send at most **5 messages per 4 seconds** — past
  that, the server tells you to slow down and drops the extras.
- **Safe by construction:** names and chat text render through the
  client's HTML escaper, so markup typed into chat shows up as plain
  text, never as live HTML.
- **Bots don't chat.** Table talk is for the humans; bots keep their
  opinions to the voting.

**Food Debates deck.** Batch 5 adds 50 cards (101–150, category
**Food Debates**), taking the deck to **150 cards**. These are rankings
and hot takes instead of plates: cards 101–125 are cereal debates
(best of all time, worst ever made, most overrated, best dry with no
milk, first pick in the cereal draft…), and cards 126–150 run the same
debate shapes on other categories — wing flavors, pizza toppings,
sodas, fast-food fries, BBQ sides, pies, breakfast plates, chips, ice
cream, Kool-Aid, sauces, and gas-station snacks.

## Write-ins (v4)

Any pick can be a **write-in**. On the Leader's pick screen and on the
voting screen, next to the 4 squares, there is an **✍️ Write in your
own** box (40 characters max). The Leader can lock a write-in in secret;
the crowd can vote write-ins; and a Switch Sides move — including the
Man on an Island escape — can land on a fresh write-in too.

How write-ins score — they are **buckets**, just like squares:

- Write-in text is normalized into a grouping key: trimmed, lowercased,
  punctuation stripped, extra spaces collapsed. "Froot Loops",
  "froot loops!" and " FROOT  LOOPS " are the same bucket. A bucket is
  displayed with the first version anybody submitted.
- If a write-in's key matches a printed square's text, it counts **as
  that square** — no separate bucket, no double-counting.
- Everything else works exactly like squares: the top bucket takes the
  majority, the Leader scores +3 when the top bucket is theirs (printed
  or written), matching the Leader's bucket pays the match point, a tied
  top is a split, and a lone voter in a write-in bucket gets the Man on
  an Island nudge like anybody else. Lightning Rounds take write-ins
  too, bucketed the same way.

**Secrecy:** a write-in is as secret as a square. Before the reveal,
other players see only that you voted — and, in the coin window, that a
masked "✍️ Write-in" bucket holds N votes. The actual words are never
sent to another phone until the reveal flips. (Even the bucket's
internal key stays server-side; state carries an opaque bucket id.)

**House Rule — Write-ins** (set in the lobby, **default ON**). Off: the
write-in boxes disappear and the server refuses write-in submissions,
so the table plays the printed 4 only.

Stated simplifications: **bots never write in** — they lead and vote the
printed squares only (their scoring runs on the same buckets). The
**Phone a Friend** poll still offers the 4 printed squares only, and
the free vote change it grants lands on a printed square too.

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
6. **Write-ins** — *On* (default): the Leader and the crowd may write in
   their own pick instead of tapping a square vs *Off*: the printed 4
   only (see the Write-ins section above).

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
bots.js            Bot players: names, personalities, their card judgment
deck.js            The full 150-card deck + winner result-card texts
public/index.html  The entire phone client (no build step, no CDN)
test/e2e-test.js   Scripted end-to-end tests (Games A/B/C/D/E/E5/G + personalities)
test/last-run.log  Latest passing test output (105 assertions)
```

## Test

```bash
npm test   # spawns the server with fast timers and plays scripted games
```

The suite asserts exact scoring (majority/match/split math), coin behavior
(Filibuster re-poll, Switch Sides, Phone a Friend answered over HTTP),
secrecy of the Leader's pick, reconnection, and a tie forced into a
Lightning Round with a declared winner (Games A and B, 46 assertions).
Game C adds the bots: host-only add/remove in the lobby, a 1-human +
2-bot game played to a winner with bot-led rounds and a bot Man on an
Island, and a distribution sanity check that the four personalities
measurably vote differently. Game D adds v3: deck integrity for the
150-card deck (exactly 4 options per card, no duplicate prompts, the
Food Debates batch tagged consistently) and the group chat — delivery
in the lobby and mid-game, no leaks into another room, the join-time
history handoff, empty/over-length handling, HTML kept inert, and the
send-rate guard. Games E, E5, and G add v4 write-ins: a secret leader
write-in the crowd matches for +3, twin write-ins with different
casing/punctuation grouping into one bucket, a write-in that spells a
printed square counting as that square, a lone write-in voter taking
the Island switch to a fresh write-in, masked write-in buckets before
the reveal, a full write-in game played to a winner, and the Write-ins
House Rule switched off — write-in submissions refused while the
printed game proceeds.
