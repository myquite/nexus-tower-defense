'use strict';

const TAU = Math.PI * 2;

function rand(min, max) {
  if (max === undefined) { max = min; min = 0; }
  return min + Math.random() * (max - min);
}
function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function chance(p) { return Math.random() < p; }
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }

function dist2(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; }
function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }

/** Shortest angular difference b - a, wrapped to [-PI, PI]. */
function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** Rotate `a` toward `b` by at most `maxStep` radians. */
function turnToward(a, b, maxStep) {
  const d = angleDiff(a, b);
  return a + clamp(d, -maxStep, maxStep);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** Squared distance from point P to segment AB — used by the death ray. */
function distToSegment2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp(t, 0, 1);
  const cx = ax + dx * t, cy = ay + dy * t;
  return dist2(px, py, cx, cy);
}

/** 1234567 -> "1.2M" */
function fmt(n) {
  n = Math.floor(n);
  if (n < 1000) return '' + n;
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(n < 1e7 ? 1 : 0) + 'M';
  return (n / 1e9).toFixed(1) + 'B';
}

/** Cheap object pool so we don't churn GC on particles. */
class Pool {
  constructor(factory) { this.factory = factory; this.free = []; }
  get() { return this.free.length ? this.free.pop() : this.factory(); }
  put(o) { if (this.free.length < 800) this.free.push(o); }
}
