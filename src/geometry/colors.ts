import { Color } from "three";
import { formatHex } from "culori";
import { type Mesh } from "./HalfEdge";
import { getSeed } from "./seeds";
import { config } from "../config";

/**
 * A geometric color is an ID VECTOR (variable length): the tetrahedron's 14 elements
 * each get a distinct one-hot of length 14 (4 faces + 6 edges + 4 vertices), and every
 * other element's color is a weighted combination of those, produced by the Conway
 * operations via the rules in `config.colors.operations` (each rule maps old tokens to
 * the coefficients their vectors are weighted by). Every rule's weights sum to 1, so
 * every ID is a convex combination — barycentric coordinates over the tetrahedron's
 * elements, always summing to 1 (only the tetrahedron's own IDs are pure 0/1 one-hots).
 *
 * Coloring is separate: the ID vectors are grouped by `config.render.schemes`, and
 * every vector in a group renders as that group's named swatch (an entry of
 * `config.render.palette`). A computed vector that matches no group falls back to
 * `config.colors.defaultSwatch`.
 *
 * Edges are keyed by their undirected vertex-index pair (`edgeKey`). Vertex and
 * face colors are indexed by mesh vertex / face index. Faces (and edge lines) are
 * drawn; vertex colors are tracked so the operation rules can read them.
 */
export type GeomColor = readonly number[];

export interface ColorSet {
  vertex: GeomColor[];
  face: GeomColor[];
  edge: Map<string, GeomColor>;
}

export type SchemeName = keyof typeof config.render.schemes;
type SwatchName = keyof typeof config.render.palette;
/** A color in the OKLab perceptual space (the form the palette is stored in). */
type OKLab = { readonly l: number; readonly a: number; readonly b: number };
type PaletteEntry = { face: OKLab; l_face: OKLab };
type Group = { swatch: string; triples: ReadonlyArray<GeomColor> };

// The currently-selected color scheme. Switched by the OPTIONS "Colors" buttons
// (see ui/shapesPanel.ts → DragController.selectColorScheme); read by every
// geometric-color → RGB resolution below so a switch recolors the whole solid.
let currentScheme: SchemeName = config.colors.defaultScheme as SchemeName;

/** The active color scheme name. */
export function getColorScheme(): SchemeName {
  return currentScheme;
}

/** Switch the active color scheme (does not itself re-render — caller recolors). */
export function setColorScheme(name: SchemeName): void {
  currentScheme = name;
}

// --- geometric color (triple) → palette swatch resolution -------------------

/** A stable string key for an ID vector. The combination arithmetic yields exact
 *  decimals from the rule coefficients, so rounding to 3 dp matches a scheme entry
 *  robustly without floating-point drift. Trailing zeros are dropped so vectors of
 *  different lengths that agree on their leading entries (e.g. a padded one-hot and a
 *  short `[0,0,0]` fallback) key identically. */
function colorKey(c: GeomColor): string {
  const r = c.map((x) => Math.round(x * 1000));
  let end = r.length;
  while (end > 0 && r[end - 1] === 0) end--;
  return r.slice(0, end).join(",");
}

const defaultSwatch = config.colors.defaultSwatch as SwatchName;

