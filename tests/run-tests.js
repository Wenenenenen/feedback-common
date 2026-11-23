'use strict';
/* Independent brute-force reference used only to validate solver.js.
 * No memoisation, separate recursion, exact fractions.
 */
const path = require('path');
const S = require(path.join(__dirname, '..', 'solver.js'));

function bfNorm(raw) { return S.normalizeDeck(raw); }

function frac(n, d) { return S.frac(n, d); }
function add(a, b) { return S.fAdd(a, b); }
function mul(a, b) { return S.fMul(a, b); }

// Deep clone
function cp(s) {
  return {
    points: s.points, tickets: s.tickets, badgeMask: s.badgeMask,
    unknown: s.unknown.slice(), tail: s.tail.slice(), roundsLeft: s.roundsLeft
  };
}

function total(unknown) { return unknown.reduce((a, b) => a + b, 0); }

function makeRef(deck) {
  const goal = deck.goal;
  function success(s) {
    return s.points >= goal.points && (s.badgeMask & goal.badgeMask) === goal.badgeMask;
  }
  // options of next card
  function nextCards(s) {
    const n = total(s.unknown);
    const out = [];
    if (n > 0) {
      for (let i = 0; i < s.unknown.length; i++) {
        if (s.unknown[i] > 0) out.push({ i, p: frac(s.unknown[i], n), fromUnknown: true });
      }
    } else if (s.tail.length > 0) {
      out.push({ i: s.tail[0], p: S.ONE, fromUnknown: false });
    }
    return out;
  }
  function removeCard(s, opt) {
    const t = cp(s);
    if (opt.fromUnknown) t.unknown[opt.i] -= 1;
    else t.tail.shift();
    return t;
  }

  // Value at round start (no cards revealed yet).
  function pre(s) {
    if (success(s)) return S.ONE;
    if (s.roundsLeft <= 0) return S.ZERO;
    if (total(s.unknown) + s.tail.length === 0) return S.ZERO;
    const cards = nextCards(s);
    let acc = S.ZERO;
    for (const c of cards) {
      const s1 = removeCard(s, c);
      acc = add(acc, mul(c.p, afterFirst(s1, [c.i])));
    }
    return acc;
  }

  // After one card `held` got revealed; decide whether to reveal again.
  function afterFirst(s, held) {
    if (success(s)) return S.ONE;
    if (s.roundsLeft <= 0) return S.ZERO;
    const avail = total(s.unknown) + s.tail.length;
    if (avail === 0) return bestValue(s, held);
    const cards = nextCards(s);
    let acc = S.ZERO;
    for (const c of cards) {
      const s1 = removeCard(s, c);
      acc = add(acc, mul(c.p, bestValue(s1, held.concat([c.i]))));
    }
    return acc;
  }

  // Best take value from a set of held cards.
  function bestValue(s, held) {
    let best = null;
    let bestIdx = -1;
    for (let k = 0; k < held.length; k++) {
      const ty = deck.types[held[k]];
      if (s.tickets + ty.tickets < 0) continue;
      const v = takeValue(s, held, k);
      if (best === null || S.fCmp(v, best) > 0) { best = v; bestIdx = k; }
    }
    return best === null ? S.ZERO : best;
  }

  function takeValue(s, held, k) {
    const ty = deck.types[held[k]];
    const t = cp(s);
    t.points += ty.points;
    t.tickets += ty.tickets;
    t.badgeMask |= ty.badgeMask;
    if (success(t)) return S.ONE;
    t.roundsLeft -= 1;
    if (t.roundsLeft <= 0) return S.ZERO;
    const leftover = held.slice(0, k).concat(held.slice(k + 1));
    if (leftover.length) t.tail = t.tail.concat(leftover);
    return pre(t);
  }

  return { pre, success };
}

let failures = 0;
function check(name, got, want) {
  if (got !== want) {
    failures++;
    console.error('FAIL ' + name + ': got ' + got + ' want ' + want);
  }
}

function testSample() {
  const raw = require('../samples/expedition-deck.json');
  const deck = S.normalizeDeck(raw);
  const eng = new S.Engine(deck);
  const st = S.makeInitialState(deck);
  const got = S.fToString(eng.preValue(st));
  const ref = frac(0, 1);
  const refVal = makeRef(deck).pre(st);
  check('sample-matches-ref', got, S.fToString(refVal));
  console.log('sample pre value =', got, '(', S.fPercent(fracOf(got)), '% )');
  return { deck, eng, st };
}

function fracOf(str) {
  const parts = String(str).split('/');
  return S.frac(BigInt(parts[0]), BigInt(parts[1] || 1));
}

// Small random decks compared between memoised engine and reference.
function randInt(n) { return Math.floor(Math.random() * n); }

function randomDeck() {
  const nTypes = 1 + randInt(3);
  const types = {};
  const names = [];
  for (let i = 0; i < nTypes; i++) {
    const name = 't' + i;
    names.push(name);
    const badges = [];
    if (Math.random() < 0.3) badges.push('b' + randInt(2));
    types[name] = { points: randInt(3), tickets: Math.random() < 0.25 ? -1 : randInt(2), badges };
  }
  const unknown = {};
  let cards = 0;
  for (const name of names) { const c = randInt(3); unknown[name] = c; cards += c; }
  const tail = [];
  const tailLen = randInt(3);
  for (let i = 0; i < tailLen; i++) tail.push(names[randInt(names.length)]);
  cards += tailLen;
  if (cards === 0) { unknown[names[0]] = 1; cards = 1; }
  if (cards > 8) return randomDeck();
  const goalBadges = [];
  if (Math.random() < 0.5) goalBadges.push('b' + randInt(2));
  return {
    types, unknown, tail,
    start: { points: 0, tickets: randInt(2), badges: [] },
    rounds: 1 + randInt(4),
    goal: { points: randInt(4), badges: goalBadges }
  };
}

