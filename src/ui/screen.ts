import { config } from "../config";

/**
 * =============================================================================
 *  THE SCREEN — a centered vintage monitor and its character grid.
 * =============================================================================
 *
 *  The app draws onto a "screen" (the glass of the monitor) that is smaller than the
 *  browser window and wrapped in a plastic "bezel". The screen interior is
 *  always sized to a whole number of character cells from the AST PremiumExec
 *  font drawn at 2x — one cell is `colW` x `rowH` px (16 x 38). Because the
 *  interior is an exact multiple of the cell size and every text element uses a
 *  cell-sized font (line-height = rowH, advance = colW), anything positioned
 *  with the helpers here lands on the same grid as the text, giving the illusion
 *  of a uniform grid of characters even though we use ordinary CSS divs.
 *
 *  Helpers:
 *    - place / placeAnchored        position an element on the grid
 *    - centered / fit               pad text to a column width
 *    - boxLines                     build a box-drawing frame as text
 *    - Popup                        a grid-positioned bordered box with a
 *                                   scrollable interior (for dialogs / panels)
 * =============================================================================
 */

const { colW, rowH } = config.screen;

export interface CellPos {
  left: number;
  top: number;
}

/** Largest multiple of `step` that is <= value (but at least one step). */
function floorTo(value: number, step: number): number {
  return Math.max(step, Math.floor(value / step) * step);
}

/** Parse a "#rrggbb" color into an "r, g, b" string (for rgba() in the glow). */
export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

/** Like "hexToRgb" but adds the inverse of the second string */
export function hexToRgbAddInv(hex: string, hexToInv: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const rToInv = parseInt(hexToInv.slice(1, 3), 16);
  const gToInv = parseInt(hexToInv.slice(3, 5), 16);
  const bToInv = parseInt(hexToInv.slice(5, 7), 16);
  const rOut = Math.min(255, r + 255 - rToInv);
  const gOut = Math.min(255, g + 255 - gToInv);
  const bOut = Math.min(255, b + 255 - bToInv);
  return `${rOut}, ${gOut}, ${bOut}`;
}

/**
 * A layered text-shadow that fakes the glass bloom on selectable text: a tight
 * bright core plus a wide soft halo. Both scale with `intensity` — the same knob
 * that drives the 3D UnrealBloom (config.theme.bloom.intensity) — so the text and
 * the 3D view glow by the same amount. `rgb` is "r, g, b" and is the TEXT's own
 * color, so darker text yields a dimmer, smaller-looking bloom automatically.
 */
export function textGlow(intensity: number, rgb: string): string {
  if (intensity <= 0) return "none";
  const core = `0 0 ${(2.2 * intensity).toFixed(2)}px rgba(${rgb}, ${Math.min(0.85, 0.55 * intensity).toFixed(2)})`;
  const halo = `0 0 ${(8 * intensity).toFixed(2)}px rgba(${rgb}, ${Math.min(0.6, 0.32 * intensity).toFixed(2)})`;
  return `${core}, ${halo}`;
}

// --- fade helpers ------------------------------------------------------------

/** Fade an element in from transparent: snap to opacity 0, then transition to 1.
 *  (Used for the popups appearing at the end of the intro.) */
export function fadeIn(el: HTMLElement, seconds = 0.5): void {
  el.style.transition = "none";
  el.style.opacity = "0";
  void el.offsetWidth; // force a reflow so the opacity change actually animates
  el.style.transition = `opacity ${seconds}s ease`;
  el.style.opacity = "1";
}

/** Fade an element out to transparent, then hide it once the transition ends. */
export function fadeOut(el: HTMLElement, seconds = 0.5): void {
  el.style.transition = `opacity ${seconds}s ease`;
  el.style.opacity = "0";
  window.setTimeout(() => {
    el.style.display = "none";
  }, seconds * 1000);
}

// --- text helpers -----------------------------------------------------------

/** Pad (or truncate) `text` to exactly `width` columns, centered. */
export function centered(text: string, width: number, fill = " "): string {
  if (text.length >= width) return text.slice(0, width);
  const total = width - text.length;
  const left = Math.floor(total / 2);
  return fill.repeat(left) + text + fill.repeat(total - left);
}

/** Pad (or truncate) `text` to exactly `width` columns, left-justified. */
export function fit(text: string, width: number, fill = " "): string {
  return text.length >= width
    ? text.slice(0, width)
    : text + fill.repeat(width - text.length);
}

export type BoxStyle = "single" | "double";

const BORDER: Record<BoxStyle, Record<string, string>> = {
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
};

/**
 * A box-drawing frame `w` columns x `h` rows, returned as `h` strings each
 * exactly `w` characters wide. The interior is blank by default (so the frame
 * can sit behind separately-positioned content), or filled line-by-line from
 * `body`. An optional `title` is centered in the top border.
 */
