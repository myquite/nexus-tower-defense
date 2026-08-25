'use strict';

/* ============================================================
   PALETTE
   ============================================================ */
const C = {
  cyan:   '#5ad8ff',
  teal:   '#3ff0c8',
  gold:   '#ffcb33',
  red:    '#ff3b5c',
  pink:   '#ff2d7a',
  purple: '#a678ff',
  orange: '#ff9838',
  white:  '#eaf8ff',
  steel:  '#9fb6d1',
};

/* ============================================================
   EFFECTIVE CEILINGS
   Stats that stop doing anything past a point. Making the limit explicit means
   the shop can refuse to sell a dead upgrade instead of taking the salvage and
   changing nothing.

   MAX_FIRE_RATE — a design cap, not a frame-rate one. The gun can only fire on
   an update tick, so without a stated ceiling the real cadence would be
   whatever the display happens to run at: 60/s on a 60Hz panel, 120/s on a
   120Hz one, and the same build would behave differently on different
   hardware. Pinning it here keeps the cap deterministic.
   ============================================================ */
const MAX_FIRE_RATE = 60;          // shots per second
const MAX_VOLLEYS_PER_FRAME = 4;   // guard against a long frame dumping a burst
const MAX_CRIT_CHANCE = 0.85;      // matches the clamp in the crit upgrades
const MAX_SLOW = 0.72;             // cryo can never freeze a wave outright
/*
   The barrier ring. Capacity is a buffer measured in enemy damage, not a
   second health bar: it does not regenerate, so what it buys is seconds of
   total immunity and a kill zone out at the perimeter, and then it is gone
   until you pay to bring it back.
*/
const SHIELD_BASE = 1800;          // capacity at level 1
const SHIELD_GROWTH = 1.9;         // per level after that
const SHIELD_RADIUS = 210;         // where the ring sits at level 1
const SHIELD_WIDEN = 1.1;          // per level, clamped to the arena at draw time
const SHIELD_KNOCK = 260;          // shove given to whatever runs into it
const SHIELD_HIT_CD = 0.8;         // per-enemy seconds between impacts
const MAX_BULLET_SPEED = 3200;     // past this a round crosses the arena inside one frame
const OVERCLOCK_WAVE = 12;         // when the shop's exponential pricing starts to bite
const BLAST_DETONATE = 74;         // fixed blast radii, scaled by t.blastMult
const BLAST_FISSION = 66;
const MAX_CARRY = 1;               // overkill can be recycled, never amplified
const MAX_BRITTLE = 1.2;
const MAX_BLAST = 3;               // a blast wider than this covers the screen
const MIN_MISSILE_CD = 2;          // the volley floor Smart Missiles works down toward
const MIN_RAY_CHARGE = 1.1;        // the death ray never becomes a continuous beam again
const NOVA_WIND = 0.42;            // seconds the plating draws in before a shockwave
/*
   Reactive Plating is a FRACTION of the attacker, never a flat number, so it
   rides the wave curve instead of decaying against it. It must stay strictly
   below 1: contact is the only thing in the game that damages the core, so a
   plating that soaked all of a hit would make the tower unkillable outright.
   The opening level is worth two, the way Orbs and Missiles open, so the first
   pick is a real decision rather than a down payment; four more of 0.12 land
   exactly on the ceiling, so no level is ever dead.
*/
const MAX_THORNS = 0.72;

/* ============================================================
   TOWER BASE STATS
   ============================================================ */
function baseTower() {
  return {
    // core gun
    damage: 10,
    fireRate: 2.2,          // shots per second
    range: 300,
    bulletSpeed: 620,      // raised only by Muzzle Velocity, once Coolant caps
    shots: 1,               // multishot projectile count
    pierce: 0,
    critChance: 0.05,
    critMult: 2,

    // survivability
    maxHp: 140,
    hp: 140,
    regen: 0,
    lifesteal: 0,           // hp restored per kill
    thorns: 0,              // fraction of an attacker burned, and of its hit soaked

    // orbiting blades
    orbCount: 0,
    orbDmg: 12,
    orbRadius: 92,
    orbSpeed: 1.9,

    // homing missiles
    missileCount: 0,
    missileCd: 3.6,
    missileDmg: 15,
    missileRadius: 52,

    // chain lightning
    chainJumps: 0,
    chainCd: 2.4,
    chainDmg: 14,

    // meteors
    meteorCount: 0,
    meteorCd: 4.5,
    meteorDmg: 55,
    meteorRadius: 96,

    // death ray — a charged sweep, not a permanent blender
    rayCount: 0,
    rayDps: 300,            // only paid out during the burst, not continuously
    raySpeed: 0.55,
    rayChargeTime: 2.2,     // seconds spent spinning up between blasts
    rayBurst: 0.9,          // seconds the beam is actually live

    // shockwave nova
    novaCd: 5,
    novaDmg: 0,      // 0 until Shockwave is taken — fireNova gates on this
    novaBase: 34,    // what Shockwave adopts, so damage taken BEFORE it still counts
    novaKnock: 90,

    // barrier ring (Wide Orbit Defenses)
    shieldMax: 0,           // 0 until the card is taken
    shieldHp: 0,
    shieldRadius: 0,
    shieldDmg: 0,           // 0 until Arc Barrier is taken — the wall is inert until then
    shieldBase: 60,         // what Arc Barrier adopts, so damage banked BEFORE it still counts

    // utility
    slowPct: 0,             // cryo field slow inside range
    cashMult: 1,
    capPierce: 0,           // raises the per-hit cap armoured units impose
    critBlast: 0,           // fraction of a crit released as a blast — 0 until Fission Rounds
    blastMult: 1,           // every fixed blast radius, scaled — Blast Calibration
    carry: 0,               // fraction of overkill passed to the next target — Overpressure
    brittle: 0,             // extra damage taken by anything the cryo field is slowing
    barrierRegen: 0,        // fraction of shield capacity recovered per wave
    detonate: 0,            // fraction of a victim's max HP released on death
    bounces: 0,             // extra targets a bullet redirects to after a hit
  };
}

