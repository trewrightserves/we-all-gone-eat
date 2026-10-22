'use strict';
// We All Gone Eat — game server.
// Holds ALL game state server-side. The leader's secret pick is never
// included in any state sent to other clients before the reveal.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { CARDS, WINNER_TEXTS } = require('./deck');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DISCUSSION_MS = parseInt(process.env.DISCUSSION_MS || '60000', 10);
const REPOLL_MS = parseInt(process.env.REPOLL_MS || '15000', 10);

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O look-alikes
const MAX_PLAYERS = 8;
const MIN_PLAYERS = 3;

const rooms = new Map(); // code -> room
const polls = new Map(); // token -> poll

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function newId() { return crypto.randomBytes(8).toString('hex'); }
function newToken() { return crypto.randomBytes(16).toString('hex'); }

function defaultSettings() {
  return {
    targetScore: 7,          // 7 | 10 | 12 | 15
    winCheck: 'immediate',   // 'immediate' | 'rotation'   (House Rule 1)
    splitRule: 'pays',       // 'pays' | 'split'          (House Rule 2)
    coinLimit: 'player',     // 'player' | 'table'        (House Rule 3)
    switchTiming: 'after',   // 'after' | 'before'        (House Rule 4)
  };
}

function freshCoins() { return { filibuster: true, switch: true, phone: true }; }

function makePlayer(name) {
  return {
    id: newId(),
    token: newToken(),
    name: String(name || 'Player').slice(0, 20),
    ws: null,
    connected: false,
    score: 0,
    coins: freshCoins(),
  };
}

function makeRoom(hostPlayer) {
  const room = {
    code: newCode(),
    hostId: hostPlayer.id,
    players: [hostPlayer],
    phase: 'lobby',
    settings: defaultSettings(),
    deckOrder: [],
    deckPos: 0,
    roundNumber: 0,
    round: null,       // active round state
    lastReveal: null,  // last completed round's reveal (shown in reveal phase)
    lightning: null,   // active lightning state
    lastLightning: null,
    winnerId: null,
    winnerText: null,
    createdAt: Date.now(),
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function shuffleDeck(room) {
  const idx = CARDS.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  room.deckOrder = idx;
  room.deckPos = 0;
}
function drawCard(room) {
  if (room.deckPos >= room.deckOrder.length) shuffleDeck(room);
  return CARDS[room.deckOrder[room.deckPos++]];
}

function effectiveHost(room) {
  const host = room.players.find(p => p.id === room.hostId);
  if (host && host.connected) return host;
  return room.players.find(p => p.connected) || host;
}
function isHost(room, player) {
  const h = effectiveHost(room);
  return h && h.id === player.id;
}
function crowdOf(room) {
  return room.players.filter(p => p.id !== room.round.leaderId);
}
function tallyOf(votes, n = 4) {
  const t = [0, 0, 0, 0];
  for (const v of votes.values()) if (v >= 0 && v < n) t[v]++;
  return t;
}
function topInfo(tally) {
  const max = Math.max(...tally);
  const tops = tally.map((c, i) => (c === max ? i : -1)).filter(i => i >= 0);
  return { max, tops, isSplit: tops.length > 1 };
}

// ---------- state serialization (per-player; protects the secret pick) ----------
function stateFor(room, me) {
  const host = effectiveHost(room);
  const r = room.round;
  const inRound = !!r && ['leaderPick', 'voting', 'coinWindow', 'discussion', 'repoll'].includes(room.phase);
  const showTally = !!r && ['coinWindow', 'discussion', 'repoll', 'reveal'].includes(room.phase);
  const view = {
    type: 'state',
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    isHost: isHost(room, me),
    you: {
      id: me.id,
      name: me.name,
      score: me.score,
      coins: me.coins,
      isLeader: !!r && r.leaderId === me.id,
      yourVote: r ? (r.votes.get(me.id) ?? null) : (room.lightning ? (room.lightning.votes.get(me.id) ?? null) : null),
      yourPick: r && r.leaderId === me.id ? r.leaderPick : null,
      freeChange: !!r && r.freeChange.has(me.id),
      ready: !!r && r.ready.has(me.id),
    },
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      isHost: host && p.id === host.id,
      isLeader: !!r && r.leaderId === p.id,
      hasVoted: r ? r.votes.has(p.id) : (room.lightning ? room.lightning.votes.has(p.id) : false),
      coins: p.coins,
    })),
    roundNumber: room.roundNumber,
    leaderId: r ? r.leaderId : null,
    leaderName: r ? (room.players.find(p => p.id === r.leaderId) || {}).name : null,
    card: inRound || room.phase === 'reveal' ? (r ? r.card : null) : (room.lightning ? room.lightning.card : null),
    tally: showTally && r ? tallyOf(r.votes) : null,
    votesIn: r ? r.votes.size : 0,
    crowdCount: r ? crowdOf(room).length : 0,
    timerEndsAt: r && (room.phase === 'discussion' || room.phase === 'repoll') ? r.timerEndsAt : null,
    filibusterBy: r ? r.filibusterBy : null,
    lastReveal: (room.phase === 'reveal' || room.phase === 'lightning') ? room.lastReveal : null,
    lightning: room.lightning ? {
      contenders: room.lightning.contenders,
      card: room.lightning.card,
      votesIn: room.lightning.votes.size,
      attempts: room.lightning.attempts,
    } : null,
    lastLightning: room.lastLightning,
    winner: room.phase === 'gameOver' && room.winnerId ? {
      id: room.winnerId,
      name: (room.players.find(p => p.id === room.winnerId) || {}).name,
      text: room.winnerText,
    } : null,
    standings: [...room.players].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score })),
  };
  return view;
}

