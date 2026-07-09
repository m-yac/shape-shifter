import { Color } from "three";
import { formatHex } from "culori";
import { type Mesh } from "./HalfEdge";
import { config } from "../config";

/**
 * A geometric color is an RGB-style TRIPLE built up by the Conway operations via
 * the combination rules in `config.colors.operations` (each rule is a map from old
 * tokens to the coefficients their triples are weighted by). The triples are grouped
 * by `config.colors.schemes`: every triple in a group renders as that group's named
 * swatch (an entry of `config.render.palette`). A computed triple that matches no
 * group falls back to `config.colors.defaultSwatch`.
 *
 * Edges are keyed by their undirected vertex-index pair (`edgeKey`). Vertex and
 * face colors are indexed by mesh vertex / face index. Faces (and edge lines) are
 * drawn; vertex colors are tracked so the operation rules can read them.
 */
export type GeomColor = readonly [number, number, number];

export interface ColorSet {
  vertex: GeomColor[];
  face: GeomColor[];
  edge: Map<string, GeomColor>;
}

export type SchemeName = keyof typeof config.colors.schemes;
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

/** A stable string key for a triple. The combination arithmetic yields exact
 *  decimals from the rule coefficients, so rounding to 3 dp matches a scheme entry
 *  robustly without floating-point drift. */
function colorKey(c: GeomColor): string {
  return `${Math.round(c[0] * 1000)},${Math.round(c[1] * 1000)},${Math.round(c[2] * 1000)}`;
}

const defaultSwatch = config.colors.defaultSwatch as SwatchName;

// --- TINT & BLEND preprocessing (built here, NOT in the config) -------------
//
// `config.render.palette` and each `config.colors.schemes[*]` are augmented with
// synthesized swatches/groups. Two kinds are added:
//
//   1. TINT (`<base>Tint`). For each face/vert/edge group we add a faceTint/vertTint/
//      edgeTint group whose triples are that group's triples given a tint of the OTHER
//      two groups: base·½ + ¼ of one triple from each of the two other groups (so ½
//      base, the other ½ split evenly across the two neighbors, normalized). It renders
//      as a swatch that is the SAME ½ : ¼ : ¼ blend of the base swatch and its two
//      neighbor swatches (no default involved).
//
//   2. EQUAL BLEND (`<a>+<b>`). For every unordered pair of DISTINCT groups we add a
//      group whose triples are an equal average (½ each) of a triple from each group —
//      e.g. octahedral face (yellow) + vert (red) gives [0.5,0,0.5] / [0,0.5,0.5]. It
//      renders as a `<a>+<b>` swatch that is an equal 3-way split of the two base
//      swatches AND the default swatch — the default share is what marks it as an
//      adjacency color.
//
// The plain groups are preferred over both synthesized kinds when a computed triple
// matches more than one; tint beats equal-blend on any remaining tie.

/** The palette (config swatches + synthesized `<base>Tint` and `<a>+<b>` blends). */
const palette: Record<string, PaletteEntry> = { ...config.render.palette };

/** Linear blend of two OKLab colors; `t` = fraction from `base` toward `toward`. Because
 *  the palette is stored in OKLab (a perceptually-uniform space), a ½ blend lands on the
 *  color the eye reads as halfway — vivid, even midtones, rather than the muddy result a
 *  raw sRGB byte lerp gives or the brightened one three.js `Color.lerp` (linear) gives.
 *  Component-wise lerp is exactly what culori's OKLab interpolation does, but with no
 *  sRGB↔OKLab round-trip per blend now that the swatches are already OKLab. */
function blendOklab(base: OKLab, toward: OKLab, t: number): OKLab {
  return {
    l: base.l + (toward.l - base.l) * t,
    a: base.a + (toward.a - base.a) * t,
    b: base.b + (toward.b - base.b) * t,
  };
}

/** ½ `base` + ¼ `n1` + ¼ `n2` in OKLab. Blending n1↔n2 at ½ gives their perceptual
 *  midpoint, then base↔that at ½ weights base ½ and each neighbor ¼ — matching the
 *  weights `tintedTriples` uses. */
function tint3Oklab(base: OKLab, n1: OKLab, n2: OKLab): OKLab {
  return blendOklab(base, blendOklab(n1, n2, 0.5), 0.5);
}

