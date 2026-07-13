/**
 * =============================================================================
 *  LED — the bottom-bezel activity indicator.
 * =============================================================================
 *
 *  A red lamp on the bottom bezel, like the disk-activity light on an old
 *  computer: lit while idle, flicked off for one frame whenever something
 *  happens (a character printed, a drag move), so it blinks rapidly during the
 *  boot text and while dragging. Dark until `powerOn`, called by the intro.
 *
 *  A module-level singleton, so any module can `pulse()` it without threading a
 *  reference through every constructor.
 * =============================================================================
 */
class Led {
  private el: HTMLElement | null = null;
  private powered = false; // dark until the monitor's power-on flash
  private on = false; // current lamp state
  private pending = false; // activity happened since the last tick

  /** Attach the lamp element (built by the bezel controls) and sync its state. */
  setElement(el: HTMLElement): void {
    this.el = el;
    this.apply();
  }

  /** Light the lamp for the first time, together with the screen's power-on flash. */
  powerOn(): void {
    this.powered = true;
    this.on = true;
    this.apply();
  }

  /** Note that something happened this frame (a printed char, a drag move). */
  pulse(): void {
    if (this.powered) this.pending = true;
  }

  /**
   * Apply one frame of the blink. No pulses: stays lit. One pulse: one frame dark,
   * then lit again. Continuous pulses (dragging): alternates every frame.
   */
  tick(): void {
    if (!this.powered) return;
    if (this.pending && this.on) this.on = false;
    else this.on = true;
    this.pending = false;
    this.apply();
  }

  private apply(): void {
    if (this.el) this.el.classList.toggle("on", this.powered && this.on);
  }
}

export const led = new Led();