/* ============================================================
   MUSIC
   Drop audio files in /music and list them here. Multiple tracks play
   through in order and then loop back to the first; a single track just
   loops. Paths are relative to index.html. Any track that fails to load
   is skipped, and if none load the volume control reports "no track"
   rather than pretending to play.
   ============================================================ */
const MUSIC_TRACKS = [
  'music/The_Iron_Crown_Ambush.mp3',
  'music/Level_One_Victory.mp3',
  'music/Seven_Seconds_to_Impact.mp3',
];

/**
 * Loop shaping. Most music isn't authored to loop — the last bar doesn't lead
 * back into the first — so butting the end against the start gives an audible
 * seam. Instead each pass is overlapped with the next and cross-faded on an
 * equal-power curve, which hides the join entirely.
 *
 * List several tracks in MUSIC_TRACKS and the same crossfade carries you from
 * one into the next, so the playlist is what fixes repetitiveness — a single
 * 30-second track will always come back around in 30 seconds.
 *
 *   crossfade  seconds of overlap. Longer = smoother and more ambient, but eats
 *              more of the track (effective loop = length - crossfade).
 *   shuffle    randomise playlist order, reshuffled each time it wraps.
 *   loopStart  skip an intro that shouldn't repeat (seconds). Single track only.
 *   loopEnd    null = end of file. Trim a hard ending here. Single track only.
 *   duck*      how the music sits back behind menus (upgrade / shop / game over).
 */
const MUSIC_CONFIG = {
  crossfade: 6,
  shuffle: true,
  loopStart: 0,
  loopEnd: null,
  fadeIn: 3,
  fadeOut: 0.7,
  duckOnMenus: true,
  duckVolume: 0.55,
  duckFilterHz: 900,
};

/* ============================================================
   ENEMY ARCHETYPES
   ============================================================ */
/**
 * capFrac — armour. Caps a SINGLE incoming hit at this fraction of the unit's
 * max HP, so no matter how large one hit is it can never remove more than that
 * slice. 1/capFrac is therefore the floor on hits-to-kill. This is the one stat
 * that stays meaningful against the card upgrades, which are multiplicative
 * (Damage x1.4) and so make any flat resistance irrelevant within a few waves.
 * The counterplay is attack frequency — fire rate, multishot, pierce, chain,
 * orbs, ray — not a bigger damage number.
 */
/**
 * form — which silhouette Enemy.draw builds. Detail is tiered by how many of
 * the thing are ever on screen at once: a late wave puts 150+ grunts up, so
 * chevron and dart stay at a single stroke each, exactly what the old squares
 * cost. The lavish multi-layer forms are reserved for units you meet a handful
 * of at a time.
 *
 * dir  — true if the silhouette points along its heading rather than tumbling.
 *        A swarm all aimed at the core reads as intent instead of debris.
 */
const ENEMIES = {
  grunt:    { hp: 11,  speed: 74,  size: 15, dmg: 6,  cash: 2,  color: C.red,    form: 'chevron',  dir: true },
  swift:    { hp: 7,   speed: 148, size: 11, dmg: 4,  cash: 2,  color: C.gold,   form: 'dart',     dir: true },
  tank:     { hp: 52,  speed: 46,  size: 24, dmg: 18, cash: 7,  color: C.purple, form: 'block' },
  splitter: { hp: 20,  speed: 80,  size: 20, dmg: 8,  cash: 4,  color: C.teal,   form: 'triangle', splits: 3 },
  shard:    { hp: 5,   speed: 128, size: 14, dmg: 3,  cash: 1,  color: C.teal,   form: 'kite' },
  bulwark:  { hp: 34,  speed: 54,  size: 21, dmg: 16, cash: 11, color: C.steel,  form: 'fortress', capFrac: 0.09 },
  boss:     { hp: 300, speed: 30,  size: 40, dmg: 30, cash: 60, color: C.pink,   form: 'monolith', boss: true },
};

/** Which archetypes are unlocked by a given wave. */
function unlockedTypes(wave) {
  const t = ['grunt'];
  if (wave >= 2) t.push('swift');
  if (wave >= 4) t.push('tank');
  if (wave >= 6) t.push('splitter');
  if (wave >= 10) t.push('bulwark');
  return t;
}

/**
 * Build the spawn schedule for a wave.
 * Returns { entries:[{type,delay}], boss:bool }
 */
