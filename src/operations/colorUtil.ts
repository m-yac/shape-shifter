import { Color } from "three";
import { type GeomColor, paletteRGB } from "../geometry/colors";

/**
 * Shared color-propagation helpers for the Conway operations. Each operation reads
 * the OLD `ColorSet` and assigns geometric-color TRIPLES to the new elements per
 * the rules in `config.colors.operations` (see geometry/colors.ts). A new element
 * either INHERITS an old element's triple directly (e.g. a kis apex ← its face's
 * color) or is a COMBINATION of several old triples, evaluated by `combine`.
 */

/** The old-element triples a rule's tokens resolve against, for one new element.
 *  The caller supplies the specific neighbor for each token (incl. any "nth" one). */
export type ColorSources = Record<string, GeomColor | undefined>;

/** A combination rule (as stored in config.colors.operations): a map from each old
 *  token to the coefficient its triple is weighted by. */
export type ColorRule = Readonly<Record<string, number>>;

/** The only tokens a combination rule (in config.colors.operations) may contain.
 *  Everything that reads the rules — `combine`, `dualRule` — depends on this exact
 *  set, so both validate against it and throw a descriptive error on anything else. */
export const COLOR_TOKENS = ["oldVertex", "oldFace", "oldEdge"] as const;
const TOKEN_SET = new Set<string>(COLOR_TOKENS);

/**
 * The DUAL of a combination rule: the same tokens (with their coefficients) but the
 * vertex/face roles exchanged (`oldVertex`↔`oldFace`; `oldEdge` maps to itself). Kis /
 * join / gyro / chamfer are the exact polyhedral duals of truncate / rectify / snub /
 * subdivide, so their color rules are NOT stored in config — each is derived here
 * from its primal. Under duality a new element's role flips too (a vertex↔a face,
 * an edge stays an edge), so the caller pairs each dual element with the PRIMAL
 * element it mirrors and dualizes that rule: e.g. a kis apex (a new vertex) reads
 * `dualRule(truncate.newFace)`, and a kis triangle (a new face) reads
 * `dualRule(truncate.newVertex)`. The caller likewise supplies sources with the
 * roles already swapped (an `oldFace` source where the primal used `oldVertex`).
 */
export function dualRule(rule: ColorRule): ColorRule {
  const out: Record<string, number> = {};
  for (const [tok, coeff] of Object.entries(rule)) {
    if (!TOKEN_SET.has(tok)) {
      throw new Error(
        `dualRule: unknown color-rule token "${tok}" (rule = ${JSON.stringify(rule)}). ` +
          `Rules in config.colors.operations may only use ${COLOR_TOKENS.join(", ")}.`,
      );
    }
    const dual = tok === "oldVertex" ? "oldFace" : tok === "oldFace" ? "oldVertex" : tok;
    out[dual] = coeff;
  }
  return out;
}

/**
 * Evaluate a combination rule against its sources: the weighted sum of each token's
 * triple by that token's coefficient. Returns the resulting geometric-color triple.
 *
 * STRICT on form: the rule may only contain `COLOR_TOKENS`, and the caller MUST
 * supply a source for every token the rule uses. A rule token with no matching
 * source key throws (rather than silently contributing zero) — that mismatch means
 * a call site and its config rule have diverged (e.g. a rule gained a token the
 * caller doesn't provide), which would otherwise drop part of the color unnoticed.
 * `label` (an operation.rule name) is included in the message to locate the culprit.
 */
export function combine(rule: ColorRule, src: ColorSources, label?: string): GeomColor {
  const where = label ? ` for '${label}'` : "";
  const out: number[] = [];
  for (const [tok, coeff] of Object.entries(rule)) {
    if (!TOKEN_SET.has(tok)) {
      throw new Error(
        `combine: unknown color-rule token "${tok}"${where} (rule = ${JSON.stringify(rule)}). ` +
          `Rules in config.colors.operations may only use ${COLOR_TOKENS.join(", ")}.`,
      );
    }
    if (!(tok in src)) {
      throw new Error(
        `combine: color rule${where} references "${tok}" but the call site provided no ` +
          `source for it (provided: ${Object.keys(src).join(", ") || "none"}; rule = ` +
          `${JSON.stringify(rule)}). Supply this token at the call site, or update the rule.`,
      );
    }
    // ID vectors are variable length (a one-hot is length 14; a `[0,0,0]` fallback is
    // shorter). Accumulate component-wise over the longest, treating missing entries as 0.
    const c = src[tok] ?? [];
    for (let i = 0; i < c.length; i++) out[i] = (out[i] ?? 0) + c[i] * coeff;
  }
  return out;
}

/**
 * Two-segment per-face color for an "intermediate" drag (truncate / kis / subdivide):
 * the solid reads as the ORIGINAL solid at t=0, its named intermediate form (the
 * truncation / kis / subdivision) at t=0.5, and the welded Rectify / Join at t=1. So
 * each face lerps `orig`→`mid` across [0, 0.5] then `mid`→`end` across [0.5, 1]. When
 * `weld` is set (the drag has latched the Rectify/Join max) the `end` color is shown
 * exactly — matching the committed weld colors so releasing is seamless.
 */
export function stagedFaceColors(
  orig: GeomColor[],
  mid: GeomColor[],
  end: GeomColor[],
  t: number,
  weld?: boolean,
): Color[] {
  if (weld) return end.map((c) => paletteRGB(c));
  const k = Math.max(0, Math.min(1, t));
  const out: Color[] = new Array(orig.length);
  for (let i = 0; i < orig.length; i++) {
    out[i] =
      k <= 0.5
        ? paletteRGB(orig[i]).lerp(paletteRGB(mid[i]), k * 2)
        : paletteRGB(mid[i]).lerp(paletteRGB(end[i]), (k - 0.5) * 2);
  }
  return out;
}

/** Per-face RGB interpolated from each face's t=0 color to its limit color. */
export function lerpFaceColors(
  startCols: GeomColor[],
  endCols: GeomColor[],
  t: number,
): Color[] {
  const k = Math.max(0, Math.min(1, t));
  const out: Color[] = new Array(startCols.length);
  for (let i = 0; i < startCols.length; i++) {
    out[i] = paletteRGB(startCols[i]).lerp(paletteRGB(endCols[i]), k);
  }
  return out;
}
