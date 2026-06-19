import { config } from "../config";
import { type Strategy } from "../solver/solver";
import { Screen, Popup, fadeIn } from "./screen";
import { makeActionButton, makeRadioGroup, type RadioGroup } from "./controls";

// Keys into `config.ui.optionsPanel`. Each named line is wired to a specific
// purpose here; the DOM + width generation below is otherwise generic over
// whatever lines the config holds.
const LIBRARY_KEY = "libraryLine";
const REGULAR_KEY = "regularLine";
const COLORS_KEY = "colorsLine";

/**
 * Top-left OPTIONS panel: a small box-drawing popup pinned to the top-left
 * corner. Its lines come from `config.ui.optionsPanel`:
 *   Library: N/250 shapes [Browse]   — count + the browse action button
 *   Regular: [Canonical] [Faces] …    — solver-strategy radio group (press-and-hold)
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
  private strategy: Strategy = config.solver.defaultStrategy;
  private colorScheme: string = config.render.defaultColorScheme;
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
    this.radios[REGULAR_KEY]?.setChecked(this.strategy);
    this.radios[COLORS_KEY]?.setChecked(this.colorScheme);
    this.render();
    screen.onLayout(() => this.popup.placeAt(0, 0));
  }

  // What a control press *means*, dispatched by line. The Regular radios drive
  // the solver strategy (press-and-hold: keep relaxing until release); the
  // Colors radios pick a scheme (instant); the Library button opens the diagram.
  private onRadioPress(lineKey: string, value: string): void {
    if (lineKey === REGULAR_KEY) {
      this.strategy = value as Strategy;
      this.onPress(value as Strategy);
    } else if (lineKey === COLORS_KEY) {
      this.colorScheme = value;
      this.onColorScheme(value);
    }
  }

  private onRadioRelease(lineKey: string): void {
    if (lineKey === REGULAR_KEY) this.onRelease();
  }

  private onButton(lineKey: string, btnKey: string): void {
    if (lineKey === LIBRARY_KEY && btnKey === "browse") this.onBrowse();
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
    this.radios[REGULAR_KEY]?.setChecked(s);
  }

  /** Toggle the "half-pressed" (solve-in-progress) state on the active strategy. */
  setSolving(solving: boolean): void {
    if (solving === this.solving) return;
    this.solving = solving;
    this.radios[REGULAR_KEY]?.setRunning(solving);
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
