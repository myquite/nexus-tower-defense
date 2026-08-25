'use strict';

/**
 * Fake a neon glow with two strokes instead of ctx.shadowBlur.
 * shadowBlur is by far the most expensive thing you can do per-draw in canvas;
 * under 'lighter' compositing a wide translucent pass reads the same and costs
 * a fraction as much. `path` is a callback that lays down the geometry.
 */
function neonStroke(ctx, path, color, width, glowMul, alpha) {
  ctx.globalAlpha = (alpha === undefined ? 1 : alpha) * 0.34;
  ctx.strokeStyle = color;
  ctx.lineWidth = width * (glowMul || 3);
  ctx.beginPath(); path(ctx); ctx.stroke();

  ctx.globalAlpha = (alpha === undefined ? 1 : alpha);
  ctx.lineWidth = width;
  ctx.beginPath(); path(ctx); ctx.stroke();
  ctx.globalAlpha = 1;
}

/* ============================================================
   ENEMY
   ============================================================ */
class Enemy {
  constructor(typeKey, x, y, scale, sizeMul) {
    const def = ENEMIES[typeKey];
    this.type = typeKey;
    this.def = def;
    this.x = x; this.y = y;
    this.sizeMul = sizeMul || 1;
    this.size = def.size * this.sizeMul;
    this.maxHp = def.hp * scale.hp * (this.sizeMul < 1 ? 0.45 : 1);
    this.hp = this.maxHp;
    this.speed = def.speed * scale.speed;
    this.dmg = def.dmg * scale.dmg * (this.sizeMul < 1 ? 0.5 : 1);
    this.cash = def.cash * scale.cash * (this.sizeMul < 1 ? 0.4 : 1);
    this.color = def.color;
    this.form = def.form;
    this.dir = !!def.dir;
    this.heading = 0;      // bearing toward the core, for directional forms
    this.boss = !!def.boss;
    // Derived from maxHp, so the cap rides the wave HP curve automatically and
    // hits-to-kill stays put (~1/capFrac) however far the run scales.
    this.dmgCap = def.capFrac ? this.maxHp * def.capFrac : Infinity;
    this.angle = rand(TAU);
    // The splitter and its pieces share a deliberate, readable rotation — the
    // shards are meant to look like the parent came apart, not like unrelated
    // debris, so killEnemy hands them the parent's exact spin.
    this.spin = (def.form === 'triangle' || def.form === 'kite')
      ? rand(1.1, 1.9) * (Math.random() < 0.5 ? -1 : 1)
      : rand(-1.6, 1.6);
    this.flash = 0;
    this.slowT = 0;
    // Eased rather than boolean: an enemy on the edge of the field would
    // otherwise strobe between frosted and clear as it drifts across the
    // boundary, which reads as a rendering fault rather than as cold.
    this.frost = 0;
    this.frostT = 0;   // own clock, so facets glitter on their own schedule
    this.knockX = 0; this.knockY = 0;
    // Set only by Game.syncShield, for something the barrier came up around.
    // Never derived from position at contact time: the block clamps an enemy
    // to exactly the wall, and re-deriving "was it outside?" from that
    // position the next frame is a coin-flip on the last bit of a float — lose
    // it once and that enemy is exempt from the wall for the rest of its life.
    this.pastShield = false;
    this.dead = false;
    this.scaleRef = scale;
  }

