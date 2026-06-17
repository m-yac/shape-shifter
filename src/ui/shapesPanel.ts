import { config } from "../config";
import { type Strategy } from "../solver/solver";
import { Screen, Popup, fadeIn } from "./screen";

// Keys into `config.ui.optionsPanel`. Each named line is wired up to a specific
// purpose here (the library count / the strategy buttons); the DOM + width
// generation below, however, is generic over whatever lines the config holds,
// so new `label: text` / `label: buttons` lines can be added without touching
// the layout code.
const LIBRARY_KEY = "libraryLine";
const REGULAR_KEY = "regularLine";

/**
 * Top-left OPTIONS panel: a small box-drawing popup pinned to the top-left
 * corner. Its lines come straight from `config.ui.optionsPanel`; today that is:
 *   Library: N/250 shapes  — how many of the (eventual 250) shapes are found
 *   Regular: [buttons]     — the three regularization-strategy buttons
 * Each line renders as "Label: <content>", where content is either a templated
 * text run or a row of buttons. The strategy buttons switch the solver's
 * objective (vertices / edges / faces) for future shapes AND re-solve the
 * current one immediately. The active button is shown "pressed" (inverted);
 * while its solve is still running it shows a dimmer "half-pressed" state.
 */
export class ShapesPanel {
  private readonly popup: Popup;
  // Built generically from the config; keyed by the config line key.
  private readonly rowEls: HTMLElement[] = [];
  private readonly textEls: Record<string, HTMLElement> = {};
  private readonly buttonEls: Record<string, Record<string, HTMLElement>> = {};
  private visible = false;
  private count = 0;
  private strategy: Strategy = config.solver.defaultStrategy;
  private solving = false;
  // The button currently held down (line + button key), or null.
  private pressed: { lineKey: string; btnKey: string } | null = null;
  private onPress: (s: Strategy) => void = () => {};
  private onRelease: () => void = () => {};
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

    // Generic layout: one row per config line, each "Label: <content>". A line
    // is a text run (templated) or a row of buttons — no per-line special cases.
    for (const [key, line] of Object.entries(config.ui.optionsPanel)) {
      const row = document.createElement("div");
      row.className = "options-line";
      row.append(document.createTextNode(`${line.label}: `));

      if ("text" in line) {
        const span = document.createElement("span");
        span.textContent = line.text; // filled in by render() (template substitution)
        row.append(span);
        this.textEls[key] = span;
      } else {
        const map: Record<string, HTMLElement> = {};
        const entries = Object.entries(line.buttons);
        // Space-separated so each button stays a whole number of cells wide and
        // they remain aligned on the character grid.
        entries.forEach(([btnKey, caption], i) => {
          const el = this.makeButton(key, btnKey, caption);
          map[btnKey] = el;
          row.append(el);
          if (i < entries.length - 1) row.append(document.createTextNode(" "));
        });
        this.buttonEls[key] = map;
      }

      this.rowEls.push(row);
      body.append(row);
    }

    this.popup.body.appendChild(body);
    // Let a pressed button's bloom spill past the body instead of being clipped.
    this.popup.body.style.overflow = "visible";
    this.popup.mount();
    this.popup.el.style.display = "none"; // hidden until the first operation
    this.render();
    this.refreshButtons();
    screen.onLayout(() => this.popup.placeAt(0, 0));

    // A release anywhere ends the hold (the pointer may have left the button).
    const release = () => this.releaseButton();
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
  }

  /** A single grid-aligned button. Press-and-hold: pointerdown starts the hold,
   *  the window-level pointerup ends it (so releasing off the button still
   *  stops). preventDefault keeps the caption from being text-selected on a
   *  drag. The button's meaning is dispatched by key in `pressButton`. */
  private makeButton(lineKey: string, btnKey: string, caption: string): HTMLElement {
    const el = document.createElement("span");
    el.className = "opt-btn";
    el.textContent = caption;
    el.dataset.label = caption; // the ::after inner-glow copy reads this
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.pressButton(lineKey, btnKey);
    });
    return el;
  }

  // Press/release wiring. The press/hold mechanics are generic; what a press
  // *means* is keyed: only the regular line drives the solver strategy.
  private pressButton(lineKey: string, btnKey: string): void {
    this.pressed = { lineKey, btnKey };
    if (lineKey === REGULAR_KEY) this.onPress(btnKey as Strategy);
  }

  private releaseButton(): void {
    if (this.pressed === null) return;
    const wasRegular = this.pressed.lineKey === REGULAR_KEY;
    this.pressed = null;
    if (wasRegular) this.onRelease();
  }

  /** Wire the press / release handlers. Press switches strategy and starts the
   *  relaxation; it keeps stepping until release (the DragController enforces a
   *  minimum run time so a single click still does something). */
  bindStrategy(onPress: (s: Strategy) => void, onRelease: () => void): void {
    this.onPress = onPress;
    this.onRelease = onRelease;
  }

  /** Update the discovered-shape count shown on the "Library:" line. */
  setCount(n: number): void {
    if (n === this.count) return;
    this.count = n;
    this.render();
  }

  /** Mark which strategy button is the active one (pressed). */
  setActiveStrategy(s: Strategy): void {
    if (s === this.strategy) return;
    this.strategy = s;
    this.refreshButtons();
  }

  /** Toggle the "half-pressed" (solve-in-progress) state on the active button. */
  setSolving(solving: boolean): void {
    if (solving === this.solving) return;
    this.solving = solving;
    this.refreshButtons();
  }

  private refreshButtons(): void {
    const map = this.buttonEls[REGULAR_KEY];
    if (!map) return;
    for (const key of Object.keys(map)) {
      const el = map[key];
      const active = key === this.strategy;
      el.classList.toggle("active", active);
      el.classList.toggle("running", active && this.solving);
    }
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
