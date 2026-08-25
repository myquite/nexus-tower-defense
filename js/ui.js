'use strict';

const $ = id => document.getElementById(id);

const UI = {
  el: {},

  init() {
    const ids = ['hud', 'waveNum', 'statCash', 'statKills', 'enemiesLeft', 'hpFill', 'hpText',
      'perkTray', 'waveBanner', 'upgradeScreen', 'upTitle', 'cards', 'rerollBtn', 'rerollCount',
      'startScreen', 'startBtn', 'overScreen', 'ovWave', 'ovKills', 'ovCash', 'ovBest', 'retryBtn',
      'pauseScreen', 'pauseBtn', 'resumeBtn', 'quitBtn',
      'shopScreen', 'shopWallet', 'shopList', 'shopNextBtn',
      'audioCtl', 'audioBtn', 'audioPop', 'muteBtn', 'volSlider', 'volValue', 'audioNote'];
    ids.forEach(i => this.el[i] = $(i));
    this._bannerTimer = 0;
    this.initAudioControl();
  },

  /* ---------------- Audio control ---------------- */
  initAudioControl() {
    const e = this.el;

    e.audioBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      e.audioPop.classList.toggle('hidden');
      this.syncAudio();
    });

    e.muteBtn.addEventListener('click', ev => {
      ev.stopPropagation();
      Music.toggleMute();
    });

    e.volSlider.addEventListener('input', () => {
      Music.setVolume(e.volSlider.value / 100);
    });

    // keep clicks inside the popover from closing it or reaching the game
    e.audioPop.addEventListener('click', ev => ev.stopPropagation());

    // click anywhere else closes the popover
    document.addEventListener('click', () => {
      if (!e.audioPop.classList.contains('hidden')) {
        e.audioPop.classList.add('hidden');
        this.syncAudio();
      }
    });
  },

  syncAudio() {
    const e = this.el;
    const pct = Math.round(Music.volume * 100);

    e.audioBtn.textContent = Music.icon();
    e.muteBtn.textContent = Music.muted ? '\u2715' : '\u266a';
    e.muteBtn.title = Music.muted ? 'Unmute' : 'Mute';
    e.volValue.textContent = Music.muted ? '—' : pct;

    if (e.volSlider.value != pct) e.volSlider.value = pct;
    e.volSlider.style.setProperty('--pct', (Music.muted ? 0 : pct) + '%');

    e.audioCtl.classList.toggle('off', Music.muted || Music.available === false);

    // be honest when there's nothing to play
    const missing = Music.available === false;
    e.audioBtn.title = missing ? 'No music track loaded — add a file to /music' : 'Music volume';
    e.audioNote.classList.toggle('hidden', !missing || e.audioPop.classList.contains('hidden'));
    e.volSlider.disabled = missing;
    e.muteBtn.disabled = missing;
  },

  show(el) { el.classList.remove('hidden'); },
  hide(el) { el.classList.add('hidden'); },

  /* ---------------- HUD ---------------- */
  syncHud(g) {
    const e = this.el;
    e.waveNum.textContent = g.wave;
    e.statCash.textContent = fmt(g.cash);
    e.statKills.textContent = fmt(g.kills);

    const remaining = g.enemies.length + g.spawnQueue.length;
    e.enemiesLeft.textContent = remaining;

    const pct = clamp(g.t.hp / g.t.maxHp, 0, 1);
    e.hpFill.style.width = (pct * 100).toFixed(1) + '%';
    e.hpFill.classList.toggle('low', pct < 0.3);
    e.hpText.textContent = Math.ceil(Math.max(0, g.t.hp)) + ' / ' + Math.ceil(g.t.maxHp);
  },

  syncPerks(g) {
    const entries = Object.entries(g.perkLevels).filter(([, v]) => v > 0);
    this.el.perkTray.innerHTML = entries.map(([id, lv]) => {
      const u = UPGRADE_BY_ID[id];
      return `<div class="perk"><span>${u.icon}</span><b>${lv}</b></div>`;
    }).join('');
  },

  /* ---------------- Banner ---------------- */
  banner(text, danger) {
    const b = this.el.waveBanner;
    b.classList.remove('hidden');
    b.classList.toggle('danger', !!danger);
    // restart the CSS animation
    b.innerHTML = `<span>${text}</span>`;
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => b.classList.add('hidden'), 1900);
  },

  /* ---------------- Upgrade screen ---------------- */
  /**
   * Takes the game rather than a loose wave number so a card's desc can see
   * the tower it is about to change. Several upgrades read differently once a
   * stat they feed has clamped, and null was being passed where the tower
   * belonged — which is why every card desc keyed off its level alone and none
   * of them could tell the truth about a ceiling.
   */
  showUpgrades(g, choices, levels, rerollsLeft, onPick, onReroll) {
    const e = this.el;
    e.upTitle.textContent = `WAVE ${g.wave} CLEARED`;
    e.cards.innerHTML = '';

    choices.forEach((u, i) => {
      const lv = (levels[u.id] || 0) + 1;
      const card = document.createElement('div');
      card.className = 'card brk' + (lv === 1 ? ' new' : '');
      card.style.setProperty('--c', u.color);
      // stagger the unfold so the two panels deploy in sequence, not together
      card.style.setProperty('--delay', (i * 0.09) + 's');
      card.innerHTML =
        `<div class="key">${i + 1}</div>` +
        `<div class="lvl">${lv > 1 ? 'LV ' + lv : ''}</div>` +
        `<div class="ico">${u.icon}</div>` +
        `<div class="name">${u.name}</div>` +
        `<div class="desc">${u.desc(g.t, lv)}</div>`;
      card.addEventListener('click', () => onPick(u));
      e.cards.appendChild(card);
    });

    e.rerollCount.textContent = `(${rerollsLeft})`;
    e.rerollBtn.disabled = rerollsLeft <= 0;
    e.rerollBtn.onclick = onReroll;

    this.show(e.upgradeScreen);
  },

  hideUpgrades() { this.hide(this.el.upgradeScreen); },

  /* ---------------- Shop ---------------- */

  /* ============================================================
     THE BAY
     Thirteen items, but they are not thirteen peers: an item that hits its
     ceiling hands off to a successor, and a flat list hides that completely —
     the player reads MAX, concludes the stat is finished, and never finds the
     thing built to continue it.

     Drawn as a GRID of tiles rather than a list, because the bay is a menu and
     a menu wants to be seen at once. Rows stacked one per item put most of the
     stock below the fold, and a shop you have to scroll to survey is a shop
     you buy the top of.

     Lineage survives the change without the vertical cost of drawing a tree:
     tiles stay in line order so a successor always sits next to what it
     succeeds, each carries its line name, and a successor is marked with a
     turnstile so the handoff is still legible inside one tile.
     ============================================================ */

  /** Why a successor is still locked. Derived, because the predicate in
   *  config knows the condition but nothing there can phrase it. */
  _bayReq(item) {
    switch (item.id) {
      case 'velocity':     return 'AT FIRE RATE CAP';
      case 'overpressure': return 'AT SHOT SPEED CAP';
      case 'fission':      return 'AT CRIT CAP';
      case 'blast':        return 'AT MAX RANGE';
      case 'overclock':    return 'WAVE ' + OVERCLOCK_WAVE;
      default:             return 'NOT YET';
    }
  },

  /**
   * The bay as an ordered list of tiles, plus the NEW bookkeeping.
   *
   * A locked tile is only ever the NEXT step of a line — the first successor
   * whose predecessor is on screen. Rendering the one after that as well would
   * turn a goal into a roadmap and quietly leak how deep every chain runs.
   *
   * Hidden ROOTS stay dropped rather than becoming locked tiles. Shield
   * Recharge is the case: before the barrier card exists the player has never
   * seen a shield, and a silhouette promising one would be the shop explaining
   * a mechanic it does not own.
   */
  shopRows(g) {
    // Waves only ever climb inside a run, so a wave that went backwards means
    // a redeploy — and NEW has to mean new to THIS run, not to this page load.
    if (this._shopWave === undefined || g.wave < this._shopWave) this._shopSeen = {};
    this._shopWave = g.wave;

    // On the first visit of a run every item is literally new, and badging all
    // of them says nothing. NEW has to mean "this appeared because of something
    // you did", so the opening stock is taken as read.
    const opening = Object.keys(this._shopSeen).length === 0;

    const byId = {};
    for (const item of SHOP) byId[item.id] = item;

    const live = SHOP.filter(item => !(item.hidden && item.hidden(g.t, g)));
    const isLive = {};
    for (const item of live) isLive[item.id] = true;

    for (const item of live) {
      item._new = !opening && !this._shopSeen[item.id];
      item._dead = !!(item.capped && item.capped(g.t, g)) ||
                   (g.shopLevels[item.id] || 0) >= item.max;
    }

    const kids = {};
    for (const item of SHOP) if (item.after) (kids[item.after] = kids[item.after] || []).push(item);

    const tiles = [];
    for (const line of SHOP_LINES) {
      // Depth-first from each root, so a successor is always laid out directly
      // after the thing it succeeds and adjacency alone carries the lineage.
      const walk = (item, depth) => {
        if (!isLive[item.id]) {
          if (item.after) tiles.push({ item, line, depth, locked: true });
          return;
        }
        // A capped terminal is where a line would otherwise dead-end, so that
        // is exactly when its pointer to the shared sink earns its space.
        const then = (item.then && item._dead) ? byId[item.then] : null;
        tiles.push({ item, line, depth, locked: false, then });
        for (const kid of kids[item.id] || []) walk(kid, depth + 1);
      };
      for (const item of SHOP) if (item.line === line.id && !item.after) walk(item, 0);
    }

    // Seen once shown, so NEW burns off after the visit that introduced it
    // rather than nagging for the rest of the run. Locked tiles are pointedly
    // NOT marked: the visit that unlocks one is the visit that gets the badge.
    for (const item of live) this._shopSeen[item.id] = true;
    return tiles;
  },

  showShop(g, onBuy, onNext) {
    this.el.shopNextBtn.onclick = onNext;
    this._onBuy = onBuy;
    this.el.shopList.innerHTML = '';

    // rebuilt every visit, so an item can start hidden and appear later in the
    // run the moment the thing it acts on exists
    for (const item of SHOP) item._row = null;

    this.shopRows(g).forEach(({ item, line, depth, locked, then }, i) => {
      const tile = document.createElement('div');
      tile.className = 'bay-tile brk' +
        (locked ? ' is-locked' : '') +
        (!locked && item._new ? ' is-new' : '') +
        (depth ? ' is-succ' : '');
      tile.style.setProperty('--c', item.color);
      tile.style.animationDelay = (i * 0.025) + 's';

      // The line name doubles as the lineage marker: a turnstile in front of it
      // means this tile continues the one before it, which is the whole of the
      // tree that survived the move to a grid.
      const tag = `<span class="t-line">${depth ? '\u21b3 ' : ''}${line.name}</span>`;

      if (locked) {
        // No cost, no button, no name: a silhouette states its condition and
        // nothing else, so unlocking it is still a reveal.
        tile.innerHTML =
          `<div class="t-top">${tag}</div>` +
          `<div class="t-ico">\u{1F512}</div>` +
          `<div class="t-name">LOCKED</div>` +
          `<div class="t-desc">${this._bayReq(item)}</div>`;
      } else {
        tile.innerHTML =
          `<div class="t-top">${tag}<span class="t-lvl" data-lvl></span></div>` +
          `<div class="t-ico">${item.icon}</div>` +
          `<div class="t-name">${item.name}` +
            (item._new ? `<span class="s-new">NEW</span>` : '') + `</div>` +
          `<div class="t-desc">${item.desc()}</div>` +
          `<button class="buy brk" data-buy></button>` +
          // Folded into the tile instead of taking a row of its own: it is a
          // signpost, not a purchase, and the thing it points at is bought in
          // its own tile.
          (then ? `<div class="t-then" style="--t:${then.color}">` +
                  `${then.icon} ${then.name.toUpperCase()}</div>` : '');
        tile.querySelector('[data-buy]').addEventListener('click', () => this._onBuy(item));
        item._row = tile;
      }
      this.el.shopList.appendChild(tile);
    });

    this.syncShop(g);
    this.show(this.el.shopScreen);
    requestAnimationFrame(() => {
      const list = this.el.shopList;
      // An arrival lands wherever its LINE is rather than at the top, so the
      // one thing the badge exists to advertise can open below the fold. Bring
      // it up to meet the player instead of hoping they scroll.
      const fresh = list.querySelector('.bay-tile.is-new');
      if (fresh && fresh.offsetTop + fresh.offsetHeight > list.clientHeight) {
        list.scrollTop = Math.max(0, fresh.offsetTop - 40);
      }
      const more = () => list.classList.toggle('has-more',
        list.scrollHeight - list.scrollTop > list.clientHeight + 2);
      list.onscroll = more;   // the hint retires once you actually reach the end
      more();
    });
  },

  /** Refresh prices / affordability without rebuilding the DOM. */
  syncShop(g) {
    this.el.shopWallet.textContent = fmt(g.cash);

    SHOP.forEach(item => {
      const row = item._row;
      if (!row) return;
      const lv = g.shopLevels[item.id] || 0;
      const btn = row.querySelector('[data-buy]');
      const lvlTag = row.querySelector('[data-lvl]');

      const showLvl = lv > 0 && item.max !== Infinity;
      lvlTag.textContent = showLvl ? 'LV ' + lv : '';
      lvlTag.style.display = showLvl ? '' : 'none';

      // a permanent ceiling reads the same as running out of levels
      if (item.capped && item.capped(g.t, g)) {
        btn.textContent = 'MAX';
        btn.disabled = true;
        btn.classList.add('maxed');
        row.style.opacity = '1';
        return;
      }

      if (lv >= item.max) {
        btn.textContent = 'MAX';
        btn.disabled = true;
        btn.classList.add('maxed');
        return;
      }

      const cost = item.cost(lv, g);
      const affordable = g.cash >= cost;
      const usable = !item.enabled || item.enabled(g.t, g);

      btn.classList.remove('maxed');
      btn.textContent = '◈ ' + fmt(cost);
      btn.disabled = !affordable || !usable;
      row.style.opacity = usable ? '1' : '.5';
    });
  },

  hideShop() { this.hide(this.el.shopScreen); },

  /* ============================================================
     DEBRIEF
     The four numbers the run used to end on said almost nothing about it. This
     is the whole run read back: which system actually carried the damage, what
     the swarm was made of, what got through, and the build that produced it.

     Same language as the rest of the visor — bracketed frames, Orbitron
     micro-caps for labels, brightness for hierarchy, colour carried by the
     thing being described. The weapon comparison is bars rather than a column
     of figures because the answer to "which system did the work" should be
     legible before any of the numbers are read.

     Everything here comes straight out of Stats. Nothing is derived that isn't
     honestly derivable from two measured values.
     ============================================================ */
  showGameOver(g, best) {
    const e = this.el;
    // resolved lazily so the debrief owns its own markup and touches nothing
    // in UI.init
    e.ovTime = e.ovTime || $('ovTime');
    e.ovReport = e.ovReport || $('ovReport');

    e.ovWave.textContent = g.wave;
    e.ovKills.textContent = fmt(g.kills);
    e.ovCash.textContent = fmt(Stats.earned);
    e.ovTime.textContent = clock(Stats.time);

    // Game.best is already raised by nextWave, so beating the mark has to be
    // judged against what the player walked in with.
    const record = g.wave > Stats.startBest;
    e.ovBest.textContent = record ? '▲ NEW RECORD — WAVE ' + g.wave : 'BEST WAVE: ' + best;
    e.ovBest.classList.toggle('record', record);

    e.ovReport.innerHTML =
      this.rptWeapons() + this.rptHostiles() + this.rptAnalysis(g) + this.rptBuild(g);

    this.show(e.overScreen);
    // After the reveal, not before: while the overlay is still display:none the
    // report has no layout to scroll, the assignment is silently dropped, and
    // the browser hands back the offset from the previous run — so a second
    // death would open the debrief already scrolled into the middle of it.
    e.ovReport.scrollTop = 0;
  },

  /** Whole percent, and never a bare 0% for something that did happen. */
  _pct(part, whole) {
    if (!whole) return '0%';
    const p = (part / whole) * 100;
    return (p > 0 && p < 1) ? '&lt;1%' : Math.round(p) + '%';
  },

  _head(label, right) {
    return `<div class="rpt-head"><span>${label}</span><b>${right || ''}</b></div>`;
  },

  /* ---- weapon systems: the run's damage, ranked ---- */
  rptWeapons() {
    const S = Stats;
    const total = S.totalDamage();
    if (total <= 0) return '';

    const order = [];
    for (let i = 0; i < SRC_META.length; i++) if (S.dmg[i] > 0) order.push(i);
    order.sort((a, b) => S.dmg[b] - S.dmg[a]);

    // Bars are scaled to the best system, not to the total — the question is
    // "how does this compare to the one that carried the run", and against a
    // total every bar in a spread build reads as equally short.
    const top = S.dmg[order[0]];

    const rows = order.map(i => {
      const m = SRC_META[i];
      const k = S.kills[i];
      return `<div class="wrow" style="--c:${m.color}">` +
        `<div class="w-ico">${m.icon}</div>` +
        `<div class="w-body">` +
          `<div class="w-line"><span class="w-name">${m.name}</span><span class="w-val">${fmt(S.dmg[i])}</span></div>` +
          `<div class="w-bar"><i style="width:${(S.dmg[i] / top * 100).toFixed(1)}%"></i></div>` +
          `<div class="w-sub">${this._pct(S.dmg[i], total)} OF DAMAGE · ${fmt(k)} KILL${k === 1 ? '' : 'S'}</div>` +
        `</div></div>`;
    }).join('');

    return `<section class="rpt-sec">${this._head('WEAPON SYSTEMS', fmt(total) + ' DMG')}${rows}</section>`;
  },

  /* ---- the swarm: what it was made of, and what got through ---- */
  rptHostiles() {
    const S = Stats;
    const keys = Object.keys(ENEMIES).filter(k => S.spawned[k] > 0);
    if (!keys.length) return '';
    keys.sort((a, b) => S.spawned[b] - S.spawned[a]);

    const rows = keys.map(k => {
      const def = ENEMIES[k];
      const n = S.spawned[k], killed = S.killed[k], leaked = S.leaked[k];
      /**
       * Each bar is scaled to that type's own spawn count, not to the biggest
       * type — a run kills hundreds of grunts and three bosses, so a shared
       * scale would leave every heavy as an invisible sliver. Read this way the
       * bar answers a better question anyway: how much of what showed up was
       * actually stopped. Any gap left at the end is the hostiles still on the
       * field when the core went down.
       */
      return `<div class="hrow" style="--c:${def.color}">` +
        `<span class="h-name">${k.toUpperCase()}</span>` +
        `<div class="h-bar">` +
          `<i style="width:${(killed / n * 100).toFixed(1)}%"></i>` +
          `<u style="width:${(leaked / n * 100).toFixed(1)}%"></u>` +
        `</div>` +
        `<span class="h-num">${fmt(killed)}</span>` +
        `<span class="h-leak${leaked ? ' hot' : ''}">${leaked}</span>` +
        `</div>`;
    }).join('');

    return `<section class="rpt-sec">${this._head('HOSTILES', 'KILLED / LEAKED')}${rows}</section>`;
  },

  /* ---- everything that isn't a ranking ---- */
  rptAnalysis(g) {
    const S = Stats;
    const total = S.totalDamage();
    const chips = [];
    const chip = (label, value, note) => chips.push(
      `<div class="chip"><small>${label}</small><span>${value}</span>` +
      (note ? `<em>${note}</em>` : '') + `</div>`);

    chip('DAMAGE DEALT', fmt(total));
    if (S.time > 0) chip('AVG DPS', fmt(total / S.time));
    if (S.big > 0) chip('BIGGEST HIT', fmt(S.big), SRC_META[S.bigSrc].name);
    chip('CRIT RATE', this._pct(S.critShots, S.rounds), fmt(S.rounds) + ' ROUNDS');
    chip('ACCURACY', this._pct(S.connected, S.rounds), 'ROUNDS ON TARGET');
    chip('OVERKILL', fmt(S.totalOverkill()), this._pct(S.totalOverkill(), total + S.totalOverkill()) + ' WASTED');
    // only ever non-zero if the run met bulwarks, so it appears when it means something
    if (S.absorbed > 0) chip('ARMOUR SHRUGGED', fmt(S.absorbed));
    // Both only ever non-zero if the run actually raised a barrier, so like
    // ARMOUR SHRUGGED they show up exactly when they mean something.
    if (S.shielded > 0) chip('SHIELD ABSORBED', fmt(S.shielded),
      S.collapses + (S.collapses === 1 ? ' COLLAPSE' : ' COLLAPSES'));
    chip('PEAK HOSTILES', S.peak);
    chip('DAMAGE TAKEN', fmt(S.taken), S.breaches + ' BREACHES');
    chip('HP REPAIRED', fmt(S.healed));
    chip('SALVAGE SPENT', fmt(S.spent), fmt(g.cash) + ' UNSPENT');

    return `<section class="rpt-sec">${this._head('ANALYSIS')}` +
      `<div class="chips">${chips.join('')}</div></section>`;
  },

  /* ---- the build that produced all of the above ---- */
  rptBuild(g) {
    const perks = Object.entries(g.perkLevels).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, lv]) => {
        const u = UPGRADE_BY_ID[id];
        return `<span class="bchip" style="--c:${u.color}"><i>${u.icon}</i>${u.name.toUpperCase()}<b>${lv}</b></span>`;
      }).join('');

    const bought = SHOP.filter(it => (g.shopLevels[it.id] || 0) > 0)
      .map(it => `<span class="bchip bought" style="--c:${it.color}">` +
        `<i>${it.icon}</i>${it.name.toUpperCase()}<b>${g.shopLevels[it.id]}</b></span>`).join('');

    if (!perks && !bought) return '';
    return `<section class="rpt-sec">${this._head('BUILD')}` +
      (perks ? `<div class="bchips">${perks}</div>` : '') +
      (bought ? `<div class="bchips dim">${bought}</div>` : '') +
      `</section>`;
  },
};
