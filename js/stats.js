'use strict';

/* ============================================================
   RUN TELEMETRY
   Everything the post-match breakdown shows is counted here at the moment it
   happens. Nothing is reconstructed afterwards and nothing is inferred: if a
   number isn't incremented somewhere in the game loop it doesn't reach the
   screen, so a stat on the debrief is always a measurement.

   Cost is the design constraint. A late wave has 160+ hostiles taking hits
   from eight systems every frame, so recording a hit is a few adds into arrays
   sized once per run — no per-event object, no push, nothing for the collector
   to sweep up afterwards.
   ============================================================ */

/**
 * Damage sources as array indices, so attributing a hit costs an integer
 * rather than a string key. Every call into Enemy.hurt carries one.
 */
const SRC = {
  GUN: 0, ORB: 1, CHAIN: 2, RAY: 3, MISSILE: 4,
  METEOR: 5, NOVA: 6, DETONATE: 7, THORNS: 8, OTHER: 9,
};

/**
 * How each source reads on the debrief. Colours are chosen to be mutually
 * distinguishable in a stack of bars first and faithful to the weapon second —
 * the bar IS the comparison, so two systems sharing a hue would cost more than
 * a slightly-off orb colour does.
 *
 * OTHER is the catch-all for damage that reaches Enemy.hurt without declaring
 * a source. It stays visible as UNCLASSIFIED rather than being folded into a
 * neighbour: a wrong attribution is a lie, an honest unknown is not.
 */
const SRC_META = [
  { name: 'CORE GUN',     icon: '◎',   color: C.cyan },
  { name: 'ORBS',         icon: '🔵',  color: C.white },
  { name: 'CHAIN',        icon: '🌩️',  color: C.purple },
  { name: 'DEATH RAY',    icon: '☀️',  color: C.gold },
  { name: 'MISSILES',     icon: '🚀',  color: C.orange },
  { name: 'METEORS',      icon: '☄️',  color: C.pink },
  { name: 'SHOCKWAVE',    icon: '💠',  color: C.teal },
  { name: 'DETONATION',   icon: '💣',  color: C.red },
  { name: 'PLATING',      icon: '🜲',  color: C.steel },
  { name: 'UNCLASSIFIED', icon: '?',   color: C.steel },
];

/** Seconds as m:ss — a run is minutes long, so hours would be noise. */
function clock(sec) {
  const s = Math.max(0, Math.floor(sec));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

const Stats = {

  /**
   * Called from Game.reset, which every redeploy goes through — so a new run
   * always starts from zero and no number can leak across the retry button.
   */
  reset(g) {
    const n = SRC_META.length;
    this.dmg = new Float64Array(n);      // damage that actually removed hp
    this.over = new Float64Array(n);     // the part of a killing blow that fell past 0
    this.kills = new Uint32Array(n);     // killing blows credited
    this.lastSrc = SRC.OTHER;            // who landed the most recent hit — kill credit reads this

    this.absorbed = 0;                   // discarded by bulwark armour caps
    this.time = 0;                       // seconds actually in combat, menus excluded
    this.rounds = 0; this.critShots = 0; // rounds fired, and how many rolled crit
    this.connected = 0;                  // rounds that touched at least one hostile
    this.big = 0; this.bigSrc = SRC.OTHER;
    this.earned = 0; this.spent = 0;
    this.taken = 0; this.healed = 0; this.breaches = 0;
    this.peak = 0;

    this.spawned = {}; this.killed = {}; this.leaked = {}; this.coreDmg = {};
    for (const k in ENEMIES) {
      this.spawned[k] = 0; this.killed[k] = 0; this.leaked[k] = 0; this.coreDmg[k] = 0;
    }

    // A record is "beat what you walked in with", and Game.best is raised the
    // moment a wave starts — so the mark has to be copied before that happens.
    this.startBest = g ? g.best : 0;
  },

  /**
   * One damage event, post-armour-cap. hpBefore splits it into what landed and
   * what fell past zero, which is the only way overkill can be known — after
   * the subtraction the remainder is indistinguishable from a healthy negative.
   */
  hit(src, amount, hpBefore) {
    if (src === undefined) src = SRC.OTHER;
    const landed = amount < hpBefore ? amount : (hpBefore > 0 ? hpBefore : 0);
    this.dmg[src] += landed;
    this.over[src] += amount - landed;
    if (amount > this.big) { this.big = amount; this.bigSrc = src; }
    this.lastSrc = src;
  },

  /** Kill credit goes to whoever landed the last recorded hit. */
  credit(e) {
    this.kills[this.lastSrc]++;
    this.killed[e.type]++;
  },

  spawn(type) { this.spawned[type]++; },

  /** A hostile that reached the core: the only thing that can end the run. */
  leak(e, dmg) {
    this.breaches++;
    this.taken += dmg;
    this.leaked[e.type]++;
    this.coreDmg[e.type] += dmg;
  },

  /** Total damage dealt across every system. */
  totalDamage() {
    let sum = 0;
    for (let i = 0; i < this.dmg.length; i++) sum += this.dmg[i];
    return sum;
  },

  totalOverkill() {
    let sum = 0;
    for (let i = 0; i < this.over.length; i++) sum += this.over[i];
    return sum;
  },
};

Stats.reset(null);