function send(player, obj) {
  if (player.ws && player.ws.readyState === 1) {
    player.ws.send(JSON.stringify(obj));
  }
}
function broadcast(room) {
  for (const p of room.players) if (p.connected) send(p, stateFor(room, p));
}
function fail(player, message) { send(player, { type: 'error', message }); }

// ---------- round flow ----------
function startGame(room) {
  for (const p of room.players) { p.score = 0; p.coins = freshCoins(); }
  shuffleDeck(room);
  room.roundNumber = 0;
  room.winnerId = null;
  room.winnerText = null;
  room.lastReveal = null;
  room.lastLightning = null;
  room.lightning = null;
  nextRound(room);
}

function nextRound(room) {
  room.roundNumber += 1;
  const leader = room.players[(room.roundNumber - 1) % room.players.length];
  room.round = {
    leaderId: leader.id,
    card: drawCard(room),
    leaderPick: null,
    votes: new Map(),
    coinsUsed: new Map(), // playerId -> coins used this round
    tableCoinsUsed: 0,
    ready: new Set(),
    freeChange: new Set(),
    timerEndsAt: null,
    timer: null,
    filibusterBy: null,
    pollTokens: [],
  };
  room.lightning = null;
  room.phase = 'leaderPick';
  broadcast(room);
}

function checkVoteComplete(room) {
  if (room.phase !== 'voting') return;
  const crowd = crowdOf(room).filter(p => p.connected);
  if (crowd.length === 0) return;
  if (crowd.every(p => room.round.votes.has(p.id))) {
    room.phase = 'coinWindow';
    if (room.settings.switchTiming === 'after') sendIslandPrompts(room);
    broadcast(room);
  }
}

function sendIslandPrompts(room) {
  const tally = tallyOf(room.round.votes);
  for (const p of crowdOf(room)) {
    const v = room.round.votes.get(p.id);
    if (v !== undefined && tally[v] === 1 && p.connected && p.coins.switch) {
      send(p, { type: 'islandPrompt', option: v, optionLabel: room.round.card.options[v] });
    }
  }
}

