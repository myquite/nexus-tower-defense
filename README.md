# NEXUS — Tower Defense

A browser tower-defense in the style of *The Tower: Idle Tower Defense*: one hex core at the
centre of the screen, enemies converging from every direction, and a **choose 1 of 2 upgrades**
card screen after every wave. Neon sci-fi look, no build step, no dependencies.

## Play

Open `index.html` in a browser. That's it — everything is plain `<script>` tags, so `file://`
works. If you prefer a server:

```
python3 -m http.server 8777    # then visit http://localhost:8777
```

## Controls

| Input | Action |
| --- | --- |
| — | The core targets and fires automatically |
| **click a card** | Take that upgrade (or press **1** / **2**) |
| **Enter** | Leave the shop, start the next wave |
| **Space** (hold) | Fast-forward |
| **Esc** | Pause |
| **speaker icon** (top right) | Music volume slider + mute |

## Music

Drop audio files into `music/` and list them in `MUSIC_TRACKS` at the top of `js/config.js`:

```js
const MUSIC_TRACKS = [
  'music/your_track.mp3',
];
```

Use a format the browser can decode — `.mp3`, `.m4a`, `.ogg`, or `.wav`.

### Looping

Most music isn't written to loop: the last bar doesn't lead back into the first, so playing it
on `<audio loop>` butts the ending against the beginning and you hear the seam. The bundled
track is a clear case — no silence at either end, and the head sits ~3 dB louder than the tail.

So playback runs on the **Web Audio API** instead. The file is decoded once into an
`AudioBuffer` and each pass is scheduled to *overlap* the next, cross-faded on an equal-power
curve (`sin`/`cos` — a linear fade would dip in the middle). The join is inaudible. Measured
offline against a constant-level source, the worst level deviation across a loop point is
**-0.54 dB**.

Tune it with `MUSIC_CONFIG` in `js/config.js`:

| Key | Meaning |
| --- | --- |
| `crossfade` | Seconds of overlap. Effective loop = track length − crossfade. |
| `shuffle` | Randomise playlist order, reshuffled on each wrap. |
| `loopStart` / `loopEnd` | Trim an intro or a hard ending. Single-track only. |
| `fadeIn` / `fadeOut` | Ease in on start, fade out on pause. |
| `duckVolume` / `duckFilterHz` | How far the music sits back behind menus. |

### Length

A crossfade hides the *seam*; it can't make a short track less repetitive. One 30-second track
comes back around every 30 seconds no matter what. **The fix is more tracks** — list several in
`MUSIC_TRACKS` and the same crossfade carries you from one into the next, so time-before-repeat
becomes the sum of the playlist rather than one file.

### Behaviour

- Playback starts on **START DEFENSE / REDEPLOY**, because browsers block audio until a real
  user gesture.
- Volume and mute persist in `localStorage` (`nexus_vol`, `nexus_muted`). The slider value is
  squared before it reaches the gain node, so the quiet end of the range stays usable, and
  changes ramp over 150 ms rather than stepping (no zipper noise).
- Music ducks behind the upgrade, shop and game-over screens — a volume drop plus a lowpass
  sweep, so between-wave menus feel like a lull instead of a hard cut.
- Pausing fades out and suspends the AudioContext, which freezes its clock, so unpausing
  resumes the loop exactly where it left off.
- Over `file://` browsers block the `fetch` that Web Audio needs, so playback falls back to a
  plain `<audio loop>` element — **the seam comes back**. Run it from a server to get the
  crossfade.
- If no track loads, the speaker turns into 🚫 and the popover says so rather than pretending
  to play.

## How it plays

- Survive waves of hostiles that spawn just off-screen and home in on the core.
- Every wave cleared → **pick one of two upgrade cards** → **Salvage Bay** (spend the salvage
  dropped by kills) → next wave. One card reroll is banked per wave, capped at 6 held.
- Every 5th wave is a boss wave.
- Waves are endless; the run ends when the core hits 0 HP. Best wave is saved to `localStorage`.

### Cards vs. shop

Two separate economies, deliberately. **Cards** are the luck-of-the-draw power spikes — big,
build-defining, one per wave. **The shop** is the steady compounding curve you control: small
repeatable percentage buys with escalating prices (Damage Core, Coolant, Hull Plating, Focusing
Lens, Targeting Optics), plus Field Repair to top the core back up and Reroll Tokens to buy
better card odds. Salvage is what makes a strong run compound instead of stalling.

## Upgrades

Straight stat boosts (Damage, Fire Rate, Multishot, Range, Piercing, Critical, Fortify,
Nanorepair, Siphon, Salvager) plus weapon systems that change how the screen looks and plays:

| Upgrade | Effect |
| --- | --- |
| **Orbs** | Blades orbiting the core, damage on contact |
| **Smart Missiles** | Homing salvo on a timer, small AoE per hit |
| **Chain Lightning** | Arcs from target to target through the swarm |
| **Meteor Strike** | Telegraphed AoE strikes on random enemies |
| **Death Ray** | Sweeping instant-kill beams (unlocks wave 4) |
| **Shockwave** | Periodic nova that damages and knocks back |
| **Cryo Field** | Slows everything inside the core's range |
| **Reactive Plating** | Burns attackers that reach the core (unlocks wave 3) |

## Layout

```
index.html          markup + DOM overlays (HUD, cards, start/over/pause)
css/style.css       all styling and screen animations
js/utils.js         math, RNG, formatting, object pool
js/config.js        palette, tower base stats, enemy archetypes, wave curve, upgrade + shop tables
js/entities.js      Enemy, Bullet, Missile, Meteor, Bolt, Ring, Particle, FloatText, Drifter
js/ui.js            DOM binding — HUD sync, upgrade cards, shop, end screens, audio control
js/music.js         looping background music, volume/mute, persistence
js/game.js          state machine, wave flow, weapon systems, collision, render
```

## Tuning

Nearly all balance lives in `js/config.js`:

- `baseTower()` — starting stats for the core.
- `ENEMIES` — per-archetype hp / speed / size / contact damage / salvage.
- `buildWave(wave)` — how many enemies spawn and over what window.
- `waveScale(wave)` — per-wave multipliers (`hp` at `1.185^(w-1)` is the main difficulty dial).
- `UPGRADES` — each entry owns its own `desc()` text and `apply()` mutation, so adding a new
  upgrade is one array element; the card UI and perk tray pick it up automatically.
- `SHOP` — same shape plus `cost(level, game)`. Prices scale `base * growth^level`; growth is
  the main dial for how fast salvage compounds.

The curve was tuned by simulating full runs headlessly — stepping `game.update(1/60)` in a loop
with scripted card and shop policies. Measured outcomes:

| Play pattern | Wave reached |
| --- | --- |
| random cards, never shops | ~15 |
| random cards, spends everything | ~31 |
| prioritised cards, spends everything | 35–49 (~20 min) |

So the shop roughly doubles run length — that's the point of it, but it's also the knob to turn
if runs feel too long. Raise the `growth` exponents in `SHOP` to make salvage compound slower.

### Rendering note

`ctx.shadowBlur` is the obvious way to get neon glow and it tanks the frame rate — at wave 25
it took the game to 7 FPS. Glow is instead faked with `neonStroke()` in `js/entities.js`: a wide
translucent pass plus a thin bright pass, drawn under `globalCompositeOperation = 'lighter'`.
Same look, 120 FPS with 40+ enemies on screen. Avoid reintroducing `shadowBlur` in anything
that draws per-entity.
