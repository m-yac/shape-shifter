/**
 * =============================================================================
 *  POLYHEDRA CRAFT — CONFIGURATION
 * =============================================================================
 *
 *  This is the single source of truth for every tunable value and on/off switch
 *  in the app. You can change behaviour, enable/disable features, and tweak the
 *  feel of the interactions WITHOUT touching any other file.
 *
 *  Edit a value, save, and the dev server hot-reloads. Each field is documented
 *  inline. Booleans turn features on/off; numbers tune thresholds and the solver.
 * =============================================================================
 */

export const config = {
  // ---------------------------------------------------------------------------
  // FEATURES — turn whole capabilities on or off.
  // ---------------------------------------------------------------------------
  features: {
    // Each interactive operation can be independently disabled. When disabled,
    // the corresponding gesture simply does nothing.
    operations: {
      truncate: true, // drag a vertex inward (no modifier)
      rectify: true, // the welded "max" end of the truncate drag (drag fully in)
      kis: true, // drag a face center outward (no modifier)
      join: true, // the welded "max" end of the kis drag (drag fully out)
      snub: true, // Shift + drag a degree-2n vertex
      gyro: true, // Shift + drag a 2n-gon face
    },

    multiSelect: true, // Cmd (macOS) / Ctrl: select several elements before dragging
    hoverHighlight: true, // highlight draggable vertices / face-centers under the mouse
    identification: true, // identify & name the current polyhedron after each edit
    isomorphismCheck: true, // background graph-isomorphism verification (the ✓ mark)
    textReadout: true, // show the name + ✓ in the bottom-left corner overlay
    logToConsole: true, // also print identification results to the dev console
  },

  // ---------------------------------------------------------------------------
  // INTERACTION — how dragging, snapping and selection feel.
  // ---------------------------------------------------------------------------
  interaction: {
    // Pixel radius around a vertex / face-center within which hovering counts as
    // "over" it: the marker takes its prominent appearance and is grabbable.
    hoverPixelRadius: 22,

    // Larger radius: when the cursor is merely NEAR the polyhedron, the single
    // closest drag point becomes subtly visible (a hint) without being grabbable.
    proximityPixelRadius: 60,

    // A marker is pickable only while at least one of its faces points toward the
    // camera by MORE than this margin (degrees) past perpendicular. Faces that are
    // edge-on (within the margin of 90°) or back-facing are treated as occluded,
    // so you can't grab a handle on the far/silhouette side of the solid.
    pickNormalMarginDeg: 4,

    // Camera orbit: left-drag on empty space and right-drag both rotate; the
    // wheel zooms. Left-drag that grabs a vertex/face does the operation instead.
    // (The middle button dollies.)

    // Per-operation snapping (snap the mouse to the relevant edge / normal line
    // when computing how far it has been dragged). Turning this off lets the raw
    // (un-projected) cursor distance drive the parameter instead.
    snapTruncateToEdge: true,
    snapKisToNormal: true,
  },

  // ---------------------------------------------------------------------------
  // SOLVER — the relaxation that runs after you release the mouse.
  //   Stage 1 makes every face planar. If it cannot, the shape is "invalid".
  //   Stage 2 (only if planar) nudges faces toward regular polygons.
  // ---------------------------------------------------------------------------
  solver: {
    enabled: true,

    planarity: {
      // Max solver iterations spent trying to flatten faces before giving up.
      maxIterations: 256,
      // Wall-clock budget (ms). Exceeding it (without converging) => invalid.
      timeBudgetMs: 4000,
      // A face counts as planar when its max out-of-plane distance (relative to
      // the shape's size) is below this.
      tolerance: 1e-3,
      // How aggressively vertices are pulled onto their face plane each step (0..1).
      stepFactor: 1.5,
    },

    regularity: {
      // Iterations spent improving regularity once the shape is planar.
      iterations: 256,
      // Step size for the regularizing nudge each iteration (0..1).
      stepFactor: 2,
      // Damping starts here and decays by `dampingRate` each iteration so the
      // motion settles instead of oscillating. effective step = stepFactor * damp.
      dampingStart: 1.0,
      dampingRate: 0.997,
      // Stop early when the largest per-vertex move drops below this (relative).
      convergeTolerance: 1e-5,
      // Re-flatten faces between regularity steps so it never drifts off-plane.
      keepPlanar: true,
      // Planarization sub-steps applied after each regularity step (keeps faces flat).
      planarSubsteps: 2,

      // After release, the solid is gently rescaled so the AVERAGE vertex distance
      // from the origin approaches this target (keeps apparent size stable across
      // truncate/kis edits). `rescaleRate` is the fraction eased each iteration.
      targetAverageRadius: 1,
      rescaleRate: 0.06,

      // Multi-stage ANTI-COLLAPSE. While regularizing, if adjacent faces get too
      // close to coplanar (the solid flattening — common when forcing Catalan-like
      // faces to be regular) the objective escalates to avoid collapse:
      //   regular faces  →  equal vertex angles (dual-regular)  →  spherize.
      // The measure is the MINIMUM angle (degrees) between adjacent face normals;
      // 0° means two faces have become coplanar.
      coplanar: {
        safeAngleDeg: 18, // above this: keep regularizing faces
        dangerAngleDeg: 6, // between danger and safe: equalize vertex angles
        // below danger: spherize. Recovery back up uses these × recoverMargin
        // (hysteresis, so it doesn't flip-flop between strategies).
        recoverMargin: 1.6,
      },
    },

    // If planarization runs out of iterations/time, mark the polyhedron invalid.
    invalidOnTimeout: true,
  },

  // ---------------------------------------------------------------------------
  // IDENTIFY — naming + verification.
  // ---------------------------------------------------------------------------
  identify: {
    // Don't even attempt the (potentially expensive) isomorphism brute-force if
    // the candidate has more than this many vertices.
    isomorphismMaxVertices: 200,
  },

  // ---------------------------------------------------------------------------
  // SEEDS — which starting solids exist, and which loads on launch.
  //   Names must match entries in geometry/seeds.ts.
  // ---------------------------------------------------------------------------
  seeds: {
    enabled: [
      "tetrahedron",
      "cube",
      "octahedron",
      "dodecahedron",
      "icosahedron",
    ],
    initial: "tetrahedron",
    // Press these number keys (1..5) to load the corresponding enabled seed.
    numberKeyToLoadSeed: true,
    // Press R to reset to the current seed.
    resetKey: "r",
  },

  // ---------------------------------------------------------------------------
  // DEBUG — manual relaxation controls for experimenting with the post-release
  //   solve. Each key re-runs relaxation on the CURRENT shape; the "force"
  //   variants lock the regularizer to one strategy instead of the automatic
  //   anti-collapse escalation, so you can isolate the coplanarity step.
  // ---------------------------------------------------------------------------
  debug: {
    manualRelax: true, // enable the keys below
    relaxKey: "g", // re-relax with the automatic (escalating) strategy
    forceFacesKey: "f", // force regular-faces regularization
    forceCanonicalKey: "c", // force the coplanarity / anti-collapse (dual/midsphere) step
    forceSpherizeKey: "v", // force spherize (last-resort inflate)
  },

  // ---------------------------------------------------------------------------
  // INTRO CUTSCENE.
  // ---------------------------------------------------------------------------

  intro: {
    cameraDistance: 7, // initial camera distance from origin
    bootDuration: 6, // second(s)
    shapeFadeInDuration: 10, // second(s)
  },

  // ---------------------------------------------------------------------------
  // CAMERA.
  // ---------------------------------------------------------------------------
  camera: {
    fov: 45,
    startDistance: 3.5, // distance from origin (the polyhedron is normalized ~unit)
    minDistance: 1.5,
    maxDistance: 25,
    rotateSpeed: 2.0,
    scaleFactor: 1.2,
    dampingFactor: 8,
    autoFrame: true, // reframe distance to fit each newly loaded seed
  },

  // ---------------------------------------------------------------------------
  // SCREEN — the vintage-monitor frame and the character grid inside it.
  //
  //   The whole app lives on a centered "screen" (a CRT) smaller than the
  //   browser window. Everything (text AND the 3D canvas) is laid out on a grid
  //   of character cells from the AST PremiumExec font (an 8x19px PC font) drawn
  //   at 2x, so one cell is 16px wide x 38px tall. The screen interior is always
  //   sized to a whole number of cells, so HTML positioned with the grid helpers
  //   (see ui/screen.ts) lines up exactly like text on a real terminal.
  // ---------------------------------------------------------------------------
  screen: {
    fontPx: 38, // font-size that makes a cell exactly colW x rowH
    colW: 16, // character cell width  (font advance 800/1900 * 38px)
    rowH: 38, // character cell height (em box 1900/1900 * 38px = line-height)
    viewportMargin: -20, // min gap from the browser edge to the monitor's outer frame
    bezel: 40, // plastic-frame thickness around the glass (always >= this)
    padding: 24, // dark glass margin between the bezel and the lit pixel grid
  },

  // ---------------------------------------------------------------------------
  // THEME — the CRT phosphor + plastic look. All CSS-side colors live here and
  //   are pushed to CSS custom properties at startup (see Screen.applyTheme).
  // ---------------------------------------------------------------------------
  theme: {
    phosphor: "#86f2b0", // base text color (green phosphor)
    phosphorBright: "#d2ffe2", // emphasized text (titles, current entry)
    phosphorDim: "#3f8a5e", // de-emphasized text (redo tail, hints)
    phosphorWarn: "#e0a36a", // invalid / warning text (amber)
    glowColor: "78, 224, 122", // rgb of the phosphor glow (text-shadow + 3D bloom tint)
    glass: "#0a0f0c", // CRT glass color behind the 3D canvas
    monitorBright: "25, 29, 38", // rgb of the monitor when it starts up
    room: "#04060a", // the void behind the monitor
    bezelLight: "#3b3e37", // plastic frame: lit edge
    bezelDark: "#1c1e19", // plastic frame: shadowed edge

    // Phosphor "pixel" mask: a faint grid aligned to the font's pixel size. The
    // 8x19 font drawn at 2x makes one source pixel exactly 2 CSS px, so a 2px
    // grid lands on every font pixel and gives each one a little definition.
    pixelMask: true,
    pixelMaskStyle: "dots" as "lines" | "dots", // "lines": dark grid; "dots": a phosphor dot per pixel
    pixelSize: 2, // px period of the mask (one font pixel at 2x)
    pixelOpacity: 0.5, // darkness of the mask gridlines / gaps between dots

    // Render the 3D view at the font-pixel resolution instead of full res: the
    // WebGL buffer is 1 texel per `pixelSize` CSS px (= one font pixel), then
    // nearest-neighbor upscaled, so the polyhedron is drawn on the SAME chunky
    // pixel grid as the text. Since a cell is 16x38 = (8x19)*pixelSize, the buffer
    // is always a whole number of texels and the upscale is an exact integer.
    pixelateRender: true,

    vignette: true, // darkened screen corners (CRT curvature hint)
    vignetteOpacity: 0.55,

    // BLOOM — one intensity drives BOTH the CSS text glow and the WebGL
    // UnrealBloom over the 3D view, so they read as a single phosphor bloom.
    // radius/threshold shape only the 3D pass.
    bloom: {
      intensity: 1.2, // master glow strength for text AND 3D (0 = off)
      scale_3d: 0.2, // glow strength multiplier for 3D only
      radius: 0, // 3D bloom spread
      threshold: 0.05, // 3D bloom luminance threshold (only brighter pixels bloom)
    },
  },

  // ---------------------------------------------------------------------------
  // RENDER — minimal, functional look only (no decorative visuals yet).
  // ---------------------------------------------------------------------------
  render: {
    backgroundColor: 0x10141c,

    faceColor: 0x57c785,
    faceOpacity: 0.92,
    invalidFaceColor: 0xb04a4a, // faces shown when the solver declares invalid
    adjustingColor: 0x5b8fb0, // faces while relaxing (NOT yet interactable)

    edgeColor: 0x0c0f15,
    showEdges: true,

    // Pickable handle markers. Radii are the on-screen size at the default
    // camera distance; markers auto-rescale with zoom to keep that apparent size.
    vertexMarkerColor: 0xe0e0e0,
    vertexMarkerRadius: 0.04,
    faceMarkerColor: 0xe0e0e0,
    faceMarkerRadius: 0.05,
    showVertexMarkers: true,
    showFaceMarkers: true,
    // Opacity of a marker when it is only a "nearby" hint (proximity, not in range).
    markerProximityOpacity: 0.32,

    // Feedback colors.
    hoverColor: 0xffffff, // element under the cursor (in range)
    selectedColor: 0x4ee07a, // multi-selected elements
    dragColor: 0xff7043, // (reserved) drag state for markers

    // The drag "range" line (current point → max). A white tube; its radius is the
    // on-screen width at the default camera distance and auto-rescales with zoom.
    dragLineColor: 0xffffff,
    dragLineRadius: 0.005,

    // Small sphere shown on the vertex currently targeted by the drag (like the
    // hover marker, but smaller). Radius is the on-screen size at the default
    // camera distance and auto-rescales with zoom.
    dragMarkerColor: 0xffffff,
    dragMarkerRadius: 0.025,

    // Hover highlight of a whole face (translucent overlay over the hovered face).
    faceHighlightColor: 0xffffff,
    faceHighlightOpacity: 0.22,
  },
} as const;

export type Config = typeof config;