function coinGate(room, player) {
  // returns error string or null if the player may spend a coin right now
  const limit = room.settings.coinLimit;
  const usedByPlayer = room.round.coinsUsed.get(player.id) || 0;
  if (limit === 'player' && usedByPlayer >= 1) return 'House rule: one coin per player per round.';
  if (limit === 'table' && room.round.tableCoinsUsed >= 1) return 'House rule: one coin per round for the whole table.';
  return null;
}
function spendCoin(room, player, coin) {
  player.coins[coin] = false;
  room.round.coinsUsed.set(player.id, (room.round.coinsUsed.get(player.id) || 0) + 1);
  room.round.tableCoinsUsed += 1;
}

function startDiscussion(room, byPlayer) {
  const r = room.round;
  room.phase = 'discussion';
  r.filibusterBy = byPlayer.name;
  r.timerEndsAt = Date.now() + DISCUSSION_MS;
  clearTimeout(r.timer);
  r.timer = setTimeout(() => {
    room.phase = 'repoll';
    r.timerEndsAt = Date.now() + REPOLL_MS;
    broadcast(room);
    r.timer = setTimeout(() => {
      r.timerEndsAt = null;
      r.filibusterBy = null;
      room.phase = 'coinWindow';
      if (room.settings.switchTiming === 'after') sendIslandPrompts(room);
      broadcast(room);
    }, REPOLL_MS);
    broadcast(room);
  }, DISCUSSION_MS);
  broadcast(room);
}

function checkAllReady(room) {
  if (room.phase !== 'coinWindow') return;
  const connected = room.players.filter(p => p.connected);
  if (connected.length && connected.every(p => room.round.ready.has(p.id))) doReveal(room);
}

function doReveal(room) {
  const r = room.round;
  clearTimeout(r.timer);
  // expire this round's polls
  for (const t of r.pollTokens) { const poll = polls.get(t); if (poll) poll.expired = true; }
  const tally = tallyOf(r.votes);
  const { tops, isSplit } = topInfo(tally);
  const leader = room.players.find(p => p.id === r.leaderId);
  let leaderPoints = 0;
  if (!isSplit && tops[0] === r.leaderPick) leaderPoints = 3;
  leader.score += leaderPoints;

  const breakdown = crowdOf(room).map(p => {
    const v = r.votes.get(p.id);
    const hasVote = v !== undefined;
    const inTop = hasVote && tops.includes(v);
    const majority = hasVote && (isSplit ? (room.settings.splitRule === 'pays' && inTop) : inTop);
    const match = hasVote && v === r.leaderPick;
    const points = (majority ? 1 : 0) + (match ? 1 : 0);
    p.score += points;
    return { playerId: p.id, name: p.name, vote: hasVote ? v : null, voteLabel: hasVote ? r.card.options[v] : null, majority, match, points, total: p.score };
  });

  room.lastReveal = {
    card: r.card,
    leaderId: r.leaderId,
    leaderName: leader.name,
    leaderPick: r.leaderPick,
    leaderPickLabel: r.card.options[r.leaderPick],
    leaderPoints,
    tally,
    topOptions: tops,
    isSplit,
    breakdown,
  };
  room.phase = 'reveal';
  broadcast(room);

  // ---- win check ----
  const rotationDone = room.roundNumber % room.players.length === 0;
  const winDue = room.settings.winCheck === 'immediate' || rotationDone;
  if (!winDue) return;
  const topScore = Math.max(...room.players.map(p => p.score));
  if (topScore < room.settings.targetScore) return;
  const leaders = room.players.filter(p => p.score === topScore);
  if (leaders.length === 1) {
    finishGame(room, leaders[0]);
  } else {
    startLightning(room, leaders.map(p => p.id));
  }
}

function startLightning(room, contenders) {
  room.lightning = {
    contenders,
    card: drawCard(room),
    votes: new Map(),
    attempts: [],
    leaderId: room.round ? room.round.leaderId : null,
  };
  room.phase = 'lightning';
  broadcast(room);
}

function checkLightningComplete(room) {
  if (room.phase !== 'lightning') return;
  const connected = room.players.filter(p => p.connected);
  if (connected.length && connected.every(p => room.lightning.votes.has(p.id))) resolveLightning(room);
}