// --- SYNTHESIZED SWATCH preprocessing (built here, NOT in the config) --------
//
// `config.render.palette` and each `config.colors.schemes[*]` are augmented with
// synthesized swatches/groups so a computed color that isn't a pure symmetry orbit still
// resolves to a sensible swatch instead of the default. Three kinds are added, each
// catching a different weighted combination the operation rules can produce, and each
// switched on/off by a `config.colors` knob (listed in precedence order — highest first):
//
//   1. avg(<c1>,…,<ck>)  [1/k each]. For every unordered set of k DISTINCT groups, for k
//      from 2 up to `avgArguments`, a group whose triples are the equal average of a triple
//      from each — e.g. octahedral face (yellow) + vert (red) gives [0.5,0,0.5] / [0,0.5,0.5].
//      A PAIR renders as an equal 3-way split of the two base swatches AND the default
//      swatch — the default share is what marks it as an adjacency color. A k >= 3 avg is a
//      genuine k-way mix, so it renders as the equal 1/k blend of just its base swatches (no
//      default share). The 3-argument one is what a snub's gap triangle is (snub.newFace
//      borders an old edge and the vertex it opens at, and its neighbours carry the third
//      share) — without it those faces name nothing and fall back to the default. A smaller
//      k wins over a bigger one. (`avgArguments` < 2 disables the whole family.)
//
//   2. avg(<base>,avg(<n1>,<n2>))  [0.5 base + 0.25 + 0.25], if `secondOrderAvgSwatches`.
//      For each group we add a group whose triples are that base weighted 0.5 plus 0.25 of
//      one triple from each of two other groups. It renders as the SAME 0.5 : 0.25 : 0.25
//      blend of the base swatch and those two neighbor swatches (no default involved).
//
//   3. tint(<base>)  [0.75 base + 0.25 other], if `tintSwatches`. For each face/vert/edge
//      group we add a group whose triples are that group's triples weighted 0.75 plus 0.25
//      of any OTHER single group's triple, or of an equal average of up to `avgArguments`
//      other groups' triples. It renders as the base swatch mixed 0.75/0.25 toward the
//      default swatch — a slight tint of the base color.
//
// The plain groups are preferred over all synthesized kinds when a computed triple matches
// more than one; among the synthesized, the equal PAIR average wins, then the nested
// average, then tint(<base>), then the higher-arity averages in increasing k.

/** The palette (config swatches + synthesized tint / nested-average / equal-average). */
const palette: Record<string, PaletteEntry> = { ...config.render.palette };

/** Linear blend of two OKLab colors; `t` = fraction from `base` toward `toward`. Because
 *  the palette is stored in OKLab (a perceptually-uniform space), a 0.5 blend lands on the
 *  color the eye reads as halfway — vivid, even midtones, rather than the muddy result a
 *  raw sRGB byte lerp gives or the brightened one three.js `Color.lerp` (linear) gives.
 *  Component-wise lerp is exactly what culori's OKLab interpolation does, but with no
 *  sRGB->OKLab round-trip per blend now that the swatches are already OKLab. */
function blendOklab(base: OKLab, toward: OKLab, t: number): OKLab {
  return {
    l: base.l + (toward.l - base.l) * t,
    a: base.a + (toward.a - base.a) * t,
    b: base.b + (toward.b - base.b) * t,
  };
}

/** The equal mix of OKLab colors — their componentwise mean, which in this perceptually-
 *  uniform space is the color the eye reads as evenly between them. */
function meanOklab(cs: ReadonlyArray<OKLab>): OKLab {
  const n = cs.length;
  return {
    l: cs.reduce((s, c) => s + c.l, 0) / n,
    a: cs.reduce((s, c) => s + c.a, 0) / n,
    b: cs.reduce((s, c) => s + c.b, 0) / n,
  };
}

/** 0.5 `base` + 0.25 `n1` + 0.25 `n2` in OKLab: blending base toward the midpoint of the
 *  two neighbors at 0.5 weights base 0.5 and each neighbor 0.25 — matching the weights
 *  `nestedAvgTriples` uses. */
function tint3Oklab(base: OKLab, n1: OKLab, n2: OKLab): OKLab {
  return blendOklab(base, meanOklab([n1, n2]), 0.5);
}

/** Ensure a `tint(<base>)` swatch exists and return its name: the base swatch mixed
 *  0.75/0.25 toward the default swatch — a slight tint of the base color (the default is
 *  white, so this lightens it). */
