import { config } from "../config";
import { type Screen } from "./screen";

/**
 * =============================================================================
 *  GLITCH OVERLAY — character-grid "corruption" on top of everything.
 * =============================================================================
 *
 *  A full-grid <pre> whose cells are independently flipped to random glyphs to
 *  fake a corrupted display. It is driven by a single coverage value in [0,1]:
 *  the probability that any given cell shows a random glyph each refresh. At 0
 *  it is empty (off); at 1 every cell churns with random characters.
 *
 *  Coverage comes from two sources, combined by max():
 *    - a STEADY `base` level (optionally eased via `rampBase`), and
 *    - transient BURSTS that decay back to 0.
 *
 *  AUTO-BURST (`setAuto`) realises the "low percentage = occasional bursts"
 *  behaviour: given an intensity p it spawns bursts at random, both their peak
 *  coverage AND how often they appear scaling with p (see config.glitch.burst).
 *
 *  One instance is shared by the boot sequence (which choreographs it) and the
 *  new-shape discovery flash. It is ticked once per frame from the main loop.
 * =============================================================================
 */

interface Burst {
  start: number; // performance.now() when it began
  duration: number; // ms it decays over
  peak: number; // coverage at start (decays linearly to 0)
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// --- value noise (for clustered, drifting corruption) ------------------------

/** Deterministic hash of an integer lattice point → [0,1). */
function hash3(x: number, y: number, z: number): number {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 1274126177;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number): number => t * t * (3 - 2 * t); // smoothstep
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Trilinearly-interpolated value noise in [0,1] — smooth blobs that the time
 *  axis (z) drifts/morphs through. */
function valueNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
  const c00 = lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), xf);
  const c10 = lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), xf);
  const c01 = lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), xf);
  const c11 = lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), xf);
  return lerp(lerp(c00, c10, yf), lerp(c01, c11, yf), zf);
}

export class GlitchOverlay {
  private readonly el: HTMLPreElement;

  private base = 0; // settled steady coverage
  private rampFrom = 0;
  private rampTo = 0;
  private rampStart = 0;
  private rampDur = 0; // >0 while a base ramp is in progress

  private bursts: Burst[] = [];
  private auto = 0; // auto-burst intensity (0 = disabled)
  private nextAuto = 0; // performance.now() of the next scheduled auto burst

  private lastRefresh = 0;
  private rendered = false; // whether the element currently holds any glyphs

  constructor(
    private readonly screen: Screen,
    parent: HTMLElement,
  ) {
    this.el = document.createElement("pre");
    this.el.className = "gui glitch";
    parent.appendChild(this.el);
  }

  /** Set the steady coverage immediately (cancels any in-progress ramp). */
  setBase(level: number): void {
    this.base = clamp01(level);
    this.rampDur = 0;
  }

  /** Ease the steady coverage to `target` over `seconds`. */
  rampBase(target: number, seconds: number): void {
    if (seconds <= 0) return this.setBase(target);
    this.rampFrom = this.currentBase(performance.now());
    this.rampTo = clamp01(target);
    this.rampStart = performance.now();
    this.rampDur = seconds * 1000;
  }

  /** Enable (p>0) or disable (p=0) random auto-bursts at intensity p. */
  setAuto(p: number): void {
    this.auto = clamp01(p);
    this.nextAuto = 0; // reschedule from now
  }

  /** Fire a single transient burst that decays from `peak` over `seconds`. */
  burst(peak: number, seconds: number): void {
    this.bursts.push({
      start: performance.now(),
      duration: Math.max(1, seconds * 1000),
      peak: clamp01(peak),
    });
  }

  /** Stop everything and clear the screen. */
  clear(): void {
    this.base = this.rampFrom = this.rampTo = 0;
    this.rampDur = 0;
    this.auto = 0;
    this.nextAuto = 0;
    this.bursts = [];
    this.el.textContent = "";
    this.rendered = false;
  }

  private currentBase(now: number): number {
    if (this.rampDur <= 0) return this.base;
    const k = Math.min(1, (now - this.rampStart) / this.rampDur);
    return this.rampFrom + (this.rampTo - this.rampFrom) * k;
  }

  /** Gap (ms) until the next auto-burst: rarer at low intensity, with jitter. */
  private autoGap(): number {
    const b = config.glitch.burst;
    const gap = b.maxGapMs + (b.minGapMs - b.maxGapMs) * this.auto;
    return gap * (0.5 + Math.random());
  }

  /** Advance and render. Call once per frame with the current time. */
  tick(now: number): void {
    if (!config.glitch.enabled) return;

    // Settle the base ramp.
    const base = this.currentBase(now);
    if (this.rampDur > 0 && now - this.rampStart >= this.rampDur) {
      this.base = this.rampTo;
      this.rampDur = 0;
    }

    // Schedule + spawn auto-bursts.
    if (this.auto > 0) {
      if (this.nextAuto === 0) this.nextAuto = now + this.autoGap();
      if (now >= this.nextAuto) {
        const b = config.glitch.burst;
        this.bursts.push({
          start: now,
          duration: b.minBurstMs + Math.random() * (b.maxBurstMs - b.minBurstMs),
          peak: clamp01(this.auto * b.peakScale),
        });
        this.nextAuto = now + this.autoGap();
      }
    }

    // Collect burst coverage (decay linearly) and drop expired bursts.
    let burstCov = 0;
    this.bursts = this.bursts.filter((bn) => {
      const t = (now - bn.start) / bn.duration;
      if (t >= 1) return false;
      burstCov = Math.max(burstCov, bn.peak * (1 - t));
      return true;
    });

    const coverage = clamp01(Math.max(base, burstCov));

    if (coverage <= 0) {
      if (this.rendered) {
        this.el.textContent = "";
        this.rendered = false;
      }
      this.lastRefresh = now;
      return;
    }
    if (now - this.lastRefresh < config.glitch.refreshMs) return;
    this.lastRefresh = now;
    this.render(coverage, now);
  }

  /**
   * The (drifting) noise field defines the BLOBS — the boundaries within which
   * corruption is allowed (noise below `coverage`). WITHIN those boundaries the
   * speckle keeps the original flat per-cell density (`random < coverage`), so
   * the clusters look exactly as dense as the old uniform effect did — just
   * confined to clumps instead of spread across the whole screen.
   */
  private render(coverage: number, now: number): void {
    const { cols, rows } = this.screen;
    const chars = config.glitch.chars;
    const n = chars.length;
    const { scale, timeScale } = config.glitch.noise;
    const z = (now / 1000) * timeScale;
    let out = "";
    for (let r = 0; r < rows; r++) {
      let line = "";
      for (let c = 0; c < cols; c++) {
        const inBlob = valueNoise(c / scale, r / scale, z) < coverage;
        const on = inBlob && Math.random() < coverage;
        line += on ? chars[(Math.random() * n) | 0] : " ";
      }
      out += r < rows - 1 ? line + "\n" : line;
    }
    this.el.textContent = out;
    this.rendered = true;
  }
}