function testRandom(n) {
  for (let k = 0; k < n; k++) {
    const raw = randomDeck();
    let deck, eng, st;
    try {
      deck = S.normalizeDeck(raw);
      eng = new S.Engine(deck);
      st = S.makeInitialState(deck);
    } catch (e) {
      continue;
    }
    const ref = makeRef(deck);
    const got = eng.preValue(st);
    const want = ref.pre(st);
    if (S.fCmp(got, want) !== 0) {
      failures++;
      console.error('FAIL random#' + k + ': got ' + S.fToString(got) + ' want ' + S.fToString(want));
      console.error(JSON.stringify(raw));
      if (failures > 5) return;
    }
  }
}

const { deck, eng, st } = testSample();

// Deterministic hand-checked cases.
// Case: one card, 1 point, goal 1 point, 1 round -> success 1.
{
  const d = S.normalizeDeck({
    types: { a: { points: 1, tickets: 0, badges: [] } },
    unknown: { a: 1 }, tail: [], start: { points: 0, tickets: 0, badges: [] },
    rounds: 1, goal: { points: 1, badges: [] }
  });
  const e = new S.Engine(d);
  check('single-card-success', S.fToString(e.preValue(S.makeInitialState(d))), '1');
}
// Case: two different cards, goal requires badge from card b, 1 round, 1 reveal? available=2 so 2 reveals, can take b -> 1.
{
  const d = S.normalizeDeck({
    types: {
      a: { points: 0, tickets: 0, badges: [] },
      b: { points: 0, tickets: 0, badges: ['x'] }
    },
    unknown: { a: 1, b: 1 }, tail: [], start: { points: 0, tickets: 0, badges: [] },
    rounds: 1, goal: { points: 0, badges: ['x'] }
  });
  const e = new S.Engine(d);
  check('both-revealed-take-b', S.fToString(e.preValue(S.makeInitialState(d))), '1');
}
// Case: tickets -1 card with no ticket -> illegal; both illegal -> 0.
{
  const d = S.normalizeDeck({
    types: { s: { points: 2, tickets: -1, badges: ['x'] } },
    unknown: { s: 2 }, tail: [], start: { points: 0, tickets: 0, badges: [] },
    rounds: 2, goal: { points: 2, badges: ['x'] }
  });
  const e = new S.Engine(d);
  check('ticket-cannot-go-negative', S.fToString(e.preValue(S.makeInitialState(d))), '0');
}
// Case: must take camp to get a ticket, then seal. 2 rounds, unknown camp+seal, 2 cards, both revealed first round: take camp (ticket 1), then second round reveal seal? after taking camp, leftover seal returns to tail; unknown empty -> tail head seal. yes success 1.
{
  const d = S.normalizeDeck({
    types: {
      camp: { points: 0, tickets: 1, badges: [] },
      seal: { points: 2, tickets: -1, badges: ['x'] }
    },
    unknown: { camp: 1, seal: 1 }, tail: [], start: { points: 0, tickets: 0, badges: [] },
    rounds: 2, goal: { points: 2, badges: ['x'] }
  });
  const e = new S.Engine(d);
  check('camp-then-seal', S.fToString(e.preValue(S.makeInitialState(d))), '1');
}

/* --- a card that loses points: extra points must not be capped away --- */
{
  // One shield card worth 3 points, goal 2.  Keeping it succeeds immediately,
  // so both orders of the pair must return 1.
  const d = S.normalizeDeck({
    types: {
      big: { points: 3, tickets: 0, badges: [] },
      minus: { points: -1, tickets: 0, badges: [] }
    },
    unknown: { big: 1, minus: 1 }, tail: [],
    start: { points: 1, tickets: 0, badges: [] },
    rounds: 1, goal: { points: 2, badges: [] }
  });
  const e = new S.Engine(d);
  const st = S.makeInitialState(d);
  check('negative-point-card-no-cap', S.fToString(e.preValue(st)),
    S.fToString(makeRef(d).pre(st)));
}

/* --- start above the goal but missing a badge: points must still count --- */
{
  const d = S.normalizeDeck({
    types: { x: { points: 0, tickets: 0, badges: ['b'] } },
    unknown: { x: 1 }, tail: [],
    start: { points: 5, tickets: 0, badges: [] },
    rounds: 1, goal: { points: 3, badges: ['b'] }
  });
  const e = new S.Engine(d);
  const st = S.makeInitialState(d);
  check('start-above-goal-missing-badge', S.fToString(e.preValue(st)), '1');
}

testRandom(400);

// A second random pass that includes negative-point cards specifically.
function randomDeckWithNegatives() {
  const raw = randomDeck();
  const names = Object.keys(raw.types);
  if (names.length) {
    const name = names[Math.floor(Math.random() * names.length)];
    raw.types[name].points = -1;
  }
  return raw;
}
{
  let localFailures = 0;
  for (let k = 0; k < 250; k++) {
    const raw = randomDeckWithNegatives();
    let deck, eng, st;
    try {
      deck = S.normalizeDeck(raw);
      eng = new S.Engine(deck);
      st = S.makeInitialState(deck);
    } catch (e) { continue; }
    const got = eng.preValue(st);
    const want = makeRef(deck).pre(st);
    if (S.fCmp(got, want) !== 0) {
      localFailures++;
      failures++;
      console.error('FAIL neg random#' + k + ': got ' + S.fToString(got) + ' want ' + S.fToString(want));
      console.error(JSON.stringify(raw));
      if (localFailures > 3) break;
    }
  }
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
} else {
  console.log('all tests passed');
}
