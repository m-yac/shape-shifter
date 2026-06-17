import { config } from "../config";
import { Screen } from "../ui/screen";

/**
 * =============================================================================
 *  LETTER INTRO — a worn typewritten letter that rises in before the program.
 * =============================================================================
 *
 *  On load a stack of letter pages (config.letterText) slides up quickly from
 *  below the monitor. The front page covers the center; the remaining pages peek
 *  out behind it (down and to the right). The reader can:
 *
 *    - click a peeking page, or the RIGHT edge of the front page  -> page forward
 *    - click the LEFT edge of the front page                      -> page back
 *    - click the CENTER of a page, or off to the side             -> put it away
 *
 *  The letter is mounted ON TOP of the whole monitor (above the plastic bezel)
 *  in a clipping layer the exact size of the bezel. "Putting it away" drops the
 *  stack down until it only covers the bottom bezel — the screen itself stays
 *  unobstructed — and lets the program boot (the `onDismiss` callback fires once,
 *  the first time). Clicking the peeking stack afterwards raises it again so the
 *  reader can keep paging; clicking the center / off the side drops it once more.
 *  The program keeps running underneath the whole time.
 *
 *  Every pointer interaction with the letter calls stopImmediatePropagation, so
 *  the global "any key/click skips the intro" handlers in main.ts never fire as
 *  a side effect of reading or dismissing the letter.
 * =============================================================================
 */

type Mode = "hidden" | "raised" | "dropped";

export class LetterIntro {
  private readonly layer: HTMLElement; // clips to the monitor; sits above the bezel
  private readonly wrap: HTMLElement; // the sliding stack
  private readonly backdrop: HTMLElement;
  private readonly pageEls: HTMLElement[] = [];

  private mode: Mode = "hidden";
  private front = 0;
  private dismissed = false; // has the program been started yet (first drop)?

  // Geometry, recomputed on every (re)layout (in monitor/layer coordinates).
  private layerH = 0;
  private raisedTop = 0;
  private droppedY = 0;

  constructor(
    private readonly screen: Screen,
    private readonly pages: readonly (readonly string[])[],
    private readonly onDismiss: () => void,
  ) {
    // A layer the size of the whole monitor, clipping the stack so the part that
    // slides below the monitor is hidden rather than spilling into the room.
    this.layer = document.createElement("div");
    this.layer.className = "letter-layer";

    // Transparent catcher behind the pages: a click on it ("off the side" of the
    // letter) puts the letter away. Only active while the letter is raised.
    this.backdrop = document.createElement("div");
    this.backdrop.className = "letter-backdrop";
    this.backdrop.addEventListener("pointerup", (e) => {
      e.stopImmediatePropagation();
      this.putAway();
    });

    // The sliding stack. The whole thing translates vertically (rise / drop);
    // each page inside it is offset to peek out from behind the front one.
    this.wrap = document.createElement("div");
    this.wrap.className = "letter-stack";

    this.pages.forEach((page, i) => {
      const el = document.createElement("div");
      el.className = "letter-page";
      for (const para of page) {
        const line = document.createElement("p");
        line.className = "letter-line";
        line.textContent = para;
        el.appendChild(line);
      }
      el.addEventListener("pointerup", (e) => {
        e.stopImmediatePropagation();
        this.onPageClick(i, e);
      });
      this.pageEls.push(el);
      this.wrap.appendChild(el);
    });

    this.layer.append(this.backdrop, this.wrap);
    // Mounted on the bezel (not inside the glass) so it rides above the whole
    // monitor and can cover the bottom bezel.
    this.screen.bezel.appendChild(this.layer);

    this.screen.onLayout(() => this.relayout());
    this.layoutPages();

    // Start fully below the monitor, then rise on the next frame so the initial
    // offscreen position isn't animated.
    this.setMode("hidden", 0);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.setMode("raised", config.letter.riseDurationS));
    });
  }

  /** Size + position the stack to the current monitor, and recompute the drop. */
  private relayout(): void {
    const L = config.letter;
    const w = this.screen.width;
    const h = this.screen.height;
    // The layer fills the bezel; its own box gives us the monitor dimensions.
    this.layerH = this.layer.clientHeight;

    const pw = Math.round(w * L.widthFrac);
    const ph = Math.round(h * L.heightFrac);
    this.raisedTop = Math.max(8, Math.round((this.layerH - ph) / 2));
    // Lowered: cover the bottom bezel (+ optional poke onto the glass), clipped
    // by the layer at the monitor's bottom edge.
    const peek = config.screen.bezel + L.peekExtraPx;
    this.droppedY = Math.max(0, this.layerH - this.raisedTop - peek);

    this.wrap.style.width = `${pw}px`;
    this.wrap.style.height = `${ph}px`;
    this.wrap.style.top = `${this.raisedTop}px`;

    // Re-apply the current offset without animating (resize shouldn't slide).
    this.setMode(this.mode, 0);
  }

  /** Apply each page's peek offset / stacking for the current `front` page. */
  private layoutPages(): void {
    const L = config.letter;
    const n = this.pageEls.length;
    this.pageEls.forEach((el, i) => {
      const rel = i - this.front;
      el.style.transform =
        `translate(${rel * L.peekX}px, ${rel * L.peekY}px) rotate(${rel * L.peekRotateDeg}deg)`;
      el.style.zIndex = `${n - Math.abs(rel)}`;
    });
  }

  /** Vertical offset (px) of the stack for a given mode. */
  private offsetFor(mode: Mode): number {
    if (mode === "raised") return 0;
    if (mode === "dropped") return this.droppedY;
    return (this.layerH || 2000) - this.raisedTop + config.screen.extraBezelBottom; // hidden: fully below
  }

  private setMode(mode: Mode, durationS: number): void {
    this.mode = mode;
    this.backdrop.style.pointerEvents = mode === "raised" ? "auto" : "none";
    this.wrap.style.transition = durationS > 0 ? `transform ${durationS}s cubic-bezier(.2,.8,.25,1)` : "none";
    this.wrap.style.transform = `translateX(-50%) translateY(${this.offsetFor(mode)}px)`;
  }

  /** Drop the stack to the bottom peek and (the first time) start the program. */
  private putAway(): void {
    if (this.mode === "dropped") return;
    if (!this.dismissed) {
      this.dismissed = true;
      this.onDismiss();
    }
    this.setMode("dropped", config.letter.dropDurationS);
  }

  private raise(): void {
    if (this.mode === "raised") return;
    this.setMode("raised", config.letter.dropDurationS);
  }

  private goTo(index: number): void {
    this.front = Math.max(0, Math.min(this.pageEls.length - 1, index));
    this.layoutPages();
  }

  private onPageClick(index: number, e: PointerEvent): void {
    // While dropped (peeking over the bottom bezel), any click on the stack
    // raises it back up so the reader can keep paging.
    if (this.mode !== "raised") {
      this.raise();
      return;
    }

    // A peeking page (not the front one): bring it to the front.
    if (index !== this.front) {
      this.goTo(index);
      return;
    }

    // The front page: left edge pages back, right edge pages forward, and the
    // center puts the letter away.
    const rect = this.pageEls[index].getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    const edge = config.letter.edgeZoneFrac;
    if (frac < edge) this.goTo(this.front - 1);
    else if (frac > 1 - edge) this.goTo(this.front + 1);
    else this.putAway();
  }
}
