import { Color } from "three";
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
type PaletteEntry = { face: number; edge: number; l_face: number; l_edge: number };
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

// --- ADJACENCY preprocessing (built here, NOT in the config) ----------------
//
// `config.render.palette` and each `config.colors.schemes[*]` are augmented with
// synthesized "adjacency" swatches/groups. For every face/vert/edge group we add
// a faceAdj/vertAdj/edgeAdj group whose triples are that group's triples tinted
// by 1/2 of every triple in the OTHER groups; it renders as a `<baseSwatch>Adj`
// swatch that is a blend (config.colors.adjacentSwatchBlend) of the base swatch
// and the default swatch. The plain groups are preferred over the adjacency ones
// when a computed triple matches both (adjacency groups can overlap primaries).

/** The palette (config swatches + synthesized `<base>Adj` blends). */
const palette: Record<string, PaletteEntry> = { ...config.render.palette };

/** Blend two packed 0xRRGGBB hexes; `t` = fraction from `base` toward `toward`. */
function blendHex(base: number, toward: number, t: number): number {
  return new Color(base).lerp(new Color(toward), t).getHex();
}

/** Ensure a `<base>Adj` swatch exists (blended base↔default) and return its name. */
function ensureAdjSwatch(base: string): string {
  const name = `${base}Adj`;
  if (!(name in palette)) {
    const b = config.render.palette[base as SwatchName];
    const d = config.render.palette[defaultSwatch];
    const t = config.colors.adjacentSwatchBlend;
    palette[name] = {
      face: blendHex(b.face, d.face, t),
      edge: blendHex(b.edge, d.edge, t),
      l_face: blendHex(b.l_face, d.l_face, t),
      l_edge: blendHex(b.l_edge, d.l_edge, t),
    };
  }
  return name;
}

/** Add each base triple tinted by 1/2 of every triple in the other groups. */
function adjacentTriples(base: Group, others: Group[]): GeomColor[] {
  const out: GeomColor[] = [];
  for (const t of base.triples)
    for (const o of others)
      for (const ot of o.triples)
        out.push([t[0] + ot[0] / 2, t[1] + ot[1] / 2, t[2] + ot[2] / 2]);
  return out;
}

// Per-scheme: the plain face/vert/edge groups plus derived faceAdj/vertAdj/edgeAdj.
const augmentedSchemes: Record<string, Record<string, Group>> = {};
for (const [name, groups] of Object.entries(config.colors.schemes)) {
  const g = groups as Record<string, Group>;
  const keys = Object.keys(g);
  const aug: Record<string, Group> = { ...g };
  for (const key of keys) {
    const others = keys.filter((k) => k !== key).map((k) => g[k]);
    aug[`${key}Adj`] = {
      swatch: ensureAdjSwatch(g[key].swatch),
      triples: adjacentTriples(g[key], others),
    };
  }
  augmentedSchemes[name] = aug;
}

// Per-scheme lookup: rounded-triple key → the swatch name of its group. Plain
// groups (keys without the "Adj" suffix) are inserted first so they win any key
// an adjacency group would otherwise claim.
const schemeLookup: Record<string, Map<string, string>> = {};
for (const [name, aug] of Object.entries(augmentedSchemes)) {
  const map = new Map<string, string>();
  const entries = Object.entries(aug);
  for (const [key, grp] of entries)
    if (!key.endsWith("Adj"))
      for (const t of grp.triples) map.set(colorKey(t), grp.swatch);
  for (const [key, grp] of entries)
    if (key.endsWith("Adj"))
      for (const t of grp.triples) {
        const k = colorKey(t);
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

/** Resolve a geometric color to a FACE RGB Color (via the active scheme). */
export function paletteRGB(geom: GeomColor | undefined): Color {
  return new Color(palette[paletteSwatch(geom)].face);
}

/** Resolve a geometric color to a darkened EDGE RGB Color (via the active scheme). */
export function darkRGB(geom: GeomColor | undefined): Color {
  return new Color(palette[paletteSwatch(geom)].edge);
}

/** Map a whole face-color array to RGB (one Color per face). */
export function faceColorsRGB(face: GeomColor[]): Color[] {
  return face.map((c) => paletteRGB(c));
}

// --- "light" palette variants (only used by the _light.png export) ----------

/** Resolve a geometric color to a FACE RGB Color in the LIGHT palette. */
export function paletteRGBLight(geom: GeomColor | undefined): Color {
  return new Color(palette[paletteSwatch(geom)].l_face);
}

/** Resolve a geometric color to an EDGE RGB Color in the LIGHT palette. */
export function darkRGBLight(geom: GeomColor | undefined): Color {
  return new Color(palette[paletteSwatch(geom)].l_edge);
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
  const g = config.colors.schemes[scheme];
  return uniformColors(
    mesh,
    g.vert.triples[0] as GeomColor,
    g.edge.triples[0] as GeomColor,
    g.face.triples[0] as GeomColor,
  );
}