  hurt(amount, g, crit, src) {
    // Armour clamps the hit rather than scaling it down, so overkill damage is
    // simply discarded. Always surface a capped hit — a silently shrunk number
    // reads as a bug, a steel one reads as armour.
    // Breaching Rounds lifts the ceiling rather than removing it, so armour
    // still matters — it just stops being an absolute wall for a damage build.
    /**
     * Brittle. Applied BEFORE the armour clamp deliberately, which means a
     * bulwark still bounds the result: against armour this buys damage only up
     * to the cap and cannot punch past it. Applying it after would let it
     * bypass armour entirely and quietly make Breaching Rounds pointless —
     * armour is supposed to be answered by penetration, not by a debuff.
     *
     * Keyed off slowT as well as the field, so a hit lands as brittle whenever
     * the target is actually slowed, whatever slowed it.
     */
    if (g.t.brittle > 0 && this.isSlowed(g)) amount *= 1 + g.t.brittle;

    const cap = this.dmgCap * (1 + (g.t.capPierce || 0));
    let capped = false;
    if (amount > cap) { Stats.absorbed += amount - cap; amount = cap; capped = true; }
    // Every weapon funnels through here, so this is the one place attribution
    // can be recorded — hence the src every caller now carries.
    Stats.hit(src, amount, this.hp);
    const hpBefore = this.hp;
    this.hp -= amount;
    this.flash = 1;
    g.spawnDamageText(this.x, this.y - this.size, amount, crit && !capped, capped);
    /**
     * Fission Rounds. Targeting Optics stops at MAX_CRIT_CHANCE, so past that
     * ceiling the only way left to make a crit worth more is to make it hit
     * more things. The blast is a fraction of the crit itself, which keeps it
     * riding every damage multiplier for free.
     *
     * areaDamage always passes crit = false, so a blast can never set off
     * another blast — the recursion ends at depth one by construction, with no
     * depth counter needed. It can still KILL, and a kill re-enters killEnemy,
     * but Detonation's own _detDepth guard already bounds that chain.
     */
    if (crit && g.t.critBlast > 0 && !this.dead) {
      g.areaDamage(this.x, this.y, BLAST_FISSION * g.t.blastMult,
        amount * g.t.critBlast, C.orange, 0, SRC.FISSION);
    }
    if (this.hp <= 0 && !this.dead) {
      // Measured before killEnemy: splits and detonations mutate the field,
      // and the excess belongs to the blow that was actually struck here.
      const spare = g.t.carry > 0 ? (amount - hpBefore) * g.t.carry : 0;
      g.killEnemy(this);
      if (spare > 0) g.carryOver(this, spare, src);
    }
  }

  /** Inside the cryo field, or slowed by anything else that sets slowT. */
  isSlowed(g) {
    if (this.slowT > 0) return true;
    return g.t.slowPct > 0 && dist2(this.x, this.y, g.cx, g.cy) < g.t.range * g.t.range;
  }

  knockback(fromX, fromY, force) {
    const d = dist(fromX, fromY, this.x, this.y) || 1;
    this.knockX += ((this.x - fromX) / d) * force;
    this.knockY += ((this.y - fromY) / d) * force;
  }

