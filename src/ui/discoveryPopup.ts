import { config } from "../config";
import { type SolidType } from "../data/namedPolyhedra";
import { Screen, Popup, centered, fadeIn, fadeOut } from "./screen";

/**
 * The centered congratulations popup shown when a new shape is discovered. It
 * names the shape and its solid family, shows the running N/250 count, and
 * auto-dismisses (config.discovery.popupHoldS) or on click. The first discovery
 * of the run gets a different banner.
 */
export class DiscoveryPopup {
  private popup: Popup | null = null;
  private timer = 0;
  // Bound once so add/removeEventListener pair up. Any click or key press
  // anywhere dismisses the popup (same inputs that skip the intro in main.ts).
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key.length == 1 || e.key == "Escape") this.dismiss();
  };
  private readonly onPointer = (): void => this.dismiss();

  constructor(private readonly screen: Screen) {}

  show(name: string, type: SolidType, count: number, first: boolean): void {
    this.dismiss(); // never stack two popups

    const cfg = config.ui.discoveryPopup;
    const banner = first ? cfg.bannerFirst : cfg.banner;
    const fill = (s: string): string =>
      s
        .replace("{banner}", banner)
        .replace("{name}", name)
        .replace("{type}", type)
        .replace("{count}", String(count))
        .replace("{total}", String(config.discovery.total));
    const lines = cfg.lines.map(fill);

    const inner = Math.max(...lines.map((l) => l.length)) + 4;
    const cols = Math.min(this.screen.cols, inner + 2);
    const rows = Math.min(this.screen.rows, lines.length + 2);

    const popup = new Popup(this.screen, { cols, rows, title: config.ui.titles.discovery, style: "double" });
    popup.el.classList.add("discovery-popup");
    const body = document.createElement("div");
    body.className = "popup-resize discovery-text";
    body.textContent = lines.map((l) => centered(l, cols - 2)).join("\n");
    popup.body.appendChild(body);
    popup.mount().center();
    fadeIn(popup.el, 0.4);
    this.popup = popup;
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("pointerup", this.onPointer);

    if (config.discovery.popupHoldS > 0) {
      this.timer = window.setTimeout(
        () => this.dismiss(),
        config.discovery.popupHoldS * 1000,
      );
    }
  }

  dismiss(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = 0;
    }
    if (!this.popup) return;
    const p = this.popup;
    this.popup = null;
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("pointerup", this.onPointer);
    fadeOut(p.el, 0.3);
    window.setTimeout(() => p.remove(), 320);
  }
}
