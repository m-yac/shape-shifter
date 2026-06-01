import { config } from "../config";
import { Console } from "../ui/console";
import { Screen } from "../ui/screen";
import { GlitchOverlay } from "../ui/glitch";

/**
 * =============================================================================
 *  BOOT SEQUENCE — a faux 90s VGA BIOS power-on, then a program launch.
 * =============================================================================
 *
 *  Played in the #console overlay while the app starts up. The names are
 *  quietly geometry-themed (a "Vertex" CPU, a "Symmetry Coprocessor", drives
 *  called TESSERACT...) so it reads like the BIOS of a machine built to do
 *  nothing but fold polyhedra.
 *
 *  The whole thing is written as a generator "script": each `yield <seconds>`
 *  is a pause before the next beat, so the sequence below reads top-to-bottom
 *  like a storyboard. `update()` advances that script against the wall clock
 *  and returns true once it has finished.
 * =============================================================================
 */

/** A scripted step. Each `yield n` waits `n` seconds before resuming. */
type Script = Generator<number, void, unknown>;

/** The object form of a boot step (see BootStep). */
interface BootLine {
  kind?:
    | "pause"
    | "memory"
    | "check"
    | "command"
    | "load"
    | "glitch"
    | "clear" // wipe the screen
    | "reveal" // clear + go transparent + fade in + show cursor (the closing setup)
    | "shape" // start the 3D shape fading in behind the text (fires onFadeIn)
    | "vcenter"; // pad with blank lines so the printed lines BELOW it are centered
  text?: string;
  center?: boolean; // type this line out from the horizontal center
  lnAfterDelay?: boolean;
  delay?: number; // extra pause (s) after this step
  totalK?: number; // "memory": count up to this many KB
  checkMin?: number; // minimum wait time for an OK
  checkRange?: number; // range of wait times for an OK
  prompt?: string; // "command": text printed before the typed command
  ok?: boolean; // "load": OK vs ERR
  wait?: number; // "load": seconds before the result appears
  // "glitch": drive the corruption overlay (see ui/glitch.ts). `level` sets the
  // steady coverage (eased over `ramp` seconds if given); `auto` enables random
  // bursts at that intensity; `burst` fires one transient burst (over `burstS`).
  level?: number;
  ramp?: number;
  auto?: number;
  burst?: number;
  burstS?: number;
}

/** Step kinds that don't print a line of their own (so vcenter can count the
 *  printed rows that follow it). */
const CONTROL_KINDS = new Set(["pause", "glitch", "clear", "reveal", "shape", "vcenter"]);

/** How many printed rows a run of steps produces (each text/centered line is one
 *  row; control-only steps produce none). Used by the "vcenter" step. */
function countRows(steps: readonly BootStep[]): number {
  let rows = 0;
  for (const raw of steps) {
    const kind = typeof raw === "string" ? undefined : raw.kind;
    if (!kind || !CONTROL_KINDS.has(kind)) rows++;
  }
  return rows;
}

/** One entry in a boot screen's list (config.bootText). A bare string is a
 *  printed line; the object form adds a `kind` and/or a trailing `delay`. */
type BootStep = string | BootLine;

export class BootSequence {
  private readonly con: Console;
  private readonly gen: Script;
  private waitUntil = 0;
  private finished = false;

  /**
   * @param el      the #console overlay.
   * @param screen  for the on-screen size (line scrolling + centered text).
   * @param onFadeIn called once, near the end, when the 3D shape should begin
   *                 fading in behind the closing message.
   */
  constructor(
    el: HTMLElement,
    private readonly screen: Screen,
    private readonly glitch: GlitchOverlay,
    private readonly onFadeIn: () => void,
  ) {
    this.con = new Console(el, () => this.screen.rows);
    this.gen = this.run();
  }

  /** Advance the timeline. Returns true once the whole boot has finished. */
  update(): boolean {
    if (this.finished) return true;
    const now = performance.now();
    this.con.tick(now);
    // Run every step whose pause has elapsed. Zero-second yields chain in the
    // same frame; a real pause re-bases waitUntil off `now`, so a slow frame
    // never fast-forwards through the script.
    while (now >= this.waitUntil) {
      const res = this.gen.next();
      if (res.done) {
        this.finished = true;
        break;
      }
      this.waitUntil = now + Math.max(0, (res.value ?? 0) * 1000);
    }
    return this.finished;
  }

  // --- the script -----------------------------------------------------------

  private *run(): Script {
    // All three screens are plain step lists played the same way; the structural
    // beats (clearing the screen, revealing the 3D view, centering, the shape
    // fade-in, the glitch choreography) are expressed as steps in config.bootText.
    yield* this.playScript(config.bootText.bios);
    yield* this.playScript(config.bootText.program);
    yield* this.playScript(config.bootText.closing);
  }