function buildWave(wave) {
  const isBoss = wave % 5 === 0;
  const types = unlockedTypes(wave);
  const count = Math.round(5 + wave * 1.6 + Math.pow(wave, 1.22));
  const duration = clamp(9 + wave * 0.5, 9, 26);
  const entries = [];

  for (let i = 0; i < count; i++) {
    // weight toward newer, tougher types as waves progress
    let type = types[0];
    const r = Math.random();
    if (types.length > 1) {
      if (r < 0.55) type = 'grunt';
      else if (r < 0.72 && types.includes('swift')) type = 'swift';
      else if (r < 0.85 && types.includes('tank')) type = 'tank';
      else if (r < 0.93 && types.includes('bulwark')) type = 'bulwark';
      else if (types.includes('splitter')) type = 'splitter';
      else type = pick(types);
    }
    entries.push({ type, delay: (i / count) * duration + rand(-0.25, 0.25) });
  }

  // baseline grunt padding on top of the mix, growing with wave
  const extraGrunts = Math.round(3 + wave * 0.9);
  for (let i = 0; i < extraGrunts; i++) {
    entries.push({ type: 'grunt', delay: (i / extraGrunts) * duration + rand(-0.3, 0.3) });
  }

  if (isBoss) {
    entries.push({ type: 'boss', delay: duration * 0.35 });
    // boss rounds bring a dense swarm, packed tight behind the boss. Past the
    // early waves a slice of it hardens into tanks so the swarm can't be cleared
    // by pure crowd-clear (pierce / chain / orbs) alone.
    const swarm = Math.round(18 + wave * 2.4);
    const hardShare = types.includes('tank') ? Math.min(0.30, 0.05 + wave * 0.012) : 0;
    const swarmStart = duration * 0.30;
    const swarmSpan = duration * 0.55;
    for (let i = 0; i < swarm; i++) {
      const type = Math.random() < hardShare ? 'tank' : 'grunt';
      entries.push({ type, delay: swarmStart + (i / swarm) * swarmSpan + rand(-0.15, 0.15) });
    }
  }

  entries.sort((a, b) => a.delay - b.delay);
  return { entries, boss: isBoss, duration };
}

/**
 * Stat multipliers applied to every enemy for a given wave.
 *
 * Card upgrades are multiplicative (Damage x1.4, Fire Rate x1.45) and the player
 * takes one per wave, so tower DPS compounds faster than a flat 1.185 HP curve.
 * The late ramp below kicks in past LATE_WAVE to close that gap; before then the
 * curve is unchanged, so the early game plays exactly as it always did.
 */
const LATE_WAVE = 8;

function waveScale(wave) {
  const late = Math.max(0, wave - LATE_WAVE);
  return {
    hp: Math.pow(1.185, wave - 1) * Math.pow(1.06, late),
    speed: Math.min(1 + (wave - 1) * 0.022, 1.9),
    dmg: Math.pow(1.10, wave - 1) * Math.pow(1.04, late),
    cash: 1 + (wave - 1) * 0.16,
  };
}

/* ============================================================
   UPGRADES
   Each: id, name, icon, color, max, weight, unlock(state), capped(state),
         desc(tower, nextLevel), apply(tower)

   unlock — not offered YET; may open up later (Death Ray before wave 4).
   capped — never worth offering again, because the stat it feeds has hit a
            hard ceiling well before its level max. Same idea as the shop's
            capped, and for the same reason: a card that does nothing is worse
            than no card at all, since it eats one of the two slots.
   ============================================================ */