function resolveLightning(room) {
  const L = room.lightning;
  const leaderId = L.leaderId;
  const primaryIds = new Set([...L.contenders, ...(leaderId ? [leaderId] : [])]);
  const primaryVotes = [...L.votes.entries()].filter(([id]) => primaryIds.has(id)).map(([, v]) => v);
  const tieVotes = [...L.votes.entries()].filter(([id]) => !primaryIds.has(id)).map(([, v]) => v);

  function countsFor(extra) {
    const pool = [...primaryVotes, ...extra];
    const tally = tallyOf(pool);
    return L.contenders.map(id => ({ id, vote: L.votes.get(id), count: tally[L.votes.get(id)] || 0 }));
  }
  let standings = countsFor([]);
  let best = Math.max(...standings.map(s => s.count));
  let winners = standings.filter(s => s.count === best);
  let usedTiebreak = false;
  if (winners.length > 1 && tieVotes.length > 0) {
    usedTiebreak = true;
    standings = countsFor(tieVotes);
    best = Math.max(...standings.map(s => s.count));
    winners = standings.filter(s => s.count === best);
  }
  L.attempts.push({
    card: L.card,
    standings: standings.map(s => ({ name: (room.players.find(p => p.id === s.id) || {}).name, vote: s.vote, voteLabel: L.card.options[s.vote], count: s.count })),
    usedTiebreak,
  });
  if (winners.length === 1) {
    room.lastLightning = { attempts: L.attempts, winnerId: winners[0].id };
    const winner = room.players.find(p => p.id === winners[0].id);
    room.lightning = null;
    finishGame(room, winner);
  } else {
    L.card = drawCard(room);
    L.votes = new Map();
    broadcast(room);
  }
}

function finishGame(room, winner) {
  room.winnerId = winner.id;
  const template = WINNER_TEXTS[crypto.randomInt(WINNER_TEXTS.length)];
  room.winnerText = template.replace('{Name}', winner.name);
  room.phase = 'gameOver';
  broadcast(room);
}

