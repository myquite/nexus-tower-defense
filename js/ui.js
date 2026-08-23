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
  showUpgrades(wave, choices, levels, rerollsLeft, onPick, onReroll) {
    const e = this.el;
    e.upTitle.textContent = `WAVE ${wave} CLEARED`;
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
        `<div class="desc">${u.desc(null, lv)}</div>`;
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
  showShop(g, onBuy, onNext) {
    this.el.shopNextBtn.onclick = onNext;
    this._onBuy = onBuy;
    this.el.shopList.innerHTML = '';

    SHOP.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'shop-row';
      row.style.setProperty('--c', item.color);
      row.style.animationDelay = (i * 0.04) + 's';
      row.innerHTML =
        `<div class="s-ico">${item.icon}</div>` +
        `<div class="s-txt">` +
          `<div class="s-name">${item.name}<span class="s-lvl" data-lvl></span></div>` +
          `<div class="s-desc">${item.desc()}</div>` +
        `</div>` +
        `<button class="buy brk" data-buy></button>`;
      row.querySelector('[data-buy]').addEventListener('click', () => this._onBuy(item));
      this.el.shopList.appendChild(row);
      item._row = row;
    });

    this.syncShop(g);
    this.show(this.el.shopScreen);
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
    e.ovReport.scrollTop = 0;

    this.show(e.overScreen);
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
