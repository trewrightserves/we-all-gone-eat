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
const { PERSONALITIES, PERSONALITY_ORDER, BOT_NAMES, chooseOption, islandDecision } = require('./bots');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DISCUSSION_MS = parseInt(process.env.DISCUSSION_MS || '60000', 10);
const REPOLL_MS = parseInt(process.env.REPOLL_MS || '15000', 10);
// Bot "thinking" time: a human-like pause before a bot picks, votes,
// readies up, or answers its Man on an Island nudge.
const BOT_DELAY_MIN_MS = parseInt(process.env.BOT_DELAY_MIN_MS || '1500', 10);
const BOT_DELAY_MAX_MS = parseInt(process.env.BOT_DELAY_MAX_MS || '4000', 10);
// Group chat: a plain relay inside the room. Messages are length-capped,
// lightly rate-guarded, kept only in room memory, and carry no game state.
const CHAT_MAX_LEN = 300;
const CHAT_HISTORY_MAX = 50;      // room keeps this much talk; joiners get it
const CHAT_RATE_COUNT = 5;        // messages allowed...
const CHAT_RATE_WINDOW_MS = 4000; // ...per this window, per player
// Write-ins (v4): a player may type their own pick instead of tapping a
// square. Text is capped, trimmed, and normalized into a grouping key.
const WRITEIN_MAX_LEN = 40;

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
    writeIns: true,          // true | false              (House Rule 5, v4)
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
    isBot: false,
    personality: null, // key into PERSONALITIES, bots only
  };
}