  update(dt, g) {
    this.flash = Math.max(0, this.flash - dt * 5);
    this.angle += this.spin * dt;

    const dx = g.cx - this.x, dy = g.cy - this.y;
    const d = Math.hypot(dx, dy) || 1;

    let spd = this.speed;
    // cryo field
    if (g.t.slowPct > 0 && d < g.t.range) spd *= (1 - g.t.slowPct);
    if (this.slowT > 0) { this.slowT -= dt; spd *= 0.45; }

    // Rime builds and thaws instead of switching. The target is the slow's own
    // strength, so a shallow field frosts lightly and a deep one glazes over —
    // the effect is legible at a glance without a number anywhere near it.
    const want = this.isSlowed(g) ? clamp(0.35 + g.t.slowPct, 0, 1) : 0;
    this.frost += (want - this.frost) * (1 - Math.pow(0.02, dt));
    if (this.frost > 0.02) this.frostT += dt;

    this.heading = Math.atan2(dy, dx);
    this.x += (dx / d) * spd * dt + this.knockX * dt;
    this.y += (dy / d) * spd * dt + this.knockY * dt;

    // knockback decay
    this.knockX *= Math.pow(0.02, dt);
    this.knockY *= Math.pow(0.02, dt);

    /**
     * The barrier ring. This is a hard positional stop, not a damage trade:
     * anything that did not start inside is put back on the outside every
     * frame it tries to cross, so nothing can be within the shield while the
     * shield is up — not a boss, not a shard, however fast it arrived.
     */
    if (g.shieldUp() && !this.pastShield) {
      const stop = g.shieldRing() + this.size * 0.5;
      const nd = Math.hypot(g.cx - this.x, g.cy - this.y) || 1;
      if (nd < stop) {
        this.x = g.cx + ((this.x - g.cx) / nd) * stop;
        this.y = g.cy + ((this.y - g.cy) / nd) * stop;
        this.shieldCd = (this.shieldCd || 0) - dt;
        if (this.shieldCd <= 0) {
          this.shieldCd = SHIELD_HIT_CD;
          g.drainShield(this.dmg, this.x, this.y);
          // Arc Barrier. Burn first, then knock back: hurt can kill, and
          // killEnemy may split this into shards that would otherwise be
          // handed a knockback belonging to a corpse.
          if (g.t.shieldDmg > 0) {
            this.hurt(g.t.shieldDmg, g, false, SRC.BARRIER);
            if (this.dead || this.hp <= 0) return;
          }
          this.knockback(g.cx, g.cy, SHIELD_KNOCK);
        }
        return;   // never falls through to the core contact below
      }
      this.shieldCd = Math.max(0, (this.shieldCd || 0) - dt);
    }

    // reached the core
    if (d < g.towerRadius + this.size * 0.5) {
      /**
       * Reactive plating burns the attacker as it closes. This has to resolve
       * BEFORE the detonation: the contact below sets dead = true whatever
       * happens, so subtracting hp afterwards only edits an object that is
       * discarded on the same frame — which is exactly what it used to do,
       * making the whole upgrade a no-op. Burn it down first and the hit never
       * lands, which is what "burn attackers on contact" should buy you.
       */
      if (g.t.thorns > 0) {
        // Reports itself, because it is the one damage source that never
        // reaches hurt() — see above for why it cannot be made to.
        Stats.hit(SRC.THORNS, g.t.thorns, this.hp);
        this.hp -= g.t.thorns;
        if (this.hp <= 0) { g.killEnemy(this); return; }   // stopped short of the core
      }
      g.damageTower(this.dmg, this);
      g.burst(this.x, this.y, this.color, this.boss ? 26 : 12, 1.4);
      g.shake(this.boss ? 16 : 7);
      this.dead = true;   // detonates on the core — no kill credit
    }
  }