const UPGRADES = [
  {
    id: 'damage', name: 'Damage', icon: '⚔️', color: C.red, max: 99, weight: 10,
    desc: () => '+40% DAMAGE',
    apply: t => {
      t.damage *= 1.4; t.orbDmg *= 1.4; t.missileDmg *= 1.4;
      t.chainDmg *= 1.4; t.meteorDmg *= 1.4; t.rayDps *= 1.4;
      t.novaBase *= 1.4; t.novaDmg *= 1.4;
      t.shieldBase *= 1.4; t.shieldDmg *= 1.4;
    },
  },
  {
    id: 'fireRate', name: 'Fire Rate', icon: '⚡', color: C.gold, max: 99, weight: 10,
    unlock: s => s.t.fireRate < MAX_FIRE_RATE - 1e-6,
    desc: (t, lv) => (lv <= 2 ? '+400% SPEED' : '+45% SPEED'),
    apply: (t, lv) => { t.fireRate = Math.min(MAX_FIRE_RATE, t.fireRate * (lv <= 2 ? 5 : 1.45)); },
  },
  {
    id: 'multishot', name: 'Multishot', icon: '🎯', color: C.cyan, max: 20, weight: 8,
    desc: (t, lv) => (lv === 1 ? '+4 PROJECTILES' : '+2 PROJECTILES'),
    apply: (t, lv) => { t.shots += (lv === 1 ? 4 : 2); },
  },
  {
    // 12 levels is far more than the arena needs — the gun outranges the
    // spawn ring by level 5 or so. Past that Wide Orbit takes over.
    id: 'range', name: 'Range', icon: '📡', color: C.cyan, max: 12, weight: 6,
    capped: s => s.t.range >= s.maxThreatDistance(),
    desc: () => '+22% RANGE',
    apply: t => { t.range *= 1.22; },
  },
  {
    id: 'pierce', name: 'Piercing', icon: '🔩', color: C.orange, max: 10, weight: 5,
    desc: () => 'SHOTS PUNCH THROUGH +2',
    apply: t => { t.pierce += 2; },
  },
  {
    id: 'crit', name: 'Critical', icon: '💥', color: C.orange, max: 12, weight: 6,
    /**
     * The card changes character at the clamp rather than dying at it: chance
     * stops moving, the multiplier does not. So the text has to change too —
     * promising +10% CRIT to a build already at MAX_CRIT_CHANCE is selling
     * something that cannot be delivered.
     *
     * Read off the tower, never off the level. Targeting Optics feeds the same
     * stat, so which card level the clamp lands on depends on what was bought
     * in the bay, and a level threshold hardcoded here would be wrong for
     * exactly the players who invested most in crit.
     */
    desc: t => (t && t.critChance >= MAX_CRIT_CHANCE - 1e-6
      ? '+0.6x CRIT MULTIPLIER' : '+10% CRIT, +0.6x MULT'),
    // still worth taking at the clamp — the multiplier keeps climbing
    apply: t => { t.critChance = Math.min(MAX_CRIT_CHANCE, t.critChance + 0.10); t.critMult += 0.6; },
  },
  {
    id: 'health', name: 'Fortify', icon: '🛡️', color: C.teal, max: 99, weight: 8,
    desc: () => '+60 MAX HP, FULL HEAL',
    apply: t => { t.maxHp += 60; t.hp = t.maxHp; },
  },
  {
    id: 'regen', name: 'Nanorepair', icon: '♻️', color: C.teal, max: 12, weight: 6,
    desc: () => '+2 HP PER SECOND',
    apply: t => { t.regen += 2; },
  },
  {
    id: 'lifesteal', name: 'Siphon', icon: '🩸', color: C.pink, max: 10, weight: 4,
    desc: () => 'HEAL 1.5 HP PER KILL',
    apply: t => { t.lifesteal += 1.5; },
  },
  {
    id: 'orbs', name: 'Orbs', icon: '🔵', color: C.cyan, max: 12, weight: 7,
    desc: (t, lv) => (lv === 1 ? '5 ORBITING KILLERS' : '+2 ORBITING KILLERS'),
    apply: (t, lv) => { t.orbCount += (lv === 1 ? 5 : 2); },
  },
  {
    id: 'missiles', name: 'Smart Missiles', icon: '🚀', color: C.orange, max: 12, weight: 7,
    unlock: s => s.wave >= 3,
    // Drops the cadence half of the claim once the volley is already at its
    // floor, which the last level reaches — payload keeps coming, the cooldown
    // does not, and only one of those should still be advertised.
    desc: (t, lv) => (lv === 1 ? '8 HOMING MISSILES'
      : (t && t.missileCd <= MIN_MISSILE_CD + 1e-6 ? '+4 MISSILES' : '+4 MISSILES, FASTER VOLLEY')),
    /**
     * Later levels buy cadence as well as payload. Stacking count alone made
     * the opening pick a wave-clear on its own; splitting the growth between
     * volley size and cooldown keeps the same late-game throughput while the
     * first level lands closer to Orbs and Chain.
     */
    apply: (t, lv) => {
      t.missileCount += (lv === 1 ? 8 : 4);
      if (lv > 1) t.missileCd = Math.max(MIN_MISSILE_CD, t.missileCd * 0.94);
    },
  },
  {
    id: 'chain', name: 'Chain Lightning', icon: '🌩️', color: C.purple, max: 12, weight: 7,
    desc: (t, lv) => (lv === 1 ? 'ARCS THROUGH THE SWARM' : '+3 ARC JUMPS'),
    apply: (t, lv) => { t.chainJumps += (lv === 1 ? 5 : 3); if (lv > 1) t.chainCd = Math.max(0.5, t.chainCd * 0.88); },
  },
  {
    id: 'meteor', name: 'Meteor Strike', icon: '☄️', color: C.orange, max: 12, weight: 6,
    desc: (t, lv) => (lv === 1 ? 'METEORS RAIN DOWN' : '+1 METEOR PER VOLLEY'),
    apply: (t, lv) => { t.meteorCount += 1; if (lv > 1) t.meteorCd = Math.max(1.2, t.meteorCd * 0.9); },
  },
  {
    /**
     * A charged weapon, not a permanent one. Left always-on it was simply the
     * best card in the game — an unbroken blender bolted to the core that
     * asked nothing of the player and never stopped. Cycling it costs the
     * uptime that made it that, and buys something better: a wind-up the
     * player can see, and a discharge worth watching.
     *
     * The old text promised an instant kill it never delivered. It is a
     * sustained beam and always was, so it now says what it does.
     */
    id: 'ray', name: 'Death Ray', icon: '☀️', color: C.gold, max: 8, weight: 5,
    unlock: s => s.wave >= 4,
    desc: (t, lv) => (lv === 1 ? 'CHARGES, THEN SWEEPS' : '+1 BEAM, FASTER CHARGE'),
    apply: (t, lv) => {
      t.rayCount += 1;
      // Levels buy cadence as well as beams, so a deep investment spends less
      // of its life waiting — the floor keeps it from ever going continuous
      // again, which is the whole point of the rework.
      if (lv > 1) t.rayChargeTime = Math.max(MIN_RAY_CHARGE, t.rayChargeTime * 0.94);
    },
  },
  {
    id: 'nova', name: 'Shockwave', icon: '💠', color: C.cyan, max: 12, weight: 6,
    desc: (t, lv) => (lv === 1 ? 'PULSE BLASTS THEM BACK' : '+80% PULSE DAMAGE'),
    // Adopt novaBase, never a literal — assigning 34 here would throw away
    // every damage multiplier banked before Shockwave was offered.
    apply: (t, lv) => {
      if (lv === 1) t.novaDmg = t.novaBase;
      else { t.novaDmg *= 1.8; t.novaBase *= 1.8; t.novaCd = Math.max(1.8, t.novaCd * 0.9); }
    },
  },
  {
    id: 'cryo', name: 'Cryo Field', icon: '❄️', color: C.cyan, max: 6, weight: 5,
    capped: s => s.t.slowPct >= MAX_SLOW - 1e-6,
    desc: () => 'SLOW EVERYTHING NEARBY',
    apply: t => { t.slowPct = Math.min(MAX_SLOW, t.slowPct + 0.18); },
  },
  {
    /**
     * Scales off the attacker rather than off a flat number it can never
     * update. At 45 damage a level it covered grunts to about wave 8, and all
     * eight levels — a third of the picks in a run — bought grunts to wave 18
     * and a boss never. A fraction of the thing hitting you costs the same at
     * wave 25 as at wave 5.
     *
     * And it both burns and soaks, because burning alone is all-or-nothing:
     * the attacker is discarded on contact whatever its health, so damage that
     * failed to kill was simply thrown away, and a level that could not finish
     * a leaker outright was worth exactly zero. Soaking the same fraction of
     * the blow gives every level something to do on the hits it cannot stop.
     */
    id: 'thorns', name: 'Reactive Plating', icon: '🜲', color: C.purple, max: 5, weight: 4,
    unlock: s => s.wave >= 3,
    capped: s => s.t.thorns >= MAX_THORNS - 1e-6,
    desc: (t, lv) => (lv === 1 ? 'BURN AND BLUNT ATTACKERS' : '+12% BURN, +12% SOAK'),
    apply: (t, lv) => {
      t.thorns = Math.min(MAX_THORNS, t.thorns + (lv === 1 ? 0.24 : 0.12));
    },
  },
  {
    id: 'cash', name: 'Salvager', icon: '◈', color: C.teal, max: 8, weight: 4,
    desc: () => '+35% SALVAGE',
    apply: t => { t.cashMult += 0.35; },
  },

  /* ---- cards that exist to unstick a dead end, not to add another stat ---- */

  {
    // The trigger caps at MAX_FIRE_RATE; past that, Fire Rate and Coolant do
    // nothing at all. Gated on reaching the cap so it can never be a trap pick:
    // it only appears for the build that has already hit the wall.
    id: 'overdrive', name: 'Overdrive', icon: '🔥', color: C.gold, max: 8, weight: 7,
    unlock: s => s.t.fireRate >= MAX_FIRE_RATE - 1e-6,
    desc: () => '+35% DAMAGE',
    apply: t => {
      t.damage *= 1.35; t.orbDmg *= 1.35; t.missileDmg *= 1.35;
      t.chainDmg *= 1.35; t.meteorDmg *= 1.35; t.rayDps *= 1.35;
      t.novaBase *= 1.35; t.novaDmg *= 1.35;
      t.shieldBase *= 1.35; t.shieldDmg *= 1.35;
    },
  },
  {
    // Range's twin. Once the gun already covers the whole arena there is
    // nothing left to reach, so the reach turns into something physical: a
    // barrier ring out at the perimeter that the swarm simply cannot cross.
    //
    // Unlike every other defensive card this one is spent rather than owned.
    // It has no regeneration — it holds absolutely until its capacity is gone,
    // then it drops and stays down until you buy a recharge in the Salvage
    // Bay. That is the whole point: a wall that always works, sometimes.
    id: 'wideOrbit', name: 'Wide Orbit Defenses', icon: '🛰️', color: C.cyan, max: 6, weight: 7,
    unlock: s => s.t.range >= s.maxThreatDistance(),
    desc: (t, lv) => (lv === 1 ? 'BARRIER RING — NOTHING CROSSES IT' : '+90% CAPACITY, FULL CHARGE'),
    apply: (t, lv) => {
      if (lv === 1) {
        t.shieldMax = SHIELD_BASE;
        t.shieldRadius = SHIELD_RADIUS;
      } else {
        t.shieldMax = Math.round(t.shieldMax * SHIELD_GROWTH);
        // Still widened, but never advertised: Game.shieldRing clamps the ring
        // to the arena, and on a phone that clamp already bites at level 1, so
        // a card promising a wider ring would be lying on every handset.
        t.shieldRadius *= SHIELD_WIDEN;
      }
      t.shieldHp = t.shieldMax;   // a new emitter comes up fully charged
    },
  },
  {
    /**
     * Where the barrier's later levels go once it cannot get any bigger.
     *
     * The ring is clamped to the arena by Game.shieldRing, and on a phone that
     * clamp bites at level 1 — so size stops being a place to put value almost
     * immediately. Damage is: the wall already holds the swarm still, in one
     * ring, at a known distance, which is the best kill zone in the game and
     * until now it did nothing with it.
     *
     * There is real tension in it rather than a flat gain: contact both drains
     * capacity and deals damage, so a barrier that kills faster is a barrier
     * that gets hit fewer times and lasts longer. Investing here buys the
     * shield's uptime as much as it buys the kill.
     */
    id: 'arcBarrier', name: 'Arc Barrier', icon: '✴️', color: C.cyan, max: 8, weight: 7,
    unlock: s => s.t.shieldMax > 0,
    desc: (t, lv) => (lv === 1 ? 'THE WALL BURNS WHAT TOUCHES IT' : '+50% BARRIER DAMAGE'),
    // Adopt shieldBase, never a literal — assigning 60 here would throw away
    // every damage multiplier banked before Arc Barrier was offered.
    apply: (t, lv) => {
      if (lv === 1) t.shieldDmg = t.shieldBase;
      else { t.shieldDmg *= 1.5; t.shieldBase *= 1.5; }
    },
  },
  {
    /**
     * Cryo Field's successor. The slow clamps at MAX_SLOW so the field cannot
     * hold anything harder, but it still marks everything inside it — and a
     * field that already covers the arena is a condition that is almost always
     * true late, which is exactly what makes it worth paying for.
     *
     * Deliberately conditional rather than a flat damage card: it is worth
     * nothing without the Cryo investment that unlocked it, which is what
     * keeps it a continuation of that line instead of a better Damage.
     */
    id: 'brittle', name: 'Brittle', icon: '❅', color: C.cyan, max: 8, weight: 6,
    unlock: s => s.t.slowPct >= MAX_SLOW - 1e-6,
    capped: s => s.t.brittle >= MAX_BRITTLE - 1e-6,
    desc: () => 'SLOWED TARGETS TAKE +15%',
    apply: t => { t.brittle = Math.min(MAX_BRITTLE, t.brittle + 0.15); },
  },
  {
    /**
     * The barrier line's end, and the answer to its worst failure state: broke
     * with the wall down, where the shield is not a spent resource any more but
     * simply gone for the rest of the run.
     *
     * A trickle per wave rather than per second, so it never rescues a wall
     * mid-collapse — it only means a run is never permanently without one.
     */
    id: 'barrierRegen', name: 'Field Regenerator', icon: '⟳', color: C.cyan, max: 6, weight: 6,
    unlock: s => (s.perkLevels.arcBarrier || 0) >= 8,
    desc: (t, lv) => (lv === 1 ? 'BARRIER SELF-CHARGES EACH WAVE' : '+8% CHARGE PER WAVE'),
    apply: (t, lv) => { t.barrierRegen += (lv === 1 ? 0.12 : 0.08); },
  },
  {
    // Bulwarks clamp every hit to a slice of their max HP, so a damage build
    // has no answer to them but attack frequency. This is that answer.
    id: 'breach', name: 'Breaching Rounds', icon: '🗡️', color: C.steel, max: 5, weight: 5,
    unlock: s => s.wave >= 9,
    desc: () => '+60% ARMOUR PENETRATION',
    apply: t => { t.capPierce += 0.6; },
  },
  {
    // Late waves are ~two thirds grunts packed tight; blast damage scales with
    // that density and chains through a formation.
    id: 'detonate', name: 'Detonation', icon: '💣', color: C.orange, max: 8, weight: 6,
    desc: (t, lv) => (lv === 1 ? 'KILLS DETONATE' : '+25% BLAST'),
    apply: (t, lv) => { t.detonate += (lv === 1 ? 0.3 : 0.25); },
  },
  {
    // Multiplies the number of hits rather than their size, which is exactly
    // what gets through a per-hit damage cap.
    id: 'ricochet', name: 'Ricochet', icon: '🔀', color: C.cyan, max: 6, weight: 6,
    desc: (t, lv) => (lv === 1 ? 'SHOTS BOUNCE TO A NEW TARGET' : '+1 BOUNCE'),
    apply: t => { t.bounces += 1; },
  },
  {
    // Every other card is a pure gain, so a pick is only ever a ranking. This
    // one costs something, which makes it the first real decision on the board.
    id: 'overload', name: 'Overload', icon: '⚠️', color: C.red, max: 6, weight: 4,
    unlock: s => s.wave >= 5,
    desc: () => '+80% DAMAGE, -25% MAX HP',
    apply: t => {
      t.damage *= 1.8; t.orbDmg *= 1.8; t.missileDmg *= 1.8;
      t.chainDmg *= 1.8; t.meteorDmg *= 1.8; t.rayDps *= 1.8;
      t.novaBase *= 1.8; t.novaDmg *= 1.8;
      t.shieldBase *= 1.8; t.shieldDmg *= 1.8;
      t.maxHp = Math.max(40, Math.round(t.maxHp * 0.75));
      t.hp = Math.min(t.hp, t.maxHp);   // never leave hp above the new ceiling
    },
  },
];