// A bot is a regular player with no socket: connected stays true so the
// phase gates count it, and driveBots() plays its turns on timers.
// The host is always a human, so bots are only ever created by addBot.
function makeBot(room) {
  const usedNames = new Set(room.players.map(p => p.name));
  let name = BOT_NAMES.find(n => !usedNames.has(n));
  if (!name) name = `Bot Cousin ${room.players.filter(p => p.isBot).length + 1}`;
  const botCount = room.players.filter(p => p.isBot).length;
  const personality = PERSONALITY_ORDER[botCount % PERSONALITY_ORDER.length];
  const bot = makePlayer(name);
  bot.isBot = true;
  bot.personality = personality;
  bot.connected = true;
  bot._botTimer = null;
  bot._botFor = null;
  return bot;
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
    voteHistory: [],   // tallies from completed rounds (public info; bots read this)
    chat: [],          // room talk, oldest first, capped at CHAT_HISTORY_MAX
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
  // Hosting falls to a connected HUMAN — a bot never runs the table.
  return room.players.find(p => p.connected && !p.isBot) || room.players.find(p => p.connected) || host;
}
function isHost(room, player) {
  const h = effectiveHost(room);
  return h && h.id === player.id;
}
function crowdOf(room) {
  return room.players.filter(p => p.id !== room.round.leaderId);
}
function tallyOf(votes, n = 4) {
  // Printed-square counts only: write-in choices (string keys) are not
  // squares. Bots read this as their popularity heuristic, unchanged.
  const t = [0, 0, 0, 0];
  for (const v of votes.values()) if (typeof v === 'number' && v >= 0 && v < n) t[v]++;
  return t;
}
// ---------- write-ins (v4) ----------
// A stored choice is either a printed option index (number) or a write-in
// key (string). A write-in's key is its text normalized: trimmed, lowercased,
// punctuation stripped, whitespace collapsed — so "Froot Loops",
// "froot loops!" and " FROOT  LOOPS " are the same bucket. If the key
// matches a printed option's normalized text, the write-in counts AS that
// printed option (stored as the number). Otherwise the write-in forms its
// own bucket, displayed with the first-submitted original (trimmed) text.
function normalizeWriteIn(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function bucketKey(choice) {
  return typeof choice === 'number' ? 'o' + choice : 'w:' + choice;
}
function bucketCountsOf(votes) {
  const m = new Map();
  for (const v of votes.values()) {
    const k = bucketKey(v);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function topBucketsOf(counts) {
  let max = 0;
  for (const c of counts.values()) max = Math.max(max, c);
  const tops = [...counts.keys()].filter(k => counts.get(k) === max);
  return { max, tops, isSplit: tops.length > 1 };
}
function choiceLabel(card, choice, writeLabels) {
  if (typeof choice === 'number') return card.options[choice];
  return (writeLabels && writeLabels.get(choice)) || choice;
}
// Buckets in display order: printed squares in card order, then write-in
// buckets in first-submitted order. Pre-reveal, write-in labels are MASKED
// (counts are public tally info; the text is secret until the reveal).
function bucketsForState(card, votes, writeLabels, revealText) {
  const counts = bucketCountsOf(votes);
  const out = [];
  for (let i = 0; i < 4; i++) {
    const c = counts.get('o' + i) || 0;
    if (c) out.push({ key: 'o' + i, label: card.options[i], count: c, writeIn: false });
  }
  const seen = new Set(out.map(b => b.key));
  let wiCount = 0;
  for (const v of votes.values()) {
    const k = bucketKey(v);
    if (typeof v === 'string' && !seen.has(k)) {
      seen.add(k);
      // The state key is deliberately OPAQUE ('w0', 'w1' by appearance):
      // the real bucket key is the normalized write-in text, and shipping
      // it would leak everyone's words before the reveal.
      out.push({ key: 'w' + (wiCount++), label: revealText ? choiceLabel(card, v, writeLabels) : '✍️ Write-in', count: counts.get(k) || 0, writeIn: true });
    }
  }
  return out;
}
// Resolve a client submission ({option} or {writeIn}) into a stored choice.
// writeLabels records each write-in bucket's first-submitted display text.
function parseChoice(room, card, msg, writeLabels) {
  if (typeof msg.writeIn === 'string') {
    if (!room.settings.writeIns) return { error: 'House rule: write-ins are off at this table.' };
    const text = msg.writeIn.trim().slice(0, WRITEIN_MAX_LEN);
    const key = normalizeWriteIn(text);
    if (!text || !key) return { error: 'Write something in first — blank plates do not count.' };
    const printed = card.options.findIndex(o => normalizeWriteIn(o) === key);
    if (printed >= 0) return { choice: printed };
    if (writeLabels && !writeLabels.has(key)) writeLabels.set(key, text);
    return { choice: key };
  }
  const opt = msg.option | 0;
  if (opt < 0 || opt > 3) return { error: 'Pick one of the four squares.' };
  return { choice: opt };
}

// ---------- state serialization (per-player; protects the secret pick) ----------
function stateFor(room, me) {
  const host = effectiveHost(room);
  const r = room.round;
  const inRound = !!r && ['leaderPick', 'voting', 'coinWindow', 'discussion', 'repoll'].includes(room.phase);
  const showTally = !!r && ['coinWindow', 'discussion', 'repoll', 'reveal'].includes(room.phase);
  // My own choice, split for the client: printed index in yourVote /
  // yourPick, write-in display text in yourVoteText / yourPickText. These
  // are the ONLY places write-in text appears in state before the reveal,
  // and only ever for the player who wrote it — never for anyone else.
  const myVoteRaw = r ? r.votes.get(me.id) : (room.lightning ? room.lightning.votes.get(me.id) : undefined);
  const myVoteCard = r ? r.card : (room.lightning ? room.lightning.card : null);
  const myVoteLabels = r ? r.writeLabels : (room.lightning ? room.lightning.writeLabels : null);
  const myPickRaw = r && r.leaderId === me.id ? r.leaderPick : undefined;
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
      yourVote: typeof myVoteRaw === 'number' ? myVoteRaw : null,
      yourVoteText: typeof myVoteRaw === 'string' ? choiceLabel(myVoteCard, myVoteRaw, myVoteLabels) : null,
      yourPick: typeof myPickRaw === 'number' ? myPickRaw : null,
      yourPickText: typeof myPickRaw === 'string' ? choiceLabel(r.card, myPickRaw, r.writeLabels) : null,
      freeChange: !!r && r.freeChange.has(me.id),
      ready: !!r && r.ready.has(me.id),
    },
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
      isBot: !!p.isBot,
      personality: p.isBot ? PERSONALITIES[p.personality].label : null,
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
    buckets: showTally && r ? bucketsForState(r.card, r.votes, r.writeLabels, room.phase === 'reveal') : null,
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
      isBot: !!(room.players.find(p => p.id === room.winnerId) || {}).isBot,
      text: room.winnerText,
    } : null,
    standings: [...room.players].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score, isBot: !!p.isBot })),
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
  driveBots(room);
}
function fail(player, message) { send(player, { type: 'error', message }); }
function sendChatHistory(room, player) {
  if (room.chat.length) send(player, { type: 'chatHistory', messages: room.chat });
}

