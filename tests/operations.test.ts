import { describe, it, expect } from "vitest";
import { getSeed } from "../src/geometry/seeds";
import { Polyhedron } from "../src/geometry/polyhedron";
import { buildDCEL, counts } from "../src/geometry/HalfEdge";
import { buildTruncate } from "../src/operations/truncate";
import { buildKis } from "../src/operations/kis";
import { computeSignature } from "../src/identify/configurations";
import { weldVertexPairs } from "../src/operations/weld";
import { uniformColors } from "../src/geometry/colors";
import { Vector3 } from "three";

const cube = () => new Polyhedron(getSeed("cube"));

describe("truncate / rectify", () => {
  it("intermediate truncation of the cube is the truncated cube (3.8.8)", () => {
    const mesh = buildTruncate(cube(), 0, null).commit(0.5, false).mesh;
    const sig = computeSignature(buildDCEL(mesh));
    expect(sig).toMatchObject({ V: 24, E: 36, F: 14 });
    expect(sig.vertexConfigs).toEqual({ "3.8.8": 24 });
    expect(sig.faceConfigs).toEqual({ "3.3.3": 8, "3.3.3.3.3.3.3.3": 6 });
  });

  it("welded max (rectify) of the cube is the cuboctahedron (3.4.3.4)", () => {
    const mesh = buildTruncate(cube(), 0, null).commit(1, true).mesh;
    const sig = computeSignature(buildDCEL(mesh));
    expect(sig).toMatchObject({ V: 12, E: 24, F: 14 });
    expect(sig.vertexConfigs).toEqual({ "3.4.3.4": 12 });
    expect(sig.faceConfigs).toEqual({ "4.4.4": 8, "4.4.4.4": 6 });
  });
});

describe("kis / join", () => {
  it("intermediate kis of the cube is the tetrakis hexahedron", () => {
    const mesh = buildKis(cube(), 0, null).commit(0.5, false).mesh;
    const c = counts(buildDCEL(mesh));
    expect(c).toEqual({ V: 14, E: 36, F: 24 });
  });

  it("welded max (join) of the cube is the rhombic dodecahedron (3.4.3.4 faces)", () => {
    const mesh = buildKis(cube(), 0, null).commit(1, true).mesh;
    const sig = computeSignature(buildDCEL(mesh));
    expect(sig).toMatchObject({ V: 14, E: 24, F: 12 });
    expect(sig.vertexConfigs).toEqual({ "4.4.4": 8, "4.4.4.4": 6 });
    expect(sig.faceConfigs).toEqual({ "3.4.3.4": 12 });
  });
});

describe("weldVertexPairs", () => {
  it("merges a pair and drops the collapsed edge", () => {
    const mesh = {
      vertices: [
        new Vector3(0, 0, 0),
        new Vector3(1, 0, 0),
        new Vector3(1, 1, 0),
        new Vector3(0, 1, 0),
      ],
      faces: [
        [0, 1, 2],
        [0, 2, 3],
      ],
    };
    const welded = weldVertexPairs(mesh, [[1, 3]], uniformColors(mesh, [0, 0, 0], [0, 0, 0], [0, 0, 0]));
    expect(welded.mesh.vertices.length).toBe(3);
    expect(welded.mesh.faces.every((f) => f.length === 3)).toBe(true);
  });
});
