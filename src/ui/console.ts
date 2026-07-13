/**
 * =============================================================================
 *  CONSOLE — a tiny text terminal over the #console overlay.
 * =============================================================================
 *
 *  The #console div sits above the 3D view and, on launch, plays the boot
 *  sequence (see interaction/bootSequence.ts). It holds a buffer of lines plus
 *  an optional blinking block cursor on the last line. Text is preformatted
 *  (`white-space: pre`), so a newline starts a new row and columns line up with
 *  the character grid.
 * =============================================================================
 */
import { fadeIn } from "./screen";
import { led } from "./led";

export class Console {
  private lines: string[] = [""];
  private cursorOn = true; // is the cursor shown at all
  private cursorLit = true; // current blink phase
  private lastBlink = 0;
  private readonly cursorChar = "█";

  /**
   * @param el       the overlay element to render into.
   * @param maxRows  how many rows fit on screen; once the buffer grows past it
   *                 the display scrolls, showing only the last `maxRows()` lines.
   *                 Defaults to unlimited.
   */
  constructor(
    private readonly el: HTMLElement,
    private readonly maxRows: () => number = () => Infinity,
  ) {
    this.render();
  }

  /** Wipe the screen back to a single empty line. */
  clear(): this {
    this.lines = [""];
    return this.render();
  }

  /** Append text to the current (last) line; embedded "\n"s start new rows. */
  print(text: string): this {
    led.pulse(); // flick the activity LED as characters appear
    const parts = text.split("\n");
    this.lines[this.lines.length - 1] += parts[0];
    for (let i = 1; i < parts.length; i++) this.lines.push(parts[i]);
    return this.render();
  }

  /** Append `text` (if any) then start a fresh line. */
  println(text = ""): this {
    return this.print(text + "\n");
  }

  /** Replace the text of the current (last) line, for in-place updates like a
   *  counter or a progress bar. */
  setLine(text: string): this {
    led.pulse();
    this.lines[this.lines.length - 1] = text;
    return this.render();
  }

  /** Show or hide the blinking cursor entirely. */
  showCursor(on: boolean): this {
    this.cursorOn = on;
    return this.render();
  }

  /** Advance the cursor blink. Call once per frame with the current time. */
  tick(nowMs: number, periodMs = 530): void {
    if (this.lastBlink === 0) this.lastBlink = nowMs;
    if (nowMs - this.lastBlink >= periodMs) {
      this.cursorLit = !this.cursorLit;
      this.lastBlink = nowMs;
      this.render();
    }
  }

  /** Set the overlay's background color (used for the CRT warm-up flash). */
  setBackground(css: string): void {
    this.el.style.backgroundColor = css;
  }

  /** Softly fade the whole console in (used for the closing message). */
  fadeIn(seconds = 0.8): void {
    fadeIn(this.el, seconds);
  }

  private render(): this {
    const out = this.lines.slice();
    if (this.cursorOn && this.cursorLit) {
      out[out.length - 1] += this.cursorChar;
    }
    // Scroll: show only the last `maxRows` lines, so text running off the bottom
    // pushes earlier lines up out of view.
    const max = this.maxRows();
    const visible = out.length > max ? out.slice(out.length - max) : out;
    this.el.textContent = visible.join("\n");
    return this;
  }
}