// ---------- message handling ----------
function handleMessage(room, player, msg) {
  const r = room.round;
  switch (msg.type) {
    case 'setSettings': {
      if (!isHost(room, player) || room.phase !== 'lobby') return fail(player, 'Only the host can change House Rules in the lobby.');
      const s = msg.settings || {};
      if ([7, 10, 12, 15].includes(s.targetScore)) room.settings.targetScore = s.targetScore;
      if (['immediate', 'rotation'].includes(s.winCheck)) room.settings.winCheck = s.winCheck;
      if (['pays', 'split'].includes(s.splitRule)) room.settings.splitRule = s.splitRule;
      if (['player', 'table'].includes(s.coinLimit)) room.settings.coinLimit = s.coinLimit;
      if (['after', 'before'].includes(s.switchTiming)) room.settings.switchTiming = s.switchTiming;
      broadcast(room);
      break;
    }
    case 'startGame': {
      if (!isHost(room, player)) return fail(player, 'Only the host can start the game.');
      if (room.phase !== 'lobby' && room.phase !== 'gameOver') return fail(player, 'Game already running.');
      if (room.players.length < MIN_PLAYERS) return fail(player, `Need at least ${MIN_PLAYERS} players to start.`);
      startGame(room);
      break;
    }
    case 'leaderPick': {
      if (room.phase !== 'leaderPick' || !r || r.leaderId !== player.id) return fail(player, 'Not your pick right now.');
      const opt = msg.option | 0;
      if (opt < 0 || opt > 3) return fail(player, 'Pick one of the four squares.');
      r.leaderPick = opt;
      room.phase = 'voting';
      broadcast(room);
      checkVoteComplete(room);
      break;
    }
    case 'vote': {
      const opt = msg.option | 0;
      if (opt < 0 || opt > 3) return fail(player, 'Vote for one of the four squares.');
      if (room.phase === 'lightning') {
        room.lightning.votes.set(player.id, opt);
        broadcast(room);
        checkLightningComplete(room);
        break;
      }
      if (!r) return fail(player, 'No round in progress.');
      if (r.leaderId === player.id) return fail(player, 'The Leader does not vote.');
      if (room.phase === 'voting') {
        if (r.votes.has(player.id)) return fail(player, 'Vote locked. Switch Sides can change it.');
        r.votes.set(player.id, opt);
        broadcast(room);
        checkVoteComplete(room);
      } else if (room.phase === 'repoll') {
        r.votes.set(player.id, opt); // free change during re-poll
        broadcast(room);
      } else {
        return fail(player, 'Voting is not open right now.');
      }
      break;
    }
    case 'switchVote': {
      // This spends the Switch Sides coin.
      if (!r) return fail(player, 'No round in progress.');
      if (r.leaderId === player.id) return fail(player, 'The Leader has no vote to switch.');
      if (!player.coins.switch) return fail(player, 'Your Switch Sides coin is spent.');
      const opt = msg.option | 0;
      if (opt < 0 || opt > 3) return fail(player, 'Pick one of the four squares.');
      if (!r.votes.has(player.id)) return fail(player, 'Vote first, then switch.');
      const timing = room.settings.switchTiming;
      const phaseOk = timing === 'after' ? room.phase === 'coinWindow' : room.phase === 'voting';
      if (!phaseOk) return fail(player, timing === 'after' ? 'Switch Sides opens after the tally is shown.' : 'House rule: Switch Sides must be played before the tally is shown.');
      const gate = coinGate(room, player);
      if (gate) return fail(player, gate);
      spendCoin(room, player, 'switch');
      r.votes.set(player.id, opt);
      broadcast(room);
      if (room.phase === 'voting') checkVoteComplete(room);
      break;
    }
    case 'freeVote': {
      // The one free change granted after a Phone a Friend answer.
      if (!r || !r.freeChange.has(player.id)) return fail(player, 'No free change waiting.');
      const opt = msg.option | 0;
      if (opt < 0 || opt > 3) return fail(player, 'Pick one of the four squares.');
      if (!['coinWindow', 'discussion'].includes(room.phase)) return fail(player, 'Too late to change that vote.');
      r.freeChange.delete(player.id);
      r.votes.set(player.id, opt);
      broadcast(room);
      break;
    }
    case 'useCoin': {
      if (!r) return fail(player, 'No round in progress.');
      if (room.phase !== 'coinWindow') return fail(player, 'Coins play in the coin window, before the reveal.');
      if (msg.coin === 'filibuster') {
        if (!player.coins.filibuster) return fail(player, 'Your Filibuster coin is spent.');
        const gate = coinGate(room, player);
        if (gate) return fail(player, gate);
        spendCoin(room, player, 'filibuster');
        startDiscussion(room, player);
      } else if (msg.coin === 'phone') {
        if (r.leaderId === player.id) return fail(player, 'The Leader cannot phone a friend.');
        if (!player.coins.phone) return fail(player, 'Your Phone a Friend coin is spent.');
        const gate = coinGate(room, player);
        if (gate) return fail(player, gate);
        spendCoin(room, player, 'phone');
        const token = newToken();
        polls.set(token, {
          token, roomCode: room.code, askerId: player.id,
          card: r.card, answered: false, answer: null, expired: false,
        });
        r.pollTokens.push(token);
        send(player, { type: 'phoneLink', path: `/poll/${token}`, token });
        broadcast(room);
      } else {
        return fail(player, 'Unknown coin.');
      }
      break;
    }
    case 'ready': {
      if (room.phase !== 'coinWindow' || !r) return;
      r.ready.add(player.id);
      broadcast(room);
      checkAllReady(room);
      break;
    }
    case 'forceReveal': {
      if (!isHost(room, player)) return fail(player, 'Only the host can force the reveal.');
      if (room.phase !== 'coinWindow') return fail(player, 'Nothing to reveal yet.');
      doReveal(room);
      break;
    }
    case 'nextRound': {
      if (!isHost(room, player)) return fail(player, 'Only the host can advance the round.');
      if (room.phase !== 'reveal') return fail(player, 'Finish the reveal first.');
      nextRound(room);
      break;
    }
    case 'hostSkip': {
      // Lets a table recover if the leader drops mid-pick.
      if (!isHost(room, player)) return fail(player, 'Only the host can skip a round.');
      if (!['leaderPick', 'voting'].includes(room.phase)) return fail(player, 'Can only skip during pick/vote.');
      clearTimeout(r.timer);
      nextRound(room);
      break;
    }
    case 'playAgain': {
      if (!isHost(room, player)) return fail(player, 'Only the host can restart.');
      if (room.phase !== 'gameOver') return fail(player, 'The game is not over yet.');
      for (const p of room.players) { p.score = 0; p.coins = freshCoins(); }
      room.winnerId = null;
      room.winnerText = null;
      room.round = null;
      room.lightning = null;
      room.lastReveal = null;
      room.lastLightning = null;
      room.roundNumber = 0;
      room.phase = 'lobby';
      broadcast(room);
      break;
    }
    default:
      fail(player, 'Unknown message.');
  }
}