export function boxLines(
  w: number,
  h: number,
  opts: { title?: string; style?: BoxStyle; body?: string[] } = {},
): string[] {
  const b = BORDER[opts.style ?? "single"];
  const inner = Math.max(0, w - 2);
  const top = opts.title
    ? b.tl + centered(` ${opts.title} `, inner, b.h) + b.tr
    : b.tl + b.h.repeat(inner) + b.tr;
  const lines = [top];
  for (let r = 0; r < h - 2; r++) {
    lines.push(b.v + fit(opts.body?.[r] ?? "", inner) + b.v);
  }
  if (h >= 2) lines.push(b.bl + b.h.repeat(inner) + b.br);
  return lines;
}

// --- the screen -------------------------------------------------------------

type LayoutCb = (screen: Screen) => void;

/**
 * Owns the bezel + glass elements and the grid math. Call `layout()` on resize;
 * subscribers (the renderer, the panels) are notified so they can re-fit and
 * re-place themselves onto the freshly-sized grid.
 */
export class Screen {
  cols = 0; // interior width  in character cells
  rows = 0; // interior height in character cells
  width = 0; // interior width  in px (cols * colW)
  height = 0; // interior height in px (rows * rowH)

  readonly colW = colW;
  readonly rowH = rowH;

  private readonly cbs: LayoutCb[] = [];

  constructor(
    readonly bezel: HTMLElement,
    readonly el: HTMLElement, // the glass; the grid origin (0,0) is its top-left
  ) {
    this.applyTheme();
    window.addEventListener("resize", () => this.layout());
  }

  /** Register a callback run now and on every (re)layout. */
  onLayout(cb: LayoutCb): void {
    this.cbs.push(cb);
    cb(this);
  }

  /** Re-fit the grid to the largest whole-cell rectangle the window allows. */
  layout(): void {
    const { viewportMargin: m, bezel: frame, extraBezelBottom: extraBot, padding: pad } = config.screen;
    const availW = window.innerWidth - 2 * (m + frame + pad);
    const availH = window.innerHeight - 2 * (m + frame + pad) - extraBot;
    this.width = floorTo(availW, colW);
    this.height = floorTo(availH, rowH);
    this.cols = Math.round(this.width / colW);
    this.rows = Math.round(this.height / rowH);
    this.el.style.width = `${this.width}px`;
    this.el.style.height = `${this.height}px`;
    for (const cb of this.cbs) cb(this);
  }

  /** Pixel top-left of a grid cell. Negative indices count from the far edge. */
  cell(col: number, row: number): CellPos {
    const c = col < 0 ? this.cols + col : col;
    const r = row < 0 ? this.rows + row : row;
    return { left: c * colW, top: r * rowH };
  }

  /** Place an element's top-left at a grid cell (col/row may be negative). */
  place(el: HTMLElement, col: number, row: number): void {
    const { left, top } = this.cell(col, row);
    el.style.position = "absolute";
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.right = "";
    el.style.bottom = "";
  }

  /**
   * Anchor an element to a screen corner on the grid: `padCols`/`padRows` cells
   * of inset from the chosen edges. Bottom/right anchoring lets the element grow
   * toward the corner while staying cell-aligned.
   */
  placeAnchored(
    el: HTMLElement,
    corner: "tl" | "tr" | "bl" | "br",
    padCols = 0,
    padRows = 0,
  ): void {
    el.style.position = "absolute";
    el.style.left = el.style.right = el.style.top = el.style.bottom = "";
    const x = `${padCols * colW}px`;
    const y = `${padRows * rowH}px`;
    if (corner === "tl" || corner === "bl") el.style.left = x;
    else el.style.right = x;
    if (corner === "tl" || corner === "tr") el.style.top = y;
    else el.style.bottom = y;
  }

