import { led } from "./led";

/**
 * =============================================================================
 *  BEZEL CONTROLS — the labels + plastic buttons on the bottom bezel.
 * =============================================================================
 *
 *  The monitor's bottom plastic strip (the extra `padding-bottom` on #bezel)
 *  carries a small control panel, styled like the silkscreen labels and molded
 *  buttons on an old computer monitor:
 *
 *    left:   [red activity LED]  [ Help & Info ]
 *    right:  Save  [ PNG ]  [ STL ]
 *
 *  The LED belongs to the `led` singleton; this builds and registers its element.
 *  The buttons fire the callbacks passed in.
 * =============================================================================
 */

export interface BezelControlHandlers {
  onHelp: () => void;
  onSavePng: () => void;
  onSaveStl: () => void;
}

export class BezelControls {
  /** The Help & Info button, exposed so the help dialog can tell a click on it
   *  apart from a click-anywhere-to-dismiss. */
  readonly helpButton: HTMLElement;

  constructor(bezel: HTMLElement, handlers: BezelControlHandlers) {
    const bar = document.createElement("div");
    bar.className = "bezel-controls";

    // Left group: the activity LED + the Help & Info button.
    const left = document.createElement("div");
    left.className = "bezel-group";
    const ledEl = document.createElement("div");
    ledEl.className = "led";
    led.setElement(ledEl);
    this.helpButton = this.button("Help & Info", handlers.onHelp);
    left.append(ledEl, this.helpButton);

    // Right group: the "Save" label + the PNG / STL buttons.
    const right = document.createElement("div");
    right.className = "bezel-group";
    const label = document.createElement("span");
    label.className = "bezel-label";
    label.textContent = "Save:";
    right.append(
      label,
      this.button("PNG", handlers.onSavePng),
      this.button("STL", handlers.onSaveStl),
    );

    bar.append(left, right);
    bezel.appendChild(bar);
  }

  private button(text: string, onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "bezel-btn";
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }
}