function ensureTintSwatch(base: string): string {
  const name = `tint(${base})`;
  if (!(name in palette)) {
    const b = config.render.palette[base as SwatchName];
    const d = config.render.palette[defaultSwatch];
    palette[name] = {
      face: blendOklab(b.face, d.face, 0.25),
      l_face: blendOklab(b.l_face, d.l_face, 0.25),
    };
  }
  return name;
}

/** Ensure an `avg(<base>,avg(<n1>,<n2>))` swatch exists and return its name: the
 *  0.5 base + 0.25 + 0.25 blend of the base swatch with its two neighbor swatches `n1`,
 *  `n2` (the same weights `nestedAvgTriples` gives the triples). The neighbors are baked
 *  into the name — a given base swatch has different neighbors across schemes — so the
 *  shared palette doesn't collide; they are sorted so the name is order-independent. */
function ensureNestedAvgSwatch(base: string, n1: string, n2: string): string {
  const [x, y] = [n1, n2].sort();
  const name = `avg(${base},avg(${x},${y}))`;
  if (!(name in palette)) {
    const b = config.render.palette[base as SwatchName];
    const p = config.render.palette[x as SwatchName];
    const q = config.render.palette[y as SwatchName];
    palette[name] = {
      face: tint3Oklab(b.face, p.face, q.face),
      l_face: tint3Oklab(b.l_face, p.l_face, q.l_face),
    };
  }
  return name;
}

/** Ensure an `avg(<c1>,…,<ck>)` swatch exists and return its name: the equal mix of the k
 *  base swatches. A PAIR additionally gives the default swatch an equal share, so it reads
 *  as an ADJACENCY color (a 3-way split) rather than a plain two-color mix; a k >= 3 avg is
 *  a genuine k-way mix and gives the default no share. The names are sorted so the swatch
 *  is order-independent. */
function ensureAvgSwatch(swatches: ReadonlyArray<string>): string {
  const sorted = [...swatches].sort();
  const name = `avg(${sorted.join(",")})`;
  if (!(name in palette)) {
    const entries = sorted.map((s) => config.render.palette[s as SwatchName]);
    if (entries.length === 2) entries.push(config.render.palette[defaultSwatch]);
    palette[name] = {
      face: meanOklab(entries.map((e) => e.face)),
      l_face: meanOklab(entries.map((e) => e.l_face)),
    };
  }
  return name;
}

/** Weighted component-wise sum of ID vectors (missing entries treated as 0), over the
 *  max of their lengths. The single length-generic vector combinator these helpers and
 *  `derive` build on. */
function weightedSum(terms: ReadonlyArray<readonly [GeomColor, number]>): GeomColor {
  const len = terms.reduce((m, [v]) => Math.max(m, v.length), 0);
  const out = new Array(len).fill(0);
  for (const [v, coeff] of terms)
    for (let i = 0; i < v.length; i++) out[i] += v[i] * coeff;
  return out;
}

/** Every unordered size-`k` subset of `items`, as arrays (in input order). */
function subsets<T>(items: ReadonlyArray<T>, k: number): T[][] {
  if (k === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i <= items.length - k; i++)
    for (const rest of subsets(items.slice(i + 1), k - 1)) out.push([items[i], ...rest]);
  return out;
}

/** Every weighted combination taking one triple from each group, each at `weight`; i.e. the
 *  cross product of the groups' triple lists, summed. The combinator the three synthesized
 *  families' triple sets are built from. */
function combineGroups(groups: ReadonlyArray<Group>, weight: (i: number) => number): GeomColor[] {
  let combos: GeomColor[] = [[]];
  groups.forEach((grp, i) => {
    const next: GeomColor[] = [];
    for (const acc of combos)
      for (const t of grp.triples) next.push(weightedSum([[acc, 1], [t, weight(i)]]));
    combos = next;
  });
  return combos;
}

/** Every equal average (1/k each) of one triple from each of `k` groups. */
function avgTriples(groups: ReadonlyArray<Group>): GeomColor[] {
  return combineGroups(groups, () => 1 / groups.length);
}

