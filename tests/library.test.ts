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
    expect(parseArrow("d2")).toEqual([{ step: [0, -2, 0], head: "middle" }]);
  });
  it("gives each direction letter its own span (non-45° lines)", () => {
    expect(parseArrow("d3r2")).toEqual([{ step: [2, -3, 0], head: "middle" }]);
  });
  it("defaults a missing span to 1 and reads a leading '>' as a start head", () => {
    expect(parseArrow(">u")).toEqual([{ step: [0, 1, 0], head: "start" }]);
  });
  it("reads a trailing '>' as an end head", () => {
    expect(parseArrow("u2>")).toEqual([{ step: [0, 2, 0], head: "end" }]);
  });
  it("splits a bundled token group into several arrows", () => {
    expect(parseArrow(">f4r4, b2r2")).toEqual([
      { step: [4, 0, 4], head: "start" },
      { step: [2, 0, -2], head: "middle" },
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
  it("reveals the Tetrahedron's children + one solid-arrowhead hop", () => {
    // The spec example: with only the Tetrahedron made, you see it, its
    // truncation + kis + chamfer + subdivision, and (one solid-arrowhead hop
    // further) the octahedron + cube.
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
      ]),
    );
  });

  it("does NOT reveal grandchildren beyond the one arrowhead hop", () => {
    // Cuboctahedron is a descendant of the Octahedron, which is itself only a
    // second-hop node — so it must stay hidden.
    expect(visibleNames(["Tetrahedron"]).has("Cuboctahedron")).toBe(false);
  });

  it("only follows arrows in their direction (a node is a neighbour only if an arrow points TO it)", () => {
    // The Octahedron has no arrow pointing back to the Tetrahedron, so making the
    // Octahedron must not reveal the Tetrahedron.
    expect(visibleNames(["Octahedron"]).has("Tetrahedron")).toBe(false);
  });
});

describe("drawableEdges (second-hop ghosts show incoming arrows only)", () => {
  const edgeNames = (eis: number[]): [string, string][] =>
    eis.map((i) => [graph.nodes[graph.edges[i].from].name, graph.nodes[graph.edges[i].to].name]);

  it("draws arrows leading TO a second-hop ghost but not FROM it", () => {
    const discovered = new Set([indexOf("Tetrahedron")]);
    const visible = computeVisible(graph, discovered);
    const drawn = edgeNames(drawableEdges(graph, discovered, visible));

    // Octahedron is a second-hop ghost: the arrow INTO it (from Truncated
    // Tetrahedron, a first-hop neighbour) is drawn...
    expect(drawn).toContainEqual(["Truncated Tetrahedron", "Octahedron"]);
    // ...but its OWN outgoing arrows are not (they'd lead off to hidden shapes).
    expect(drawn.every(([from]) => from !== "Octahedron")).toBe(true);
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

  it("colors the cube the way the game makes it: join(tetrahedron) → all faces one color", () => {
    const cube = libraryShapeFor("Cube")!;
    expect(cube.scheme).toBe("octahedral");
    // join() colors its rhombi by the parent's edge color (the tetrahedron's edge
    // triple [0,0,1]), NOT the bare-seed face color — so every face is that one color.
    expect(new Set(cube.poly.colors.face.map((c) => c.join(",")))).toEqual(new Set(["0,0,1"]));
  });

  it("gives each Platonic solid its own symmetry color scheme", () => {
    expect(libraryShapeFor("Tetrahedron")!.scheme).toBe("tetrahedral");
    expect(libraryShapeFor("Octahedron")!.scheme).toBe("octahedral");
    expect(libraryShapeFor("Icosahedron")!.scheme).toBe("icosahedral");
  });
});
