'use strict';
// We All Gone Eat — bot players (v2).
//
// Bots are full server-side players with a personality. A bot's "judgment"
// uses ONLY public information: the card in front of the table (category,
// prompt, option text) and the public vote history from past reveals.
// A bot NEVER sees the leader's secret pick — the only pick a bot ever
// knows is its own, when it is the leader.
//
// "Popularity" below is a pseudo-popularity score: a deterministic hash of
// the option text. It is the same for every bot looking at the same card,
// which is what lets the personalities disagree measurably: SAFE HANDS
// rides the score, CONTRARIAN runs from it, WILDCARD scrambles it, and
// COPYCAT mostly follows what the table has been picking in past rounds.
const crypto = require('crypto');

// Deterministic pseudo-popularity of an option on a card, in [0, 1).
function popularity(card, optionIndex) {
  const text = `${card.category}|${card.prompt}|${card.options[optionIndex]}`;
  const digest = crypto.createHash('sha256').update(text).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}
function popularityRow(card) {
  return card.options.map((_, i) => popularity(card, i));
}

const PERSONALITIES = {
  wildcard: {
    key: 'wildcard',
    label: 'Wild Card',
    blurb: 'Picks like the grill is already lit and nobody is supervising.',
    islandSwitchChance: 0.75,
  },
  safe: {
    key: 'safe',
    label: 'Safe Hands',
    blurb: 'Rides with what the whole cookout would pick. Usually right.',
    islandSwitchChance: 0.6,
  },
  copycat: {
    key: 'copycat',
    label: 'Copycat',
    blurb: 'Watches what the table has been eating and orders the same.',
    islandSwitchChance: 0.5,
  },
  contrarian: {
    key: 'contrarian',
    label: 'Contrarian',
    blurb: 'If everybody wants it, it must be wrong. Picks the lonely plate.',
    islandSwitchChance: 0.25,
  },
};
const PERSONALITY_ORDER = ['wildcard', 'safe', 'copycat', 'contrarian'];

const BOT_NAMES = [
  'Auntie Bertha',
  'Uncle June Bug',
  'Cousin Peaches',
  'Big Mama Rose',
  'Deacon Earl',
  'Miss Tootie',
  'PawPaw Slim',
  'Cousin Skeeter',
];

function weightedPick(weights, rng = Math.random) {
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return weights.length - 1;
}

// voteHistory: array of past reveal tallies (public info), each [n,n,n,n].
function historyRow(voteHistory) {
  const h = [0, 0, 0, 0];
  for (const tally of voteHistory || []) {
    for (let i = 0; i < 4; i++) h[i] += tally[i] || 0;
  }
  return h;
}

// The bot's choice on a card, for voting AND for its own leader pick.
// Returns an option index 0..3. rng is injectable for tests.
function chooseOption(personalityKey, card, voteHistory, rng = Math.random) {
  const pop = popularityRow(card);
  const hist = historyRow(voteHistory);
  let weights;
  switch (personalityKey) {
    case 'safe':
      // Strong pull toward the most "popular" squares, tiny bit of noise.
      weights = pop.map(p => Math.pow(p, 3) + 0.04);
      break;
    case 'contrarian':
      // Strong pull AWAY from the popular squares, almost no noise.
      weights = pop.map(p => Math.pow(1 - p, 4) + 0.015);
      break;
    case 'copycat': {
      // Follows the table's revealed history; popularity breaks round-1 ties.
      const maxHist = Math.max(...hist, 1);
      weights = pop.map((p, i) => (hist[i] / maxHist) * 2.2 + p * 0.6 + 0.05);
      break;
    }
    case 'wildcard':
    default:
      // Leans toward the unpopular squares but scrambles hard — on any
      // given card it can land anywhere.
      weights = pop.map(p => (1 - p) * 1.2 + 0.55);
      break;
  }
  return weightedPick(weights, rng);
}

// A bot stranded alone on a square (Man on an Island) decides whether to
// spend its Switch Sides coin, and where to land if it does.
// Returns a target option index, or null to stay put.
function islandDecision(personalityKey, card, current, voteHistory, rng = Math.random) {
  const def = PERSONALITIES[personalityKey] || PERSONALITIES.wildcard;
  if (rng() >= def.islandSwitchChance) return null;
  const pop = popularityRow(card);
  const others = [0, 1, 2, 3].filter(i => i !== current);
  switch (personalityKey) {
    case 'safe':
      return others.reduce((a, b) => (pop[b] > pop[a] ? b : a), others[0]);
    case 'contrarian': {
      const loneliest = others.reduce((a, b) => (pop[b] < pop[a] ? b : a), others[0]);
      return loneliest;
    }
    case 'copycat': {
      const hist = historyRow(voteHistory);
      const topHist = others.reduce((a, b) => (hist[b] > hist[a] ? b : a), others[0]);
      return hist[topHist] > 0 ? topHist : others.reduce((a, b) => (pop[b] > pop[a] ? b : a), others[0]);
    }
    case 'wildcard':
    default:
      return others[Math.floor(rng() * others.length)];
  }
}

module.exports = {
  PERSONALITIES,
  PERSONALITY_ORDER,
  BOT_NAMES,
  popularity,
  popularityRow,
  historyRow,
  chooseOption,
  islandDecision,
};