const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map(u => [u.id, u]));

/* ============================================================
   SHOP
   Bought with salvage between waves. Unlike the card upgrades these are
   small, repeatable and always available — salvage is the resource that
   lets a good run compound instead of being purely luck of the draw.

   Each: id, name, icon, color, max, desc(level), cost(level, game),
         enabled(tower, game), capped(tower, game), hidden(tower, game),
         apply(tower, game)

   enabled — false when the item is useless RIGHT NOW but may matter again
             (Field Repair at full health). Dims the row.
   hidden  — the item has nothing to act on yet and saying so would only
             confuse (Shield Recharge before the barrier card). Drops the row.
   capped  — true when the item can never do anything again, because the stat
             it feeds has hit a ceiling. Reads as MAX, exactly like running out
             of levels, because to the player it is the same thing.
   ============================================================ */
/**
 * The bay reads as tech lines, not as a list, because that is what it is: an
 * item that caps hands off to a successor, and a player who cannot see the
 * handoff experiences a ceiling instead of a progression.
 *
 * Every line terminates in something with no ceiling — most of them through
 * Overclock, which is uncapped by design. That is what keeps "every cap gets a
 * successor" a finite rule rather than an infinite regress: a line is allowed
 * to end, but only on a node that never runs out.
 */
const SHOP_LINES = [
  { id: 'WEAPON',  name: 'WEAPON'  },
  { id: 'RATE',    name: 'RATE'    },
  { id: 'OPTICS',  name: 'OPTICS'  },
  { id: 'RANGE',   name: 'RANGE'   },
  { id: 'HULL',    name: 'HULL'    },
  { id: 'BARRIER', name: 'BARRIER' },
  { id: 'SUPPORT', name: 'SUPPORT' },
];