/** `tint(base)` triples: each base triple weighted 0.75, plus 0.25 shared equally among one
 *  triple from each of a subset of the OTHER groups (a single other at 0.25, a pair at
 *  0.125 each, …). `maxOthers` caps that subset's size — it is `avgArguments`, since a
 *  subset bigger than one IS an `avg(...)` of the others. */
function tintTriples(base: Group, others: ReadonlyArray<Group>, maxOthers: number): GeomColor[] {
  const out: GeomColor[] = [];
  for (let k = 1; k <= Math.min(maxOthers, others.length); k++)
    for (const combo of subsets(others, k))
      out.push(...combineGroups([base, ...combo], (i) => (i === 0 ? 0.75 : 0.25 / k)));
  return out;
}

/** Each base triple given a tint of two other groups: base·0.5 + 0.25 of one triple from
 *  each of `other1` and `other2` (i.e. (base·2 + o1 + o2) / 4). */
function nestedAvgTriples(base: Group, other1: Group, other2: Group): GeomColor[] {
  return combineGroups([base, other1, other2], (i) => (i === 0 ? 0.5 : 0.25));
}

// --- TETRAHEDRAL ONE-HOT IDs (the identity root) ----------------------------
//
// The tetrahedron's elements are THE basis: its faces, edges and vertices each get a
// distinct one-hot ID of length D = (#faces + #edges + #vertices) = 14. Every other
// color is a convex combination of these. The block order is faces, then edges, then
// vertices; the assignment is arbitrary but fixed (see config.colors header) and is what
// `seedColors` hands a freshly-loaded tetrahedron so its elements start all-distinct.
const TET_MESH = getSeed("tetrahedron");
const TET_EDGE_KEYS = meshEdgeKeys(TET_MESH);
const N_TET_FACE = TET_MESH.faces.length;
const N_TET_EDGE = TET_EDGE_KEYS.length;
const N_TET_VERT = TET_MESH.vertices.length;
const ID_DIM = N_TET_FACE + N_TET_EDGE + N_TET_VERT;
const oneHot = (i: number): GeomColor => {
  const v = new Array(ID_DIM).fill(0);
  v[i] = 1;
  return v;
};
const tetFaceIds: GeomColor[] = Array.from({ length: N_TET_FACE }, (_, i) => oneHot(i));
const tetEdgeIds: GeomColor[] = Array.from({ length: N_TET_EDGE }, (_, i) => oneHot(N_TET_FACE + i));
const tetVertIds: GeomColor[] = Array.from({ length: N_TET_VERT }, (_, i) => oneHot(N_TET_FACE + N_TET_EDGE + i));

/**
 * Collapse a full ID vector to the 3D (face, vert, edge) "provenance" triple the swatch
 * lookup runs in: sum the weight sitting on the tetrahedron's face / vertex / edge blocks
 * respectively. This is the linear map sending each tetra face one-hot → [1,0,0], each
 * vertex → [0,1,0], each edge → [0,0,1]. Since every color is a convex combination of the
 * one-hots and this map is linear, two distinct IDs in the same orbit collapse to the same
 * triple (and so the same swatch), while the scheme lookup below stays in this tiny 3D
 * provenance space instead of ever enumerating the huge 14-D combination space.
 */
export function collapse(c: GeomColor): GeomColor {
  let f = 0, e = 0, v = 0;
  for (let i = 0; i < c.length; i++) {
    if (i < N_TET_FACE) f += c[i];
    else if (i < N_TET_FACE + N_TET_EDGE) e += c[i];
    else v += c[i];
  }
  return [f, v, e]; // [face, vert, edge] provenance order
}

