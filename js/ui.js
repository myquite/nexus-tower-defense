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

  /**
   * The bay holds more than a screenful now, and several items unlock partway
   * through a run rather than being there from the start. In SHOP order those
   * arrivals land at the BOTTOM of a list that scrolls — which is the one
   * place a player will never look. An unlock nobody discovers may as well not
   * exist, so the order is by what the player needs to see, not by array
   * position: newly available first, then anything still worth buying, then
   * the finished ones.
   */
  shopRows(g) {
    // Waves only ever climb inside a run, so a wave that went backwards means
    // a redeploy — and NEW has to mean new to THIS run, not to this page load.
    if (this._shopWave === undefined || g.wave < this._shopWave) this._shopSeen = {};
    this._shopWave = g.wave;

    // On the first visit of a run every item is literally new, and badging all
    // seven says nothing. NEW has to mean "this appeared because of something
    // you did", so the opening stock is taken as read.
    const opening = Object.keys(this._shopSeen).length === 0;

    const rows = SHOP.filter(item => !(item.hidden && item.hidden(g.t, g)));
    for (const item of rows) {
      item._new = !opening && !this._shopSeen[item.id];
      item._dead = !!(item.capped && item.capped(g.t, g)) ||
                   (g.shopLevels[item.id] || 0) >= item.max;
    }
    // Stable, so items keep their authored order inside each band.
    const rank = item => (item._new ? 0 : item._dead ? 2 : 1);
    rows.sort((a, b) => rank(a) - rank(b));

    // Seen once shown, so NEW burns off after the visit that introduced it
    // rather than nagging for the rest of the run.
    for (const item of rows) this._shopSeen[item.id] = true;
    return rows;
  },

  showShop(g, onBuy, onNext) {
    this.el.shopNextBtn.onclick = onNext;
    this._onBuy = onBuy;
    this.el.shopList.innerHTML = '';

    // rebuilt every visit, so an item can start hidden and appear later in the
    // run the moment the thing it acts on exists
    for (const item of SHOP) item._row = null;

    this.shopRows(g).forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'shop-row' + (item._new ? ' is-new' : '');
      row.style.setProperty('--c', item.color);
      row.style.animationDelay = (i * 0.04) + 's';
      row.innerHTML =
        `<div class="s-ico">${item.icon}</div>` +
        `<div class="s-txt">` +
          `<div class="s-name">${item.name}` +
            (item._new ? `<span class="s-new">NEW</span>` : '') +
            `<span class="s-lvl" data-lvl></span></div>` +
          `<div class="s-desc">${item.desc()}</div>` +
        `</div>` +
        `<button class="buy brk" data-buy></button>`;
      row.querySelector('[data-buy]').addEventListener('click', () => this._onBuy(item));
      this.el.shopList.appendChild(row);
      item._row = row;
    });

    this.syncShop(g);
    this.show(this.el.shopScreen);
    // Measured after layout: the list only earns its bottom fade when there is
    // actually something below the fold to hint at.
    requestAnimationFrame(() => {
      const list = this.el.shopList;
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

  /* ---------------- End screens ---------------- */
  showGameOver(g, best) {
    this.el.ovWave.textContent = g.wave;
    this.el.ovKills.textContent = fmt(g.kills);
    this.el.ovCash.textContent = fmt(g.cash);
    this.el.ovBest.textContent = 'BEST WAVE: ' + best;
    this.show(this.el.overScreen);
  },
};
