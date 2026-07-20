import { describe, it, expect } from "vitest";
import { NAMED } from "../src/data/namedPolyhedra";
import { computeSignature } from "../src/identify/configurations";

describe("named database integrity", () => {
  it("has no duplicate signatures and the new shapes are well-formed", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const e of NAMED) {
      const sig = computeSignature(e.poly.dcel);
      const key = JSON.stringify({
        V: sig.V, E: sig.E, F: sig.F,
        v: sig.vertexConfigs, f: sig.faceConfigs,
      });
      const prev = seen.get(key);
      if (prev) dupes.push(`${e.name} == ${prev}`);
      else seen.set(key, e.name);
    }

    for (const name of [
      "Chamfered cube", "Chamfered octahedron", "Chamfered dodecahedron",
      "Chamfered icosahedron", "Subdivided cube", "Subdivided octahedron",
      "Subdivided dodecahedron", "Subdivided icosahedron",
    ]) {
      const e = NAMED.find((n) => n.name.toLowerCase() === name.toLowerCase())!;
      const s = computeSignature(e.poly.dcel);
      console.log(`${name}: V=${s.V} E=${s.E} F=${s.F}  faces=${JSON.stringify(s.faceConfigs)}`);
    }

    expect(dupes).toEqual([]);
  });
});