/** Ensure a `<base>Tint` swatch exists and return its name: the ½ base + ¼ + ¼ blend
 *  of the base swatch with its two neighbor swatches `n1`, `n2` (the same weights
 *  `tintedTriples` gives the triples). The neighbors are baked into the name — a given
 *  base swatch has different neighbors across schemes — so the shared palette doesn't
 *  collide; they are sorted so the name is order-independent. */
function ensureTintSwatch(base: string, n1: string, n2: string): string {
  const [x, y] = [n1, n2].sort();
  const name = `${base}Tint(${x}+${y})`;
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

/** Equal 1/3 : 1/3 : 1/3 mix of OKLab colors `p`, `q` and the default swatch's `d`.
 *  Mixing p↔q at ½ gives (p+q)/2, then lerping that toward d by 1/3 gives (p+q)/3 + d/3. */
function blend3Oklab(p: OKLab, q: OKLab, d: OKLab): OKLab {
  return blendOklab(blendOklab(p, q, 0.5), d, 1 / 3);
}

/** Ensure a `<a>+<b>` swatch exists and return its name. To read as an ADJACENCY
 *  color (rather than a plain two-color mix), it is an equal 3-way split of swatches
 *  a, b AND the default swatch. The two names are sorted so the pair is
 *  order-independent. */
function ensurePairSwatch(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  const name = `${x}+${y}`;
  if (!(name in palette)) {
    const p = config.render.palette[x as SwatchName];
    const q = config.render.palette[y as SwatchName];
    const d = config.render.palette[defaultSwatch];
    palette[name] = {
      face: blend3Oklab(p.face, q.face, d.face),
      l_face: blend3Oklab(p.l_face, q.l_face, d.l_face),
    };
  }
  return name;
}

/** Each base triple given a tint of the two other groups: base·½ + ¼ of one triple
 *  from each of `other1` and `other2` (i.e. (base·2 + o1 + o2) / 4). */
function tintedTriples(base: Group, other1: Group, other2: Group): GeomColor[] {
  const out: GeomColor[] = [];
  for (const t of base.triples)
    for (const ot1 of other1.triples)
      for (const ot2 of other2.triples)
        out.push([(t[0] * 2 + ot1[0] + ot2[0]) / 4,
                  (t[1] * 2 + ot1[1] + ot2[1]) / 4,
                  (t[2] * 2 + ot1[2] + ot2[2]) / 4]);
  return out;
}

/** Every equal average (½ each) of a triple from each of two groups. */
function combinedTriples(a: Group, b: Group): GeomColor[] {
  const out: GeomColor[] = [];
  for (const t of a.triples)
    for (const ot of b.triples)
      out.push([(t[0] + ot[0]) / 2,
                (t[1] + ot[1]) / 2,
                (t[2] + ot[2]) / 2]);
  return out;
}

// --- DERIVED SCHEME TRIPLES -------------------------------------------------
//
// Only the tetrahedral scheme lists its triples in the config; the octahedral and
// icosahedral triples are derived HERE by pushing those base triples through the same
// operation color rules the live operations use (config.colors.operations), so tweaking
// an operation's coefficients re-colors a directly-loaded octa/cube/ico/dodec to match
// without re-hand-entering triples:
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
  let combos: GeomColor[] = [[0, 0, 0]];
  for (const [tok, coeff] of Object.entries(rule)) {
    const next: GeomColor[] = [];
    for (const acc of combos)
      for (const t of sources[tok])
        next.push([acc[0] + t[0] * coeff, acc[1] + t[1] * coeff, acc[2] + t[2] * coeff]);
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
const tet = config.colors.schemes.tetrahedral;
const tetSrc = { oldFace: tet.face.triples, oldVertex: tet.vert.triples, oldEdge: tet.edge.triples };

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

// The config schemes with each group's `triples` filled in (tetrahedral already has
// them; octa/ico get the derived ones above). Used everywhere below in place of the
// raw config schemes.
const resolvedSchemes: Record<string, Record<string, Group>> = {};
for (const [name, groups] of Object.entries(config.colors.schemes))
  resolvedSchemes[name] = Object.fromEntries(
    Object.entries(groups as Record<string, { swatch: string; triples?: Triples }>).map(([k, grp]) => [
      k,
      { swatch: grp.swatch, triples: grp.triples ?? [] },
    ]),
  );
const withTriples = (name: string, t: Record<string, GeomColor[]>) => {
  for (const [k, triples] of Object.entries(t)) resolvedSchemes[name][k] = { ...resolvedSchemes[name][k], triples };
};
withTriples("octahedral", { face: octaFace, vert: octaVert, edge: octaEdge });
withTriples("icosahedral", { face: icoFace, vert: icoVert, edge: icoEdge });

// Per-scheme: the plain face/vert/edge groups plus derived faceTint/vertTint/edgeTint
// tints and `<a>+<b>` equal blends. Tint keys end in "Tint"; equal-blend keys contain
// "+" (their name doubles as the swatch name); plain keys have neither.
const augmentedSchemes: Record<string, Record<string, Group>> = {};
for (const [name, groups] of Object.entries(resolvedSchemes)) {
  const g = groups as Record<string, Group>;
  const keys = Object.keys(g);
  const aug: Record<string, Group> = { ...g };
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = g[keys[i]], b = g[keys[j]];
      const swatch = ensurePairSwatch(a.swatch, b.swatch);
      aug[`${keys[i]}+${keys[j]}`] = { swatch, triples: combinedTriples(a, b) };
      for (let k = 0; k < keys.length; k++) {
        if (k == i || k == j) continue;
        const c = g[keys[k]];
        aug[`${keys[k]}Tint`] = {
          swatch: ensureTintSwatch(c.swatch, a.swatch, b.swatch),
          triples: tintedTriples(c, a, b),
        };
      }
    }
  }
  augmentedSchemes[name] = aug;
}