// --- DERIVED SCHEME TRIPLES -------------------------------------------------
//
// The tetrahedral orbits ARE the one-hot IDs above; the octahedral and icosahedral
// orbits are derived HERE by pushing those base IDs through the same operation color
// rules the live operations use (config.colors.operations), so tweaking an operation's
// coefficients re-colors a directly-loaded octa/cube/ico/dodec to match without
// re-hand-entering anything:
//   - octahedron  = RECTIFY of the tetrahedron
//   - icosahedron = SNUB of the octahedron (snub reads the colors of the shape's
//     rectification, which for the icosahedron are exactly the octahedral triples)
// Each element group is the union of the OLD elements the operation keeps (rectify &
// snub both keep the faces they act on) plus the NEW elements it creates; a new group
// enumerates the weighted combination of every old-triple assignment its rule can see
// (a full cross product, matching how the adjacency/blend groups below build theirs).

type Triples = ReadonlyArray<GeomColor>;

/** Weighted combinations of one triple per rule token, over the cross product of the
 *  per-token triple lists — the same weighted sum `combine` (colorUtil) computes live. */
function derive(rule: Readonly<Record<string, number>>, sources: Record<string, Triples>): GeomColor[] {
  let combos: GeomColor[] = [[]];
  for (const [tok, coeff] of Object.entries(rule)) {
    const next: GeomColor[] = [];
    for (const acc of combos)
      for (const t of sources[tok])
        next.push(weightedSum([[acc, 1], [t, coeff]]));
    combos = next;
  }
  return combos;
}

/** Distinct triples (by rounded key), preserving first-seen order. */
function dedupeTriples(triples: GeomColor[]): GeomColor[] {
  const seen = new Set<string>();
  const out: GeomColor[] = [];
  for (const t of triples) {
    const k = colorKey(t);
    if (!seen.has(k)) { seen.add(k); out.push(t); }
  }
  return out;
}

const ops = config.colors.operations;

// tetrahedral (the root) → octahedron via rectify → icosahedron via snub. Each step's
// derivation is handed the FULL old-triple source set (face/vert/edge of the shape the
// operation reads); `derive` only consumes the tokens a given rule actually names, so a
// rule swapping which old tokens it uses re-colors automatically without touching this.
const tetSrc = { oldFace: tetFaceIds, oldVertex: tetVertIds, oldEdge: tetEdgeIds };

// octahedron = rectify(tetrahedron): rectify keeps the old faces, adds a face per old
// vertex, a vertex per old edge, and an edge per old face/vertex incidence.
const octaFace = dedupeTriples([...tetSrc.oldFace, ...derive(ops.rectify.newFace, tetSrc)]);
const octaVert = dedupeTriples(derive(ops.rectify.newVertex, tetSrc));
const octaEdge = dedupeTriples(derive(ops.rectify.newEdge, tetSrc));

// icosahedron = snub(octahedron): snub reads the colors of the shape's rectification,
// which here are the octahedral triples. It keeps the faces, adds a gap-triangle face,
// a center + boundary edge per split, and a vertex per split.
const octaSrc = { oldFace: octaFace, oldVertex: octaVert, oldEdge: octaEdge };
const icoFace = dedupeTriples([...octaFace, ...derive(ops.snub.newFace, octaSrc)]);
const icoVert = dedupeTriples(derive(ops.snub.newVertex, octaSrc));
const icoEdge = dedupeTriples([
  ...derive(ops.snub.newEdge, octaSrc),
  ...derive(ops.snub.snubEdge, octaSrc),
]);

// The swatch-only config schemes (config.render.schemes) with each group's `triples`
// filled in: tetrahedral gets the one-hot IDs, octa/ico the derived ones above. Used
// everywhere below in place of the raw config schemes.
const resolvedSchemes: Record<string, Record<string, Group>> = {};
for (const [name, groups] of Object.entries(config.render.schemes))
  resolvedSchemes[name] = Object.fromEntries(
    Object.entries(groups as Record<string, { swatch: string }>).map(([k, grp]) => [
      k,
      { swatch: grp.swatch, triples: [] as GeomColor[] },
    ]),
  );