  /** Play one screen's list of steps top-to-bottom (see config.bootText). A bare
   *  string is a printed line; an object's `kind` selects a special beat, and
   *  `delay` (if any) is an extra pause after the step. */
  private *playScript(steps: readonly BootStep[]): Script {
    const c = this.con;
    let shapeNum = 0; // running index for "load" entries

    for (let idx = 0; idx < steps.length; idx++) {
      const raw = steps[idx];
      const step: BootLine = typeof raw === "string" ? { text: raw } : raw;
      const text = step.text ?? "";

      switch (step.kind) {
        case "pause":
          break; // text-less beat; only its `delay` matters
        case "memory":
          c.print(text);
          yield* this.memoryCount(text, step.totalK ?? 0);
          c.println();
          break;
        case "check":
          yield* this.check(text, step.checkMin ?? 0, step.checkRange ?? 0.25);
          break;
        case "command":
          c.print(step.prompt ?? "");
          yield 0.5;
          yield* this.type(text);
          yield 0.3;
          c.println(); // the Enter keystroke
          break;
        case "load":
          yield* this.loadShape(++shapeNum, text, step.ok ?? false, step.wait ?? 0);
          break;
        case "glitch":
          if (step.level !== undefined) this.glitch.rampBase(step.level, step.ramp ?? 0);
          if (step.auto !== undefined) this.glitch.setAuto(step.auto);
          if (step.burst !== undefined) this.glitch.burst(step.burst, step.burstS ?? 0.3);
          break;
        case "clear":
          c.clear();
          break;
        case "reveal":
          c.clear();
          c.setBackground("transparent"); // reveal the 3D view behind the text
          c.fadeIn(); // soft entrance for the closing message
          c.showCursor(true);
          break;
        case "shape":
          this.onFadeIn(); // the 3D shape starts fading in behind the message
          break;
        case "vcenter": {
          // Pad with blank rows so the printed lines that FOLLOW are vertically
          // centered on the screen.
          const rows = countRows(steps.slice(idx + 1));
          const top = Math.max(0, Math.floor((this.screen.rows - rows) / 2));
          for (let i = 0; i < top; i++) c.println();
          break;
        }
        default:
          shapeNum = 0;
          if (step.center) {
            yield* this.typeCentered(text); // grows out from the center, then a newline
          } else {
            c.println(text);
          }
      }

      if (step.delay) yield step.delay;
      if (step.lnAfterDelay) c.println();
    }
  }

  // --- reusable beats -------------------------------------------------------

  /** Count a memory figure up in 2 MB-ish steps on the current line, then OK. */
  private *memoryCount(label: string, totalK: number): Script {
    const step = 2048;
    for (let k = step; k < totalK; k += step) {
      this.con.setLine(`${label}${k}K`);
      yield 0.03;
    }
    this.con.setLine(`${label}${totalK}K  OK`);
  }

  /** "Label ............." then a beat, then "[ OK ]" on the same line. */
  private *check(label: string, min: number, range: number): Script {
    const leader = ".".repeat(Math.max(3, 36 - label.length));
    this.con.print(`${label} ${leader} `);
    yield min + Math.random() * range;
    this.con.println("[ OK ]");
    yield 0.06;
  }

  /** One shape-library entry: "NNN  Name ....." then OK or ERR after `wait`s. */
  private *loadShape(n: number, name: string, ok: boolean, wait: number): Script {
    const label = `${String(n).padStart(3, "0")}  ${name}`;
    const dots = Math.max(3, 30 - label.length);
    this.con.print(`  ${label} `);
    for (let i = 0; i < dots;) {
      let inc = Math.floor(1 + Math.random() * 3);
      if (i+inc >= dots) inc = dots-1-i;
      if (inc == 0) break;
      this.con.print(".".repeat(inc));
      yield wait * inc / dots;
      i += inc;
    }
    this.con.println(ok ? " [ SUCCESS ]" : " [ FAILURE ]");
    yield 0.15;
  }

  /** "Type" `text` one character at a time with a slightly irregular cadence. */
  private *type(text: string): Script {
    for (const ch of text) {
      this.con.print(ch);
      yield 0.05 + Math.random() * 0.07;
    }
  }

  /** Type `text` starting from a horizontally-centered column (it grows out from
   *  the center, ending up centered on the line). */
  private *typeCentered(text: string): Script {
    const pad = Math.max(0, Math.floor((this.screen.cols - text.length) / 2));
    this.con.print(" ".repeat(pad));
    yield* this.type(text);
  }
}
