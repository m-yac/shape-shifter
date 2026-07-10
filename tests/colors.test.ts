import { describe, it, expect } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { type Mesh } from "../src/geometry/HalfEdge";
import {
  type ColorSet,
  type GeomColor,
  type SchemeName,
  setColorScheme,
  paletteRGB,
} from "../src/geometry/colors";
import { config } from "../src/config";
import { formatHex } from "culori";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { buildSnub } from "../src/operations/snub";
import { buildGyro } from "../src/operations/gyro";

// Colors propagate through a chain of operations exactly as they do during live
// editing: each committed shape is re-wrapped as a colored Polyhedron and fed to the
// next operation. These helpers mirror that threading.
const seed = (n: string) => new Polyhedron(getSeed(n));
const wrap = (r: { mesh: Mesh; colors: ColorSet }) => new Polyhedron(r.mesh, r.colors);
const rectify = (p: Polyhedron) => wrap(buildTruncate(p, 0, null).commit(1, true));
const snub = (p: Polyhedron) => buildSnub(p, 0, p.vertices[0].clone()).commit(1, true).colors;
const gyro = (p: Polyhedron) => buildGyro(p, 0, p.vertices[0].clone()).commit(1, true).colors;
const join = (p: Polyhedron) => wrap(buildKis(p, 0, null).commit(1, true));

// Reverse map from a swatch's rendered FACE hex back to its name, so a resolved
// geometric color can be checked by the swatch a viewer actually SEES. Only the base
// swatches are indexed: a color that falls through to an `<x>Adj` blend or the default
// swatch won't match any name here, which is exactly the mis-color we want to catch.
// The palette stores OKLab, so convert each base face color to its sRGB hex to match
// `paletteRGB(...).getHex()`.
const swatchByHex = new Map<number, string>();
for (const [name, entry] of Object.entries(config.render.palette)) {
  const { l, a, b } = entry.face;
  swatchByHex.set(parseInt(formatHex({ mode: "oklab", l, a, b })!.slice(1), 16), name);
}

/** Count of each swatch NAME across a geometric-color list, under the active scheme.
 *  An unrecognised (Adj / default) resolution is surfaced as `?<hex>` so it fails loudly. */
const swatchCounts = (colors: Iterable<GeomColor>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of colors) {
    const hex = paletteRGB(c).getHex();
    const name = swatchByHex.get(hex) ?? `?${hex.toString(16)}`;
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
};

const withScheme = <T>(scheme: SchemeName, fn: () => T): T => {
  setColorScheme(scheme);
  try {
    return fn();
  } finally {
    setColorScheme(config.colors.defaultScheme as SchemeName);
  }
};

describe("snub / gyro geometric colors", () => {
  it("snub(rectify(tetra)) = icosahedron: 20 faces / 12 vertices / 30 edges", () => {
    const c = snub(rectify(seed("tetrahedron")));
    // Every element now carries its own distinct ID (uniqueness is checked in
    // tests/colorIds); here we just pin the element counts. 20 faces = 4 tetra faces +
    // 4 tetra-vertex faces + 12 new snub triangles; 12 vertices; 30 edges.
    expect(c.face.length).toBe(20);
    expect(c.vertex.length).toBe(12);
    expect(c.edge.size).toBe(30);
  });

  it("gyro(join(tetra)) = dodecahedron, grouped by provenance", () => {
    const c = gyro(join(seed("tetrahedron")));
    // Dual of the snub: 12 faces, 20 vertices, 30 edges.
    expect(c.face.length).toBe(12);
    expect(c.vertex.length).toBe(20);
    expect(c.edge.size).toBe(30);
  });
});

// Specific-swatch regression tests: pin the actual color a viewer sees for the
// classic solids, so a broken propagation rule (e.g. a new element landing on the
// wrong swatch, or falling through to the default) is caught rather than passing a
// size-only check. See the octahedral / icosahedral schemes in config.ts for why
// each element resolves to the swatch asserted.
describe("swatch colors of the built solids", () => {
  it("octahedron (rectify tetra) and its dual cube", () =>
    withScheme("octahedral", () => {
      const oct = rectify(seed("tetrahedron"));
      expect(swatchCounts(oct.colors.face)).toEqual({ yellow: 8 });
      expect(swatchCounts(oct.colors.vertex)).toEqual({ red: 6 });
      expect(swatchCounts(oct.colors.edge.values())).toEqual({ blue: 12 });

      const cube = join(seed("tetrahedron"));
      // Dual: vertex↔face roles swap, edges stay edges.
      expect(swatchCounts(cube.colors.face)).toEqual({ red: 6 });
      expect(swatchCounts(cube.colors.vertex)).toEqual({ yellow: 8 });
      expect(swatchCounts(cube.colors.edge.values())).toEqual({ blue: 12 });
    }));

  it("icosahedron (snub) and its dual dodecahedron (gyro)", () =>
    withScheme("icosahedral", () => {
      const ico = snub(rectify(seed("tetrahedron")));
      expect(swatchCounts(ico.face)).toEqual({ yellow: 20 });
      expect(swatchCounts(ico.vertex)).toEqual({ red: 12 });
      expect(swatchCounts(ico.edge.values())).toEqual({ blue: 30 });

      const dod = gyro(join(seed("tetrahedron")));
      // Dual of the icosahedron: face↔vertex swatches swap, edges stay blue. (The
      // dodecahedron's 12 non-cube vertices are the dual of the icosahedron's 12 snub
      // gap triangles — they must land on `yellow`, not fall through to another swatch.)
      expect(swatchCounts(dod.face)).toEqual({ red: 12 });
      expect(swatchCounts(dod.vertex)).toEqual({ yellow: 20 });
      expect(swatchCounts(dod.edge.values())).toEqual({ blue: 30 });
    }));
});

// The dodecahedron IS the dual of the icosahedron, so — since gyro is the dual of snub
// — the two solids must carry mirror-image colors: every icosahedron FACE color must
// reappear as a dodecahedron VERTEX color (and vice-versa), with edges identical.
describe("gyro is the color-dual of snub", () => {
  it("icosahedron ↔ dodecahedron colors are swapped face/vertex, equal on edges", () => {
    const ico = snub(rectify(seed("tetrahedron")));
    const dod = gyro(join(seed("tetrahedron")));
    withScheme("icosahedral", () => {
      // Faces of one = vertices of the other, as multisets of swatch names.
      expect(swatchCounts(dod.vertex)).toEqual(swatchCounts(ico.face));
      expect(swatchCounts(dod.face)).toEqual(swatchCounts(ico.vertex));
      // Edges map to edges unchanged.
      expect(swatchCounts(dod.edge.values())).toEqual(swatchCounts(ico.edge.values()));
    });
  });
});
