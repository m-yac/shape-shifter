import { config } from "../config";
import { type Strategy } from "../solver/solver";
import { Screen, Popup, fadeIn } from "./screen";
import { makeActionButton, makeRadioGroup, type RadioGroup } from "./controls";

// Keys into `config.ui.optionsPanel`. Only these three lines are wired to a
// behaviour; the DOM + width generation below is generic over whatever lines the
// config holds.
const LIBRARY_KEY = "libraryLine";
const FORM_KEY = "formLine";
const COLORS_KEY = "colorsLine";

type RGB = [number, number, number];

/** Parse a `#rgb` / `#rrggbb` string to an [r,g,b] triple (0..255). */
function parseHex(hex: string): RGB {
  const h = hex.trim().replace("#", "");
  const s = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const n = parseInt(s || "ffffff", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function lerpRGB(a: RGB, b: RGB, k: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

const rgbCss = ([r, g, b]: RGB): string => `rgb(${r}, ${g}, ${b})`;

/**
 * Top-left OPTIONS panel: a small box-drawing popup pinned to the top-left
 * corner. Its lines come from `config.ui.optionsPanel`:
 *   Library: N/99 shapes [Browse]   — count + the browse action button
 *   Form:    [Canonical] [Regular] …  — solver-strategy radio group (press-and-hold)
 *   Colors:  [Tetra] [Octa] …         — color-scheme radio group (instant select)
 * The widgets themselves (action buttons + radio groups) come from ui/controls.
 */
export class ShapesPanel {
  private readonly popup: Popup;
  private readonly rowEls: HTMLElement[] = [];
  private readonly textEls: Record<string, HTMLElement> = {};
  private readonly radios: Record<string, RadioGroup> = {};
  private visible = false;
  private count = 0;
  // Shapes discovered since the browser was last opened, shown as "Browse (N new)".
  private newCount = 0;
  private browseBtn: HTMLElement | null = null;
  private flashRaf = 0;
  private flashHovered = false;
  private strategy: Strategy = config.solver.defaultStrategy;
  private colorScheme: string = config.colors.defaultScheme;
  private solving = false;
  private onPress: (s: Strategy) => void = () => {};
  private onRelease: () => void = () => {};
  private onColorScheme: (name: string) => void = () => {};
  private onBrowse: () => void = () => {};
  /** Height of the panel in rows (one per config line + the two border rows),
   *  so neighbours can avoid overlapping it. */
  readonly rows = 2 + Object.keys(config.ui.optionsPanel).length;

  constructor(screen: Screen) {
    this.popup = new Popup(screen, {
      cols: 16,
      rows: this.rows,
      title: config.ui.titles.shapes,
    });

    const body = document.createElement("div");
    body.className = "options-body";

    // One row per config line, each "Label: <content>", where content is any of
    // templated text, momentary action buttons, and a radio selector group.
    for (const [key, line] of Object.entries(config.ui.optionsPanel)) {
      const row = document.createElement("div");
      row.className = "options-line";
      row.append(document.createTextNode(`${line.label}: `));

      if ("text" in line) {
        const span = document.createElement("span");
        span.textContent = line.text; // filled in by render() (template substitution)
        row.append(span);
        this.textEls[key] = span;
      }
      if ("buttons" in line) {
        if ("text" in line) row.append(document.createTextNode(" "));
        const entries = Object.entries(line.buttons);
        entries.forEach(([btnKey, caption], i) => {
          const btn = makeActionButton(caption, () => this.onButton(key, btnKey));
          if (key === LIBRARY_KEY && btnKey === "browse") {
            this.browseBtn = btn.el;
            // Hovering cancels the new-shape flash and pins the hover color: the
            // CSS :hover rule takes over once the inline color is cleared.
            btn.el.addEventListener("mouseenter", () => {
              this.flashHovered = true;
              cancelAnimationFrame(this.flashRaf);
              this.clearFlashStyle();
            });
            btn.el.addEventListener("mouseleave", () => {
              this.flashHovered = false;
            });
          }
          row.append(btn.el);
          if (i < entries.length - 1) row.append(document.createTextNode(" "));
        });
      }
      if ("radios" in line) {
        const group = makeRadioGroup({
          name: key,
          options: line.radios,
          onPress: (v) => this.onRadioPress(key, v),
          onRelease: () => this.onRadioRelease(key),
        });
        this.radios[key] = group;
        row.append(group.el);
      }

      this.rowEls.push(row);
      body.append(row);
    }

    this.popup.body.appendChild(body);
    // Let a pressed control's bloom spill past the body instead of being clipped.
    this.popup.body.style.overflow = "visible";
    this.popup.mount();
    this.popup.el.style.display = "none"; // hidden until the first operation
    this.radios[FORM_KEY]?.setChecked(this.strategy);
    this.radios[COLORS_KEY]?.setChecked(this.colorScheme);
    this.render();
    screen.onLayout(() => this.popup.placeAt(0, 0));
  }

  // What a control press does, dispatched by line: the Form radios drive the
  // solver strategy (press-and-hold keeps relaxing until release), the Colors
  // radios pick a scheme, and the Library button opens the diagram.
  private onRadioPress(lineKey: string, value: string): void {
    if (lineKey === FORM_KEY) {
      this.strategy = value as Strategy;
      this.onPress(value as Strategy);
    } else if (lineKey === COLORS_KEY) {
      this.colorScheme = value;
      this.onColorScheme(value);
    }
  }

  private onRadioRelease(lineKey: string): void {
    if (lineKey === FORM_KEY) this.onRelease();
  }

  private onButton(lineKey: string, btnKey: string): void {
    if (lineKey === LIBRARY_KEY && btnKey === "browse") {
      // Opening the browser clears the "(N new)" badge.
      if (this.newCount !== 0) {
        this.newCount = 0;
        this.updateBrowseLabel();
      }
      this.onBrowse();
    }
  }

  /** Note that a new shape was discovered: bump the "(N new)" badge and flash the
   *  Browse button to its hover color, decaying back to normal. */
  markNew(): void {
    this.newCount++;
    this.updateBrowseLabel();
    this.startFlash();
  }

  /** Re-caption the Browse button as "Browse" or "Browse (N new)" and re-fit. */
  private updateBrowseLabel(): void {
    if (!this.browseBtn) return;
    const base = config.ui.optionsPanel.libraryLine.buttons.browse;
    const label = this.newCount > 0 ? `${base} (${this.newCount} new)` : base;
    this.browseBtn.textContent = `[${label}]`;
    this.render();
  }

  private clearFlashStyle(): void {
    if (!this.browseBtn) return;
    this.browseBtn.style.color = "";
    this.browseBtn.style.textShadow = "";
  }

  /** Flash the Browse button to the hover color, then ease back to normal over
   *  `newFlashSeconds`. Hovering cancels it (see the mouseenter handler). */
  private startFlash(): void {
    const el = this.browseBtn;
    if (!el) return;
    cancelAnimationFrame(this.flashRaf);
    if (this.flashHovered) return; // hover already shows the accent
    const cs = getComputedStyle(document.documentElement);
    const select = parseHex(cs.getPropertyValue("--select") || "#5ad7ff");
    const text = parseHex(cs.getPropertyValue("--text") || "#ffffff");
    const glowSelect = cs.getPropertyValue("--glow-select").trim();
    const durMs = Math.max(1, config.ui.optionsPanel.libraryLine.newFlashSeconds * 1000);
    const start = performance.now();
    const step = (now: number): void => {
      if (this.flashHovered) {
        this.clearFlashStyle();
        return;
      }
      const k = Math.min(1, (now - start) / durMs);
      el.style.color = rgbCss(lerpRGB(select, text, k));
      el.style.textShadow = k < 1 ? glowSelect : "";
      if (k < 1) this.flashRaf = requestAnimationFrame(step);
      else this.clearFlashStyle();
    };
    el.style.color = rgbCss(select);
    el.style.textShadow = glowSelect;
    this.flashRaf = requestAnimationFrame(step);
  }

  /** Wire the strategy press / release handlers. Press switches strategy and
   *  starts the relaxation; it keeps stepping until release. */
  bindStrategy(onPress: (s: Strategy) => void, onRelease: () => void): void {
    this.onPress = onPress;
    this.onRelease = onRelease;
  }

  /** Wire the color-scheme selection handler (fired on each Colors-line press). */
  bindColorScheme(onSelect: (name: string) => void): void {
    this.onColorScheme = onSelect;
  }

  /** Wire the "Browse" button (opens the full-screen LIBRARY diagram). */
  bindBrowse(onBrowse: () => void): void {
    this.onBrowse = onBrowse;
  }

  /** Mark which color scheme is the active one. */
  setActiveColorScheme(name: string): void {
    if (name === this.colorScheme) return;
    this.colorScheme = name;
    this.radios[COLORS_KEY]?.setChecked(name);
  }

  /** Update the discovered-shape count shown on the "Library:" line. */
  setCount(n: number): void {
    if (n === this.count) return;
    this.count = n;
    this.render();
  }

  /** Mark which strategy is the active one. */
  setActiveStrategy(s: Strategy): void {
    if (s === this.strategy) return;
    this.strategy = s;
    this.radios[FORM_KEY]?.setChecked(s);
  }

  /** Toggle the "half-pressed" (solve-in-progress) state on the active strategy. */
  setSolving(solving: boolean): void {
    if (solving === this.solving) return;
    this.solving = solving;
    this.radios[FORM_KEY]?.setRunning(solving);
  }

  /** Re-fill the templated library line and re-fit the frame (width follows the
   *  widest row, measured in characters so the frame hugs the content). */
  private render(): void {
    const lib = this.textEls[LIBRARY_KEY];
    if (lib) {
      lib.textContent = config.ui.optionsPanel.libraryLine.text
        .replace("{count}", String(this.count))
        .replace("{total}", String(config.discovery.total));
    }
    let inner = 0;
    for (const row of this.rowEls) inner = Math.max(inner, row.textContent?.length ?? 0);
    this.popup.resize(inner + 2, this.rows);
    this.popup.placeAt(0, 0);
  }

  /** Reveal the panel (called after the user's first operation, or on skip). */
  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.popup.el.style.display = "";
    fadeIn(this.popup.el);
  }

  /** Rows it occupies while visible (0 while hidden), so the SELECTION readout
   *  below it can avoid overlapping. */
  reservedRows(): number {
    return this.visible ? this.rows : 0;
  }
}
