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
    // A release with a t value (between 0 and 1) below this is treated as no change
    minCommitT: 1e-3,

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
    // CRT "power-on" flash: the console starts at the bright monitor color and
    // settles to the dark glass over this long before the boot text appears.
    warmupDuration: 0.6, // second(s)
    // The 3D shape fades in behind the boot sequence's closing message; once it
    // has fully faded in the console is hidden and the app takes over.
    shapeFadeInDuration: 10, // second(s)
  },

  // ---------------------------------------------------------------------------
  // GLITCH — a character-grid "corruption" overlay: random cells flip to random
  //   glyphs. ONE intensity (0..1) drives it — at 0 it is off, at 1 the entire
  //   grid is filled with churning random characters. Crucially, LOW intensities
  //   don't just thin the coverage, they also make the corruption come in
  //   occasional BURSTS rather than a steady fill (so a small percentage both
  //   shrinks each flicker and makes them pop up less often).
  //
  //   The same overlay is used twice: choreographed across the boot sequence
  //   (interaction/bootSequence.ts) and as the flash when a new shape is
  //   discovered (see `discovery` below).
  // ---------------------------------------------------------------------------
  glitch: {
    enabled: true,
    // The pool of glyphs a corrupted cell can show (one picked at random per
    // cell, per refresh). Edit this to change the texture of the corruption.
    chars: "█▓▒░▚▞▙▟◣◢╳╱╲@#$%&*?/\\<>=+-:;01ABEFΔΞΣΨΦ",
    // The glitch glyph color (defaults to a bright phosphor); a CSS color string.
    color: "#c8ffd9",
    // How often (ms) the whole random field is regenerated — the flicker rate.
    refreshMs: 55,

    // CLUSTERING. Corrupted cells aren't scattered uniformly; they're carved out
    // of an animated value-noise field, so the corruption appears in moving
    // BLOBS rather than evenly-spread static. `scale` is how many grid cells span
    // one noise lattice cell (bigger = larger, smoother blobs); `timeScale` is
    // how fast the blobs drift/morph (units per second). The coverage (0..1) is
    // the slice of the noise field that lights up, so it still reads as a
    // percentage — just clumped.
    noise: {
      scale: 5,
      timeScale: 1.6,
    },

    // AUTO-BURST. When an "auto" intensity p (0..1) is set, bursts pop up at
    // random with NO steady fill: the gap between them eases from `maxGapMs`
    // (at p→0, rare) to `minGapMs` (at p→1, constant), and each burst's peak
    // coverage is p * `peakScale`. Each burst's coverage decays linearly to 0
    // over a random duration in [minBurstMs, maxBurstMs]. This is what produces
    // the "intermittent slight reappearances" during the closing message.
    burst: {
      minGapMs: 110,
      maxGapMs: 2400,
      minBurstMs: 90,
      maxBurstMs: 340,
      peakScale: 1.0,
    },
    // The boot-sequence glitch choreography lives inline as "glitch" steps in
    // config.bootText (program + closing), so the whole arc is editable there.
  },

  // ---------------------------------------------------------------------------
  // DISCOVERY — the celebration the first time you MAKE a named shape (Platonic,
  //   Archimedean, Catalan now; Johnson solids, their duals and a few dihedral
  //   solids later — hence the eventual 250). The shape glows, the screen
  //   glitches, then a popup congratulates you and names the kind of solid.
  //   The very FIRST discovery of the session is made especially strong via the
  //   `first*` multipliers below.
  // ---------------------------------------------------------------------------
  discovery: {
    enabled: true,
    total: 250, // the eventual shape count (shown in the SHAPES panel as N/250)

    // Remember discoveries across page reloads (localStorage). Off by default so
    // the experience is reproducible; turn on to make discoveries permanent.
    persist: false,
    storageKey: "polyhedra-craft:discovered",

    // Shapes you "already have" at launch and so never trigger a discovery. The
    // boot story finds exactly the tetrahedron (1/250), so it starts discovered.
    preDiscovered: ["Tetrahedron"],

    // The bright emissive glow pulse on the shape (picked up by the 3D bloom).
    glowStrength: 1.6, // peak emissive intensity
    glowDurationS: 1.6,

    // The glitch flash over the screen (coverage peak + how long it decays over).
    // Kept well below the boot sequence's peak: a discovery should sparkle with
    // clustered corruption, never black out the whole screen.
    glitchBurst: 0.22,
    glitchDurationS: 0.9,

    // The first discovery of the session multiplies both effects for extra punch.
    // (The glow goes big; the glitch only nudges up — coverage stays comfortable.)
    firstGlowMultiplier: 2.4,
    firstGlitchMultiplier: 1.6,

    // The congratulations popup: how long after the glitch it appears, and how
    // long it stays before auto-dismissing (0 = stay until clicked/keyed away).
    popupDelayS: 0.35,
    popupHoldS: 6,
  },

  // ---------------------------------------------------------------------------
  // UI TEXT — the titles drawn in each panel's box-drawing frame, and the
  //   contents of the SHAPES panel + the new-shape DISCOVERY popup. Tokens in
  //   {braces} are substituted at runtime:
  //     SHAPES panel:     {count} {total}
  //     DISCOVERY popup:  {banner} {name} {type} {count} {total}
  // ---------------------------------------------------------------------------
  ui: {
    // Frame titles for each panel / popup.
    titles: {
      polyhedron: "SHAPE", // bottom-left status box (ui/readout.ts)
      selection: "SELECTION", //   top-left selection box (ui/readout.ts)
      history: "HISTORY", //       top-right operation list (ui/historyPanel.ts)
      shapes: "LIBRARY", //         top-left discovered-shapes panel (ui/shapesPanel.ts)
      discovery: "WOW", //   new-shape popup (ui/discoveryPopup.ts)
    },

    // The SHAPES panel body (one line).
    shapesPanel: "{count}/{total} shapes",

    // The new-shape DISCOVERY popup. `banner` is the headline (the first
    // discovery of the run uses `bannerFirst` instead); `lines` is the body,
    // one entry per centered row ("" = a blank row).
    discoveryPopup: {
      banner: "CONGRATULATIONS YOU MADE A MISSING SHAPE",
      bannerFirst: "CONGRATULATIONS YOU MADE A MISSING SHAPE",
      lines: [
        "{banner}",
        "",
        "Its name is: {name}",
        "({type})",
        "",
        "Library: {count} / {total} total shapes",
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // BOOT TEXT — the script for the faux-BIOS boot sequence (see
  //   interaction/bootSequence.ts). Each of the three screens below is a flat
  //   list, played top to bottom. To re-skin the power-on story, just edit /
  //   add / remove / reorder lines.
  //
  //   A bare string is one printed line (use "" for a blank line). An object is
  //   a line with extra behaviour, set by `kind`:
  //     (none)      a normal line of text (same as a bare string)
  //     "pause"     no text; just wait (use with `delay`)
  //     "memory"    a counts-up-in-place memory test after `text` (to `totalK`)
  //     "check"     "text ........ [ OK ]"   (a POST subsystem check)
  //     "command"   print `prompt`, then "type" `text` and press Enter
  //     "load"      a shape-library entry: "NNN  text ..... [ OK | ERR ]"
  //                 after `wait`s; `ok` picks OK vs ERR, `n` auto-increments
  //     "glitch"    drive the corruption overlay: `level` (+ `ramp` seconds) sets
  //                 the steady coverage, `auto` enables intermittent bursts,
  //                 `burst` fires one transient burst (over `burstS`)
  //     "clear"     wipe the screen
  //     "reveal"    clear + go transparent (show the 3D view) + fade in + cursor
  //     "shape"     start the real polyhedron fading in behind the text
  //     "vcenter"   pad with blanks so the printed lines BELOW are centered
  //   A text entry with `center: true` types itself out from the screen center.
  //   `delay` (seconds) on any entry is an extra pause AFTER it. The leader
  //   dots and the [ OK ]/[ ERR ] tokens are generated by bootSequence.ts.
  // ---------------------------------------------------------------------------
  bootText: {
    bios: [
      { kind: "pause", delay: 0.8 },
      "LAGRANGE Mathematical Computing BIOS  v2.71PM",
      "Copyright © 2186-2189  East Belt Systems Ltd.",
      { text: "", delay: 0.15 },
      { text: "Modus Ponens Processor . . . . Operational", delay: 0.1 },
      { text: "Contradiction Engine   . . . . Installed", delay: 0.1 },
      { text: "Splines                . . . . Reticulated", delay: 0.1 },
      { kind: "memory", text: "Memory Test : ", totalK: 16384, delay: 0.1 },
      { text: "Detecting Installed Peripherals ...", delay: 0.1 },
      { text: "  Algebra Bus       . . . GrabGroup-7920", delay: 0.1 },
      { text: "  Integrator Chip   . . . RIEMANN3", delay: 0.1 },
      { text: "  Mani-folder (TM)  . . . FoldLabs Clopen", delay: 0.1 },
      "",
      { kind: "check", text: "Gödel Enforcer" },
      { kind: "check", text: "Countability Meter" },
      { kind: "check", text: "Riemann Hypothesis Solution" },
      { kind: "check", text: "Goldbach Counterexample Generator" },
      { kind: "check", text: "Internal 5D Core" },
      { kind: "check", text: "Injection Injector" },
      { kind: "check", text: "Category of Categories" },
      "",
      { text: "Starting ErDOS ..." },
      "",
      { kind: "command", prompt: "C:\\> ", text: "ss250.exe", delay: 0.2 },
    ],

    program: [
      { kind: "clear" }, // wipe the BIOS screen before the program's splash
      { kind: "pause", delay: 1.0 },
      "   _____ __  _____    ____  ______         ",
      "  / ___// / / /   |  / __ \\/ ____/         ",
      "  \\__ \\/ /_/ / /| | / /_/ / __/            ",
      " ___/ / __  / ___ |/ ____/ /___            ",
      "/____/_/ /_/_/__|_/_/___/_____/__________  ",
      "  / ___// / / /  _/ ____/_  __/ ____/ __ \\ ",
      "  \\__ \\/ /_/ // // /_    / / / __/ / /_/ / ",
      " ___/ / __  // // __/   / / / /___/ _, _/  ",
      "/____/_/ /_/___/_/_    /_/ /_____/_/ |_|   ",
      "  |__ \\ / ____/ __ \\                       ",
      "  __/ //___ \\/ / / /                       ",
      " / __/____/ / /_/ /                        ",
      "/____/_____/\\____/                         ",
      "",
      "Shaper Shifter 250",
      "© 2189 Working Mathematician Supply Inc.",
      { text: "", delay: 1.2 },
      { text: "Loading shape library:", delay: 0.4 },
      { kind: "load", text: "Tetrahedron", ok: true, wait: 1.9 },
      { kind: "glitch", level: 0.15, ramp: 3 },
      { kind: "load", text: "Cube", ok: false, wait: 4 },
      { kind: "glitch", level: 0.25, ramp: 3.5 },
      { text: "", delay: 1.0 },
      { text: "[ PANIC ] UNEXPECTED ERROR", delay: 0.1 },
      { text: "", delay: 0.8 },
      { text: "Could not access shape library.", delay: 1.0 },
      { text: "", delay: 0.8 },
      { text: "Trying again:", delay: 0.4 },
      { kind: "load", text: "Tetrahedron", ok: true, wait: 0.8 },
      { kind: "glitch", level: 0.4, ramp: 3.0 },
      { kind: "load", text: "Cube", ok: false, wait: 4 },
      { kind: "glitch", level: 0.5, ramp: 3.5 },
      "",
      { text: "[ PANIC ] OUTSIDE INTERFERENCE DETECTED", delay: 0.1 },
      { kind: "glitch", level: 0.8, ramp: 2.0, delay: 1.2 },
    ],

    closing: [
      { kind: "reveal" },
      { kind: "glitch", level: 0, ramp: 0, auto: 0.2 },
      { kind: "pause", delay: 1.2 },
      { kind: "vcenter" },
      { kind: "shape" },
      { text: "Sorry.", center: true, delay: 1.4, lnAfterDelay: true },
      "",
      "",
      { text: "Looks like you'll have to make", center: true, lnAfterDelay: true },
      { text: "all the shapes yourself.", center: true },
      { kind: "pause", delay: 0.6 },
      { kind: "glitch", level: 0, ramp: 1.0, auto: 0 },
    ],
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
