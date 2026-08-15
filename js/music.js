'use strict';

/**
 * Background music.
 *
 * Primary path is the Web Audio API: the track is decoded once into an
 * AudioBuffer and each pass is scheduled to overlap the next, cross-faded on an
 * equal-power curve. That hides the loop seam even when the music was never
 * written to loop, which `<audio loop>` cannot do — it can only butt the last
 * sample against the first.
 *
 * Fallback path is a plain HTMLAudioElement with loop=true. It has an audible
 * seam, but Web Audio needs to fetch the file as an ArrayBuffer and browsers
 * block that over file://, so the fallback keeps the game playable when
 * index.html is opened directly.
 *
 * Named `Music` rather than `Audio` on purpose — `Audio` is a browser global.
 */
const Music = {
  mode: null,           // 'webaudio' | 'element' | null
  available: null,      // null = unknown, false = nothing loadable
  started: false,
  volume: 0.55,
  muted: false,
  ducked: false,

  // web audio
  ctx: null,
  buffer: null,         // current buffer (single-track case / most recent)
  buffers: [],          // decoded tracks, index-aligned with MUSIC_TRACKS
  order: [],            // playback order
  orderPos: 0,
  volGain: null,
  duckGain: null,
  filter: null,
  sources: [],
  nextStart: 0,
  timer: null,
  firstPass: true,

  // element fallback
  el: null,
  index: 0,

  init() {
    const v = localStorage.getItem('nexus_vol');
    const m = localStorage.getItem('nexus_muted');
    if (v !== null) this.volume = clamp(parseFloat(v) || 0, 0, 1);
    if (m !== null) this.muted = m === '1';

    if (!MUSIC_TRACKS.length) { this.available = false; return; }
    this.loadTrack(0);
  },

  async loadTrack(i) {
    const AC = window.AudioContext || window.webkitAudioContext;

    if (AC && location.protocol !== 'file:') {
      try {
        this.ctx = this.ctx || new AC();
        this.buffers[i] = await this.decode(MUSIC_TRACKS[i]);
        this.buffer = this.buffers[i];
        this.buildGraph();
        this.rebuildOrder();
        this.mode = 'webaudio';
        this.available = true;
        UI.syncAudio();
        if (this.started) this.play();
        this.decodeRest();          // remaining tracks stream in behind the first
        return;
      } catch (err) {
        console.warn('[music] Web Audio path failed, falling back to <audio>:', err.message);
      }
    }

    this.initElement(i);
  },

  async decode(src) {
    const res = await fetch(src);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + src);
    return this.ctx.decodeAudioData(await res.arrayBuffer());
  },

  /** Decode the rest of the playlist in the background; a bad file is skipped. */
  async decodeRest() {
    for (let i = 0; i < MUSIC_TRACKS.length; i++) {
      if (this.buffers[i]) continue;
      try {
        this.buffers[i] = await this.decode(MUSIC_TRACKS[i]);
        this.rebuildOrder();
      } catch (err) {
        console.warn('[music] skipping', MUSIC_TRACKS[i], '—', err.message);
      }
    }
  },

  /**
   * @param avoidFirst track index that must not land first, used when
   *        reshuffling on a wrap. Without it the new order can open with the
   *        track that just finished — one time in three at three tracks — and a
   *        30s loop crossfading into itself is the exact repetition a playlist
   *        exists to avoid.
   */
  rebuildOrder(avoidFirst) {
    const ready = [];
    for (let i = 0; i < MUSIC_TRACKS.length; i++) if (this.buffers[i]) ready.push(i);
    const next = MUSIC_CONFIG.shuffle && ready.length > 1 ? shuffle(ready) : ready;
    if (avoidFirst !== undefined && next.length > 1 && next[0] === avoidFirst) {
      const j = 1 + ((Math.random() * (next.length - 1)) | 0);
      const t = next[0]; next[0] = next[j]; next[j] = t;
    }
    this.order = next;
  },

  /**
   * Next buffer to schedule. With one track this returns it forever (a loop);
   * with several it walks the playlist, so the crossfade that hides the loop
   * seam also serves as the transition between tracks.
   */
  nextBuffer() {
    if (!this.order.length) return null;
    const idx = this.order[this.orderPos % this.order.length];
    const buf = this.buffers[idx];
    this.orderPos++;
    // reshuffle each time the playlist wraps so the order isn't identical,
    // holding back the track that just played so the seam can't repeat it
    if (MUSIC_CONFIG.shuffle && this.orderPos % this.order.length === 0 && this.order.length > 2) {
      this.rebuildOrder(idx);
    }
    return buf;
  },

  /* ============================================================
     Web Audio graph:  per-pass gain -> filter -> duck -> volume -> out
     ============================================================ */
  buildGraph() {
    const ctx = this.ctx;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 22050;
    this.filter.Q.value = 0.4;

    this.duckGain = ctx.createGain();
    this.duckGain.gain.value = 1;

    this.volGain = ctx.createGain();
    this.volGain.gain.value = this.gainValue();

    this.filter.connect(this.duckGain);
    this.duckGain.connect(this.volGain);
    this.volGain.connect(ctx.destination);
  },

  /** Squared so the quiet end of the slider stays usable. */
  gainValue() { return this.muted ? 0 : this.volume * this.volume; },

  /**
   * Region of a buffer that actually plays. loopStart/loopEnd are only
   * meaningful when trimming a single looping track — with a playlist each
   * track plays in full.
   */
  loopRegion(buffer) {
    const b = buffer || this.buffer;
    const single = this.order.length <= 1;
    const start = single ? clamp(MUSIC_CONFIG.loopStart || 0, 0, b.duration - 0.5) : 0;
    const end = single
      ? clamp(MUSIC_CONFIG.loopEnd || b.duration, start + 0.5, b.duration)
      : b.duration;
    // an overlap can never exceed half the region or the fade curves collide
    const xf = clamp(MUSIC_CONFIG.crossfade, 0, (end - start) / 2 - 0.05);
    return { start, end, dur: end - start, xf };
  },

  /** Equal-power curve — a linear fade would dip in volume mid-crossfade. */
  fadeCurve(rising, steps) {
    const n = steps || 64;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * (Math.PI / 2);
      c[i] = rising ? Math.sin(t) : Math.cos(t);
    }
    return c;
  },

  /**
   * Schedule one pass. Each gets its own gain node so the outgoing pass can
   * fade down while the incoming one fades up over the same window.
   */
  schedulePass(at) {
    const buffer = this.nextBuffer();
    if (!buffer) return 0;
    const { start, dur, xf } = this.loopRegion(buffer);
    const ctx = this.ctx;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    const g = ctx.createGain();
    src.connect(g);
    g.connect(this.filter);

    // the very first pass eases in from silence over a longer window
    const inDur = this.firstPass ? Math.min(MUSIC_CONFIG.fadeIn, dur / 2) : xf;

    if (inDur > 0.01) {
      g.gain.setValueAtTime(0, at);
      g.gain.setValueCurveAtTime(this.fadeCurve(true), at, inDur);
    } else {
      g.gain.setValueAtTime(1, at);
    }

    if (xf > 0.01) {
      g.gain.setValueAtTime(1, at + dur - xf);
      g.gain.setValueCurveAtTime(this.fadeCurve(false), at + dur - xf, xf);
    }

    src.start(at, start, dur);
    src.stop(at + dur + 0.05);

    src.onended = () => {
      g.disconnect();
      const i = this.sources.indexOf(src);
      if (i >= 0) this.sources.splice(i, 1);
    };

    this.sources.push(src);
    this.firstPass = false;
    return dur - xf;                   // how far to advance before the next pass
  },

  /** Keep a few seconds of passes queued ahead of the clock. */
  pump() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const horizon = this.ctx.currentTime + 5;
    let guard = 0;
    while (this.nextStart < horizon && guard++ < 6) {
      const advance = this.schedulePass(this.nextStart);
      if (!advance) break;             // nothing decoded yet
      this.nextStart += advance;       // next pass overlaps this one by the crossfade
    }
  },

  startLoop() {
    this.stopSources();
    this.firstPass = true;
    this.nextStart = this.ctx.currentTime + 0.08;
    this.pump();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.pump(), 1000);
  },

  stopSources() {
    clearInterval(this.timer);
    this.timer = null;
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch (_) {} }
    this.sources.length = 0;
  },

  /* ============================================================
     Element fallback
     ============================================================ */
  initElement(i) {
    this.mode = 'element';
    this.index = i;
    if (!this.el) {
      this.el = new window.Audio();
      this.el.preload = 'auto';
      this.el.loop = MUSIC_TRACKS.length === 1;
      this.el.addEventListener('ended', () => {
        if (MUSIC_TRACKS.length > 1) {
          this.index = (this.index + 1) % MUSIC_TRACKS.length;
          this.el.src = MUSIC_TRACKS[this.index];
          this.el.load();
          this.play();
        }
      });
      this.el.addEventListener('canplay', () => {
        if (this.available !== true) { this.available = true; UI.syncAudio(); }
      });
      this.el.addEventListener('error', () => {
        this.available = false;
        UI.syncAudio();
      });
    }
    this.el.volume = this.gainValue();
    this.el.src = MUSIC_TRACKS[i];
    this.el.load();
    this.probeElement();
  },

  /** Chrome may defer a preload request forever, so ask the server directly. */
  async probeElement() {
    if (location.protocol === 'file:') return;
    try {
      const res = await fetch(MUSIC_TRACKS[this.index], { method: 'HEAD' });
      if (!res.ok) throw new Error();
    } catch (_) {
      if (this.available !== true) { this.available = false; UI.syncAudio(); }
    }
  },

  /* ============================================================
     Public API
     ============================================================ */

  /** Call from a real user gesture — browsers block audio until then. */
  start() {
    this.started = true;
    this.play();
  },

  play() {
    if (this.muted || this.available === false) return;

    if (this.mode === 'webaudio') {
      this.ctx.resume().then(() => {
        this.volGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.volGain.gain.setValueAtTime(this.gainValue(), this.ctx.currentTime);
        if (!this.sources.length) this.startLoop();
      }).catch(() => {});
      return;
    }

    if (this.el) {
      const p = this.el.play();
      if (p && p.catch) p.catch(() => {});
    }
  },

  pause() {
    if (this.mode === 'webaudio' && this.ctx) {
      // fade out, then freeze the clock so the loop resumes exactly in place
      const now = this.ctx.currentTime;
      const g = this.volGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + MUSIC_CONFIG.fadeOut);
      clearTimeout(this._suspendTimer);
      this._suspendTimer = setTimeout(
        () => { if (this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); },
        MUSIC_CONFIG.fadeOut * 1000 + 60);
      return;
    }
    if (this.el) this.el.pause();
  },

  suspend() { this.pause(); },

  resume() {
    if (!this.started) return;
    clearTimeout(this._suspendTimer);
    this.play();
  },

  /**
   * Sit the music back behind menus — a gentle volume drop plus a lowpass, so
   * between-wave screens feel like a lull rather than a hard cut.
   */
  duck(on) {
    this.ducked = on;
    if (this.mode !== 'webaudio' || !this.ctx || !MUSIC_CONFIG.duckOnMenus) return;
    const now = this.ctx.currentTime;
    const t = 0.45;

    this.duckGain.gain.cancelScheduledValues(now);
    this.duckGain.gain.setValueAtTime(this.duckGain.gain.value, now);
    this.duckGain.gain.linearRampToValueAtTime(on ? MUSIC_CONFIG.duckVolume : 1, now + t);

    this.filter.frequency.cancelScheduledValues(now);
    this.filter.frequency.setValueAtTime(this.filter.frequency.value, now);
    this.filter.frequency.exponentialRampToValueAtTime(
      on ? MUSIC_CONFIG.duckFilterHz : 22050, now + t);
  },

  applyVolume() {
    if (this.mode === 'webaudio' && this.volGain) {
      const now = this.ctx.currentTime;
      const g = this.volGain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(this.gainValue(), now + 0.15);   // no zipper noise
      return;
    }
    if (this.el) this.el.volume = this.gainValue();
  },

  setVolume(v) {
    this.volume = clamp(v, 0, 1);
    localStorage.setItem('nexus_vol', this.volume);
    if (this.volume > 0 && this.muted) this.muted = false;
    localStorage.setItem('nexus_muted', this.muted ? '1' : '0');
    this.applyVolume();
    if (!this.muted && this.started) this.play();
    UI.syncAudio();
  },

  toggleMute() {
    this.muted = !this.muted;
    localStorage.setItem('nexus_muted', this.muted ? '1' : '0');
    if (this.muted) { this.applyVolume(); this.pause(); }
    else if (this.started) this.play();
    else this.applyVolume();
    UI.syncAudio();
  },

  /**
   * Geometric glyphs rather than emoji — emoji drag their own colour palette
   * in and are the one thing on screen the visor styling cannot reach. Level
   * still reads at a glance: the bar grows with volume.
   */
  icon() {
    if (this.available === false) return '\u2205';   // no track loaded
    if (this.muted || this.volume === 0) return '\u2715';
    if (this.volume < 0.34) return '\u2581';
    if (this.volume < 0.67) return '\u2583';
    return '\u2585';
  },
};