// ---------- bot players ----------
// Bots act by feeding their moves through handleMessage, exactly like a
// human's taps — so every v1 rule (coin gates, pick secrecy, phase checks)
// is enforced on bots by the same code path. Bots only ever schedule
// timers; each timer re-validates the room/round/phase it was set for, so
// a stale timer from a skipped or restarted round can never fire a move.
function botDelay() {
  const span = Math.max(0, BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS);
  return BOT_DELAY_MIN_MS + Math.floor(Math.random() * (span + 1));
}
function scheduleBot(room, bot, tag, act) {
  // One pending move at a time — but a pending timer for a DIFFERENT tag
  // is stale by definition (that phase/round has passed, and its callback
  // would only guard-fail). Cancel it and schedule the current move, or
  // the bot can be left holding an old timer while the table waits on it.
  if (bot._botTimer && bot._botFor !== tag) clearBotTimer(bot);
  if (bot._botTimer) return;
  bot._botFor = tag;
  bot._botTimer = setTimeout(() => {
    bot._botTimer = null;
    bot._botFor = null;
    if (!rooms.has(room.code)) return;
    if (!room.players.includes(bot)) return;
    try { act(); } catch (e) { console.error('bot action error', e); }
  }, botDelay());
  if (bot._botTimer.unref) bot._botTimer.unref();
}
function clearBotTimer(bot) {
  if (bot._botTimer) { clearTimeout(bot._botTimer); bot._botTimer = null; bot._botFor = null; }
}

function driveBots(room) {
  const bots = room.players.filter(p => p.isBot);
  if (!bots.length) return;
  const r = room.round;

  if (room.phase === 'leaderPick' && r) {
    const leader = room.players.find(p => p.id === r.leaderId);
    if (leader && leader.isBot) {
      scheduleBot(room, leader, `pick:${room.roundNumber}`, () => {
        if (room.round !== r || room.phase !== 'leaderPick' || r.leaderPick !== null) return;
        const option = chooseOption(leader.personality, r.card, room.voteHistory);
        handleMessage(room, leader, { type: 'leaderPick', option });
      });
    }
    return;
  }

  if (room.phase === 'voting' && r) {
    for (const bot of bots) {
      if (bot.id === r.leaderId || r.votes.has(bot.id)) continue;
      scheduleBot(room, bot, `vote:${room.roundNumber}`, () => {
        if (room.round !== r || room.phase !== 'voting' || r.votes.has(bot.id)) return;
        const option = chooseOption(bot.personality, r.card, room.voteHistory);
        handleMessage(room, bot, { type: 'vote', option });
      });
    }
    return;
  }

  if (room.phase === 'coinWindow' && r) {
    for (const bot of bots) {
      if (r.ready.has(bot.id)) continue;
      scheduleBot(room, bot, `ready:${room.roundNumber}`, () => {
        if (room.round !== r || room.phase !== 'coinWindow' || r.ready.has(bot.id)) return;
        // Man on an Island: a bot stranded alone answers its own nudge
        // before readying up, so the table never stalls on a bot. This is
        // the ONLY way a bot ever spends a coin (its Switch Sides).
        const v = r.votes.get(bot.id);
        if (v !== undefined && tallyOf(r.votes)[v] === 1 && bot.coins.switch && room.settings.switchTiming === 'after') {
          const target = islandDecision(bot.personality, r.card, v, room.voteHistory);
          if (target !== null && target !== v) {
            handleMessage(room, bot, { type: 'switchVote', option: target });
          }
        }
        // The switch (or staying put) does not change the phase; ready up.
        if (room.round === r && room.phase === 'coinWindow' && !r.ready.has(bot.id)) {
          handleMessage(room, bot, { type: 'ready' });
        }
      });
    }
    return;
  }

  if (room.phase === 'lightning' && room.lightning) {
    const L = room.lightning;
    for (const bot of bots) {
      if (L.votes.has(bot.id)) continue;
      scheduleBot(room, bot, `lightning:${room.roundNumber}:${L.attempts.length}:${L.card.prompt}`, () => {
        if (room.lightning !== L || room.phase !== 'lightning' || L.votes.has(bot.id)) return;
        const option = chooseOption(bot.personality, L.card, room.voteHistory);
        handleMessage(room, bot, { type: 'vote', option });
      });
    }
  }
}