  /** Regular polygon path, the shared building block of the heavy forms. */
  static poly(c, n, rad, rot) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + (rot || 0);
      const px = Math.cos(a) * rad, py = Math.sin(a) * rad;
      i ? c.lineTo(px, py) : c.moveTo(px, py);
    }
    c.closePath();
  }

  /**
   * Built on the same rules as the core: layered vector neon, and every layer
   * that moves means something. Wear shows on the hull rather than on a bar —
   * a worn unit dims and thins, so you can read a swarm's remaining health from
   * its brightness alone.
   *
   * Detail is tiered by population. Chevron and dart are one stroke each,
   * exactly what the old squares cost, because late waves put 150+ of them on
   * screen. Only the rare heavies get the full treatment.
   */
  draw(ctx) {
    const s = this.size;
    const hurt = this.flash > 0;
    const col = hurt ? '#ffffff' : this.color;
    const frac = clamp(this.hp / this.maxHp, 0, 1);
    // damage reads as the hull going thin and dim
    const vigor = 0.42 + 0.58 * frac;
    const lw = (this.sizeMul < 1 ? 1.5 : 2.2) * (0.7 + 0.3 * frac);
    const glow = hurt ? 4.5 : 3;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.dir ? this.heading : this.angle);

    /**
     * Rime. Drawn UNDER the hull and in the hull's own rotation, so it reads
     * as ice forming on this ship rather than as a marker floating near it —
     * and so the silhouette that tells you what the thing IS survives being
     * frozen. Type colour is never replaced for the same reason: a frosted
     * tank still has to read as a tank.
     *
     * One path, one neonStroke. This runs for every slowed enemy on screen and
     * late waves have well over a hundred, so it gets two strokes, not eight.
     */
    if (this.frost > 0.03) {
      const f = this.frost;
      const arms = 6;
      // Drifts on its own clock rather than riding the hull's rotation, so the
      // ice is something sitting ON the ship rather than part of it.
      const spin = this.frostT * 0.55;
      neonStroke(ctx, c => {
        for (let i = 0; i < arms; i++) {
          /**
           * Each facet breathes on its own phase and vanishes entirely at its
           * minimum, so the rime forms and melts in place instead of rotating
           * as one rigid piece. The per-ship offset comes off spin, which is
           * already random per enemy — otherwise a wave that arrived together
           * would twinkle in unison and read as one blinking object.
           */
          const k = 0.5 + 0.5 * Math.sin(this.frostT * 2.6 + i * 2.4 + this.spin * 3);
          const g0 = f * k;
          if (g0 < 0.14) continue;
          const a = (i / arms) * TAU + spin;
          const rr = s * (1.1 + 0.07 * g0);
          c.arc(0, 0, rr, a - 0.15 * g0, a + 0.15 * g0);
          const r1 = rr + s * 0.26 * g0;
          c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        }
      }, C.cyan, 0.75 + 0.5 * f, 2.4, 0.09 + 0.24 * f);
    }

    switch (this.form) {

      /* ---- chevron: the grunt. Points where it is going, so a wave reads
              as a formation driving inward rather than tumbling debris. ---- */
      case 'chevron':
        neonStroke(ctx, c => {
          c.moveTo(s, 0);
          c.lineTo(-s * 0.55, -s * 0.78);
          c.lineTo(-s * 0.18, 0);
          c.lineTo(-s * 0.55, s * 0.78);
          c.closePath();
        }, col, lw, glow, vigor);
        break;

      /* ---- dart: swift and shard. Stretched along travel — the silhouette
              itself says "fast" before the motion does. ---- */
      case 'dart':
        neonStroke(ctx, c => {
          c.moveTo(s * 1.5, 0);
          c.lineTo(-s * 0.45, -s * 0.62);
          c.lineTo(-s * 0.1, 0);
          c.lineTo(-s * 0.45, s * 0.62);
          c.closePath();
        }, col, lw, glow, vigor);
        break;

      /* ---- kite: the shard. This is literally one of the three pieces the
              triangle divides into — the quadrilateral bounded by one vertex,
              the two adjacent side midpoints, and the centroid. Push three of
              them back together and you get the parent back.

              Local coords are that piece, recentred on its own centroid so it
              spins about itself: apex at -0.625, shoulders at +/-0.433, tail at
              +0.375 (all x size). ---- */
      case 'kite':
        neonStroke(ctx, c => {
          c.moveTo(0, -s * 0.625);
          c.lineTo(s * 0.433, s * 0.125);
          c.lineTo(0, s * 0.375);
          c.lineTo(-s * 0.433, s * 0.125);
          c.closePath();
        }, col, lw, glow, vigor);
        break;

      /* ---- triangle: the splitter. Carries its own fracture lines — the
              three cuts from centroid to side midpoints — so the break is
              telegraphed by the geometry that actually performs it, rather
              than by a decoration that merely hints at it. ---- */
      case 'triangle': {
        const tri = c => Enemy.poly(c, 3, s, -Math.PI / 2);
        ctx.globalAlpha = 0.1 * frac;
        ctx.fillStyle = this.color;
        ctx.beginPath(); tri(ctx); ctx.fill();
        ctx.globalAlpha = 1;
        neonStroke(ctx, tri, col, lw + 0.4, glow, vigor);
        // fracture lines: centroid out to each side midpoint
        neonStroke(ctx, c => {
          for (let i = 0; i < 3; i++) {
            const a0 = -Math.PI / 2 + (i / 3) * TAU;
            const a1 = -Math.PI / 2 + ((i + 1) / 3) * TAU;
            const mx = (Math.cos(a0) + Math.cos(a1)) * 0.5 * s;
            const my = (Math.sin(a0) + Math.sin(a1)) * 0.5 * s;
            c.moveTo(0, 0); c.lineTo(mx, my);
          }
        }, col, 1, 2.2, vigor * 0.45);
        break;
      }

      /* ---- block: the tank. Heavy hex hull, filled, with a lateral brace. ---- */
      case 'block': {
        const hull = c => Enemy.poly(c, 6, s, 0);
        ctx.globalAlpha = 0.14 * frac;
        ctx.fillStyle = this.color;
        ctx.beginPath(); hull(ctx); ctx.fill();
        ctx.globalAlpha = 1;
        neonStroke(ctx, hull, col, lw + 0.8, glow, vigor);
        neonStroke(ctx, c => {
          c.moveTo(-s * 0.5, 0); c.lineTo(s * 0.5, 0);
        }, col, lw * 0.7, 2.4, vigor * 0.7);
        break;
      }

      /* ---- fortress: the bulwark. Segmented plate ring outside the hull,
              the same language the core uses for its own integrity. ---- */
      case 'fortress': {
        const hull = c => Enemy.poly(c, 6, s, 0);
        ctx.globalAlpha = 0.13 * frac;
        ctx.fillStyle = this.color;
        ctx.beginPath(); hull(ctx); ctx.fill();
        ctx.globalAlpha = 1;
        neonStroke(ctx, hull, col, lw + 0.6, glow, vigor);
        neonStroke(ctx, c => Enemy.poly(c, 6, s * 0.55, Math.PI / 6), col, 1.2, 2.4, vigor * 0.8);
        // plates, thinning out as the armour is worn down
        neonStroke(ctx, c => {
          for (let i = 0; i < 6; i++) {
            const a0 = (i / 6) * TAU + 0.16, a1 = ((i + 1) / 6) * TAU - 0.16;
            c.moveTo(Math.cos(a0) * s * 1.22, Math.sin(a0) * s * 1.22);
            c.arc(0, 0, s * 1.22, a0, a1);
          }
        }, col, 1.6, 2.6, vigor * 0.7);
        break;
      }

      /* ---- monolith: the boss. Counter-rotating rings and a hot core, so it
              reads as machinery rather than a big shape. ---- */
      case 'monolith': {
        const hull = c => Enemy.poly(c, 6, s, 0);
        ctx.globalAlpha = 0.15 * frac;
        ctx.fillStyle = this.color;
        ctx.beginPath(); hull(ctx); ctx.fill();
        ctx.globalAlpha = 1;
        neonStroke(ctx, hull, col, 3.4, glow, vigor);
        // vertex ticks, the core's own mark
        neonStroke(ctx, c => {
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU;
            c.moveTo(Math.cos(a) * s * 1.1, Math.sin(a) * s * 1.1);
            c.lineTo(Math.cos(a) * s * 1.26, Math.sin(a) * s * 1.26);
          }
        }, col, 1.8, 2.6, vigor * 0.75);
        neonStroke(ctx, c => Enemy.poly(c, 6, s * 0.66, -this.angle * 2.4), col, 1.8, 2.6, 0.6);
        neonStroke(ctx, c => Enemy.poly(c, 3, s * 0.36, this.angle * 3.1), '#ffffff', 1.6, 3, 0.75);
        break;
      }
    }

    ctx.restore();

    // Boss integrity, in the visor's language: bracketed, segmented, micro-cap.
    if (this.boss) {
      const w = 84, h = 4, y = this.y - s - 22;
      const x0 = this.x - w / 2;
      ctx.save();
      neonStroke(ctx, c => { c.moveTo(x0, y + h / 2); c.lineTo(x0 + w, y + h / 2); },
        C.pink, 1, 2, 0.18);
      neonStroke(ctx, c => {
        c.moveTo(x0, y + h / 2); c.lineTo(x0 + w * frac, y + h / 2);
      }, frac < 0.3 ? '#ffffff' : C.pink, h, 2.6, 0.9);
      // tick every 25%
      neonStroke(ctx, c => {
        for (let i = 1; i < 4; i++) {
          const px = x0 + (w * i) / 4;
          c.moveTo(px, y - 2); c.lineTo(px, y + h + 2);
        }
      }, C.pink, 1, 2, 0.35);
      ctx.restore();
    }
  }
}

