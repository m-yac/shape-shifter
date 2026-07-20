import { Color } from "three";
import { type ColorSet, type GeomColor, edgeKey, paletteRGB } from "../geometry/colors";
import { config } from "../config";

/**
 * Shared color-propagation helpers for the operations. Each operation reads the old
 * `ColorSet` and assigns geometric colors to the new elements per the rules in
 * `config.colors.operations` (see geometry/colors.ts). A new element either inherits an old
 * element's color directly (a kis apex takes its face's color) or is a combination of
 * several old ones, evaluated by `combine`.
 */

/** The old-element colors a rule's tokens resolve against, for one new element. The caller
 *  supplies the specific neighbor for each token, including any "nth" one. */
export type ColorSources = Record<string, GeomColor | undefined>;

/** A combination rule, as stored in config.colors.operations: a map from each old token to
 *  the coefficient its color is weighted by. */
export type ColorRule = Readonly<Record<string, number>>;

/** The only tokens a combination rule (in config.colors.operations) may contain. `combine`
 *  and `dualRule` both depend on this exact set, so both validate against it and throw a
 *  descriptive error on anything else. */
export const COLOR_TOKENS = ["oldVertex", "oldFace", "oldEdge"] as const;
const TOKEN_SET = new Set<string>(COLOR_TOKENS);

/**
 * The dual of a combination rule: the same tokens and coefficients, but with the
 * vertex/face roles exchanged (`oldVertex`↔`oldFace`; `oldEdge` maps to itself). Kis /
 * join / gyro / chamfer are the polyhedral duals of truncate / rectify / snub / subdivide,
 * so their color rules are not stored in config; each is derived here from its primal.
 * Under duality a new element's role flips too (a vertex↔a face, an edge stays an edge), so
 * the caller pairs each dual element with the primal element it mirrors and dualizes that
 * rule: a kis apex (a new vertex) reads `dualRule(truncate.newFace)`, and a kis triangle (a
 * new face) reads `dualRule(truncate.newVertex)`. The caller likewise supplies sources with
 * the roles already swapped (an `oldFace` source where the primal used `oldVertex`).
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
 * Evaluate a combination rule against its sources: the weighted sum of each token's color
 * by that token's coefficient.
 *
 * Strict on form: the rule may only contain `COLOR_TOKENS`, and the caller has to supply a
 * source for every token the rule uses. A rule token with no matching source key throws
 * rather than silently contributing zero, since that mismatch means a call site and its
 * config rule have diverged (a rule gained a token the caller doesn't provide), which would
 * otherwise drop part of the color unnoticed. `label` (an operation.rule name) is included
 * in the message to locate the culprit.
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
    // Id vectors are variable length (a one-hot is length 14; a `[0,0,0]` fallback is
    // shorter). Accumulate component-wise over the longest, treating missing entries as 0.
    const c = src[tok] ?? [];
    for (let i = 0; i < c.length; i++) out[i] = (out[i] ?? 0) + c[i] * coeff;
  }
  return out;
}

/**
 * Recolor a propellor (`pX`) so it comes out identical whichever twist reached it — the
 * whirl (off X's join) or the volute (off X's rectification). Both weld into the same
 * shape but color the new elements as duals of each other, so the two disagree (a whirl's
 * blade quad takes the color a volute gives a new vertex, and vice versa). Propellor is its
 * own dual, so it must be colored by rules that are symmetric under face↔vertex — the
 * `config.colors.operations.propellor` set — read against X's own faces / edges / vertices.
 *
 * The fix keys entirely off the elements both paths already agree on: a propellor keeps X's
 * faces (as n-gons), X's vertices, and X's edges (as the "over-edge" where each edge's two
 * blades meet), all at their own colors. Given which faces / vertices are those kept ones
 * (`keptFaceIds` / `keptVertIds` — everything else is new), every new element's color
 * follows from adjacency to the kept ones, so both paths produce the same result by
 * construction. Each new element neighbors kept elements of every kind, and we hand its rule
 * a source for each — an oldFace, an oldEdge, an oldVertex — so the config is free to weight
 * whichever it likes without changing this code. The neighbors, per element:
 *   - blade quad (a new face): one kept n-gon (oldFace), one over-edge (oldEdge), and the two
 *     kept vertices its over-edge corners slid off (oldVertex, their mean);
 *   - new vertex: its kept vertex (oldVertex), its over-edge (oldEdge), and the two kept
 *     n-gons the blades flanking its over-edge border (oldFace, their mean);
 *   - seam edge (kept n-gon ↔ blade): that n-gon (oldFace), the blade's over-edge (oldEdge),
 *     and the two kept vertices its ends slid off (oldVertex, their mean);
 *   - spoke edge (kept vertex ↔ new vertex): that vertex (oldVertex), the new vertex's
 *     over-edge (oldEdge), and the two kept n-gons the flanking blades border (oldFace, mean).
 * Blade/new-vertex and seam/spoke are dual pairs, so the whole set is symmetric under
 * face↔vertex, as a self-dual operation demands. Kept faces / vertices and the over-edges are
 * left exactly as they came in. Nothing here reads another new element's color, so the pass
 * is order-independent, and every paired source is a mean (order-independent, and a distinct
 * unordered pair per element) so both twists agree and ids stay unique.
 */
