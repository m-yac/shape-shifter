import { Color } from "three";
import { type Mesh } from "./HalfEdge";
import { config } from "../config";

/**
 * A geometric color is an RGB-style TRIPLE built up by the Conway operations via
 * the combination rules in `config.colors.operations` (a rule
 * `["oldVertex","oldFace"]` means oldVertexTriple + oldFaceTriple/10, each
 * further token ÷10). The triples are grouped by `config.colors.schemes`: every
 * triple in a group renders as that group's named swatch (an entry of
 * `config.render.palette`). A computed triple that matches no group falls back to
 * `config.colors.defaultSwatch`.
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
 *  decimals (0.1 / 0.01 / 0.11 / …), so rounding to 3 dp matches a scheme entry
 *  robustly without floating-point drift. */
function colorKey(c: GeomColor): string {
  return `${Math.round(c[0] * 1000)},${Math.round(c[1] * 1000)},${Math.round(c[2] * 1000)}`;
}

// Per-scheme lookup: rounded-triple key → the swatch name of its group.
const schemeLookup: Record<string, Map<string, SwatchName>> = {};
for (const [name, groups] of Object.entries(config.colors.schemes)) {
  const map = new Map<string, SwatchName>();
  for (const g of Object.values(groups) as ReadonlyArray<{
    swatch: SwatchName;
    triples: ReadonlyArray<ReadonlyArray<number>>;
  }>) {
    for (const t of g.triples) map.set(colorKey(t as GeomColor), g.swatch);
  }
  schemeLookup[name] = map;
}
const defaultSwatch = config.colors.defaultSwatch as SwatchName;

/** Palette swatch name for a geometric color under the active scheme (a color that
 *  matches no scheme group — or is missing — falls back to the default swatch). */
function paletteSwatch(geom: GeomColor | undefined): SwatchName {
  if (!geom) return defaultSwatch;
  return schemeLookup[currentScheme].get(colorKey(geom)) ?? defaultSwatch;
}

/** Undirected edge key from two vertex indices. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/** Resolve a geometric color to a FACE RGB Color (via the active scheme). */
export function paletteRGB(geom: GeomColor | undefined): Color {
  return new Color(config.render.palette[paletteSwatch(geom)].face);
}

/** Resolve a geometric color to a darkened EDGE RGB Color (via the active scheme). */
export function darkRGB(geom: GeomColor | undefined): Color {
  return new Color(config.render.palette[paletteSwatch(geom)].edge);
}

/** Map a whole face-color array to RGB (one Color per face). */
export function faceColorsRGB(face: GeomColor[]): Color[] {
  return face.map((c) => paletteRGB(c));
}

// --- "light" palette variants (only used by the _light.png export) ----------

/** Resolve a geometric color to a FACE RGB Color in the LIGHT palette. */
export function paletteRGBLight(geom: GeomColor | undefined): Color {
  return new Color(config.render.palette[paletteSwatch(geom)].l_face);
}

/** Resolve a geometric color to an EDGE RGB Color in the LIGHT palette. */
export function darkRGBLight(geom: GeomColor | undefined): Color {
  return new Color(config.render.palette[paletteSwatch(geom)].l_edge);
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