/* ============================================================
   BULLET
   ============================================================ */
class Bullet {
  constructor(x, y, angle, speed, dmg, pierce, crit, bounces) {
    this.x = x; this.y = y;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.dmg = dmg;
    this.pierce = pierce;
    this.crit = crit;
    this.bounces = bounces || 0;
    this.life = 2.2;
    this.hit = new Set();
    this.scored = false;   // has this round touched anything yet — accuracy, not hit count
    this.dead = false;
    this.px = x; this.py = y;
  }

  update(dt, g) {
    this.px = this.x; this.py = this.y;
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    if (this.life <= 0) { this.dead = true; return; }

    for (const e of g.enemies) {
      if (e.dead || this.hit.has(e)) continue;
      const r = e.size * 0.62 + 4;
      if (dist2(this.x, this.y, e.x, e.y) < r * r) {
        this.hit.add(e);
        // Pierce and ricochet mean one round can land many hits, so accuracy
        // counts rounds that connected at all, not impacts.
        if (!this.scored) { this.scored = true; Stats.connected++; }
        e.hurt(this.dmg, g, this.crit, SRC.GUN);
        g.burst(this.x, this.y, this.crit ? C.gold : C.cyan, this.crit ? 7 : 3, 0.6);

        // Ricochet is checked before the pierce budget, so a bounce keeps the
        // round alive even once it has spent its pass-throughs.
        if (this.bounces > 0) {
          let best = null, bd = 300 * 300;
          for (const o of g.enemies) {
            if (o.dead || this.hit.has(o)) continue;
            const d2 = dist2(this.x, this.y, o.x, o.y);
            if (d2 < bd) { bd = d2; best = o; }
          }
          if (best) {
            const a = Math.atan2(best.y - this.y, best.x - this.x);
            const sp = Math.hypot(this.vx, this.vy);
            this.vx = Math.cos(a) * sp;
            this.vy = Math.sin(a) * sp;
            this.bounces--;
            this.life = Math.max(this.life, 0.7);
            g.spark(this.x, this.y, C.cyan, 0.2);
            return;   // one redirect per frame, or it would chain instantly
          }
        }

        if (this.hit.size > this.pierce) { this.dead = true; return; }
      }
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    const px = this.px, py = this.py, x = this.x, y = this.y;
    neonStroke(ctx, c => { c.moveTo(px, py); c.lineTo(x, y); },
      this.crit ? C.gold : '#ffe9a8', this.crit ? 4 : 2.6, 3.2);
    ctx.restore();
  }
}

/* ============================================================
   HOMING MISSILE
   ============================================================ */
class Missile {
  constructor(x, y, angle, dmg, radius) {
    this.x = x; this.y = y;
    this.angle = angle;
    this.speed = 170;
    this.dmg = dmg;
    this.radius = radius;
    this.life = 5;
    this.target = null;
    this.dead = false;
    this.trail = [];
  }

