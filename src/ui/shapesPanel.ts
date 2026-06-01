import { config } from "../config";
import { Screen, Popup, fadeIn } from "./screen";

/**
 * Top-left SHAPES panel: a small box-drawing popup pinned to the top-left
 * corner. It shows how many of the (eventual) 250 shapes have been found — the
 * count is driven by the discovery tracker via `setCount` — plus a (not-yet-
 * wired) browse affordance.
 */
export class ShapesPanel {
  private readonly popup: Popup;
  private readonly el: HTMLElement;
  private visible = false;
  private count = 0;
  /** Height of the panel in rows (so neighbours can avoid overlapping it). */
  readonly rows = 3;

  constructor(screen: Screen) {
    this.popup = new Popup(screen, { cols: 16, rows: this.rows, title: config.ui.titles.shapes });
    this.el = document.createElement("div");
    this.el.className = "popup-resize";
    this.popup.body.appendChild(this.el);
    this.popup.mount();
    this.popup.el.style.display = "none"; // hidden until the first operation
    this.render();
    screen.onLayout(() => this.popup.placeAt(0, 0));
  }

  /** Update the discovered-shape count shown as "N/250". */
  setCount(n: number): void {
    if (n === this.count) return;
    this.count = n;
    this.render();
  }

  /** Re-fill the body and re-fit the frame to it (the count changes width). */
  private render(): void {
    const body = config.ui.shapesPanel
      .replace("{count}", String(this.count))
      .replace("{total}", String(config.discovery.total));
    this.el.textContent = body;
    this.popup.resize(body.length + 2, this.rows);
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