export function recolorPropellor(
  faces: number[][],
  colors: ColorSet,
  keptFaceIds: ReadonlySet<number>,
  keptVertIds: ReadonlySet<number>,
): ColorSet {
  const P = config.colors.operations.propellor;
  const isKeptV = (v: number) => keptVertIds.has(v);

  // Edge → the faces touching it (2 on a closed propellor), and each face's undirected
  // edge keys (in loop order).
  const faceOfEdge = new Map<string, number[]>();
  const edgesOfFace: string[][] = faces.map((loop, fi) => {
    const keys: string[] = [];
    for (let i = 0; i < loop.length; i++) {
      const k = edgeKey(loop[i], loop[(i + 1) % loop.length]);
      keys.push(k);
      (faceOfEdge.get(k) ?? faceOfEdge.set(k, []).get(k)!).push(fi);
    }
    return keys;
  });
  const otherFace = (key: string, fi: number): number | undefined =>
    (faceOfEdge.get(key) ?? []).find((g) => g !== fi);
  const isKeptF = (fi: number) => keptFaceIds.has(fi);

  // Each new vertex slides off exactly one kept vertex, reached by its lone spoke.
  const spokeVertOf = new Map<number, number>(); // new vertex → the kept vertex it slid off
  for (const [key] of faceOfEdge) {
    const [a, b] = key.split("_").map(Number);
    if (isKeptV(a) && !isKeptV(b)) spokeVertOf.set(b, a);
    else if (isKeptV(b) && !isKeptV(a)) spokeVertOf.set(a, b);
  }

  // Each blade borders exactly one kept n-gon, across its seam edge (its other new-new edge
  // is the over-edge, whose far side is the twin blade). Record that n-gon per blade.
  const keptFaceOfBlade = new Map<number, number>();
  faces.forEach((_, fi) => {
    if (isKeptF(fi)) return;
    for (const k of edgesOfFace[fi]) {
      const g = otherFace(k, fi);
      if (g !== undefined && isKeptF(g)) { keptFaceOfBlade.set(fi, g); break; }
    }
  });

  const face = colors.face.slice();
  const vertex = colors.vertex.slice();
  const edge = new Map(colors.edge);
  /** Componentwise mean of two id vectors (over the longer length). */
  const mean2 = (c: GeomColor, d: GeomColor): GeomColor => {
    const out: number[] = [];
    for (let i = 0; i < Math.max(c.length, d.length); i++) out[i] = ((c[i] ?? 0) + (d[i] ?? 0)) / 2;
    return out;
  };

  // Each new element sits amongst kept elements of every kind, so we offer a source for each
  // token — oldFace, oldEdge, oldVertex — and let its rule weight whichever it names. Where a
  // token maps to a pair of kept elements (e.g. two vertices, two n-gons), we pass their
  // mean, which is order-independent (so both twists agree) and distinct per element (so ids
  // stay unique).

  // A blade quad borders one kept n-gon and one over-edge; its two over-edge corners each
  // slid off a kept vertex.
  const overEdgeOfBlade = new Map<number, string>(); // blade → its over-edge key
  faces.forEach((loop, fi) => {
    if (isKeptF(fi)) return;
    const kf = keptFaceOfBlade.get(fi);
    let overKey: string | undefined;
    edgesOfFace[fi].forEach((k, i) => {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const g = otherFace(k, fi);
      if (!isKeptV(a) && !isKeptV(b) && !(g !== undefined && isKeptF(g))) overKey = k;
    });
    if (overKey === undefined || kf === undefined) return;
    overEdgeOfBlade.set(fi, overKey);
    const [oa, ob] = overKey.split("_").map(Number);
    const va = spokeVertOf.get(oa), vb = spokeVertOf.get(ob);
    const src: ColorSources = { oldFace: face[kf], oldEdge: edge.get(overKey)! };
    if (va !== undefined && vb !== undefined) src.oldVertex = mean2(vertex[va], vertex[vb]);
    face[fi] = combine(P.newFace, src, "propellor.newFace");
  });

  // A new vertex sits on one over-edge and one spoke to its kept vertex; the two blades
  // flanking its over-edge each border a kept n-gon.
  const overEdgeOf = new Map<number, string>(); // new vertex → its over-edge key
  for (const [key] of faceOfEdge) {
    const [a, b] = key.split("_").map(Number);
    if (isKeptV(a) || isKeptV(b)) continue;
    const [f0, f1] = faceOfEdge.get(key)!;
    if (isKeptF(f0) || isKeptF(f1)) continue; // a seam, not an over-edge
    overEdgeOf.set(a, key);
    overEdgeOf.set(b, key);
  }
  vertex.forEach((_, vi) => {
    if (isKeptV(vi)) return;
    const kv = spokeVertOf.get(vi);
    const oe = overEdgeOf.get(vi);
    if (kv === undefined || oe === undefined) return;
    const [g0, g1] = faceOfEdge.get(oe)!.map((g) => keptFaceOfBlade.get(g));
    const src: ColorSources = { oldVertex: vertex[kv], oldEdge: edge.get(oe)! };
    if (g0 !== undefined && g1 !== undefined) src.oldFace = mean2(face[g0], face[g1]);
    vertex[vi] = combine(P.newVert, src, "propellor.newVert");
  });

  // Edges: seam (kept n-gon ↔ blade) and spoke (kept vertex ↔ new vertex). Over-edges keep
  // their incoming (X-edge) color.
  for (const [key, faceList] of faceOfEdge) {
    const [a, b] = key.split("_").map(Number);
    const kept = faceList.filter(isKeptF);
    if (kept.length === 1 && !isKeptV(a) && !isKeptV(b)) {
      // Seam: borders one kept n-gon and the blade's over-edge; its two ends each slid off a
      // kept vertex.
      const blade = faceList.find((g) => !isKeptF(g));
      const overKey = blade !== undefined ? overEdgeOfBlade.get(blade) : undefined;
      const va = spokeVertOf.get(a), vb = spokeVertOf.get(b);
      if (overKey !== undefined) {
        const src: ColorSources = { oldFace: face[kept[0]], oldEdge: edge.get(overKey)! };
        if (va !== undefined && vb !== undefined) src.oldVertex = mean2(vertex[va], vertex[vb]);
        edge.set(key, combine(P.newFaceEdge, src, "propellor.newFaceEdge"));
      }
    } else if (kept.length === 0 && (isKeptV(a) || isKeptV(b))) {
      // Spoke: joins one kept vertex to a new vertex on its over-edge; the two blades it runs
      // between each border a kept n-gon.
      const kv = isKeptV(a) ? a : b;
      const nv = isKeptV(a) ? b : a;
      const overKey = overEdgeOf.get(nv);
      const [g0, g1] = faceList.map((g) => keptFaceOfBlade.get(g));
      if (overKey !== undefined) {
        const src: ColorSources = { oldVertex: vertex[kv], oldEdge: edge.get(overKey)! };
        if (g0 !== undefined && g1 !== undefined) src.oldFace = mean2(face[g0], face[g1]);
        edge.set(key, combine(P.newVertEdge, src, "propellor.newVertEdge"));
      }
    }
  }

  return { vertex, face, edge };
}

/**
 * Two-segment per-face color for an intermediate drag (truncate / kis / subdivide): the
 * solid reads as the original at t=0, as its named intermediate form (the truncation / kis
 * / subdivision) at t=0.5, and as the welded Rectify / Join at t=1. So each face lerps
 * `orig`→`mid` across [0, 0.5] then `mid`→`end` across [0.5, 1]. When `weld` is set (the
 * drag has latched the Rectify/Join max) the `end` color is shown exactly, matching the
 * committed weld colors so releasing doesn't jump.
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
