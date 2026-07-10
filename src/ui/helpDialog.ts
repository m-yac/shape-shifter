import { config } from "../config";
import { Screen, Popup, fadeIn, fadeOut } from "./screen";

/** Greedy word-wrap to at most `width` columns. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!cur) cur = word;
    else if ((cur + " " + word).length <= width) cur += " " + word;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Which blurb the dialog shows: the main-screen controls, or the LIBRARY map. */
export type HelpVariant = "main" | "library";

/**
 * The bottom-bezel "Help & Info" popup. On the main screen it explains the
 * controls; while the LIBRARY browse screen is open it explains the map instead.
 * Centered over everything (above the library too), with a solid backlight
 * backing. Pressing the Help button again (or Escape) closes it.
 */
export class HelpDialog {
  private popup: Popup | null = null;
  private toggleButton: HTMLElement | null = null;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.dismiss();
  };
  // Any click closes the dialog — except a click on the Help button itself, which
  // the button's own toggle handles (so it doesn't dismiss-then-reopen).
  private readonly onPointer = (e: PointerEvent): void => {
    const t = e.target as Node | null;
    if (this.toggleButton && t && this.toggleButton.contains(t)) return;
    this.dismiss();
  };

  constructor(private readonly screen: Screen) {}

  /** Tell the dialog which button toggles it, so clicks on it aren't treated as
   *  click-anywhere-to-dismiss. */
  setToggleButton(el: HTMLElement): void {
    this.toggleButton = el;
  }

  /** Open the dialog for `variant`, or close it if it's already showing. */
  toggle(variant: HelpVariant = "main"): void {
    if (this.popup) this.dismiss();
    else this.show(variant);
  }

  show(variant: HelpVariant = "main"): void {
    if (this.popup) return;
    const base = config.ui.helpDialog;
    const cfg = variant === "library" ? base.library : base;
    const width = Math.min(base.wrapCols, this.screen.cols - 4);
    const lines = [...wrapText(cfg.intro, width), "", ...cfg.operations];

    const maxLen = Math.max(width, ...lines.map((l) => l.length));
    const cols = Math.min(this.screen.cols, maxLen + 4);
    const rows = Math.min(this.screen.rows, lines.length + 2);

    const popup = new Popup(this.screen, {
      cols,
      rows,
      title: config.ui.titles.help,
      style: "double",
      opaque: true,
    });
    popup.el.classList.add("help-popup");
    const body = document.createElement("div");
    body.className = "popup-resize help-text";
    body.textContent = lines.join("\n");
    popup.body.appendChild(body);
    popup.mount().center();
    fadeIn(popup.el, 0.3);
    this.popup = popup;
    // Attached synchronously: this runs from the Help button's `click`, which fires
    // AFTER its `pointerup`, so the opening gesture never reaches this listener.
    window.addEventListener("keyup", this.onKey);
    window.addEventListener("pointerup", this.onPointer);
  }

  dismiss(): void {
    const p = this.popup;
    if (!p) return;
    this.popup = null;
    window.removeEventListener("keyup", this.onKey);
    window.removeEventListener("pointerup", this.onPointer);
    fadeOut(p.el, 0.25);
    window.setTimeout(() => p.remove(), 260);
  }
}