const SHOP = [
  {
    id: 'repair', name: 'Field Repair', icon: '🔧', color: C.teal, max: Infinity,
    line: 'SUPPORT',
    desc: () => 'RESTORE 40% HP',
    cost: (lv, g) => Math.round(30 + 10 * g.wave),
    enabled: t => t.hp < t.maxHp - 0.5,
    apply: t => { t.hp = Math.min(t.maxHp, t.hp + t.maxHp * 0.4); },
  },
  {
    id: 'plating', name: 'Hull Plating', icon: '🛡️', color: C.teal, max: 99,
    line: 'HULL',
    desc: () => '+25 MAX HP',
    cost: lv => Math.round(45 * Math.pow(1.5, lv)),
    apply: t => { t.maxHp += 25; t.hp += 25; },
  },
  {
    id: 'core', name: 'Damage Core', icon: '⚔️', color: C.red, max: 99,
    line: 'WEAPON',
    desc: () => '+12% DAMAGE',
    cost: lv => Math.round(55 * Math.pow(1.55, lv)),
    apply: t => {
      t.damage *= 1.12; t.orbDmg *= 1.12; t.missileDmg *= 1.12;
      t.chainDmg *= 1.12; t.meteorDmg *= 1.12; t.rayDps *= 1.12;
      t.novaBase *= 1.12; t.novaDmg *= 1.12;
      t.shieldBase *= 1.12; t.shieldDmg *= 1.12;
    },
  },
  {
    id: 'coolant', name: 'Coolant', icon: '⏱️', color: C.gold, max: 99,
    line: 'RATE',
    desc: () => '+10% FIRE RATE',
    cost: lv => Math.round(55 * Math.pow(1.55, lv)),
    // the gun cannot cycle faster than MAX_FIRE_RATE, so stop selling past it
    capped: t => t.fireRate >= MAX_FIRE_RATE - 1e-6,
    apply: t => { t.fireRate = Math.min(MAX_FIRE_RATE, t.fireRate * 1.10); },
  },
  {
    id: 'lens', name: 'Focusing Lens', icon: '📡', color: C.cyan, max: 20,
    line: 'RANGE',
    desc: () => '+8% RANGE',
    cost: lv => Math.round(50 * Math.pow(1.45, lv)),
    // nothing can ever be further away than the spawn ring's far corner
    capped: (t, g) => t.range >= g.maxThreatDistance(),
    apply: t => { t.range *= 1.08; },
  },
  {
    id: 'optics', name: 'Targeting Optics', icon: '💥', color: C.orange, max: 20,
    line: 'OPTICS',
    desc: () => '+4% CRIT CHANCE',
    cost: lv => Math.round(60 * Math.pow(1.5, lv)),
    // Critical cards share this clamp and can reach it first
    capped: t => t.critChance >= MAX_CRIT_CHANCE - 1e-6,
    apply: t => { t.critChance = Math.min(MAX_CRIT_CHANCE, t.critChance + 0.04); },
  },
  {
    /**
     * The other half of the barrier card. Priced off capacity rather than a
     * flat curve, because a level-6 emitter holds twenty times what a level-1
     * one does — a fixed price would make the late shield free to run.
     *
     * hidden, not capped, before the card is taken: a row reading MAX would
     * say "you have finished with this", when the truth is the opposite — the
     * player has never seen the shield and the shop is not where it is
     * explained. The row appears the moment there is an emitter to charge.
     */
    id: 'shield', name: 'Shield Recharge', icon: '⬡', color: C.cyan, max: Infinity,
    line: 'BARRIER',
    desc: () => 'RESTORE 45% SHIELD',
    cost: (lv, g) => Math.round(g.t.shieldMax * 0.08 + 10 * g.wave),
    hidden: t => t.shieldMax <= 0,
    enabled: t => t.shieldHp < t.shieldMax - 0.5,
    apply: t => { t.shieldHp = Math.min(t.shieldMax, t.shieldHp + t.shieldMax * 0.45); },
  },
  {
    /**
     * Coolant's successor, and the answer to a gun that physically cannot
     * cycle any faster.
     *
     * bulletSpeed is 620 and nothing else in the game touches it, which is a
     * problem that only shows up once Range is maxed: a round crossing 1150px
     * of arena takes nearly two seconds, so at the fire rate cap there are
     * ~110 rounds in the air at any moment and a good share of them are
     * flying at things that are already dead. This does not add damage; it
     * stops damage you already paid for from being thrown away.
     */
    id: 'velocity', name: 'Muzzle Velocity', icon: '➶', color: C.gold, max: 10,
    line: 'RATE', after: 'coolant',
    desc: () => '+18% SHOT SPEED',
    cost: lv => Math.round(70 * Math.pow(1.4, lv)),
    // only sold once the gun has hit the wall Coolant runs into
    hidden: t => t.fireRate < MAX_FIRE_RATE - 1e-6,
    // 10 levels is exactly where 620 x 1.18^n reaches MAX_BULLET_SPEED, so the
    // level count and the real ceiling agree and neither can advertise a
    // purchase the other would refuse
    capped: t => t.bulletSpeed >= MAX_BULLET_SPEED - 1e-6,
    apply: t => { t.bulletSpeed = Math.min(MAX_BULLET_SPEED, t.bulletSpeed * 1.18); },
  },
  {
    /**
     * Targeting Optics' successor. Crit CHANCE stops at MAX_CRIT_CHANCE, so
     * this buys what a crit does instead of how often one lands.
     *
     * Blast damage is the one thing that gets better as the waves get worse:
     * late waves are not harder single enemies so much as far more of them at
     * once, and a blast is worth exactly as much as the crowd is dense.
     */
    id: 'fission', name: 'Fission Rounds', icon: '☢', color: C.orange, max: 10,
    line: 'OPTICS', after: 'optics',
    then: 'overclock',
    desc: () => 'CRITS DETONATE FOR +14%',
    // Priced above the other stat items on purpose. A blast turns one crit
    // into as many hits as there are bodies in 66px, so in the crowds this is
    // sold into it is worth several times a flat damage buy — measured at
    // roughly 2x total output by the third level.
    cost: lv => Math.round(130 * Math.pow(1.5, lv)),
    hidden: t => t.critChance < MAX_CRIT_CHANCE - 1e-6,
    apply: t => { t.critBlast += 0.14; },
  },
  {
    /**
     * The sink for late salvage, and the only uncapped source of power in the
     * shop.
     *
     * Every other item is priced at roughly x1.5 per level owned, so it prices
     * itself out around level 10-12 — a Damage Core at level 15 costs about
     * seventeen waves of income. Salvage income, meanwhile, is close to linear
     * in the wave number while enemy HP compounds at 1.185^wave. The result is
     * a late game where the Salvage Bay has quietly stopped mattering and the
     * cards carry the entire run.
     *
     * So this one is priced off the WAVE instead of off how many you own.
     * Income per wave and cost per wave then grow together, which holds the
     * number of purchases per wave roughly constant — and a constant number of
     * multiplicative buys per wave is itself an exponential, which is the only
     * shape that can stay with the HP curve. It stays deliberately behind that
     * curve: this is meant to keep salvage relevant, not to replace the cards.
     */
    id: 'overclock', name: 'Overclock', icon: '⏦', color: C.red, max: Infinity,
    line: 'WEAPON', after: 'core',
    desc: () => '+8% DAMAGE, NO LIMIT',
    cost: (lv, g) => Math.round(120 + 45 * g.wave),
    // Hidden early: before the shop starts pricing itself out there is nothing
    // for this to solve, and an uncapped buy would just warp the opening.
    hidden: (t, g) => g.wave < OVERCLOCK_WAVE,
    apply: t => {
      t.damage *= 1.08; t.orbDmg *= 1.08; t.missileDmg *= 1.08;
      t.chainDmg *= 1.08; t.meteorDmg *= 1.08; t.rayDps *= 1.08;
      t.novaBase *= 1.08; t.novaDmg *= 1.08;
      t.shieldBase *= 1.08; t.shieldDmg *= 1.08;
    },
  },
  {
    /**
     * Focusing Lens' successor. Once the gun already reaches the far corner of
     * the arena there is no distance left to buy, so reach turns into COVERAGE:
     * the same shots, landing across more of the crowd.
     *
     * Only the fixed radii scale. Shockwave's is already t.range * 0.9 and so
     * was never the thing that stalled — doubling up on it here would quietly
     * pay the Range line twice for the same purchase.
     */
    id: 'blast', name: 'Blast Calibration', icon: '◉', color: C.cyan, max: 12,
    line: 'RANGE', after: 'lens',
    then: 'overclock',
    desc: () => '+12% BLAST RADIUS',
    cost: lv => Math.round(80 * Math.pow(1.45, lv)),
    hidden: (t, g) => t.range < g.maxThreatDistance(),
    capped: t => t.blastMult >= MAX_BLAST - 1e-6,
    apply: t => { t.blastMult = Math.min(MAX_BLAST, t.blastMult * 1.12); },
  },
  {
    /**
     * Muzzle Velocity's successor, and the one upgrade aimed at a number the
     * debrief already reports back: overkill, routinely a fifth of everything
     * a run deals. At the fire rate cap with rounds arriving instantly, the
     * waste is not aim or travel any more, it is that a killing blow spends
     * whatever it had left over.
     *
     * Recycled, never amplified — MAX_CARRY is 1, so at best a round finishes
     * one target and starts the next with exactly what it did not need. Above
     * that it would be a damage multiplier wearing a disguise.
     */
    id: 'overpressure', name: 'Overpressure', icon: '⇴', color: C.gold, max: 7,
    line: 'RATE', after: 'velocity',
    then: 'overclock',
    desc: () => 'OVERKILL CARRIES ON +15%',
    cost: lv => Math.round(150 * Math.pow(1.5, lv)),
    hidden: t => t.bulletSpeed < MAX_BULLET_SPEED - 1e-6,
    capped: t => t.carry >= MAX_CARRY - 1e-6,
    apply: t => { t.carry = Math.min(MAX_CARRY, t.carry + 0.15); },
  },
  {
    id: 'token', name: 'Reroll Token', icon: '🎲', color: C.purple, max: Infinity,
    line: 'SUPPORT',
    desc: () => '+1 CARD REROLL',
    cost: (lv, g) => Math.round(70 * Math.pow(1.3, g.rerolls)),
    enabled: (t, g) => g.rerolls < 6,
    apply: (t, g) => { g.rerolls++; },
  },
];