// Per-scheme lookup: rounded-triple key → the swatch name of its group. Inserted in
// precedence tiers, highest first, so a key claimed by an earlier tier is never
// overwritten: plain groups, then tint (`<base>Tint`), then equal-blend (`<a>+<b>`).
const schemeLookup: Record<string, Map<string, string>> = {};
for (const [name, aug] of Object.entries(augmentedSchemes)) {
  const map = new Map<string, string>();
  const tier = (key: string): number =>
    key.includes("+") ? 2 : key.endsWith("Tint") ? 1 : 0;
  const entries = Object.entries(aug);
  for (const t of [0, 1, 2])
    for (const [key, grp] of entries)
      if (tier(key) === t)
        for (const tr of grp.triples) {
          const k = colorKey(tr);
          if (!map.has(k)) map.set(k, grp.swatch);
        }
  schemeLookup[name] = map;
}

/** Palette swatch name for a geometric color under the active scheme (a color that
 *  matches no scheme group — or is missing — falls back to the default swatch). */
function paletteSwatch(geom: GeomColor | undefined): string {
  if (!geom) return defaultSwatch;
  return schemeLookup[currentScheme].get(colorKey(geom)) ?? defaultSwatch;
}

/** Undirected edge key from two vertex indices. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** The EDGE color of a swatch, derived from its face as a uniform OKLab darken (all
 *  channels × config.render.edgeDarken) — edges aren't stored. Because both the darken
 *  and the tint/blend swatch mixes are linear in OKLab, darkening the (already-blended)
 *  face here is identical to blending pre-darkened edges. Memoized per source OKLab
 *  object so each stable palette/synthesized face maps to one stable darkened object,
 *  which then hits `hexCache` on conversion. */
const edgeDarken = config.render.edgeDarken;
const darkCache = new Map<OKLab, OKLab>();
function darken(face: OKLab): OKLab {
  let d = darkCache.get(face);
  if (d === undefined) {
    d = { l: face.l * edgeDarken, a: face.a * edgeDarken, b: face.b * edgeDarken };
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
 * Initial colors for a freshly-loaded seed: each face / vertex / edge takes the
 * representative (first) triple of the matching group in the scheme the seed's
 * topology fits (see `schemeForMesh`), so a directly-loaded solid is colored like
 * the one built from the tetrahedron. The operations then layer the combination
 * rules on top, and the chosen scheme decides how all of them display.
 */
export function seedColors(mesh: Mesh): ColorSet {
  const scheme = schemeForMesh(mesh) ?? (config.colors.defaultScheme as SchemeName);
  const g = resolvedSchemes[scheme];
  return uniformColors(
    mesh,
    g.vert.triples[0] as GeomColor,
    g.edge.triples[0] as GeomColor,
    g.face.triples[0] as GeomColor,
  );
}
