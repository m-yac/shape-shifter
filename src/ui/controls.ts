/**
 * =============================================================================
 *  TERMINAL CONTROLS — reusable buttons + radio groups for the character grid.
 * =============================================================================
 *
 *  Two widgets, both landing on whole character cells:
 *
 *    makeActionButton — a momentary button framed as `[X]` / `[Browse]` (the
 *      brackets are added here): white by default, the selection accent while
 *      held, fires on click.
 *    makeRadioGroup   — a mutually-exclusive selector backed by
 *      <input type="radio"> elements (the Form / Colors lines). Captions are
 *      bare; the chosen option shows an inverted lit block, and a held option
 *      shows that block in the selection accent. Options can be press-and-held,
 *      e.g. to keep the solver relaxing.
 *
 *  The selection accent is `--select` (config.render.selectedColor, set in
 *  ui/screen.ts); the lit-block styling lives in style.css (`.ctl*`).
 * =============================================================================
 */

/** Wrap a caption in the action-button `[caption]` frame. */
const bracket = (caption: string): string => `[${caption}]`;

export interface ActionButton {
  readonly el: HTMLElement;
}

/**
 * A momentary action button rendered as `[caption]`. `onClick` fires on a real
 * click, so a press that slides off and releases elsewhere does nothing. The
 * `.pressed` class tracks the held state for the accent color.
 */
export function makeActionButton(caption: string, onClick: () => void): ActionButton {
  const el = document.createElement("span");
  el.className = "ctl ctl-btn";
  el.textContent = bracket(caption);

  const setPressed = (p: boolean): void => {
    el.classList.toggle("pressed", p);
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    setPressed(true);
  });
  // A release anywhere clears the held look; only `click` (down+up on the
  // element) fires the callback, as with a normal button.
  window.addEventListener("pointerup", () => setPressed(false));
  window.addEventListener("pointercancel", () => setPressed(false));
  el.addEventListener("click", () => onClick());
  return { el };
}

export interface RadioGroup {
  /** The inline container holding the option labels. */
  readonly el: HTMLElement;
  /** Mark `value` as the chosen option (reflects external state changes). */
  setChecked(value: string): void;
  /** Toggle the dimmer half-pressed look on the chosen option, e.g. while a
   *  solve started by it is still running. */
  setRunning(running: boolean): void;
}

export interface RadioOpts {
  /** The radio `name` shared by the group's <input> elements. */
  name: string;
  /** value → caption, rendered bare (no brackets). */
  options: Record<string, string>;
  /** Fired on pointerdown of an option; the option is already marked checked when
   *  this runs. The press-and-hold Form line uses it to start relaxing. */
  onPress?: (value: string) => void;
  /** Fired when the press ends (pointerup / cancel anywhere). */
  onRelease?: (value: string) => void;
}

/**
 * A radio selector group. Each option is a `<label>` wrapping a hidden
 * `<input type="radio">` plus its caption; the labels are separated by one space
 * so the row stays on the character grid. The accent shows while an option is
 * held; the chosen option keeps the lit-block look.
 */
export function makeRadioGroup(opts: RadioOpts): RadioGroup {
  const el = document.createElement("span");
  el.className = "ctl-radio-group";

  const labels: Record<string, HTMLElement> = {};
  const inputs: Record<string, HTMLInputElement> = {};
  let pressedValue: string | null = null;

  const entries = Object.entries(opts.options);
  entries.forEach(([value, caption], i) => {
    const label = document.createElement("label");
    label.className = "ctl ctl-radio";
    label.dataset.label = caption; // the copy the lit-block ::before/::after draw

    const input = document.createElement("input");
    input.type = "radio";
    input.name = opts.name;
    input.value = value;
    label.append(input, document.createTextNode(caption));

    label.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pressedValue = value;
      label.classList.add("pressed");
      setChecked(value);
      opts.onPress?.(value);
    });

    labels[value] = label;
    inputs[value] = input;
    el.append(label);
    if (i < entries.length - 1) el.append(document.createTextNode(" "));
  });

  const endPress = (): void => {
    if (pressedValue === null) return;
    const value = pressedValue;
    pressedValue = null;
    labels[value]?.classList.remove("pressed");
    opts.onRelease?.(value);
  };
  window.addEventListener("pointerup", endPress);
  window.addEventListener("pointercancel", endPress);

  function setChecked(value: string): void {
    for (const [v, label] of Object.entries(labels)) {
      const on = v === value;
      label.classList.toggle("checked", on);
      inputs[v].checked = on;
    }
  }

  function setRunning(running: boolean): void {
    for (const label of Object.values(labels)) {
      label.classList.toggle("running", running && label.classList.contains("checked"));
    }
  }

  return { el, setChecked, setRunning };
}
