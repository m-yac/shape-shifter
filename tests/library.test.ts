import { describe, it, expect } from "vitest";
import { config } from "../src/config";
import {
  parseArrow,
  buildDiagramGraph,
  computeVisible,
  drawableEdges,
} from "../src/data/libraryDiagram";
import { libraryShapeFor } from "../src/data/libraryShapes";
import { identify } from "../src/identify/identify";
import { paletteRGB, setColorScheme, type SchemeName } from "../src/geometry/colors";

const diagramNames = (config.library.diagram as unknown as [number, number, number, string, string[]][]).map(
  (e) => e[3],
);

const graph = buildDiagramGraph();
const indexOf = (name: string): number =>
  graph.nodes.findIndex((n) => n.name.toLowerCase() === name.toLowerCase());
const visibleNames = (discovered: string[]): Set<string> => {
  const set = new Set(discovered.map((n) => indexOf(n)));
  return new Set([...computeVisible(graph, set)].map((i) => graph.nodes[i].name));
};

describe("parseArrow (per-axis span notation)", () => {
  it("reads a single axis with a span (bare token = middle head)", () => {
    expect(parseArrow("d2")).toEqual([{ step: [0, -2, 0], head: "middle", dashed: false }]);
  });
  it("gives each direction letter its own span (non-45° lines)", () => {
    expect(parseArrow("d3r2")).toEqual([{ step: [2, -3, 0], head: "middle", dashed: false }]);
  });
  it("defaults a missing span to 1 and reads a leading '>' as a start head", () => {
    expect(parseArrow(">u")).toEqual([{ step: [0, 1, 0], head: "start", dashed: false }]);
  });
  it("reads a trailing '>' as an end head", () => {
    expect(parseArrow("u2>")).toEqual([{ step: [0, 2, 0], head: "end", dashed: false }]);
  });
  it("reads a leading ':' as a dashed arrow (before the head '>')", () => {
    expect(parseArrow(":>fl")).toEqual([{ step: [-1, 0, 1], head: "start", dashed: true }]);
  });
  it("splits a bundled token group into several arrows", () => {
    expect(parseArrow(">f4r4, b2r2")).toEqual([
      { step: [4, 0, 4], head: "start", dashed: false },
      { step: [2, 0, -2], head: "middle", dashed: false },
    ]);
  });
});

describe("diagram graph", () => {
  it("places every diagram solid as a node", () => {
    expect(graph.nodes.length).toBe(diagramNames.length);
  });
  it("resolves the Tetrahedron's arrows to its truncation and kis", () => {
    const tet = indexOf("Tetrahedron");
    const targets = graph.outgoing[tet].map((ei) => graph.nodes[graph.edges[ei].to].name);
    expect(targets).toContain("Truncated Tetrahedron");
    expect(targets).toContain("Triakis Tetrahedron");
  });
});

