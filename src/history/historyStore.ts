import { Vector3 } from "three";
import { config } from "../config";
import { Polyhedron } from "../geometry/polyhedron";
import { type Mesh } from "../geometry/HalfEdge";
import { type ColorSet, type GeomColor } from "../geometry/colors";
import { type HistoryEntry, type HistoryOptions } from "./history";
import { type OpDescriptor } from "../operations/naming";

/**
 * Per-shape construction histories, persisted to localStorage. When the user MAKES
 * a named shape for the first time, the DragController saves the timeline that led
 * there (keyed by the shape's name). The LIBRARY browse screen then reopens a shape
 * in the main view *with that history* when it is clicked.
 *
 * Each history entry is reduced to its plain geometry (mesh vertices + faces),
 * palette colors, and the small bit of metadata the timeline needs (label, op
 * descriptor, view options, …). On load the Polyhedron is rebuilt from that data;
 * its `raw` defaults to a clone of the saved mesh, which is all a later re-solve
 * from the entry needs.
 */

interface SavedMesh {
  v: number[][]; // vertices as [x, y, z]
  f: number[][]; // faces as vertex-index loops
}

interface SavedColors {
  vertex: GeomColor[];
  face: GeomColor[];
  edge: [string, GeomColor][];
}

interface SavedEntry {
  label: string;
  name: string | null;
  displayName: string | null;
  op: OpDescriptor | null;
  invalid: boolean;
  isSeed: boolean;
  options: HistoryOptions;
  mesh: SavedMesh;
  colors: SavedColors;
}

/** A serialized timeline: the seed label plus every committed entry. */
export interface SavedHistory {
  seedLabel: string;
  entries: SavedEntry[];
}

function meshToSaved(mesh: Mesh): SavedMesh {
  return {
    v: mesh.vertices.map((p) => [p.x, p.y, p.z]),
    f: mesh.faces.map((loop) => loop.slice()),
  };
}

function savedToMesh(s: SavedMesh): Mesh {
  return {
    vertices: s.v.map(([x, y, z]) => new Vector3(x, y, z)),
    faces: s.f.map((loop) => loop.slice()),
  };
}

function colorsToSaved(c: ColorSet): SavedColors {
  return { vertex: c.vertex.slice(), face: c.face.slice(), edge: [...c.edge.entries()] };
}

function savedToColors(s: SavedColors): ColorSet {
  return { vertex: s.vertex.slice(), face: s.face.slice(), edge: new Map(s.edge) };
}

/** Reduce a slice of live history entries to a serializable form. */
export function serializeHistory(
  entries: readonly HistoryEntry[],
  seedLabel: string,
): SavedHistory {
  return {
    seedLabel,
    entries: entries.map((e) => ({
      label: e.label,
      name: e.name,
      displayName: e.displayName,
      op: e.op,
      invalid: e.invalid,
      isSeed: e.isSeed,
      options: { ...e.options },
      mesh: meshToSaved(e.poly.mesh),
      colors: colorsToSaved(e.poly.colors),
    })),
  };
}

/** Rebuild live history entries (with real Polyhedron objects) from saved data. */
export function deserializeHistory(saved: SavedHistory): {
  entries: HistoryEntry[];
  seedLabel: string;
} {
  const entries = saved.entries.map((e): HistoryEntry => ({
    poly: new Polyhedron(savedToMesh(e.mesh), savedToColors(e.colors)),
    label: e.label,
    name: e.name,
    displayName: e.displayName,
    op: e.op,
    invalid: e.invalid,
    isSeed: e.isSeed,
    options: { ...e.options },
  }));
  return { entries, seedLabel: saved.seedLabel };
}

/**
 * The localStorage-backed map of shape-name → its saved timeline. Names are keyed
 * case-insensitively (matching the rest of the app), so "Truncated Tetrahedron"
 * and the database's "Truncated tetrahedron" resolve to the same record.
 */
export class HistoryStore {
  private readonly map = new Map<string, SavedHistory>();

  constructor() {
    try {
      const raw = localStorage.getItem(config.discovery.historyStorageKey);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, SavedHistory>;
        for (const [name, hist] of Object.entries(obj)) {
          this.map.set(name.trim().toLowerCase(), hist);
        }
      }
    } catch {
      /* corrupt / unavailable storage: start with no saved histories */
    }
  }

  has(name: string): boolean {
    return this.map.has(name.trim().toLowerCase());
  }

  get(name: string): SavedHistory | null {
    return this.map.get(name.trim().toLowerCase()) ?? null;
  }

  /** Save (once) the timeline that first produced `name`. Ignores re-saves so the
   *  ORIGINAL path to a shape is the one the LIBRARY replays. */
  save(name: string, entries: readonly HistoryEntry[], seedLabel: string): void {
    const key = name.trim().toLowerCase();
    if (this.map.has(key)) return;
    this.map.set(key, serializeHistory(entries, seedLabel));
    this.persist();
  }

  private persist(): void {
    if (!config.discovery.persist) return;
    try {
      const obj: Record<string, SavedHistory> = {};
      for (const [name, hist] of this.map) obj[name] = hist;
      localStorage.setItem(config.discovery.historyStorageKey, JSON.stringify(obj));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }
}

/** Wipe ALL persisted progress (made-shape set + every saved history). Used by the
 *  LIBRARY's "Reset" button before reloading the page back to the intro. */
export function clearAllProgress(): void {
  try {
    localStorage.removeItem(config.discovery.storageKey);
    localStorage.removeItem(config.discovery.historyStorageKey);
  } catch {
    /* ignore */
  }
}

/** Whether a returning visitor has saved progress (more made shapes than the
 *  pre-discovered starters), so the app can skip the boot intro and load straight in. */
export function hasSavedProgress(): boolean {
  try {
    const raw = localStorage.getItem(config.discovery.storageKey);
    if (!raw) return false;
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) && arr.length > config.discovery.preDiscovered.length;
  } catch {
    return false;
  }
}