const withTriples = (name: string, t: Record<string, GeomColor[]>) => {
  for (const [k, triples] of Object.entries(t)) resolvedSchemes[name][k] = { ...resolvedSchemes[name][k], triples };
};
withTriples("tetrahedral", { face: tetFaceIds, vert: tetVertIds, edge: tetEdgeIds });
withTriples("octahedral", { face: octaFace, vert: octaVert, edge: octaEdge });
withTriples("icosahedral", { face: icoFace, vert: icoVert, edge: icoEdge });

// The scheme lookup runs entirely in the collapsed 3D provenance space (see `collapse`):
// each group's many 14-D IDs collapse to just a handful of distinct 3D triples, so the
// synthesized cross-products below stay tiny rather than enumerating millions of 14-D
// combinations. `collapse(color)` at lookup time lands on exactly these, so the resolved
// swatch is identical to the full-enumeration result.
const collapsedSchemes: Record<string, Record<string, Group>> = {};
for (const [name, groups] of Object.entries(resolvedSchemes))
  collapsedSchemes[name] = Object.fromEntries(
    Object.entries(groups).map(([k, grp]) => [
      k,
      { swatch: grp.swatch, triples: dedupeTriples(grp.triples.map(collapse)) },
    ]),
  );

// How many groups an `avg(...)` may mix, and whether the nested-average / tint families are
// derived at all (see the header above and `config.colors`). `avgArguments` < 2 turns off
// the `avg(...)` family — and with it the nested average, which is one.
const { avgArguments, secondOrderAvgSwatches, tintSwatches } = config.colors;
const maxAvgArgs = avgArguments >= 2 ? avgArguments : 0;

// Per-scheme: the plain face/vert/edge groups plus the synthesized average / nested-average
// / tint groups. Each augmented group carries its precedence `tier` (lower wins):
//   0 = plain, 1 = avg(<a>,<b>), 2 = avg(<base>,avg(<n1>,<n2>)), 3 = tint(<base>),
//   4+ = the higher-arity avg(<c1>,…,<ck>), in increasing k.
type AugGroup = Group & { tier: number };
const avgTier = (k: number) => (k === 2 ? 1 : k + 1);
const augmentedSchemes: Record<string, AugGroup[]> = {};
for (const [name, groups] of Object.entries(collapsedSchemes)) {
  const g = groups as Record<string, Group>;
  const keys = Object.keys(g);
  const aug: AugGroup[] = keys.map((k) => ({ ...g[k], tier: 0 }));

  // avg(<c1>,…,<ck>): the equal 1/k mix of k distinct groups (the 3-argument one is a
  // snub's gap triangles).
  for (let k = 2; k <= Math.min(maxAvgArgs, keys.length); k++)
    for (const combo of subsets(keys, k).map((ks) => ks.map((key) => g[key])))
      aug.push({
        swatch: ensureAvgSwatch(combo.map((grp) => grp.swatch)),
        triples: avgTriples(combo),
        tier: avgTier(k),
      });

  for (let i = 0; i < keys.length; i++) {
    const base = g[keys[i]];
    const others = keys.filter((_, k) => k !== i).map((k) => g[k]);
    // avg(<base>,avg(<n1>,<n2>)): 0.5 base + 0.25 n1 + 0.25 n2, for each pair of others.
    if (secondOrderAvgSwatches && maxAvgArgs >= 2)
      for (const [n1, n2] of subsets(others, 2))
        aug.push({
          swatch: ensureNestedAvgSwatch(base.swatch, n1.swatch, n2.swatch),
          triples: nestedAvgTriples(base, n1, n2),
          tier: 2,
        });
    // tint(<base>): base·0.75 + 0.25 of an average of n other groups, n = 1..avgArguments.
    // A single other (n = 1) is not an `avg(...)` at all, so it survives even when the
    // `avg(...)` family is switched off.
    if (tintSwatches)
      aug.push({
        swatch: ensureTintSwatch(base.swatch),
        triples: tintTriples(base, others, Math.max(avgArguments, 1)),
        tier: 3,
      });
  }
  augmentedSchemes[name] = aug;
}