  update(dt, g) {
    this.life -= dt;
    if (this.life <= 0) { this.explode(g); return; }

    this.speed = Math.min(560, this.speed + 620 * dt);

    if (!this.target || this.target.dead) this.target = g.nearestEnemy(this.x, this.y, Infinity, true);
    if (this.target) {
      const want = Math.atan2(this.target.y - this.y, this.target.x - this.x);
      this.angle = turnToward(this.angle, want, 6.5 * dt);
    }

    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    this.trail.push(this.x, this.y);
    if (this.trail.length > 14) this.trail.splice(0, 2);

    if (this.target && dist2(this.x, this.y, this.target.x, this.target.y) < Math.pow(this.target.size * 0.6 + 8, 2)) {
      this.explode(g);
    }
  }

  explode(g) {
    if (this.dead) return;
    this.dead = true;
    g.areaDamage(this.x, this.y, this.radius, this.dmg, C.orange, 0, SRC.MISSILE);
    g.burst(this.x, this.y, C.orange, 16, 1.6);
    g.rings.push(new Ring(this.x, this.y, this.radius, C.orange, 0.32));
  }

  draw(ctx) {
    const tr = this.trail;
    ctx.save();
    ctx.lineCap = 'round';
    neonStroke(ctx, c => {
      for (let i = 0; i < tr.length; i += 2) {
        i ? c.lineTo(tr[i], tr[i + 1]) : c.moveTo(tr[i], tr[i + 1]);
      }
    }, C.orange, 2, 3, 0.75);

    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.fillStyle = C.orange;
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffd9a0';
    ctx.beginPath();
    ctx.moveTo(8, 0); ctx.lineTo(-5, 3.5); ctx.lineTo(-5, -3.5);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  }
}

/* ============================================================
   METEOR
   ============================================================ */
class Meteor {
  constructor(tx, ty, dmg, radius) {
    this.tx = tx; this.ty = ty;
    this.dmg = dmg; this.radius = radius;
    const a = rand(-2.4, -0.8);
    const d = 760;
    this.x = tx + Math.cos(a) * d;
    this.y = ty + Math.sin(a) * d;
    this.sx = this.x; this.sy = this.y;
    this.t = 0;
    this.dur = 0.75;
    this.dead = false;
  }

