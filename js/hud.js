'use strict';

/* ============================================================
   VISOR
   Every readout the player sees during a run, drawn on the canvas in one
   shared language so the HUD reads as a single projected display rather than
   a web page sitting on top of a game.

   The rules the whole thing obeys:
     · additive glow, never flat fills — the display is projected light
     · thin strokes (1–1.6px), brightness carries hierarchy instead of weight
     · raked geometry: circles are seen edge-on as ellipses, so the HUD sits
       in the same perspective as the threat ring
     · corner brackets frame anything holding a value
     · labels are Orbitron micro-caps, widely tracked, always dimmer than
       the number they describe
     · far/low = dim, near/live = bright

   Interactive controls (pause, audio) stay in the DOM — canvas buttons would
   mean hand-rolling hit-testing and focus for no visual gain.
   ============================================================ */
const Visor = {

  /* ---------------- shared primitives ---------------- */

  /** Orbitron micro-caps. Tracking is what makes them read as instrumentation. */
  micro(ctx, text, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.font = `700 ${o.size || 9}px Orbitron, sans-serif`;
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.globalAlpha = o.alpha === undefined ? 0.62 : o.alpha;
    ctx.fillStyle = o.color || C.cyan;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (o.track === undefined ? 0.2 : o.track) + 'em';
    ctx.fillText(text, x, y);
    ctx.restore();
  },

  /** Value text — brighter and heavier than its label, by rule. */
  value(ctx, text, x, y, o) {
    o = o || {};
    ctx.save();
    ctx.font = `${o.weight || 900} ${o.size || 22}px Orbitron, sans-serif`;
    ctx.textAlign = o.align || 'left';
    ctx.globalAlpha = o.alpha === undefined ? 0.95 : o.alpha;
    ctx.fillStyle = o.color || C.cyan;
    if ('letterSpacing' in ctx) ctx.letterSpacing = (o.track === undefined ? 0.04 : o.track) + 'em';
    ctx.fillText(text, x, y);
    ctx.restore();
  },

  /**
   * Corner brackets. The core motif — an open frame reads as a targeting
   * reticle where a closed box would read as a button.
   */
  bracket(ctx, x, y, w, h, o) {
    o = o || {};
    const arm = o.arm === undefined ? 6 : o.arm;
    ctx.save();
    ctx.globalAlpha = o.alpha === undefined ? 0.4 : o.alpha;
    ctx.strokeStyle = o.color || C.cyan;
    ctx.lineWidth = o.width || 1.2;
    ctx.beginPath();
    // tl, tr, bl, br
    ctx.moveTo(x, y + arm);           ctx.lineTo(x, y);          ctx.lineTo(x + arm, y);
    ctx.moveTo(x + w - arm, y);       ctx.lineTo(x + w, y);      ctx.lineTo(x + w, y + arm);
    ctx.moveTo(x, y + h - arm);       ctx.lineTo(x, y + h);      ctx.lineTo(x + arm, y + h);
    ctx.moveTo(x + w - arm, y + h);   ctx.lineTo(x + w, y + h);  ctx.lineTo(x + w, y + h - arm);
    ctx.stroke();
    ctx.restore();
  },

  /** A run of pips — the HUD's only counting device, used wherever a small
   *  discrete quantity beats a number. */
  pips(ctx, x, y, count, filled, o) {
    o = o || {};
    const gap = o.gap || 9, r = o.r || 2.4;
    for (let i = 0; i < count; i++) {
      const on = i < filled;
      ctx.globalAlpha = on ? 0.9 : 0.22;
      ctx.fillStyle = (o.lastColor && i === count - 1) ? o.lastColor : (o.color || C.cyan);
      ctx.beginPath();
      ctx.arc(x + i * gap, y, on ? r : r * 0.72, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },

  /* ---------------- composite ---------------- */

  draw(ctx, g) {
    if (g.state === 'start' || g.state === 'over') return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.threatRing(ctx, g);
    this.waveBlock(ctx, g);
    this.statPods(ctx, g);
    this.perkRail(ctx, g);
    this.integrityArc(ctx, g);
    ctx.restore();
  },

  /* ============================================================
     THREAT RING  (top centre)
     The full 360 degrees around the core raked over into perspective, the way
     a visor would project it. Every live hostile is a blip at its true
     bearing; the far arc sits high and dim, the near arc low and bright, so
     the ellipse reads as ground rather than as an oval. Clear the wave and
     the whole display folds shut into a skinny flat line.
     ============================================================ */
  threatRing(ctx, g) {
    const open = g.ringOpen;
    const narrow = g.w < 620;
    const cx = g.w * 0.5;
    const cy = narrow ? 104 : 88;
    const rx = Math.min(232, g.w * 0.33);
    const ry = 5 + 25 * open;

    const live = [];
    for (const e of g.enemies) if (!e.dead) live.push(e);
    const pending = g.spawnQueue.length;
    const total = live.length + pending;

    const arc = (from, to, alpha, width) => {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, from, to);
      ctx.stroke();
    };
    ctx.strokeStyle = C.cyan;
    arc(Math.PI, TAU, 0.20 + 0.10 * open, 1);
    arc(0, Math.PI, 0.42 + 0.22 * open, 1.4);
    ctx.globalAlpha = 0.06 + 0.05 * open;
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.stroke();

    // bearing ticks, cardinals longer
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * TAU;
      const card = i % 2 === 0;
      const len = (card ? 7 : 4) * open;
      const px = Math.cos(a) * rx, py = Math.sin(a) * ry;
      ctx.globalAlpha = (card ? 0.5 : 0.26) * (0.35 + 0.65 * open);
      ctx.lineWidth = card ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + px, cy + py);
      ctx.lineTo(cx + px + Math.cos(a) * len, cy + py + Math.sin(a) * 0.42 * len);
      ctx.stroke();
    }

    // blips, nearest-to-core first so the dangerous ones always draw
    const MAX_BLIPS = 44;
    if (live.length > 1) {
      live.sort((a, b) => dist2(g.cx, g.cy, a.x, a.y) - dist2(g.cx, g.cy, b.x, b.y));
    }
    const shown = Math.min(live.length, MAX_BLIPS);
    for (let i = 0; i < shown; i++) {
      const e = live[i];
      const bearing = Math.atan2(e.y - g.cy, e.x - g.cx);
      const px = cx + Math.cos(bearing) * rx;
      const py = cy + Math.sin(bearing) * ry;
      const depth = (Math.sin(bearing) + 1) * 0.5;
      const d = Math.hypot(e.x - g.cx, e.y - g.cy);
      const closeness = clamp(1 - d / (Math.max(g.w, g.h) * 0.55), 0, 1);

      let col = C.red;
      if (e.boss) col = C.pink;
      else if (e.dmgCap < Infinity) col = C.steel;
      else if (e.type === 'tank') col = C.purple;
      else if (e.type === 'swift') col = C.gold;
      else if (e.type === 'splitter' || e.type === 'shard') col = C.teal;

      const size = (e.boss ? 4.2 : 2.1) + depth * 1.5 + closeness * 1.6;
      ctx.fillStyle = col;
      ctx.globalAlpha = (0.10 + 0.20 * depth) * open;
      ctx.beginPath(); ctx.arc(px, py, size * 2.3, 0, TAU); ctx.fill();
      ctx.globalAlpha = (0.45 + 0.5 * depth) * open;
      ctx.beginPath(); ctx.arc(px, py, size, 0, TAU); ctx.fill();

      if (e.boss) {
        ctx.globalAlpha = 0.8 * open;
        ctx.strokeStyle = C.pink;
        ctx.lineWidth = 1.2;
        const s = size * 2.6;
        ctx.beginPath();
        for (const [ox, oy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          ctx.moveTo(px + ox * s, py + oy * s * 0.7);
          ctx.lineTo(px + ox * s * 0.45, py + oy * s * 0.7);
          ctx.moveTo(px + ox * s, py + oy * s * 0.7);
          ctx.lineTo(px + ox * s, py + oy * s * 0.25);
        }
        ctx.stroke();
      }
    }

    this.boresight(ctx, g, cx, cy, rx, ry, open);

    const overflow = live.length > MAX_BLIPS ? ` +${live.length - MAX_BLIPS}` : '';
    this.micro(ctx,
      total > 0 ? `${total} HOSTILE${total === 1 ? '' : 'S'}${overflow}` : 'SECTOR CLEAR',
      cx, cy + ry + 18,
      { size: 11, align: 'center', color: total > 0 ? '#ff8098' : C.teal, alpha: 0.5 + 0.45 * open });

    if (pending > 0) {
      this.micro(ctx, `${pending} INBOUND`, cx, cy + ry + 30,
        { size: 8, align: 'center', color: C.cyan, alpha: 0.32 * open });
    }
  },

  /* ============================================================
     BORESIGHT
     Where the gun is actually pointing, locked to game.turretAngle — the same
     bearing convention the blips use, so the marker sits directly on whichever
     contact the turret is currently servicing. Drawn over the blips because it
     is the one thing that should never be occluded.

     The trail behind it is real barrel history, so a fast slew smears and a
     settled lock reads as a tight point. With no target the turret idles at
     0.45 rad/s (game.js), which gives the display a slow scan for free.
     ============================================================ */
  boresight(ctx, g, cx, cy, rx, ry, open) {
    const trail = g.turretTrail;
    const vis = 0.35 + 0.65 * open;   // stays legible once the ring folds shut
    const flash = g.barrelFlash;

    // swing trail, oldest first and faintest
    for (let i = 0; i < trail.length - 1; i++) {
      const k = i / trail.length;
      const a = trail[i];
      ctx.globalAlpha = k * k * 0.4 * vis;
      ctx.fillStyle = C.white;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, 0.6 + k * 1.7, 0, TAU);
      ctx.fill();
    }

    const a = g.turretAngle;
    const px = cx + Math.cos(a) * rx;
    const py = cy + Math.sin(a) * ry;

    // halo, punched up on the shot
    ctx.globalAlpha = (0.16 + 0.5 * flash) * vis;
    ctx.fillStyle = C.white;
    ctx.beginPath(); ctx.arc(px, py, 5 + 5 * flash, 0, TAU); ctx.fill();

    // head
    ctx.globalAlpha = (0.85 + 0.15 * flash) * vis;
    ctx.beginPath(); ctx.arc(px, py, 2 + 1.2 * flash, 0, TAU); ctx.fill();

    // gunsight caret straddling the bearing, opening outward along the normal
    const nx = Math.cos(a), ny = Math.sin(a) * 0.42;
    const tan = a + Math.PI / 2;
    const tx = Math.cos(tan), ty = Math.sin(tan) * 0.42;
    const spanA = 5, spanB = 9 + 3 * flash;
    ctx.globalAlpha = (0.7 + 0.3 * flash) * vis;
    ctx.strokeStyle = C.white;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const s of [-1, 1]) {
      ctx.moveTo(px + tx * s * spanA, py + ty * s * spanA);
      ctx.lineTo(px + tx * s * spanB + nx * 5, py + ty * s * spanB + ny * 5);
    }
    ctx.stroke();
  },

  /* ============================================================
     WAVE BLOCK  (top left)
     Bracketed value plus a five-pip boss cycle, so the run's rhythm is
     readable at a glance instead of requiring mental arithmetic.
     ============================================================ */
  waveBlock(ctx, g) {
    const x = 18, y = 18;
    const w = 92, h = 46;

    this.bracket(ctx, x, y, w, h, { alpha: 0.34, arm: 8 });
    this.micro(ctx, 'WAVE', x + 10, y + 15, { size: 8, alpha: 0.5 });
    this.value(ctx, String(g.wave), x + 10, y + 39, { size: 24 });

    // boss cycle — fifth pip is the boss and is coloured as the threat it is
    const inCycle = ((g.wave - 1) % 5) + 1;
    this.pips(ctx, x + w - 40, y + 33, 5, inCycle, { lastColor: C.pink, gap: 8 });
  },

  /* ============================================================
     STAT PODS  (top left, under the wave block)
     Deliberately left-hand: the top right belongs to the DOM pause and audio
     controls, and overlapping canvas with real buttons is a hit-target bug
     waiting to happen.
     ============================================================ */
  statPods(ctx, g) {
    const x = 18;
    let y = 78;
    const pod = (icon, val, color) => {
      this.bracket(ctx, x, y, 92, 22, { alpha: 0.2, arm: 5, color });
      this.micro(ctx, icon, x + 8, y + 15, { size: 10, color, alpha: 0.85, track: 0 });
      this.value(ctx, fmt(val), x + 84, y + 15, { size: 12, align: 'right', color, weight: 700, alpha: 0.8 });
      y += 27;
    };
    pod('◈', g.cash, C.teal);
    pod('✷', g.kills, C.cyan);
  },

  /* ============================================================
     INTEGRITY ARC  (bottom centre)
     The threat ring's mirror: same raked circle, same tick language, bulging
     up from the bottom of the visor. Threats read across the top, your own
     integrity across the bottom. Depletion eats the arc from the right.
     ============================================================ */
  integrityArc(ctx, g) {
    const cx = g.w * 0.5;
    const cy = g.h - 46;   // clear of the bottom edge and any home indicator
    const rx = Math.min(300, g.w * 0.42);
    const ry = 40;
    const frac = clamp(g.hpShown, 0, 1);
    const low = frac < 0.3;
    const col = low ? C.red : C.teal;

    // the arc runs right-to-left across the top of the ellipse: PI -> TAU
    const A0 = Math.PI, A1 = TAU;

    // empty channel
    ctx.strokeStyle = C.cyan;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, A0, A1); ctx.stroke();

    // filled portion
    const end = A0 + (A1 - A0) * frac;
    const pulse = low ? 0.72 + 0.28 * Math.sin(g.rangePulse * 7) : 1;
    ctx.strokeStyle = col;
    ctx.globalAlpha = 0.14 * pulse;
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, A0, end); ctx.stroke();
    ctx.globalAlpha = 0.9 * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, A0, end); ctx.stroke();

    // head marker riding the fill
    if (frac > 0.001 && frac < 0.999) {
      const hx = cx + Math.cos(end) * rx, hy = cy + Math.sin(end) * ry;
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.28 * pulse;
      ctx.beginPath(); ctx.arc(hx, hy, 6, 0, TAU); ctx.fill();
      ctx.globalAlpha = pulse;
      ctx.beginPath(); ctx.arc(hx, hy, 2.4, 0, TAU); ctx.fill();
    }

    // decile ticks, outward along the ellipse normal
    for (let i = 0; i <= 10; i++) {
      const a = A0 + (A1 - A0) * (i / 10);
      const major = i % 5 === 0;
      const px = cx + Math.cos(a) * rx, py = cy + Math.sin(a) * ry;
      const len = major ? 10 : 5;
      ctx.globalAlpha = major ? 0.62 : 0.3;
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = major ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * 0.42 * len);
      ctx.stroke();
    }

    // seated in the bowl of the arc, where the raked ellipse leaves clear space
    this.micro(ctx, 'CORE INTEGRITY', cx, cy - 20, { size: 8, align: 'center', alpha: 0.45 });
    this.value(ctx, `${Math.ceil(Math.max(0, g.t.hp))} / ${Math.ceil(g.t.maxHp)}`,
      cx, cy - 2, { size: 15, align: 'center', color: col, alpha: 0.9 * pulse, weight: 700 });
  },

  /* ============================================================
     PERK RAIL  (above the integrity arc)
     Bracketed chips, centred, wrapping upward so a long build grows away
     from the arc instead of colliding with it.
     ============================================================ */
  perkRail(ctx, g) {
    const entries = Object.entries(g.perkLevels).filter(([, v]) => v > 0);
    if (!entries.length) return;

    const cw = 40, ch = 20, gap = 5;
    const perRow = Math.max(1, Math.floor((Math.min(600, g.w - 40) + gap) / (cw + gap)));
    const rows = Math.ceil(entries.length / perRow);
    const baseY = g.h - 112 - (rows - 1) * (ch + gap);

    entries.forEach((entry, i) => {
      const [id, lv] = entry;
      const u = UPGRADE_BY_ID[id];
      if (!u) return;
      const row = Math.floor(i / perRow);
      const inRow = Math.min(perRow, entries.length - row * perRow);
      const rowW = inRow * cw + (inRow - 1) * gap;
      const col = i % perRow;
      const x = g.w * 0.5 - rowW * 0.5 + col * (cw + gap);
      const y = baseY + row * (ch + gap);

      this.bracket(ctx, x, y, cw, ch, { alpha: 0.26, arm: 4, color: u.color, width: 1 });
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(u.icon, x + 5, y + 14);
      ctx.restore();
      this.value(ctx, String(lv), x + cw - 6, y + 14,
        { size: 10, align: 'right', color: u.color, weight: 700, alpha: 0.85 });
    });
  },
};