// Per-scheme lookup: rounded-triple key → the swatch name of its group. Inserted in
// ascending precedence tier so a key claimed by a higher-precedence (lower-tier) group is
// never overwritten by a synthesized one: plain, then equal pair average, then nested
// average, then tint, then the higher-arity averages.
const schemeLookup: Record<string, Map<string, string>> = {};
for (const [name, aug] of Object.entries(augmentedSchemes)) {
  const map = new Map<string, string>();
  const tiers = [...new Set(aug.map((grp) => grp.tier))].sort((a, b) => a - b);
  for (const tier of tiers)
    for (const grp of aug)
      if (grp.tier === tier)
        for (const tr of grp.triples) {
          const k = colorKey(tr);
          if (!map.has(k)) map.set(k, grp.swatch);
        }
  schemeLookup[name] = map;
}

/** Palette swatch name for a geometric color under the active scheme (a color that
 *  matches no scheme group — or is missing — falls back to the default swatch). The ID
 *  vector is collapsed to its 3D provenance triple first (see `collapse`), which is what
 *  the scheme lookup is keyed on. */
export function paletteSwatch(geom: GeomColor | undefined): string {
  if (!geom) return defaultSwatch;
  return schemeLookup[currentScheme].get(colorKey(collapse(geom))) ?? defaultSwatch;
}

/** Undirected edge key from two vertex indices. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** The EDGE color of a swatch, derived from its face as an OKLab transformation. Because both the darken
 *  and the tint/blend swatch mixes are linear in OKLab, darkening the (already-blended)
 *  face here is identical to blending pre-darkened edges. Memoized per source OKLab
 *  object so each stable palette/synthesized face maps to one stable darkened object,
 *  which then hits `hexCache` on conversion. */
const darkCache = new Map<OKLab, OKLab>();
function darken(face: OKLab): OKLab {
  let d = darkCache.get(face);
  if (d === undefined) {
    d = { l: 1.0 - face.l, a: face.a, b: face.b };
    darkCache.set(face, d);
  }
  return d;
}

/** Packed 0xRRGGBB sRGB int for an OKLab color, memoized per OKLab object (palette
 *  entries are stable references, so each distinct swatch color converts once). This is
 *  the only OKLab→sRGB conversion — blending stays in OKLab; three.js Color needs sRGB. */
const hexCache = new Map<OKLab, number>();
function oklabHex(c: OKLab): number {
  let h = hexCache.get(c);
  if (h === undefined) {
    h = parseInt(formatHex({ mode: "oklab", l: c.l, a: c.a, b: c.b }).slice(1), 16);
    hexCache.set(c, h);
  }
  return h;
}

/** Resolve a geometric color to a FACE RGB Color (via the active scheme). */
export function paletteRGB(geom: GeomColor | undefined): Color {
  return new Color(oklabHex(palette[paletteSwatch(geom)].face));
}

/** Resolve a geometric color to a darkened EDGE RGB Color (via the active scheme). */
export function darkRGB(geom: GeomColor | undefined): Color {
  return new Color(oklabHex(darken(palette[paletteSwatch(geom)].face)));
}

/** Map a whole face-color array to RGB (one Color per face). */
export function faceColorsRGB(face: GeomColor[]): Color[] {
  return face.map((c) => paletteRGB(c));
}

// --- "light" palette variants (only used by the _light.png export) ----------

/** Resolve a geometric color to a FACE RGB Color in the LIGHT palette. */
export function paletteRGBLight(geom: GeomColor | undefined): Color {
  return new Color(oklabHex(palette[paletteSwatch(geom)].l_face));
}

/** Resolve a geometric color to an EDGE RGB Color in the LIGHT palette. */
export function darkRGBLight(geom: GeomColor | undefined): Color {
  return new Color(oklabHex(darken(palette[paletteSwatch(geom)].l_face)));
}