  update(dt, g) {
    this.t += dt;
    const k = clamp(this.t / this.dur, 0, 1);
    this.x = lerp(this.sx, this.tx, k);
    this.y = lerp(this.sy, this.ty, k);
    if (Math.random() < 0.7) g.spark(this.x, this.y, C.orange, 0.4);
    if (k >= 1) {
      this.dead = true;
      g.areaDamage(this.tx, this.ty, this.radius, this.dmg, C.orange, 140, SRC.METEOR);
      g.burst(this.tx, this.ty, C.orange, 34, 2.4);
      g.rings.push(new Ring(this.tx, this.ty, this.radius, C.gold, 0.45));
      g.shake(9);
    }
  }

  draw(ctx) {
    // target marker
    const k = clamp(this.t / this.dur, 0, 1);
    const r = this.radius * (1 - k * 0.25);
    const tx = this.tx, ty = this.ty;
    ctx.save();
    ctx.lineCap = 'round';
    neonStroke(ctx, c => c.arc(tx, ty, r, 0, TAU), C.orange, 2, 3,
      0.35 + 0.35 * Math.sin(this.t * 26));

    const ang = Math.atan2(this.ty - this.sy, this.tx - this.sx);
    const bx = this.x - Math.cos(ang) * 46, by = this.y - Math.sin(ang) * 46;
    const x = this.x, y = this.y;
    neonStroke(ctx, c => { c.moveTo(bx, by); c.lineTo(x, y); }, '#ffbe6e', 5, 2.6, 0.8);

    ctx.fillStyle = C.orange; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(x, y, 18, 0, TAU); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#fff3d6';
    ctx.beginPath(); ctx.arc(x, y, 8, 0, TAU); ctx.fill();
    ctx.restore();
  }
}

/* ============================================================
   LIGHTNING BOLT (visual only — damage applied on creation)
   ============================================================ */
class Bolt {
  constructor(points, color) {
    this.pts = points;
    this.color = color || C.purple;
    this.life = 0.26;
    this.max = 0.26;
    this.dead = false;
    this.jitter = points.map(() => rand(-9, 9));
  }
  update(dt) { this.life -= dt; if (this.life <= 0) this.dead = true; }
  draw(ctx) {
    const a = this.life / this.max;
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    for (let pass = 0; pass < 3; pass++) {
      ctx.globalAlpha = a * (pass === 0 ? 0.3 : 1);
      ctx.strokeStyle = pass === 2 ? '#ffffff' : this.color;
      ctx.lineWidth = pass === 0 ? 16 : (pass === 1 ? 6 : 2);
      ctx.beginPath();
      for (let i = 0; i < this.pts.length; i++) {
        const p = this.pts[i];
        if (i === 0) { ctx.moveTo(p.x, p.y); continue; }
        const prev = this.pts[i - 1];
        // jagged midpoint
        const mx = (prev.x + p.x) / 2 + this.jitter[i];
        const my = (prev.y + p.y) / 2 - this.jitter[i];
        ctx.lineTo(mx, my);
        ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
}

/* ============================================================
   EXPANDING RING (nova / explosion visual)
   ============================================================ */
class Ring {
  constructor(x, y, radius, color, dur) {
    this.x = x; this.y = y;
    this.r = radius;
    this.color = color;
    this.t = 0;
    this.dur = dur || 0.4;
    this.dead = false;
  }
  update(dt) { this.t += dt; if (this.t >= this.dur) this.dead = true; }
  draw(ctx) {
    const k = this.t / this.dur;
    const rr = this.r * (0.25 + k * 0.85);
    const x = this.x, y = this.y;
    ctx.save();
    neonStroke(ctx, c => c.arc(x, y, rr, 0, TAU), this.color, 5 * (1 - k) + 1, 3.5, (1 - k) * 0.9);
    ctx.restore();
  }
}

/* ============================================================
   PARTICLE
   ============================================================ */
class Particle {
  init(x, y, vx, vy, life, size, color) {
    this.x = x; this.y = y; this.vx = vx; this.vy = vy;
    this.life = life; this.max = life; this.size = size; this.color = color;
    this.dead = false;
    return this;
  }
  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= Math.pow(0.12, dt);
    this.vy *= Math.pow(0.12, dt);
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const a = this.life / this.max;
    ctx.fillStyle = this.color;
    // soft halo + hot core, both additive — no shadowBlur
    ctx.globalAlpha = a * 0.28;
    const g = this.size * 2.2;
    ctx.fillRect(this.x - g / 2, this.y - g / 2, g, g);
    ctx.globalAlpha = a;
    ctx.fillRect(this.x - this.size / 2, this.y - this.size / 2, this.size, this.size);
    ctx.globalAlpha = 1;
  }
}

/* ============================================================
   FLOATING DAMAGE TEXT
   ============================================================ */
class FloatText {
  init(x, y, text, color, big) {
    this.x = x + rand(-8, 8); this.y = y;
    this.text = text; this.color = color;
    this.life = big ? 0.95 : 0.6; this.max = this.life;
    this.big = big;
    this.vy = big ? -58 : -42;
    this.dead = false;
    return this;
  }
  update(dt) {
    this.y += this.vy * dt;
    this.vy *= Math.pow(0.35, dt);
    this.life -= dt;
    if (this.life <= 0) this.dead = true;
  }
  draw(ctx) {
    const a = clamp(this.life / this.max * 1.6, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `700 ${this.big ? 20 : 14}px Orbitron, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = this.color;
    ctx.shadowBlur = 10; ctx.shadowColor = this.color;
    ctx.fillText(this.text, this.x, this.y);
    ctx.restore();
  }
}

/* ============================================================
   AMBIENT BACKGROUND DRIFTERS
   ============================================================ */
class Drifter {
  constructor(w, h) { this.reset(w, h, true); }
  reset(w, h, initial) {
    this.x = rand(-40, w + 40);
    this.y = initial ? rand(-40, h + 40) : h + 40;
    this.s = rand(6, 26);
    this.vy = -rand(6, 22);
    this.vx = rand(-6, 6);
    this.a = rand(0.04, 0.12);
    this.rot = rand(TAU);
    this.spin = rand(-0.4, 0.4);
    this.color = pick([C.red, C.gold, C.purple, C.teal, C.cyan]);
  }
  update(dt, w, h) {
    this.x += this.vx * dt; this.y += this.vy * dt; this.rot += this.spin * dt;
    if (this.y < -60) this.reset(w, h, false);
  }
  draw(ctx) {
    ctx.save();
    ctx.globalAlpha = this.a;
    ctx.translate(this.x, this.y);
    ctx.rotate(this.rot);
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(-this.s / 2, -this.s / 2, this.s, this.s);
    ctx.restore();
  }
}