describe("computeVisible (directed neighbours)", () => {
  it("reveals the Tetrahedron's whole compound chain (truncate → rectify → snub)", () => {
    // The spec example: with only the Tetrahedron made, you see it, its
    // truncation + kis (start), their rectification + join — the Octahedron +
    // Cube (middle) — and one further hop, the snub + gyro — the Icosahedron +
    // Dodecahedron (end). Plus its dashed chamfer + subdivide leaves.
    const v = visibleNames(["Tetrahedron"]);
    expect(v).toEqual(
      new Set([
        "Tetrahedron",
        "Truncated Tetrahedron",
        "Triakis Tetrahedron",
        "Chamfered Tetrahedron",
        "Subdivided Tetrahedron",
        "Octahedron",
        "Cube",
        "Icosahedron",
        "Dodecahedron",
      ]),
    );
  });

  it("does NOT expand a chain node's own new branches", () => {
    // The Octahedron is reached mid-chain (via a middle arrow), so only its END
    // arrow (the snub) continues; its own truncations must stay hidden until it
    // is discovered. The Cuboctahedron (a truncation-branch of the Octahedron)
    // therefore stays hidden.
    expect(visibleNames(["Tetrahedron"]).has("Cuboctahedron")).toBe(false);
  });

  it("does NOT chain a dashed chamfer/subdivide leaf onward into a middle arrow", () => {
    // The Cube reaches the Chamfered Cube by a dashed (:>) arrow, so it is a
    // leaf: the Rhombicuboctahedron it points on to (via a solid middle arrow)
    // must not be revealed just from making the Cube.
    const v = visibleNames(["Cube"]);
    expect(v.has("Chamfered Cube")).toBe(true);
    expect(v.has("Rhombicuboctahedron")).toBe(false);
  });

  it("does NOT begin a chain partway along a compound arrow (a middle head)", () => {
    // Making (not just seeing) the Subdivided Cube reveals nothing new: its only
    // arrow onward is the MIDDLE of the compound arrow Cuboctahedron →
    // Subdivided Octahedron → Deltoidal Icositetrahedron, and its ">…" first hop
    // is not active — you have not rectified. So the Deltoidal Icositetrahedron
    // (and the arrow leading to it) must stay hidden.
    const v = visibleNames(["Subdivided Cube"]);
    expect(v.has("Deltoidal Icositetrahedron")).toBe(false);
    expect(v).toEqual(new Set(["Subdivided Cube"]));
  });

  it("only follows arrows in their direction (a node is a neighbour only if an arrow points TO it)", () => {
    // The Octahedron has no arrow pointing back to the Tetrahedron, so making the
    // Octahedron must not reveal the Tetrahedron.
    expect(visibleNames(["Octahedron"]).has("Tetrahedron")).toBe(false);
  });
});

describe("drawableEdges (only the traversed chain arrows)", () => {
  const edgeNames = (eis: number[]): [string, string][] =>
    eis.map((i) => [graph.nodes[graph.edges[i].from].name, graph.nodes[graph.edges[i].to].name]);

  it("draws every arrow the reveal chain follows, but not a node's un-followed branches", () => {
    const discovered = new Set([indexOf("Tetrahedron")]);
    const visible = computeVisible(graph, discovered);
    const drawn = edgeNames(drawableEdges(graph, discovered, visible));

    // The chain arrows are all drawn: truncate → rectify → snub.
    expect(drawn).toContainEqual(["Truncated Tetrahedron", "Octahedron"]);
    expect(drawn).toContainEqual(["Octahedron", "Icosahedron"]);
    // But the Octahedron's OWN start branches (its truncations) are not followed
    // here, so they aren't drawn (they'd lead off to still-hidden shapes).
    expect(drawn).not.toContainEqual(["Octahedron", "Truncated Octahedron"]);
    expect(drawn).not.toContainEqual(["Octahedron", "Triakis Octahedron"]);
  });
});

describe("library shapes (rooted at the tetrahedron)", () => {
  it("builds every diagram solid and identifies it by its diagram name", () => {
    for (const name of diagramNames) {
      const shape = libraryShapeFor(name);
      expect(shape, `missing shape: ${name}`).not.toBeNull();
      expect(identify(shape!.poly).name?.toLowerCase(), `identify: ${name}`).toBe(
        name.toLowerCase(),
      );
    }
  });

  it("colors the cube the way the game makes it: join(tetrahedron) → all faces one swatch", () => {
    const cube = libraryShapeFor("Cube")!;
    expect(cube.scheme).toBe("octahedral");
    // join() colors its 6 rhombi from the tetrahedron's 6 EDGES — so each face now
    // carries its own distinct edge ID (6 unique vectors), but under the octahedral
    // scheme all 6 still render as the one edge swatch, so the cube reads as one color.
    expect(new Set(cube.poly.colors.face.map((c) => c.join(",")))).toHaveProperty("size", 6);
    setColorScheme(cube.scheme as SchemeName);
    try {
      const hexes = new Set(cube.poly.colors.face.map((c) => paletteRGB(c).getHex()));
      expect(hexes.size).toBe(1);
    } finally {
      setColorScheme(config.colors.defaultScheme as SchemeName);
    }
  });

  it("gives each Platonic solid its own symmetry color scheme", () => {
    expect(libraryShapeFor("Tetrahedron")!.scheme).toBe("tetrahedral");
    expect(libraryShapeFor("Octahedron")!.scheme).toBe("octahedral");
    expect(libraryShapeFor("Icosahedron")!.scheme).toBe("icosahedral");
  });
});