/** Map a whole face-color array to RGB using the LIGHT palette. */
export function faceColorsRGBLight(face: GeomColor[]): Color[] {
  return face.map((c) => paletteRGBLight(c));
}

/** Every undirected edge of a mesh, as keys, once each. */
export function meshEdgeKeys(mesh: Mesh): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of mesh.faces) {
    for (let i = 0; i < f.length; i++) {
      const k = edgeKey(f[i], f[(i + 1) % f.length]);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
}

/** A ColorSet with every element set to a single triple (used for seeds). */
export function uniformColors(
  mesh: Mesh,
  vertexColor: GeomColor,
  edgeColor: GeomColor,
  faceColor: GeomColor,
): ColorSet {
  const edge = new Map<string, GeomColor>();
  for (const k of meshEdgeKeys(mesh)) edge.set(k, edgeColor);
  return {
    vertex: mesh.vertices.map(() => vertexColor),
    face: mesh.faces.map(() => faceColor),
    edge,
  };
}

/**
 * The color scheme that best fits a solid, recognised purely from topology, so the
 * UI can auto-switch when an operation forms one of the classic Platonic solids:
 *   - tetrahedron (4V/4F)                              → "tetrahedral"
 *   - octahedron (6V/8F tri) / cube (8V/6F quad)       → "octahedral"
 *   - icosahedron (12V/20F tri) / dodecahedron (20V/12F penta) → "icosahedral"
 * Returns null for anything else (the active scheme is then left unchanged).
 */
export function schemeForMesh(mesh: Mesh): SchemeName | null {
  const V = mesh.vertices.length;
  const F = mesh.faces.length;
  const sides = (n: number) => mesh.faces.every((f) => f.length === n);
  if (V === 4 && F === 4 && sides(3)) return "tetrahedral";
  if (V === 6 && F === 8 && sides(3)) return "octahedral";
  if (V === 8 && F === 6 && sides(4)) return "octahedral";
  if (V === 12 && F === 20 && sides(3)) return "icosahedral";
  if (V === 20 && F === 12 && sides(5)) return "icosahedral";
  return null;
}

/**
 * Initial colors for a freshly-loaded seed.
 *
 * The tetrahedron is the identity root, so a loaded tetrahedron gets its per-element
 * one-hot IDs (every element distinct — the same starting point operations propagate
 * from, keeping IDs unique; see tests/colorIds). Any other directly-loaded seed takes
 * the representative (first) triple of each matching orbit in the scheme its topology
 * fits (see `schemeForMesh`) — enough to color it like the built-from-tetra one, though
 * its elements aren't individually unique (their canonical unique IDs come from actually
 * building the solid out of the tetrahedron). Operations then layer the combination
 * rules on top, and the chosen scheme decides how all of them display.
 */
export function seedColors(mesh: Mesh): ColorSet {
  const scheme = schemeForMesh(mesh) ?? (config.colors.defaultScheme as SchemeName);
  // A loaded tetrahedron: give each element its own one-hot ID (assigned by element
  // index / edge-key order, matching the block layout the derivation used).
  if (scheme === "tetrahedral" && mesh.faces.length === N_TET_FACE && mesh.vertices.length === N_TET_VERT) {
    const edge = new Map<string, GeomColor>();
    meshEdgeKeys(mesh).forEach((k, i) => edge.set(k, tetEdgeIds[i] ?? tetEdgeIds[0]));
    return {
      vertex: mesh.vertices.map((_, i) => tetVertIds[i]),
      face: mesh.faces.map((_, i) => tetFaceIds[i]),
      edge,
    };
  }
  const g = resolvedSchemes[scheme];
  return uniformColors(
    mesh,
    g.vert.triples[0] as GeomColor,
    g.edge.triples[0] as GeomColor,
    g.face.triples[0] as GeomColor,
  );
}
