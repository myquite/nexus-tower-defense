'use strict';

const MAX_PARTICLES = 420;

/* ============================================================
   GAME
   ============================================================ */
class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.w = 0; this.h = 0;
    this.state = 'start';
    this.timeScale = 1;
    this.shakeAmt = 0;
    this.towerRadius = 34;

    this.particlePool = new Pool(() => new Particle());
    this.textPool = new Pool(() => new FloatText());

    this.drifters = [];
    this.best = +(localStorage.getItem('nexus_best') || 0);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.reset();
  }

  /* ------------------------------------------------------ */
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.w = w; this.h = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.cx = w / 2;
    this.cy = h / 2;
    this.spawnMargin = 60;
    if (this.drifters.length === 0) {
      const n = Math.round((w * h) / 26000);
      for (let i = 0; i < n; i++) this.drifters.push(new Drifter(w, h));
    }
  }

  reset() {
    // Every redeploy comes through here, so the debrief can never show a
    // number that belongs to the previous run.
    Stats.reset(this);
    this.t = baseTower();
    this.perkLevels = {};
    this.shopLevels = {};
    this.wave = 0;
    this.kills = 0;
    this.cash = 0;
    this.rerolls = 2;

    this.enemies = [];
    this.bullets = [];
    this.missiles = [];
    this.meteors = [];
    this.bolts = [];
    this.rings = [];
    this.particles = [];
    this.texts = [];
    this.orbs = [];

    this.spawnQueue = [];
    this.waveTime = 0;
    this.turretAngle = -Math.PI / 2;
    this.fireCd = 0;
    this.missileCd = 0;
    this.chainCd = 0;
    this.meteorCd = 0;
    this.novaCd = 0;
    this.novaWind = 0;    // 0..1 plating drawing in before a shockwave
    this.novaPulse = 0;   // kicks to 1 as it releases, decays — the plating punch
    this.rayAngle = 0;
    this.rayT = 0;        // seconds into the current phase
    this.rayOn = false;   // true while the beam is actually live
    this.rayCharge = 0;   // 0..1 spin-up, read by the core's capacitor ring
    this.rayFlash = 0;    // kicks to 1 the instant a beam fires, decays
    this.orbAngle = 0;
    this.rangePulse = 0;
    this.shieldFlash = 0;     // kicks to 1 on each impact, decays
    this.shieldHitAngle = 0;  // where the last impact landed, for the flare
    this.shakeAmt = 0;
    this.hitFlash = 0;
    this.ringOpen = 0;    // 0 = collapsed to a flat line, 1 = fully open ellipse
    this.turretTrail = [];// recent barrel bearings, newest last — the boresight swing
    this.barrelFlash = 0; // kicks to 1 on each shot, decays
    this.hpShown = 1;     // eased HP fraction, so the integrity arc drains smoothly
    this.heat = 0;        // barrel heat, 0..1 — climbs with sustained fire
    this._detDepth = 0;   // detonation chain depth guard
    this._carryDepth = 0; // overkill carry chain depth guard
    this.betweenWaves = 0;
  }

  /* ============================================================
     WAVE FLOW
     ============================================================ */
  startRun() {
    this.reset();
    this.state = 'playing';
    Music.duck(false);
    UI.hideShop();
    UI.hideUpgrades();
    UI.show(UI.el.hud);
    UI.syncPerks(this);
    this.nextWave();
  }

  nextWave() {
    this.wave++;
    const w = buildWave(this.wave);
    this.scale = waveScale(this.wave);
    this.spawnQueue = w.entries.map(e => ({ type: e.type, at: Math.max(0.4, e.delay + 0.6) }));
    this.waveTime = 0;
    this.isBossWave = w.boss;
    /**
     * Field Regenerator. Per WAVE, not per second, so it can never rescue a
     * wall mid-collapse — what it buys is that a run is never permanently
     * without a barrier just because the salvage ran out.
     */
    const t = this.t;
    if (t.barrierRegen > 0 && t.shieldMax > 0 && t.shieldHp < t.shieldMax) {
      t.shieldHp = Math.min(t.shieldMax, t.shieldHp + t.shieldMax * t.barrierRegen);
      this.syncShield();
    }
    UI.banner(w.boss ? `WAVE ${this.wave} — BOSS` : `WAVE ${this.wave}`, w.boss);
    if (this.wave > this.best) {
      this.best = this.wave;
      localStorage.setItem('nexus_best', this.best);
    }
  }

  waveCleared() {
    return this.spawnQueue.length === 0 && this.enemies.length === 0;
  }

  openUpgrades() {
    this.state = 'upgrade';
    Music.duck(true);
    // +1 free reroll per wave, but never clamp below rerolls the player bought in the shop
    this.rerolls = Math.min(6, this.rerolls + 1);
    this.rollChoices();
  }

  rollChoices() {
    const available = UPGRADES.filter(u => {
      const lv = this.perkLevels[u.id] || 0;
      if (lv >= u.max) return false;
      if (u.unlock && !u.unlock(this)) return false;
      // a stat can hit its ceiling long before its level max — Range outreaches
      // the arena around level 5 of 12. Keep offering it and the player is
      // picking between one live card and one that does nothing.
      if (u.capped && u.capped(this)) return false;
      return true;
    });

    // weighted pick of 2 distinct upgrades, biased toward unowned ones early
    const pool = [];
    for (const u of available) {
      const lv = this.perkLevels[u.id] || 0;
      let w = u.weight;
      if (lv === 0) w *= 1.6;
      for (let i = 0; i < Math.round(w); i++) pool.push(u);
    }

    const picked = [];
    let guard = 0;
    while (picked.length < 2 && pool.length && guard++ < 400) {
      const u = pick(pool);
      if (!picked.includes(u)) picked.push(u);
    }
    if (picked.length === 0) picked.push(UPGRADE_BY_ID.damage);

    this.choices = picked;
    UI.showUpgrades(this, picked, this.perkLevels,
      this.rerolls,
      u => this.takeUpgrade(u),
      () => { if (this.rerolls > 0) { this.rerolls--; this.rollChoices(); } });
  }

  takeUpgrade(u) {
    const lv = (this.perkLevels[u.id] || 0) + 1;
    this.perkLevels[u.id] = lv;
    u.apply(this.t, lv);
    this.syncOrbs();
    this.syncShield();
    UI.syncPerks(this);
    UI.hideUpgrades();
    this.rings.push(new Ring(this.cx, this.cy, this.t.range, u.color, 0.7));
    this.openShop();
  }

  /* ---- shop ---- */
  openShop() {
    this.state = 'shop';
    UI.showShop(this, item => this.buy(item), () => this.closeShop());
  }

  buy(item) {
    const lv = this.shopLevels[item.id] || 0;
    if (lv >= item.max) return;
    if (item.enabled && !item.enabled(this.t, this)) return;
    const cost = item.cost(lv, this);
    if (this.cash < cost) return;

    this.cash -= cost;
    Stats.spent += cost;
    this.shopLevels[item.id] = lv + 1;
    item.apply(this.t, this);
    this.syncOrbs();
    this.syncShield();
    UI.syncShop(this);
  }

  closeShop() {
    UI.hideShop();
    Music.duck(false);
    this.state = 'playing';
    this.nextWave();
  }

  syncOrbs() {
    while (this.orbs.length < this.t.orbCount) this.orbs.push({ a: (this.orbs.length / Math.max(1, this.t.orbCount)) * TAU });
    while (this.orbs.length > this.t.orbCount) this.orbs.pop();
    // even redistribution
    this.orbs.forEach((o, i) => o.a = (i / this.orbs.length) * TAU);
  }

  gameOver() {
    this.state = 'over';
    Music.duck(true);
    this.burst(this.cx, this.cy, C.cyan, 70, 3.5);
    this.shake(30);
    UI.hide(UI.el.hud);
    UI.showGameOver(this, this.best);
  }

  /* ============================================================
     HELPERS USED BY ENTITIES
     ============================================================ */
  shake(a) { this.shakeAmt = Math.min(34, this.shakeAmt + a); }

  /** A point just beyond the viewport edge, in a random direction from the core. */
  spawnPoint() {
    const a = rand(TAU);
    const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const m = this.spawnMargin;
    const rx = c > 1e-4 ? (this.w / 2 + m) / c : Infinity;
    const ry = s > 1e-4 ? (this.h / 2 + m) / s : Infinity;
    const r = Math.min(rx, ry);
    return { x: this.cx + Math.cos(a) * r, y: this.cy + Math.sin(a) * r };
  }

  spark(x, y, color, life) {
    if (this.particles.length > MAX_PARTICLES) return;
    this.particles.push(this.particlePool.get().init(x, y, rand(-40, 40), rand(-40, 40), life || 0.4, rand(2, 4), color));
  }

  burst(x, y, color, count, power) {
    power = power || 1;
    for (let i = 0; i < count; i++) {
      if (this.particles.length > MAX_PARTICLES) break;
      const a = rand(TAU), s = rand(60, 300) * power;
      this.particles.push(this.particlePool.get().init(
        x, y, Math.cos(a) * s, Math.sin(a) * s, rand(0.25, 0.6) * power, rand(2, 5), color));
    }
  }

  spawnDamageText(x, y, amount, crit, capped) {
    if (this.texts.length > 40) return;
    // capped hits skip the sampling — the player needs to see armour working
    if (!crit && !capped && Math.random() > 0.32) return;
    const color = capped ? C.steel : (crit ? C.gold : '#cfe9ff');
    this.texts.push(this.textPool.get().init(x, y, fmt(amount), color, crit));
  }

  damageTower(dmg, from) {
    if (this.state !== 'playing') return;
    if (from) Stats.leak(from, dmg);
    this.t.hp -= dmg;
    this.hitFlash = 1;
    if (this.t.hp <= 0) { this.t.hp = 0; this.gameOver(); }
  }

  nearestEnemy(x, y, range, ignoreRange) {
    let best = null, bd = ignoreRange ? Infinity : range * range;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist2(x, y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /** Prefer the closest enemy to the core inside range (highest threat). */
  targetEnemy() {
    let best = null, bd = Infinity;
    const r2 = this.t.range * this.t.range;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = dist2(this.cx, this.cy, e.x, e.y);
      if (d <= r2 && d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /**
   * The shared blast funnel. Missiles, meteors, the nova and Detonation all
   * land here, and by the time a hit reaches Enemy.hurt they are
   * indistinguishable — so the caller has to say which one it is.
   */
  /**
   * Overpressure. A killing blow normally throws away whatever it had left
   * over — routinely a fifth of everything a run deals, per the debrief — so
   * this hands the excess to the nearest thing still standing.
   *
   * Bounded three ways, because a chain of kills that each feed the next is
   * how you write an infinite loop by accident: a radius, so it reads as the
   * round carrying on rather than damage teleporting across the arena; a depth
   * guard, the same one Detonation needs; and MAX_CARRY at 1, so the excess is
   * recycled and never amplified. It keeps the original source, because the
   * weapon that fired the round is honestly the thing that dealt this damage.
   */
  carryOver(from, dmg, src) {
    if (this._carryDepth >= 3 || dmg <= 0) return;
    const reach = 220 * 220;
    let best = null, bd = reach;
    for (const e of this.enemies) {
      if (e.dead || e === from) continue;
      const d = dist2(from.x, from.y, e.x, e.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return;
    this._carryDepth++;
    best.hurt(dmg, this, false, src);
    this._carryDepth--;
  }

  areaDamage(x, y, radius, dmg, color, knock, src) {
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (dist2(x, y, e.x, e.y) < r2) {
        e.hurt(dmg, this, false, src);
        if (knock) e.knockback(x, y, knock);
      }
    }
  }

  killEnemy(e) {
    if (e.dead) return;
    e.dead = true;
    this.kills++;
    // Credited before the detonation below, which can kill again and would
    // otherwise overwrite the source that earned this one.
    Stats.credit(e);

    /**
     * Detonation releases a slice of the victim's own max HP, so the blast
     * scales with the wave curve for free. A blast can kill, which re-enters
     * killEnemy — that chain reaction is the point of the card, but it needs a
     * depth bound or a dense formation would recurse until the stack gives out.
     */
    if (this.t.detonate > 0 && this._detDepth < 3) {
      this._detDepth++;
      this.areaDamage(e.x, e.y, BLAST_DETONATE * this.t.blastMult,
        e.maxHp * this.t.detonate, C.orange, 0, SRC.DETONATE);
      this.rings.push(new Ring(e.x, e.y, 74, C.orange, 0.28));
      this._detDepth--;
    }
    const paid = e.cash * this.t.cashMult;
    this.cash += paid;
    Stats.earned += paid;
    if (this.t.lifesteal) {
      // banked as what was actually restored, not what was offered — a siphon
      // at full health heals nothing
      const before = this.t.hp;
      this.t.hp = Math.min(this.t.maxHp, this.t.hp + this.t.lifesteal);
      Stats.healed += this.t.hp - before;
    }
    this.burst(e.x, e.y, e.color, e.boss ? 40 : (e.sizeMul < 1 ? 5 : 10), e.boss ? 2.6 : 1);
    if (e.boss) { this.shake(18); this.rings.push(new Ring(e.x, e.y, 150, C.pink, 0.6)); }

    /**
     * Splitters come apart along the fracture lines they were drawing all
     * along. Each piece is placed at the centroid of the wedge it occupied
     * (0.375 of the way out toward its vertex), carries the rotation that
     * wedge already had, and inherits the parent's spin — so for the first
     * instant the three shards still form the triangle, and only then fly
     * apart. Random scatter would throw that away.
     */
    if (e.def.splits && e.sizeMul >= 1) {
      const n = e.def.splits;
      for (let i = 0; i < n; i++) {
        const local = -Math.PI / 2 + (i / n) * TAU;   // toward this piece's vertex
        const world = local + e.angle;
        const r = e.size * 0.42;
        const s = new Enemy('shard',
          e.x + Math.cos(world) * r, e.y + Math.sin(world) * r, this.scale, 0.85);
        Stats.spawn('shard');   // shards are hostiles the run really had to kill
        s.angle = e.angle + (i / n) * TAU;   // keep the wedge's own orientation
        s.spin = e.spin;                      // one shape coming apart, not three arrivals
        s.knockback(e.x, e.y, 150);
        this.enemies.push(s);
      }
    }
  }

  /* ============================================================
     WEAPON SYSTEMS
     ============================================================ */
  fireGun(dt) {
    const t = this.t;
    this.fireCd -= dt;

    const target = this.targetEnemy();
    if (target) {
      const want = Math.atan2(target.y - this.cy, target.x - this.cx);
      this.turretAngle = turnToward(this.turretAngle, want, 11 * dt);
    } else {
      this.turretAngle += 0.45 * dt;
    }

    if (!target || this.fireCd > 0) return;

    /**
     * Carry the leftover cooldown instead of resetting it, and allow more than
     * one volley per frame. Resetting to a full interval threw away the
     * remainder, which quantised the real cadence to the frame rate rounded
     * down: every rate from 30/s to 59/s fired at exactly 30/s, so whole bands
     * of fire-rate purchases bought nothing at all.
     */
    const interval = 1 / Math.min(t.fireRate, MAX_FIRE_RATE);
    let volleys = 0;
    while (this.fireCd <= 0 && volleys < MAX_VOLLEYS_PER_FRAME) {
      this.volley(t);
      this.fireCd += interval;
      volleys++;
    }
    // a long stall shouldn't leave the gun owing shots it can never repay
    if (this.fireCd <= 0) this.fireCd = interval;
  }

  /** One trigger pull: every projectile in the multishot spread. */
  volley(t) {
    this.barrelFlash = 1;   // the visor boresight pulses on the shot
    // heat is per-projectile, so multishot runs the barrel hotter than a single
    this.heat = Math.min(1, this.heat + 0.05 + 0.02 * t.shots);

    const n = t.shots;
    const spread = Math.min(0.5, 0.09 * (n - 1));
    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : lerp(-spread, spread, i / (n - 1));
      const crit = chance(t.critChance);
      // the roll is per projectile, so crit rate is measured per round too
      Stats.rounds++;
      if (crit) Stats.critShots++;
      const dmg = t.damage * (crit ? t.critMult : 1);
      const a = this.turretAngle + off + rand(-0.012, 0.012);
      const muzzle = this.towerRadius + 8;
      this.bullets.push(new Bullet(
        this.cx + Math.cos(a) * muzzle, this.cy + Math.sin(a) * muzzle,
        a, t.bulletSpeed, dmg, t.pierce, crit, t.bounces));
    }
    this.spark(this.cx + Math.cos(this.turretAngle) * (this.towerRadius + 10),
               this.cy + Math.sin(this.turretAngle) * (this.towerRadius + 10), C.cyan, 0.16);
  }

  /**
   * How far a hostile can ever be from the core: the spawn ring is the
   * viewport rectangle pushed out by the spawn margin, so its far corner is
   * the point past which extra range can never reach anything.
   */
  maxThreatDistance() {
    return Math.hypot(this.w / 2 + this.spawnMargin, this.h / 2 + this.spawnMargin);
  }

  /* ---- barrier ring ---- */

  shieldUp() { return this.t.shieldHp > 0; }

  /**
   * Where the ring actually sits. The canvas is the whole window, so a radius
   * that looks generous on a desktop is off-screen on a phone; clamp it to the
   * arena rather than let the player buy a barrier they cannot see. Held off
   * the core by towerRadius so it can never form inside the tower itself.
   */
  shieldRing() {
    return clamp(this.t.shieldRadius, this.towerRadius + 40, Math.min(this.w, this.h) * 0.42);
  }

  /**
   * Anything already inside the ring when it comes up stays inside — the
   * barrier forms around it rather than flinging it out through its own wall.
   * In practice the shield only ever comes up between waves, when there is
   * nothing to mark; this is what keeps that assumption from being load-
   * bearing, and it is the only thing that ever sets pastShield.
   */
  syncShield() {
    if (!this.shieldUp()) return;
    const ring = this.shieldRing();
    for (const e of this.enemies) {
      if (dist(e.x, e.y, this.cx, this.cy) < ring + e.size * 0.5) e.pastShield = true;
    }
  }

  /**
   * Called by an enemy that just ran into the ring. Returns nothing — the
   * enemy handles being stopped; this only spends the barrier and reacts.
   */
  drainShield(amount, x, y) {
    const t = this.t;
    // Bank only what the wall could actually absorb: past the last point of
    // capacity the overflow is not stopped by anything, and counting it would
    // credit the barrier with damage that went on to hit the core.
    Stats.shielded += Math.min(amount, Math.max(0, t.shieldHp));
    t.shieldHp -= amount;
    this.shieldFlash = 1;
    this.shieldHitAngle = Math.atan2(y - this.cy, x - this.cx);
    this.burst(x, y, C.cyan, 5, 0.7);
    if (t.shieldHp <= 0) this.collapseShield();
  }

  /**
   * The barrier failing is the single most important thing that can happen in
   * a wave — everything the player was ignoring is suddenly walking straight
   * at the core — so it gets the loudest feedback in the game short of dying.
   */
  collapseShield() {
    const t = this.t;
    Stats.collapses++;
    t.shieldHp = 0;
    const ring = this.shieldRing();
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * TAU;
      this.burst(this.cx + Math.cos(a) * ring, this.cy + Math.sin(a) * ring, C.cyan, 3, 1.2);
    }
    this.rings.push(new Ring(this.cx, this.cy, ring, C.cyan, 0.9));
    this.shake(14);
    this.shieldFlash = 0;
  }

  fireMissiles(dt) {
    const t = this.t;
    if (t.missileCount <= 0) return;
    this.missileCd -= dt;
    if (this.missileCd > 0) return;
    if (!this.enemies.length) return;
    this.missileCd = t.missileCd;

    for (let i = 0; i < t.missileCount; i++) {
      const a = (i / t.missileCount) * TAU + rand(-0.2, 0.2);
      const m = new Missile(this.cx + Math.cos(a) * 20, this.cy + Math.sin(a) * 20,
        a, t.missileDmg, t.missileRadius * t.blastMult);
      m.speed = rand(90, 160);
      this.missiles.push(m);
    }
    this.shake(3);
  }

  fireChain(dt) {
    const t = this.t;
    if (t.chainJumps <= 0) return;
    this.chainCd -= dt;
    if (this.chainCd > 0) return;

    const first = this.targetEnemy();
    if (!first) return;
    this.chainCd = t.chainCd;

    const pts = [{ x: this.cx, y: this.cy }];
    const hit = new Set();
    let cur = first;
    for (let j = 0; j < t.chainJumps && cur; j++) {
      hit.add(cur);
      pts.push({ x: cur.x, y: cur.y });
      cur.hurt(t.chainDmg, this, false, SRC.CHAIN);
      cur.slowT = 0.5;
      // next nearest unhit within jump range
      let best = null, bd = 200 * 200;
      for (const e of this.enemies) {
        if (e.dead || hit.has(e)) continue;
        const d = dist2(cur.x, cur.y, e.x, e.y);
        if (d < bd) { bd = d; best = e; }
      }
      cur = best;
    }
    this.bolts.push(new Bolt(pts, C.purple));
  }

  fireMeteors(dt) {
    const t = this.t;
    if (t.meteorCount <= 0) return;
    this.meteorCd -= dt;
    if (this.meteorCd > 0) return;
    if (!this.enemies.length) return;
    this.meteorCd = t.meteorCd;

    for (let i = 0; i < t.meteorCount; i++) {
      const e = pick(this.enemies);
      this.meteors.push(new Meteor(e.x + rand(-30, 30), e.y + rand(-30, 30),
        t.meteorDmg, t.meteorRadius * t.blastMult));
    }
  }

  /**
   * The shockwave used to arrive out of nowhere — a ring simply existed, with
   * nothing on the tower to say it had come from there. Now the plating winds
   * in ahead of it and snaps out as it releases, so the shells are visibly the
   * thing that threw the wave rather than something it passed through.
   *
   * NOVA_WIND is the anticipation window. Kept short: the shockwave is on a
   * cooldown the player does not control, so a long tell would read as the
   * tower flinching constantly rather than as a weapon winding up.
   */
  fireNova(dt) {
    const t = this.t;
    if (t.novaDmg <= 0) { this.novaWind = 0; return; }
    this.novaCd -= dt;
    // drawn in tighter the closer the release is, eased so the last moments
    // move fastest and the snap has something to snap from
    const w = clamp((NOVA_WIND - this.novaCd) / NOVA_WIND, 0, 1);
    this.novaWind = w * w;
    if (this.novaCd > 0) return;
    this.novaCd = t.novaCd;
    this.novaWind = 0;
    this.novaPulse = 1;
    const r = t.range * 0.9;
    this.areaDamage(this.cx, this.cy, r, t.novaDmg, C.cyan, t.novaKnock, SRC.NOVA);
    this.rings.push(new Ring(this.cx, this.cy, r, C.cyan, 0.55));
    this.shake(6);
  }

  /**
   * The emitters keep sweeping the whole time; only the beam is intermittent.
   * That is what makes the wind-up readable — the array is visibly tracking
   * across the field while it charges, so when it fires the player already
   * knows where it is pointed rather than being surprised by it.
   */
  updateRays(dt) {
    const t = this.t;
    if (t.rayCount <= 0) return;
    this.rayAngle += t.raySpeed * dt;
    this.rayFlash = Math.max(0, this.rayFlash - dt * 2.4);

    this.rayT += dt;
    if (this.rayOn) {
      if (this.rayT >= t.rayBurst) { this.rayOn = false; this.rayT = 0; }
    } else {
      this.rayCharge = clamp(this.rayT / t.rayChargeTime, 0, 1);
      if (this.rayT >= t.rayChargeTime) {
        this.rayOn = true; this.rayT = 0; this.rayCharge = 1;
        this.rayFlash = 1;
        this.shake(3);
      }
    }
    if (!this.rayOn) return;   // charging: the array turns, but nothing burns

    const len = t.range * 1.15;
    const width = 13;
    for (let i = 0; i < t.rayCount; i++) {
      const a = this.rayAngle + (i / t.rayCount) * TAU;
      const ex = this.cx + Math.cos(a) * len, ey = this.cy + Math.sin(a) * len;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const r = width + e.size * 0.5;
        if (distToSegment2(e.x, e.y, this.cx, this.cy, ex, ey) < r * r) {
          e.hurt(t.rayDps * dt, this, false, SRC.RAY);
          if (Math.random() < 0.25) this.spark(e.x, e.y, C.gold, 0.25);
        }
      }
    }
  }

  updateOrbs(dt) {
    if (!this.orbs.length) return;
    const t = this.t;
    this.orbAngle += t.orbSpeed * dt;
    for (const e of this.enemies) {
      if (e.dead) continue;
      e.orbCd = (e.orbCd || 0) - dt;
      if (e.orbCd > 0) continue;
      for (const o of this.orbs) {
        const a = this.orbAngle + o.a;
        const ox = this.cx + Math.cos(a) * t.orbRadius;
        const oy = this.cy + Math.sin(a) * t.orbRadius;
        const r = 11 + e.size * 0.5;
        if (dist2(ox, oy, e.x, e.y) < r * r) {
          e.hurt(t.orbDmg, this, false, SRC.ORB);
          e.knockback(this.cx, this.cy, 40);
          e.orbCd = 0.28;
          this.burst(ox, oy, C.cyan, 4, 0.5);
          break;
        }
      }
    }
  }

  /* ============================================================
     MAIN UPDATE
     ============================================================ */
  update(dt) {
    // ambient always animates
    for (const d of this.drifters) d.update(dt, this.w, this.h);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 2.6);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 3.2);
    this.novaPulse = Math.max(0, this.novaPulse - dt * 3.4);
    this.shakeAmt *= Math.pow(0.0008, dt);
    this.rangePulse += dt;

    // Threat ring: opens while hostiles are live, falls shut to a flat line once
    // the sky is clear. Eased rather than snapped so clearing a wave reads as the
    // visor powering the display down.
    const threats = this.enemies.length + this.spawnQueue.length;
    // Pausing must not wipe the threat picture — the display stays up for any
    // live state, and only folds shut when the sector is actually clear.
    const want = (this.state !== 'over' && threats > 0) ? 1 : 0;
    this.ringOpen += (want - this.ringOpen) * (1 - Math.pow(0.008, dt));
    // Boresight history. Angles are stored raw and drawn individually, so a
    // swing across the +/-PI seam needs no unwrapping.
    this.barrelFlash = Math.max(0, this.barrelFlash - dt * 4.5);
    this.heat = Math.max(0, this.heat - dt * 0.85);
    if (this.state === 'playing') {
      this.turretTrail.push(this.turretAngle);
      if (this.turretTrail.length > 14) this.turretTrail.shift();
    }

    // Integrity arc chases the real value rather than snapping, so a big hit
    // reads as the arc being driven back instead of just becoming shorter.
    const hpFrac = clamp(this.t.hp / this.t.maxHp, 0, 1);
    this.hpShown += (hpFrac - this.hpShown) * (1 - Math.pow(0.0001, dt));

    if (this.state !== 'playing') {
      // let effects settle on the upgrade screen
      this.stepEffects(dt * 0.4);
      return;
    }

    const t = this.t;
    this.waveTime += dt;
    // Only ticks here, past the state gate — the debrief's clock is time under
    // fire, not time with the tab open on the shop screen.
    Stats.time += dt;
    if (this.enemies.length > Stats.peak) Stats.peak = this.enemies.length;

    // regen
    if (t.regen) {
      const before = t.hp;
      t.hp = Math.min(t.maxHp, t.hp + t.regen * dt);
      Stats.healed += t.hp - before;
    }

    // spawns
    while (this.spawnQueue.length && this.spawnQueue[0].at <= this.waveTime) {
      const s = this.spawnQueue.shift();
      const p = this.spawnPoint();
      Stats.spawn(s.type);
      this.enemies.push(new Enemy(s.type, p.x, p.y, this.scale, 1));
    }

    // weapons
    this.fireGun(dt);
    this.fireMissiles(dt);
    this.fireChain(dt);
    this.fireMeteors(dt);
    this.fireNova(dt);
    this.updateRays(dt);
    this.updateOrbs(dt);

    // entities
    for (const e of this.enemies) if (!e.dead) e.update(dt, this);
    for (const b of this.bullets) if (!b.dead) b.update(dt, this);
    for (const m of this.missiles) if (!m.dead) m.update(dt, this);
    for (const m of this.meteors) if (!m.dead) m.update(dt, this);
    this.stepEffects(dt);

    this.prune();

    if (this.state === 'playing' && this.waveCleared() && this.waveTime > 1) {
      this.openUpgrades();
    }

    UI.syncHud(this);
  }

  stepEffects(dt) {
    for (const b of this.bolts) b.update(dt);
    for (const r of this.rings) r.update(dt);
    for (const p of this.particles) p.update(dt);
    for (const f of this.texts) f.update(dt);
  }

  prune() {
    this.enemies = this.enemies.filter(e => !e.dead);
    this.bullets = this.bullets.filter(b => !b.dead && b.x > -80 && b.x < this.w + 80 && b.y > -80 && b.y < this.h + 80);
    this.missiles = this.missiles.filter(m => !m.dead);
    this.meteors = this.meteors.filter(m => !m.dead);
    this.bolts = this.bolts.filter(b => !b.dead);
    this.rings = this.rings.filter(r => !r.dead);

    const keptP = [];
    for (const p of this.particles) { if (p.dead) this.particlePool.put(p); else keptP.push(p); }
    this.particles = keptP;

    const keptT = [];
    for (const f of this.texts) { if (f.dead) this.textPool.put(f); else keptT.push(f); }
    this.texts = keptT;
  }

  /* ============================================================
     RENDER
     ============================================================ */
  draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);

    if (this.shakeAmt > 0.4) {
      ctx.translate(rand(-this.shakeAmt, this.shakeAmt), rand(-this.shakeAmt, this.shakeAmt));
    }

    this.drawGrid(ctx);
    for (const d of this.drifters) d.draw(ctx);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    this.drawRange(ctx);
    for (const r of this.rings) r.draw(ctx);
    for (const m of this.meteors) m.draw(ctx);
    this.drawRays(ctx);
    for (const b of this.bolts) b.draw(ctx);
    for (const e of this.enemies) e.draw(ctx);
    for (const b of this.bullets) b.draw(ctx);
    for (const m of this.missiles) m.draw(ctx);
    for (const p of this.particles) p.draw(ctx);
    this.drawOrbs(ctx);
    this.drawShield(ctx);
    this.drawTower(ctx);

    ctx.restore();

    for (const f of this.texts) f.draw(ctx);

    // damage vignette
    if (this.hitFlash > 0.01) {
      const g = ctx.createRadialGradient(this.cx, this.cy, Math.min(this.w, this.h) * 0.25,
        this.cx, this.cy, Math.max(this.w, this.h) * 0.72);
      g.addColorStop(0, 'rgba(255,45,85,0)');
      g.addColorStop(1, `rgba(255,45,85,${0.34 * this.hitFlash})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    // Visor HUD last, on a clean transform — the shake is the world moving
    // inside the helmet, not the helmet moving.
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    Visor.draw(ctx, this);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawGrid(ctx) {
    const step = 64;
    ctx.save();
    ctx.strokeStyle = 'rgba(90,216,255,.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = (this.cx % step); x < this.w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, this.h); }
    for (let y = (this.cy % step); y < this.h; y += step) { ctx.moveTo(0, y); ctx.lineTo(this.w, y); }
    ctx.stroke();
    ctx.restore();
  }

  drawRange(ctx) {
    const r = this.t.range;
    ctx.save();
    ctx.strokeStyle = 'rgba(90,216,255,.10)';
    ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(this.cx, this.cy, r, 0, TAU); ctx.stroke();
    ctx.strokeStyle = 'rgba(90,216,255,.30)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(this.cx, this.cy, r, 0, TAU); ctx.stroke();

    // slow sweep highlight
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 3;
    const a = this.rangePulse * 0.6;
    ctx.beginPath(); ctx.arc(this.cx, this.cy, r, a, a + 0.7); ctx.stroke();

    if (this.t.slowPct > 0) {
      ctx.globalAlpha = 0.06 + 0.02 * Math.sin(this.rangePulse * 2);
      ctx.fillStyle = C.cyan;
      ctx.beginPath(); ctx.arc(this.cx, this.cy, r, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Three states, and the middle one is the point. While charging there is
   * nothing but a hairline sight down each emitter, which only starts to show
   * in the last stretch of the wind-up — a telegraph, so the discharge reads
   * as the end of something rather than as a beam blinking on at random.
   *
   * The beam itself flares at the instant of firing and settles over the burst,
   * because a weapon that looks identical for the whole of its uptime does not
   * look like it fired, it looks like it is on.
   */
  drawRays(ctx) {
    const t = this.t;
    if (t.rayCount <= 0) return;
    const len = t.range * 1.15;
    const aim = this.rayCharge;
    ctx.save();
    ctx.lineCap = 'round';

    // A bloom at the origin, under the beams. Without it the beams merely
    // start at the core's coordinates; with it they leave from the core, which
    // is the difference between a weapon firing and lines appearing.
    if (this.rayOn) {
      const f = this.rayFlash;
      const rad = 30 + 66 * f;
      const grd = ctx.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, rad);
      grd.addColorStop(0, `rgba(255,246,210,${(0.5 + 0.4 * f).toFixed(3)})`);
      grd.addColorStop(0.45, `rgba(255,203,51,${(0.22 + 0.3 * f).toFixed(3)})`);
      grd.addColorStop(1, 'rgba(255,203,51,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(this.cx, this.cy, rad, 0, TAU); ctx.fill();
    }
    for (let i = 0; i < t.rayCount; i++) {
      const a = this.rayAngle + (i / t.rayCount) * TAU;
      const ex = this.cx + Math.cos(a) * len, ey = this.cy + Math.sin(a) * len;

      if (!this.rayOn) {
        // Only the last third of the wind-up telegraphs, so most of the cycle
        // stays visually quiet and the tell means something when it arrives.
        if (aim < 0.66) continue;
        const k = (aim - 0.66) / 0.34;
        ctx.strokeStyle = C.gold;
        ctx.globalAlpha = 0.05 + 0.3 * k * k;
        ctx.lineWidth = 1 + k;
        ctx.beginPath(); ctx.moveTo(this.cx, this.cy); ctx.lineTo(ex, ey); ctx.stroke();
        continue;
      }

      const f = this.rayFlash;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = 'rgba(255,203,51,.18)';
      ctx.lineWidth = 34 + 26 * f;
      ctx.beginPath(); ctx.moveTo(this.cx, this.cy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,203,51,.42)';
      ctx.lineWidth = 16 + 12 * f;
      ctx.beginPath(); ctx.moveTo(this.cx, this.cy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.strokeStyle = '#fff6d2';
      ctx.lineWidth = 4 + 5 * f;
      ctx.beginPath(); ctx.moveTo(this.cx, this.cy); ctx.lineTo(ex, ey); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The barrier. Charge is read off the ring itself rather than off a number
   * in the corner: a full shield is a bright continuous wall, a spent one is a
   * dim flickering outline, so the player can see it is about to fail without
   * ever looking away from the swarm. Impacts flare locally at the point of
   * contact, which is what makes a wall being pushed on look like a wall.
   */
  drawShield(ctx) {
    const t = this.t;
    if (t.shieldMax <= 0 || t.shieldHp <= 0) return;
    const frac = clamp(t.shieldHp / t.shieldMax, 0, 1);
    const r = this.shieldRing();
    // A nearly-spent emitter stutters. Tied to rangePulse, not a random value,
    // so the flicker is a steady failing-hardware pulse and not visual noise.
    const fail = frac < 0.3 ? 0.72 + 0.28 * Math.sin(this.rangePulse * 22) : 1;

    ctx.save();
    // body — brightest at full charge, barely there when nearly spent
    const grad = ctx.createRadialGradient(this.cx, this.cy, r * 0.82, this.cx, this.cy, r);
    grad.addColorStop(0, 'rgba(40,140,255,0)');
    grad.addColorStop(1, `rgba(40,140,255,${(0.05 + 0.16 * frac) * fail})`);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(this.cx, this.cy, r, 0, TAU); ctx.fill();

    // rim
    ctx.strokeStyle = C.cyan;
    ctx.globalAlpha = (0.3 + 0.55 * frac) * fail;
    ctx.lineWidth = 1.4 + 2.2 * frac;
    ctx.beginPath(); ctx.arc(this.cx, this.cy, r, 0, TAU); ctx.stroke();

    // Arc Barrier. A wall that kills has to look like it kills, or the player
    // reads a dead ring and a mystery kill feed. Short arcs skitter around the
    // rim, brighter with charge, so a live barrier is obvious at a glance and
    // a spent one cannot be mistaken for it.
    if (t.shieldDmg > 0) {
      // Near-white, not more cyan. An arc the same colour as the rim just
      // reads as a thicker rim; the whole point is that it should not look
      // like the wall, it should look like something crawling on it.
      ctx.strokeStyle = '#dff4ff';
      ctx.lineWidth = 1.6;
      for (let i = 0; i < 7; i++) {
        const a = rand(TAU);
        ctx.globalAlpha = rand(0.35, 0.95) * (0.4 + 0.6 * frac) * fail;
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, r + rand(-7, 7), a, a + rand(0.04, 0.14));
        ctx.stroke();
      }
      ctx.strokeStyle = C.cyan;
    }

    // impact flare, centred on wherever the last hit landed
    if (this.shieldFlash > 0.01) {
      ctx.globalAlpha = this.shieldFlash * 0.9;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(this.cx, this.cy, r, this.shieldHitAngle - 0.34, this.shieldHitAngle + 0.34);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawOrbs(ctx) {
    const t = this.t;
    if (!this.orbs.length) return;
    ctx.save();
    for (const o of this.orbs) {
      const a = this.orbAngle + o.a;
      const x = this.cx + Math.cos(a) * t.orbRadius;
      const y = this.cy + Math.sin(a) * t.orbRadius;
      ctx.fillStyle = C.cyan;
      ctx.globalAlpha = 0.28;
      ctx.beginPath(); ctx.arc(x, y, 20, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(40,140,255,.95)';
      ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.fill();
      ctx.strokeStyle = '#dff4ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * THE CORE
   * Same vector-neon vocabulary as before, but every layer now reads a real
   * value instead of just spinning: plating burns down with HP, the gyro spins
   * at your actual fire rate, the charge ring fills toward the next volley, and
   * the barrel recoils and heats under sustained fire. Nothing here is
   * decoration for its own sake — if it moves, it means something.
   *
   * Drawn with neonStroke rather than shadowBlur for the same reason the
   * entities are: shadowBlur is the most expensive per-draw call in canvas, and
   * this is the one object on screen that is always visible.
   */
  drawTower(ctx) {
    const R = this.towerRadius;
    const t = this.t;
    const flash = this.barrelFlash;
    const heat = this.heat;
    const hpFrac = clamp(t.hp / t.maxHp, 0, 1);
    const hurt = this.hitFlash > 0.2;

    // how close the next volley is — drives the charge ring and the core pulse
    const interval = 1 / Math.min(t.fireRate, MAX_FIRE_RATE);
    const charge = clamp(1 - this.fireCd / interval, 0, 1);

    ctx.save();
    ctx.translate(this.cx, this.cy);

    /* ---- integrity plating: six shells that burn out as the core is hit,
            and that throw the shockwave when there is one to throw ---- */
    // One radius for all six, so they move as a single shell rather than six
    // plates that happen to agree. Winding in is small and the release is
    // large: the punch has to outweigh the tell or it reads as a stumble.
    const plate = R * 1.36 * (1 - 0.11 * this.novaWind + 0.34 * this.novaPulse);
    const plateLit = 0.6 * this.novaPulse + 0.25 * this.novaWind;
    for (let i = 0; i < 6; i++) {
      const lit = clamp(hpFrac * 6 - i, 0, 1);
      if (lit <= 0.002) continue;
      // the gaps close as the shells draw in, so the ring looks like it seals
      // before it fires and blows apart as it lets go
      const gap = 0.13 * (1 - 0.55 * this.novaWind) + 0.1 * this.novaPulse;
      const a0 = (i / 6) * TAU + gap;
      const a1 = ((i + 1) / 6) * TAU - gap;
      neonStroke(ctx, c => c.arc(0, 0, plate, a0, a1),
        this.novaPulse > 0.15 ? C.cyan : (lit > 0.4 ? C.teal : C.red),
        2.2 + 2.4 * this.novaPulse, 3, clamp(0.22 + 0.5 * lit + plateLit, 0, 1));
    }

    /* ---- gyro: outer shell fixed, inner rings spun by the real fire rate ---- */
    const rate = Math.min(t.fireRate, MAX_FIRE_RATE);
    const spin = this.rangePulse * (0.4 + rate * 0.06);
    const hex = (rad, rot) => c => {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + rot;
        const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      }
      c.closePath();
    };

    neonStroke(ctx, hex(R, 0), hurt ? '#ffffff' : C.cyan, 3, 3.4, 0.95);

    // vertex ticks, the same mark the visor uses for its cardinals
    neonStroke(ctx, c => {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        c.moveTo(Math.cos(a) * R * 1.06, Math.sin(a) * R * 1.06);
        c.lineTo(Math.cos(a) * R * 1.18, Math.sin(a) * R * 1.18);
      }
    }, C.cyan, 1.4, 2.6, 0.5);

    neonStroke(ctx, hex(R * 0.68, -spin * 0.5), C.cyan, 1.6, 2.6, 0.45);
    neonStroke(ctx, hex(R * 0.44, spin * 0.8), C.cyan, 1.4, 2.6, 0.35);

    /* ---- charge ring: sweeps round as the next volley comes up ---- */
    if (rate > 0) {
      const a0 = -Math.PI / 2;
      neonStroke(ctx, c => c.arc(0, 0, R * 0.86, a0, a0 + charge * TAU),
        charge > 0.985 ? C.white : C.gold, 2, 3, 0.35 + 0.5 * charge);
    }

    /**
     * ---- ray charge: the core drawing power in
     * Read on the CORE itself, not as a gauge beside it, because the core is
     * where the beams leave from — a wind-up that happens somewhere else
     * belongs to a different object than the discharge does, and the two stop
     * reading as one weapon.
     *
     * Rings falling inward rather than an arc sweeping round: an arc is a
     * clock and says "waiting", where something collapsing toward the middle
     * says "gathering". They fall on charge SQUARED, so the last moment before
     * release is visibly the fastest and the core looks like it is straining.
     */
    if (t.rayCount > 0) {
      const rc = this.rayCharge;
      if (!this.rayOn && rc > 0.02) {
        const RINGS = 3;
        for (let k = 0; k < RINGS; k++) {
          // phase-offset, so one ring is always near the core and the inflow
          // reads as continuous rather than as three separate pulses
          const p = ((rc * rc * 2.4) + k / RINGS) % 1;
          // Starts outside the plating and ends inside the core, so the ring
          // is seen to cross the whole tower and arrive rather than just
          // existing somewhere in the middle of it.
          const rr = R * (2.05 - 1.75 * p);
          neonStroke(ctx, c => c.arc(0, 0, rr, 0, TAU),
            p > 0.82 ? C.white : C.gold, 1.1 + 2.3 * p, 2.6, (0.06 + 0.7 * p * p) * rc);
        }
      }
      // The core heats gold as it fills and blows to white on release, so the
      // brightest thing on screen at the instant of firing is the emitter.
      const g0 = this.rayOn ? 1 : rc;
      neonStroke(ctx, c => c.arc(0, 0, R * (0.26 + 0.10 * g0), 0, TAU),
        this.rayOn ? C.white : C.gold, 1.4 + 3.2 * g0, 3, 0.10 + 0.62 * g0);
      // the release itself: one ring thrown back out, the inflow reversed
      if (this.rayFlash > 0.01) {
        const k = 1 - this.rayFlash;
        neonStroke(ctx, c => c.arc(0, 0, R * (0.3 + 1.7 * k), 0, TAU),
          C.white, 1 + 2.6 * this.rayFlash, 3, 0.75 * this.rayFlash);
      }
    }

    /* ---- core: brightens as it comes up to charge ---- */
    neonStroke(ctx, c => c.arc(0, 0, R * 0.19, 0, TAU),
      C.white, 2.4 + 2 * charge, 3.2, 0.5 + 0.45 * charge);

    /* ---- barrel ---- */
    ctx.save();
    ctx.rotate(this.turretAngle);

    const recoil = -8 * flash;             // kicks back into the housing
    const bx = R - 6 + recoil;
    const len = 26;

    // housing
    neonStroke(ctx, c => {
      c.moveTo(bx, -5.5); c.lineTo(bx + len, -3.2);
      c.lineTo(bx + len, 3.2); c.lineTo(bx, 5.5); c.closePath();
    }, hurt ? '#ffffff' : C.cyan, 2, 3, 0.9);

    // bore — the hot line down the middle
    neonStroke(ctx, c => { c.moveTo(bx + 3, 0); c.lineTo(bx + len - 1, 0); },
      C.white, 2 + 1.8 * heat, 2.6, 0.5 + 0.45 * heat);

    // heat wash. Additive, so a hard-worked barrel goes cyan -> gold -> white
    if (heat > 0.01) {
      neonStroke(ctx, c => { c.moveTo(bx + 5, 0); c.lineTo(bx + len, 0); },
        C.orange, 4, 3, 0.45 * heat);
    }

    // muzzle bloom on the shot
    if (flash > 0.01) {
      const m = bx + len;
      ctx.globalAlpha = flash * 0.8;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(m, 0);
      ctx.lineTo(m + 15 * flash, -7 * flash);
      ctx.lineTo(m + 23 * flash, 0);
      ctx.lineTo(m + 15 * flash, 7 * flash);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();

    ctx.restore();
  }
}

/* ============================================================
   BOOT
   ============================================================ */
(function boot() {
  UI.init();
  Music.init();
  UI.syncAudio();
  const game = new Game(document.getElementById('game'));
  window.game = game;

  let last = performance.now();
  let ff = false;

  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 1 / 20);           // clamp big tab-switch gaps
    const steps = ff ? 2 : 1;
    for (let i = 0; i < steps; i++) game.update(dt);
    game.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---- buttons ---- */
  // both are real user gestures, so this is where audio is allowed to begin
  UI.el.startBtn.onclick = () => { UI.hide(UI.el.startScreen); Music.start(); game.startRun(); };
  UI.el.retryBtn.onclick = () => { UI.hide(UI.el.overScreen); Music.start(); game.startRun(); };

  const pause = () => {
    if (game.state !== 'playing') return;
    game._resumeState = game.state;
    game.state = 'paused';
    Music.suspend();
    UI.show(UI.el.pauseScreen);
  };
  const resume = () => {
    if (game.state !== 'paused') return;
    game.state = 'playing';
    Music.resume();
    UI.hide(UI.el.pauseScreen);
  };

  UI.el.pauseBtn.onclick = pause;
  UI.el.resumeBtn.onclick = resume;
  UI.el.quitBtn.onclick = () => {
    UI.hide(UI.el.pauseScreen);
    UI.hide(UI.el.hud);
    game.state = 'start';
    game.reset();
    UI.show(UI.el.startScreen);
  };

  window.addEventListener('keydown', ev => {
    if (ev.code === 'Escape') { game.state === 'paused' ? resume() : pause(); }
    if (ev.code === 'Space') { ev.preventDefault(); ff = true; }
    if (ev.code === 'Digit1' && game.state === 'upgrade') game.takeUpgrade(game.choices[0]);
    if (ev.code === 'Digit2' && game.state === 'upgrade' && game.choices[1]) game.takeUpgrade(game.choices[1]);
    if (ev.code === 'Enter' && game.state === 'shop') game.closeShop();
  });
  window.addEventListener('keyup', ev => { if (ev.code === 'Space') ff = false; });

  /**
   * pause() only fires while state is 'playing', so a lock screen during an
   * upgrade or shop screen leaves the music unsuspended — and iOS parks the
   * AudioContext in 'interrupted' regardless. Nothing else would ever bring it
   * back in that case, since the pause screen's tap is what normally does it.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
    else if (game.state !== 'paused') Music.resume();
  });
})();