// ---------- HTTP (client + phone-a-friend poll pages) ----------
function pollPage(poll, req) {
  const opts = poll.card.options.map((o, i) =>
    `<button onclick="answer(${i})">${o}</button>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Phone a Friend — We All Gone Eat</title>
<style>body{font-family:system-ui;background:#000;color:#fff;text-align:center;padding:24px}
button{display:block;width:100%;max-width:420px;margin:10px auto;padding:16px;font-size:18px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;border-radius:12px;border:2px solid #f5b921;background:#0d0d0d;color:#f5b921;cursor:pointer}
button:active{background:#f5b921;color:#000}
h1{color:#f5b921;text-transform:uppercase;letter-spacing:.04em}
.emblem{width:180px;max-width:60vw;height:auto}
.card{font-size:20px;margin:16px 0}.cat{color:#ff3b30;text-transform:uppercase;letter-spacing:.05em}</style></head>
<body><img class="emblem" src="/brand-emblem.png" alt="We All Gone Eat">
<h1>🍗 Phone a Friend</h1>
<p>A player in <b>We All Gone Eat</b> needs your call on this card:</p>
<p class="card"><b class="cat">${poll.card.category}</b><br>${poll.card.prompt}</p>
<div id="opts">${opts}</div>
<p id="done"></p>
<script>
async function answer(i){
  const res = await fetch(location.pathname, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({option:i})});
  const data = await res.json();
  document.getElementById('opts').innerHTML = '';
  document.getElementById('done').textContent = data.ok ? 'Got it — your pick was sent back to the table. Thanks!' : (data.error || 'That poll is closed.');
}
</script></body></html>`;
}

// Brand art: exact-path whitelist only. The filename is never derived from
// the request, so there is no directory traversal surface.
const STATIC_ART = {
  '/brand-emblem.png': ['brand-emblem.png', 'image/png'],
  '/brand-mascot.png': ['brand-mascot.png', 'image/png'],
  '/brand-emblem.webp': ['brand-emblem.webp', 'image/webp'],
  '/brand-mascot.webp': ['brand-mascot.webp', 'image/webp'],
  '/favicon-64.png': ['favicon-64.png', 'image/png'],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  const pollMatch = url.pathname.match(/^\/poll\/([a-f0-9]+)$/);
  if (pollMatch) {
    const poll = polls.get(pollMatch[1]);
    if (req.method === 'GET') {
      if (!poll || poll.expired) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!DOCTYPE html><html><body style="font-family:system-ui;background:#000;color:#fff;text-align:center;padding:24px"><img src="/brand-emblem.png" alt="We All Gone Eat" style="width:180px;max-width:60vw;height:auto"><h1 style="color:#f5b921;text-transform:uppercase">That poll has closed.</h1></body></html>');
      }
      if (poll.answered) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<!DOCTYPE html><html><body style="font-family:system-ui;background:#000;color:#fff;text-align:center;padding:24px"><img src="/brand-emblem.png" alt="We All Gone Eat" style="width:180px;max-width:60vw;height:auto"><h1 style="color:#f5b921;text-transform:uppercase">Already answered — thanks!</h1></body></html>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(pollPage(poll));
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (!poll || poll.expired) return res.end(JSON.stringify({ ok: false, error: 'That poll has closed.' }));
        if (poll.answered) return res.end(JSON.stringify({ ok: false, error: 'Already answered.' }));
        let opt;
        try { opt = JSON.parse(body).option | 0; } catch { return res.end(JSON.stringify({ ok: false, error: 'Bad request.' })); }
        if (opt < 0 || opt > 3) return res.end(JSON.stringify({ ok: false, error: 'Pick one of the four.' }));
        poll.answered = true;
        poll.answer = opt;
        const room = rooms.get(poll.roomCode);
        if (room && room.round) {
          const asker = room.players.find(p => p.id === poll.askerId);
          if (asker) {
            room.round.freeChange.add(asker.id);
            send(asker, { type: 'phoneResult', option: opt, optionLabel: poll.card.options[opt] });
            broadcast(room);
          }
        }
        return res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
  }
  const art = STATIC_ART[url.pathname];
  if (art) {
    const file = path.join(__dirname, 'public', art[0]);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': art[1], 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(__dirname, 'public', 'index.html');
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(500); return res.end('client missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let room = null;
  let player = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (msg.type === 'create') {
        player = makePlayer(msg.name);
        room = makeRoom(player);
        player.ws = ws;
        player.connected = true;
        send(player, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: true });
        broadcast(room);
        return;
      }
      if (msg.type === 'join') {
        const target = rooms.get(String(msg.code || '').toUpperCase());
        if (!target) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code.' })); return; }
        room = target;
        // Rejoin by token first, then by name match on a disconnected seat.
        let seat = null;
        if (msg.token) seat = room.players.find(p => p.token === msg.token);
        if (!seat && msg.name) seat = room.players.find(p => !p.connected && p.name.toLowerCase() === String(msg.name).toLowerCase());
        if (seat) {
          player = seat;
          player.ws = ws;
          player.connected = true;
          if (msg.name) player.name = String(msg.name).slice(0, 20);
          send(player, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: isHost(room, player), rejoined: true });
          broadcast(room);
          // Re-issue an island prompt if the table is sitting in the coin window.
          if (room.phase === 'coinWindow' && room.settings.switchTiming === 'after') sendIslandPrompts(room);
          return;
        }
        if (room.phase !== 'lobby') { ws.send(JSON.stringify({ type: 'error', message: 'That game already started. Rejoin with the same name to reclaim your seat.' })); return; }
        if (room.players.length >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'That room is full (8 players).' })); return; }
        player = makePlayer(msg.name);
        player.ws = ws;
        player.connected = true;
        room.players.push(player);
        send(player, { type: 'joined', code: room.code, playerId: player.id, token: player.token, isHost: false });
        broadcast(room);
        return;
      }
      if (!room || !player) { ws.send(JSON.stringify({ type: 'error', message: 'Join a room first.' })); return; }
      handleMessage(room, player, msg);
    } catch (e) {
      console.error('message error', e);
      if (player) fail(player, 'Something went wrong with that move.');
    }
  });

  ws.on('close', () => {
    if (room && player) {
      player.connected = false;
      player.ws = null;
      // Re-evaluate completion gates that wait on connected players.
      if (room.phase === 'voting') checkVoteComplete(room);
      if (room.phase === 'coinWindow') checkAllReady(room);
      if (room.phase === 'lightning') checkLightningComplete(room);
      if (!room.players.some(p => p.connected)) room.emptySince = Date.now();
      broadcast(room);
    }
  });
});

// Keep sockets alive on hosts that idle-timeout.
setInterval(() => {
  for (const client of wss.clients) { try { client.ping(); } catch {} }
}, 30000);

// Reap rooms empty for 30+ minutes.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 30 * 60 * 1000) {
      if (room.round) clearTimeout(room.round.timer);
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log(`We All Gone Eat server listening on port ${PORT}`);
});
