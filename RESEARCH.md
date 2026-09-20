# WireViz Visual Editor — Research Report

**Date:** 2026-09-20 · **Status:** Final · **Author:** AI DevOps (Build+)

## 1. Goal

Build a simplified, spliceCAD-style **visual editor for [WireViz](https://github.com/wireviz/WireViz)**:

- Drag and drop blocks (connectors, cables, notes) on a canvas
- Edit element properties in place
- Define connections between elements in the UI
- Attach **images to blocks**, not just text labels
- Deploy as the **simplest possible app** — Cloudron or GitHub Pages

## 2. What WireViz is (and what we must be compatible with)

WireViz (5.3k★, GPL-3.0, current release **0.4.1** on PyPI) is a Python CLI that turns
YAML into wiring diagrams via Graphviz, plus auto-generated BOMs.

Input model (from `docs/syntax.md`):

| Section | Shape | Notes |
|---|---|---|
| `connectors` | dict of designator → attrs | `type`, `subtype`, `pincount`, `pins`, `pinlabels`, `pincolors`, `style: simple`, `bgcolor`, **`image: {src, caption, width, height}`**, BOM fields |
| `cables` | dict of designator → attrs | `wirecount`, `colors`/`color_code` (DIN, IEC, TEL, T568A/B, BW), `gauge` (mm²/AWG), `length`, `shield`, `category: bundle`, **`image`** |
| `connections` | list of connection sets | Each set = list of items **alternating connector/cable**; pins/wires may be scalars, lists, or ranges (`1-4`); `s` = shield; arrows (`--`, `<-->`, `==>`) model mates; `.` triggers autogeneration |
| `metadata`, `options`, `tweak` | dicts | title, bgcolor, fontname, DOT overrides |

Key facts that shape the architecture:

1. **Images are already first-class** in WireViz (`image: {src, caption, width, height}` on
   connectors *and* cables). The GUI requirement maps directly onto the file format.
2. **There is no native `splices:` section** in 0.4.1 — splices are modeled as `style: simple`
   connectors or inline in connection sets. The editor should not invent a format WireViz
   can't read.
3. **Connection sets are ordered, alternating lists** (connector → cable → connector), not
   pairwise "wires". The UI must let users build 2–3 participant sets with per-participant
   pin lists/ranges.
4. **Clean Python API**: `wireviz.parse(inp, return_types=("svg",))` accepts a YAML string or
   dict and returns raw SVG bytes (`Harness.svg` = `graph.pipe(format="svg")`).
5. **Dependencies are tiny**: `click`, `graphviz`, `pillow`, `pyyaml` — all pure-Python or
   already shipped in Pyodide. `wireviz-0.4.1-py3-none-any.whl` exists on PyPI, so
   `micropip` can install it in WebAssembly.

## 3. Prior art

| Project | What it is | Gap vs. our goal |
|---|---|---|
| [wireviz/wireviz-web](https://github.com/wireviz/wireviz-web) (77★, AGPL) | Flask/Docker **server** wrapper: paste YAML → rendered SVG/BOM | No visual editing; needs a server |
| [slightlynybbled/wireviz-gui](https://github.com/slightlynybbled/wireviz-gui) (41★) | Desktop tkinter GUI (Windows-first) | Requires local Python + Graphviz install; no web deployment |
| [nanangp/vscode-wireviz-preview](https://github.com/nanangp/vscode-wireviz-preview) (8★) | VS Code preview pane | Text-first |
| [pierrejay/wireviz-designer](https://github.com/pierrejay/wireviz-designer) (2★) | Web-based YAML generation assistant | Form-driven, not canvas-driven |
| [Splice CAD](https://splice-cad.com) (commercial, Hackaday 2025-07) | Browser/desktop harness CAD: SVG canvas, parts library, drag-and-drop wiring, BOM, exports | The UX benchmark — but closed, and not WireViz-compatible |
| harness.design, Siemens Capital | Commercial harness tools | Enterprise scope, not WireViz |

**Conclusion:** the niche "free, browser-based, drag-and-drop editor that speaks WireViz
YAML" is open. wireviz-web proves demand for web rendering; nobody ships a visual canvas.

## 4. Architecture options

| Option | Description | Pros | Cons |
|---|---|---|---|
| **A. Static web app + WASM render** | Pure client-side HTML/JS canvas; generates WireViz YAML in JS; renders **real** WireViz output in-browser via Pyodide (wireviz wheel) with viz.js (Graphviz WASM) as the `dot` engine | Zero backend; deploys to GitHub Pages *or* Cloudron static hosting *or* runs from `file://`; exact WireViz fidelity; no install friction | First render downloads Pyodide (~10 MB from CDN); GPL-3.0 applies to the combined work |
| B. Python desktop app (PySide6/tkinter) | Native canvas + local Graphviz | Best raw canvas performance; native file access | Fails the deployment requirement (no GitHub Pages/Cloudron); install friction (the exact complaint wireviz-gui's author documents) |
| C. Python server + web frontend (wireviz-web style) | FastAPI/Flask renders YAML server-side | Full WireViz, no WASM quirks | Needs a Cloudron app package, Docker, ops; not "simplest possible" |
| D. Canvas-only editor, no real render | Editor draws its own approximation; user runs wireviz CLI for final output | Lightest build | Two divergent renderings; users can't trust the preview |

## 5. Recommendation

**Option A — a single static web app**, phased:

- **Phase 1 (this prototype):** SVG canvas editor (drag/drop, inspector, image upload,
  connection sets), live WireViz YAML export/import, project save/load, and a
  **real WireViz render** button (Pyodide + wireviz 0.4.1 + viz.js, lazy-loaded).
- **Phase 2:** pin-level connection UX (click individual pins), splice/simple-connector
  palette entry, BOM panel, HTML output export, self-hosted Pyodide for offline use.
- **Phase 3 (optional):** optional server mode on Cloudron for batch/CLI parity.

### Why this wins

- **Deployment:** one `index.html` (+ vendored JS) is the simplest possible artifact —
  GitHub Pages (free, zero ops) and Cloudron (Surfer static upload) both serve it
  unchanged. No build step, no runtime, no database.
- **Fidelity without a server:** patching one Python method
  (`graphviz.Graph.pipe` → delegate to viz.js) makes `wireviz.parse(yaml, return_types="svg")`
  produce genuine WireViz diagrams in the browser. Everything else (label tables, color
  codes, BOM logic, autogeneration) is upstream code, not a reimplementation.
- **Images:** stored as data-URLs inside the project JSON (works offline, survives
  copy/paste); on export they are written to `images/` inside a downloadable ZIP next to
  `harness.yml`, which is exactly what WireViz expects (`image: {src: images/...}`).

### Render pipeline (validated against WireViz 0.4.1 source)

```
editor model (JSON) ──export──▶ WireViz YAML
                                    │  (browser, Pyodide)
                                    ▼
        wireviz.parse(yaml, return_types="svg")
                                    │  Harness.svg → graph.pipe(format="svg")
                                    ▼
        [patched] graphviz.Graph.pipe ──calls──▶ viz.js (Graphviz WASM) ──▶ SVG string
```

Only `graphviz.Graph.pipe` needs patching (it normally spawns the `dot` binary, which
doesn't exist in WASM). Images are written to Pyodide's in-memory FS so relative
`image.src` paths resolve.

## 6. Deployment analysis

| Target | Effort | Notes |
|---|---|---|
| **GitHub Pages** ✅ chosen | Push to repo, enable Pages | Free, HTTPS, zero maintenance; `gh` already authenticated on this box |
| Cloudron (Surfer app) | Install Surfer from App Store → `surfer put index.html` | Equally valid; needs Cloudron CLI + token (token present on box, CLI not installed) |
| Cloudron (custom packaged app) | Write CloudronManifest + nginx Docker image | Overkill for a static page |

GitHub Pages is the primary target; the app is plain static files, so the same folder can
be uploaded to Surfer (or any web server) verbatim.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pyodide CDN download on first render (~10 MB) | Lazy-load only when "Render" is clicked; show progress; cache in browser; phase-2 option to self-host |
| GPL-3.0 of WireViz applies to combined work | Keep the project GPL-3.0-compatible; wireviz is loaded from PyPI at runtime, not vendored |
| viz.js Graphviz version differs from user's local dot | Acceptable: viz.js bundles a recent Graphviz; output is WireViz's own DOT either way |
| YAML round-trip edge cases (anchors, tweak, exotic attrs) | Import supports the core sections; unknown keys are preserved per-component and re-emitted; full-fidelity round-trip is phase 2 |
| Browser file:// quirks | No ES modules, no fetch of local assets — plain script tags only |

## 8. Prototype scope (built alongside this report)

`index.html` + `style.css` + `app.js` + vendored `viz-standalone.js`, `js-yaml.min.js`,
`fflate.min.js`:

- Palette: Connector / Cable / Note; drag onto canvas
- Canvas: SVG, pan/zoom, grid, draggable blocks with image thumbnails
- Inspector: all core WireViz attrs per kind, image upload (→ data-URL) + caption
- Connections: drag between blocks (auto-merges connector→cable→connector chains),
  pin-range editing, mate arrows for connector↔connector
- Live YAML panel (copy/download), YAML import, project save/load, localStorage autosave
- ZIP export (`harness.yml` + `images/`) ready for the wireviz CLI
- Render tab: real WireViz SVG via Pyodide + viz.js