  private applyTheme(): void {
    const t = config.theme;
    const root = document.documentElement.style;
    root.setProperty("--text", t.text);
    root.setProperty("--text-bright", t.textBright);
    root.setProperty("--text-dim", t.textDim);
    root.setProperty("--text-warn", t.textWarn);
    // Each text tone glows in its OWN color, so the bloom tracks the text instead
    // of a single fixed tint (darker tones bloom less). The matching --text-* var
    // is paired with each --text* color in style.css.
    const i = t.bloom.intensity;
    // Raw "r, g, b" tones too, for effects that build their own rgba() (e.g. the
    // OPTIONS buttons' inner glow on their dark glyphs).
    root.setProperty("--text-rgb", hexToRgb(t.text));
    root.setProperty("--text-dim-rgb", hexToRgb(t.textDim));
    root.setProperty("--glow", textGlow(i, hexToRgb(t.text)));
    root.setProperty("--glow-bright", textGlow(i, hexToRgb(t.textBright)));
    root.setProperty("--glow-dim", textGlow(i, hexToRgb(t.textDim)));
    root.setProperty("--glow-warn", textGlow(i, hexToRgb(t.textWarn)));
    // The interactive-control accent: the same color the 3D selection turns
    // (config.render.selectedColor), used for pressed buttons / held radios.
    const selectHex = "#" + config.render.selectedColor.toString(16).padStart(6, "0");
    root.setProperty("--select", selectHex);
    root.setProperty("--glow-select", textGlow(i, hexToRgb(selectHex)));
    root.setProperty("--glow-inv", textGlow(2*i, hexToRgbAddInv(t.backlight, t.text)));
    // The select-colored variant of --glow-inv, for a held radio's inverted
    // "lit block" rendered in the selection accent (same shift trick, vs --select).
    root.setProperty("--glow-select-inv", textGlow(2*i, hexToRgbAddInv(t.backlight, selectHex)));
    root.setProperty("--glow-dim-inv", textGlow(2*i, hexToRgbAddInv(t.backlight, t.textDim)));
    root.setProperty("--glitch-color", config.glitch.color);
    root.setProperty("--backlight", t.backlight);
    root.setProperty("--glass", t.glass);
    root.setProperty("--room", t.room);
    root.setProperty("--bezel-light", t.bezelLight);
    root.setProperty("--bezel-dark", t.bezelDark);
    root.setProperty("--cell-w", `${colW}px`);
    root.setProperty("--cell-h", `${rowH}px`);
    root.setProperty("--font-px", `${config.screen.fontPx}px`);
    root.setProperty("--screen-pad", `${config.screen.padding}px`);
    root.setProperty("--pixel-size", `${t.pixelSize}px`);
    root.setProperty("--pixel-opacity", t.pixelMask ? `${t.pixelOpacity}` : "0");
    document.documentElement.setAttribute("data-pixel-mask", t.pixelMaskStyle);
    root.setProperty("--vignette-opacity", t.vignette ? `${t.vignetteOpacity}` : "0");
    this.bezel.style.padding = `${config.screen.bezel}px`;
    const botPad = config.screen.bezel + config.screen.extraBezelBottom;
    this.bezel.style.paddingBottom = `${botPad}px`;
    // Expose the frame thickness + bottom strip so the bottom-bezel controls
    // (ui/bezelControls.ts) can position themselves in the plastic below the glass.
    root.setProperty("--bezel-frame", `${config.screen.bezel}px`);
    root.setProperty("--bezel-bottom", `${botPad}px`);
  }
}

// --- popups ------------------------------------------------------------------

export interface PopupOpts {
  cols: number;
  rows: number;
  title?: string;
  style?: BoxStyle;
}

/**
 * A bordered box positioned on the grid. The border is a `<pre>` of box-drawing
 * characters (one per cell), and the interior is a separate, inset content area
 * that scrolls if it overflows — so the frame stays crisp on the grid while the
 * contents behave like normal HTML. Use for dialogs and panels.
 */
export class Popup {
  readonly el: HTMLElement; // outer, grid-positioned
  readonly body: HTMLElement; // inner content area (inset 1 cell on every side)
  private readonly frame: HTMLElement;

  constructor(
    private readonly screen: Screen,
    private opts: PopupOpts,
  ) {
    this.el = document.createElement("div");
    this.el.className = "popup gui";

    this.frame = document.createElement("pre");
    this.frame.className = "popup-frame";

    this.body = document.createElement("div");
    this.body.className = "popup-body";

    this.el.append(this.frame, this.body);
    this.resize(opts.cols, opts.rows);
  }

  /** Re-draw the frame and size the inner area for `cols` x `rows` cells. */
  resize(cols: number, rows: number): void {
    this.opts = { ...this.opts, cols, rows };
    this.el.style.width = `${cols * colW}px`;
    this.el.style.height = `${rows * rowH}px`;
    this.frame.textContent = boxLines(cols, rows, {
      title: this.opts.title,
      style: this.opts.style,
    }).join("\n");
    // Inset the body one cell on every side so it sits inside the border.
    this.body.style.left = `${colW}px`;
    this.body.style.top = `${rowH}px`;
    this.body.style.width = `${(cols - 2) * colW}px`;
    this.body.style.height = `${(rows - 2) * rowH}px`;
  }

  placeAt(col: number, row: number): this {
    this.screen.place(this.el, col, row);
    return this;
  }

  /** Center the popup on the grid (rounded to whole cells). */
  center(): this {
    const col = Math.floor((this.screen.cols - this.opts.cols) / 2);
    const row = Math.floor((this.screen.rows - this.opts.rows) / 2);
    return this.placeAt(Math.max(0, col), Math.max(0, row));
  }

  mount(parent: HTMLElement = this.screen.el): this {
    parent.appendChild(this.el);
    return this;
  }

  remove(): void {
    this.el.remove();
  }
}