// ---------- round flow ----------
function startGame(room) {
  for (const p of room.players) { p.score = 0; p.coins = freshCoins(); }
  shuffleDeck(room);
  room.voteHistory = [];
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
    writeLabels: new Map(), // write-in bucket key -> first-submitted display text
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
  // A player is on an island when their BUCKET — printed square or
  // write-in — holds exactly one vote: theirs.
  const counts = bucketCountsOf(room.round.votes);
  for (const p of crowdOf(room)) {
    const v = room.round.votes.get(p.id);
    if (v !== undefined && counts.get(bucketKey(v)) === 1 && p.connected && p.coins.switch) {
      send(p, { type: 'islandPrompt', option: typeof v === 'number' ? v : null, writeIn: typeof v === 'string', optionLabel: choiceLabel(room.round.card, v, room.round.writeLabels) });
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
  // Scoring runs on BUCKETS: the 4 printed squares plus any write-in
  // buckets the crowd built. Top group, majority, and leader match are
  // all bucket comparisons, exactly as they were square comparisons.
  const counts = bucketCountsOf(r.votes);
  const { tops, isSplit } = topBucketsOf(counts);
  const leader = room.players.find(p => p.id === r.leaderId);
  let leaderPoints = 0;
  if (!isSplit && r.leaderPick !== null && tops[0] === bucketKey(r.leaderPick)) leaderPoints = 3;
  leader.score += leaderPoints;

  const breakdown = crowdOf(room).map(p => {
    const v = r.votes.get(p.id);
    const hasVote = v !== undefined;
    const inTop = hasVote && tops.includes(bucketKey(v));
    const majority = hasVote && (isSplit ? (room.settings.splitRule === 'pays' && inTop) : inTop);
    const match = hasVote && r.leaderPick !== null && bucketKey(v) === bucketKey(r.leaderPick);
    const points = (majority ? 1 : 0) + (match ? 1 : 0);
    p.score += points;
    return { playerId: p.id, name: p.name, isBot: !!p.isBot, vote: hasVote ? v : null, voteLabel: hasVote ? choiceLabel(r.card, v, r.writeLabels) : null, voteWriteIn: hasVote && typeof v === 'string', majority, match, points, total: p.score };
  });
  room.voteHistory.push(tally);

  room.lastReveal = {
    card: r.card,
    leaderId: r.leaderId,
    leaderName: leader.name,
    leaderPick: r.leaderPick,
    leaderPickLabel: r.leaderPick !== null ? choiceLabel(r.card, r.leaderPick, r.writeLabels) : null,
    leaderPickWriteIn: typeof r.leaderPick === 'string',
    leaderPoints,
    tally,
    topOptions: tops,
    buckets: bucketsForState(r.card, r.votes, r.writeLabels, true),
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
    writeLabels: new Map(),
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
  const primaryEntries = [...L.votes.entries()].filter(([id]) => primaryIds.has(id));
  const tieEntries = [...L.votes.entries()].filter(([id]) => !primaryIds.has(id));

  // Counts are per BUCKET (printed square or write-in), same as a reveal.
  function countsFor(extraEntries) {
    const counts = bucketCountsOf(new Map([...primaryEntries, ...extraEntries]));
    return L.contenders.map(id => {
      const vote = L.votes.get(id);
      return { id, vote, count: vote === undefined ? 0 : (counts.get(bucketKey(vote)) || 0) };
    });
  }
  let standings = countsFor([]);
  let best = Math.max(...standings.map(s => s.count));
  let winners = standings.filter(s => s.count === best);
  let usedTiebreak = false;
  if (winners.length > 1 && tieEntries.length > 0) {
    usedTiebreak = true;
    standings = countsFor(tieEntries);
    best = Math.max(...standings.map(s => s.count));
    winners = standings.filter(s => s.count === best);
  }
  L.attempts.push({
    card: L.card,
    standings: standings.map(s => ({ name: (room.players.find(p => p.id === s.id) || {}).name, vote: s.vote, voteLabel: s.vote === undefined ? null : choiceLabel(L.card, s.vote, L.writeLabels), count: s.count })),
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
    L.writeLabels = new Map(); // write-in keys belong to the old card
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
    case 'chat': {
      // Room-scoped table talk: a pure relay inside this room only. It
      // never touches phases, timers, coins, or the secret pick, and it
      // carries no game state. Bots don't chat.
      if (player.isBot) return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, CHAT_MAX_LEN) : '';
      if (!text) return; // empty talk is just air — drop it quietly
      const now = Date.now();
      player._chatTimes = (player._chatTimes || []).filter(t => now - t < CHAT_RATE_WINDOW_MS);
      if (player._chatTimes.length >= CHAT_RATE_COUNT) return fail(player, 'Slow down — the table can only read so fast.');
      player._chatTimes.push(now);
      const entry = { fromId: player.id, name: player.name, text, ts: now };
      room.chat.push(entry);
      if (room.chat.length > CHAT_HISTORY_MAX) room.chat.splice(0, room.chat.length - CHAT_HISTORY_MAX);
      const out = { type: 'chat', ...entry };
      for (const p of room.players) if (p.connected) send(p, out);
      break;
    }
    case 'setSettings': {
      if (!isHost(room, player) || room.phase !== 'lobby') return fail(player, 'Only the host can change House Rules in the lobby.');
      const s = msg.settings || {};
      if ([7, 10, 12, 15].includes(s.targetScore)) room.settings.targetScore = s.targetScore;
      if (['immediate', 'rotation'].includes(s.winCheck)) room.settings.winCheck = s.winCheck;
      if (['pays', 'split'].includes(s.splitRule)) room.settings.splitRule = s.splitRule;
      if (['player', 'table'].includes(s.coinLimit)) room.settings.coinLimit = s.coinLimit;
      if (['after', 'before'].includes(s.switchTiming)) room.settings.switchTiming = s.switchTiming;
      if (typeof s.writeIns === 'boolean') room.settings.writeIns = s.writeIns;
      broadcast(room);
      break;
    }
    case 'addBot': {
      if (!isHost(room, player)) return fail(player, 'Only the host can seat a bot.');
      if (room.phase !== 'lobby') return fail(player, 'Bots take their seats in the lobby, before the game starts.');
      if (room.players.length >= MAX_PLAYERS) return fail(player, 'The table is full — 8 seats, that is everybody.');
      const bot = makeBot(room);
      room.players.push(bot);
      broadcast(room);
      break;
    }
    case 'removeBot': {
      if (!isHost(room, player)) return fail(player, 'Only the host can send a bot back to the kitchen.');
      if (room.phase !== 'lobby') return fail(player, 'Bots leave from the lobby, not mid-game.');
      const idx = room.players.findIndex(p => p.id === msg.playerId && p.isBot);
      if (idx < 0) return fail(player, 'That seat is not a bot.');
      const [bot] = room.players.splice(idx, 1);
      clearBotTimer(bot);
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
      const parsed = parseChoice(room, r.card, msg, r.writeLabels);
      if (parsed.error) return fail(player, parsed.error);
      r.leaderPick = parsed.choice;
      room.phase = 'voting';
      broadcast(room);
      checkVoteComplete(room);
      break;
    }
    case 'vote': {
      if (room.phase === 'lightning') {
        const parsedL = parseChoice(room, room.lightning.card, msg, room.lightning.writeLabels);
        if (parsedL.error) return fail(player, parsedL.error);
        room.lightning.votes.set(player.id, parsedL.choice);
        broadcast(room);
        checkLightningComplete(room);
        break;
      }
      if (!r) return fail(player, 'No round in progress.');
      if (r.leaderId === player.id) return fail(player, 'The Leader does not vote.');
      if (room.phase === 'voting') {
        if (r.votes.has(player.id)) return fail(player, 'Vote locked. Switch Sides can change it.');
        const parsed = parseChoice(room, r.card, msg, r.writeLabels);
        if (parsed.error) return fail(player, parsed.error);
        r.votes.set(player.id, parsed.choice);
        broadcast(room);
        checkVoteComplete(room);
      } else if (room.phase === 'repoll') {
        const parsed = parseChoice(room, r.card, msg, r.writeLabels);
        if (parsed.error) return fail(player, parsed.error);
        r.votes.set(player.id, parsed.choice); // free change during re-poll
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
      if (!r.votes.has(player.id)) return fail(player, 'Vote first, then switch.');
      // The switch target may be a printed square or a fresh write-in.
      const parsed = parseChoice(room, r.card, msg, r.writeLabels);
      if (parsed.error) return fail(player, parsed.error);
      const timing = room.settings.switchTiming;
      const phaseOk = timing === 'after' ? room.phase === 'coinWindow' : room.phase === 'voting';
      if (!phaseOk) return fail(player, timing === 'after' ? 'Switch Sides opens after the tally is shown.' : 'House rule: Switch Sides must be played before the tally is shown.');
      const gate = coinGate(room, player);
      if (gate) return fail(player, gate);
      spendCoin(room, player, 'switch');
      r.votes.set(player.id, parsed.choice);
      broadcast(room);
      if (room.phase === 'voting') checkVoteComplete(room);
      break;
    }
    case 'freeVote': {
      // The one free change granted after a Phone a Friend answer. The
      // friend's poll only offers the printed squares, so the free change
      // lands on a printed square too (v4 simplification).
      if (typeof msg.writeIn === 'string') return fail(player, 'A Phone a Friend change lands on the printed squares — pick one of the four.');
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
      room.voteHistory = [];
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
          sendChatHistory(room, player);
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
        sendChatHistory(room, player);
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
      // A room lives while a HUMAN is in it. Bots never keep a room
      // alive on their own — no zombie bot games.
      if (!room.players.some(p => !p.isBot && p.connected)) room.emptySince = Date.now();
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
