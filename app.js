/*
 * WireViz GUI — a visual editor for WireViz wiring diagrams.
 * Generates WireViz-compatible YAML from a drag-and-drop canvas,
 * and renders real WireViz output in-browser (Pyodide + viz.js).
 */
'use strict';

/* ============================== constants ============================== */

const PYODIDE_BASE = 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/';
const STORAGE_KEY = 'wireviz-gui:doc';

// Color code sequences (from WireViz wv_colors.py) for swatch display.
const COLOR_CODES = {
  DIN: ['WH', 'BN', 'GN', 'YE', 'GY', 'PK', 'BU', 'RD', 'BK', 'VT', 'GYPK', 'RDBU',
    'WHGN', 'BNGN', 'WHYE', 'YEBN', 'WHGY', 'GYBN', 'WHPK', 'PKBN', 'WHBU', 'BNBU',
    'WHRD', 'BNRD', 'WHBK', 'BNBK', 'GYGN', 'YEGY', 'PKGN', 'YEPK', 'GNBU', 'YEBU',
    'GNRD', 'YERD', 'GNBK', 'YEBK', 'GYBU', 'PKBU', 'GYRD', 'PKRD', 'GYBK', 'PKBK',
    'BUBK', 'RDBK'],
  IEC: ['BN', 'RD', 'OG', 'YE', 'GN', 'BU', 'VT', 'GY', 'WH', 'BK'],
  BW: ['BK', 'WH'],
  TEL: ['BUWH', 'WHBU', 'OGWH', 'WHOG', 'GNWH', 'WHGN', 'BNWH', 'WHBN', 'SLWH', 'WHSL',
    'BURD', 'RDBU', 'OGRD', 'RDOG', 'GNRD', 'RDGN', 'BNRD', 'RDBN', 'SLRD', 'RDSL',
    'BUBK', 'BKBU', 'OGBK', 'BKOG', 'GNBK', 'BKGN', 'BNBK', 'BKBN', 'SLBK', 'BKSL',
    'BUYE', 'YEBU', 'OGYE', 'YEOG', 'GNYE', 'YEGN', 'BNYE', 'YEBN', 'SLYE', 'YESL',
    'BUVT', 'VTBU', 'OGVT', 'VTOG', 'GNVT', 'VTGN', 'BNVT', 'VTBN', 'SLVT', 'VTSL'],
  TELALT: ['WHBU', 'BU', 'WHOG', 'OG', 'WHGN', 'GN', 'WHBN', 'BN', 'WHSL', 'SL',
    'RDBU', 'BURD', 'RDOG', 'OGRD', 'RDGN', 'GNRD', 'RDBN', 'BNRD', 'RDSL', 'SLRD',
    'BKBU', 'BUBK', 'BKOG', 'OGBK', 'BKGN', 'GNBK', 'BKBN', 'BNBK', 'BKSL', 'SLBK',
    'YEBU', 'BUYE', 'YEOG', 'OGYE', 'YEGN', 'GNYE', 'YEBN', 'BNYE', 'YESL', 'SLYE',
    'VTBU', 'BUVT', 'OGVT', 'VTOG', 'VTGN', 'GNVT', 'VTBN', 'BNVT', 'VTSL', 'SLVT'],
  T568A: ['WHGN', 'GN', 'WHOG', 'BU', 'WHBU', 'OG', 'WHBN', 'BN'],
  T568B: ['WHOG', 'OG', 'WHGN', 'BU', 'WHBU', 'GN', 'WHBN', 'BN'],
};

// IEC 60757 short-color hex values (from WireViz wv_colors.py).
const COLOR_HEX = {
  BK: '#000000', WH: '#ffffff', GY: '#999999', PK: '#ff66cc', RD: '#ff0000',
  OG: '#ff8000', YE: '#ffff00', OL: '#708000', GN: '#00ff00', TQ: '#00ffff',
  LB: '#a0dfff', BU: '#0066ff', VT: '#8000ff', BN: '#895956', BG: '#ceb673',
  IV: '#f5f0d0', SL: '#708090', CU: '#d6775e', SN: '#aaaaaa', SR: '#84878c',
  GD: '#ffcf80',
};

// Patch that redirects the graphviz Python package's `pipe()` (which normally
// spawns the `dot` binary) to viz.js running Graphviz in WebAssembly.
const PATCH_PY = `
import graphviz, js
def _wv_pipe(self, format=None, renderer=None, formatter=None, quiet=False, *, engine=None, encoding=None):
    out = js.wvRenderDot(str(self.source), format or "svg")
    return out.encode("utf-8") if isinstance(out, str) else out
graphviz.Graph.pipe = _wv_pipe
graphviz.Digraph.pipe = _wv_pipe
`;

/* ============================== state ============================== */

let doc = null;               // { version, metadata, options, tweak, nodes[], connections[] }
let selection = null;         // { type: 'node'|'connection', id }
let view = { x: 40, y: 40, scale: 1 };
let drag = null;              // active pointer interaction
let pendingImageNode = null;  // node awaiting an image file selection
let pyodidePromise = null;
let vizInstancePromise = null;
let imageFilesCache = [];     // images for the current export/render [{path, bytes}]

/* ============================== dom handles ============================== */

const $ = (id) => document.getElementById(id);
const canvasEl = $('canvas');
const worldEl = $('world');
const inspectorEl = $('inspector');
const yamlViewEl = $('yaml-view');
const previewHolderEl = $('preview-holder');
const connectionListEl = $('connection-list');
const renderStatusEl = $('render-status');
const toastEl = $('toast');

/* ============================== utilities ============================== */

const SVGNS = 'http://www.w3.org/2000/svg';

function uid() {
  return 'n' + Math.random().toString(36).slice(2, 10);
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k of Object.keys(attrs || {})) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function el(tag, attrs, parent) {
  const e = document.createElement(tag);
  for (const k of Object.keys(attrs || {})) {
    if (k === 'class') e.className = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  if (parent) parent.appendChild(e);
  return e;
}

let toastTimer = null;
function toast(msg, isError) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', !!isError);
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3000);
}

function setStatus(msg) {
  renderStatusEl.textContent = msg || '';
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function sanitizeFilename(name) {
  return (name || 'image').replace(/[^A-Za-z0-9_-]+/g, '_') || 'image';
}

function dataURLToBytes(dataURL) {
  const b64 = dataURL.split(',')[1] || '';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ============================== model ============================== */

function emptyDoc() {
  return { version: 1, metadata: {}, options: {}, tweak: {}, nodes: [], connections: [] };
}

function nodeById(id) {
  return doc.nodes.find((n) => n.id === id) || null;
}

function connById(id) {
  return doc.connections.find((c) => c.id === id) || null;
}

function nextDesignator(prefix) {
  let max = 0;
  for (const n of doc.nodes) {
    const m = new RegExp('^' + prefix + '(\\d+)$').exec(n.name || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + (max + 1);
}

function defaultNode(kind) {
  const n = { id: uid(), kind, name: '', x: 120, y: 120, attrs: {} };
  if (kind === 'connector') {
    n.name = nextDesignator('X');
    n.attrs = { type: '', subtype: '', pincount: 4, pinlabels: [] };
  } else if (kind === 'cable') {
    n.name = nextDesignator('W');
    n.attrs = { type: '', wirecount: 4, color_code: 'DIN', gauge: '', length: '' };
  } else if (kind === 'note') {
    n.text = 'Double-click to edit… (select to edit in the inspector)';
  }
  return n;
}

function defaultPins(node) {
  if (node.kind === 'connector') {
    const pc = parseInt(node.attrs.pincount, 10);
    return pc > 1 ? '1-' + pc : '1';
  }
  if (node.kind === 'cable') {
    const wc = parseInt(node.attrs.wirecount, 10);
    return wc > 1 ? '1-' + wc : '1';
  }
  return '';
}

// Number of pins/wires a pins-string refers to ("1-4" -> 4, "1,3,5" -> 3, "s" -> 1).
function pinListLength(pins) {
  const s = (pins || '').trim();
  if (!s) return 0;
  if (s.includes(',')) return s.split(',').filter((x) => x.trim()).length;
  const m = /^(-?\d+)\s*-\s*(-?\d+)$/.exec(s);
  if (m) return Math.abs(parseInt(m[2], 10) - parseInt(m[1], 10)) + 1;
  return 1;
}

function duplicateNames() {
  const seen = new Map();
  const dups = new Set();
  for (const n of doc.nodes) {
    if (n.kind === 'note' || !n.name) continue;
    if (seen.has(n.name)) dups.add(n.name);
    seen.set(n.name, n.id);
  }
  return dups;
}

/* ============================== YAML export ============================== */

// Convert the editor's pins string into the YAML value WireViz expects.
// "1-4" stays a string (WireViz expands ranges); "1,3,5" becomes a list.
function pinsToYamlValue(pins) {
  const s = (pins || '').trim();
  if (!s) return null;
  if (s.includes(',')) {
    return s.split(',').map((p) => {
      const t = p.trim();
      return /^-?\d+$/.test(t) ? parseInt(t, 10) : t;
    });
  }
  return s;
}

// Collect embedded images, assigning export paths. Returns [{path, bytes, dataURL}].
function collectImages(srcBase) {
  const used = new Set();
  const out = [];
  for (const n of doc.nodes) {
    const img = n.attrs && n.attrs.image;
    if (!img || !img.src || !img.src.startsWith('data:')) continue;
    let base = sanitizeFilename(n.name || n.id);
    let i = 1;
    while (used.has(base)) base = sanitizeFilename(n.name || n.id) + '_' + (++i);
    used.add(base);
    const path = (srcBase || 'images') + '/' + base + '.png';
    out.push({ node: n, path, bytes: dataURLToBytes(img.src) });
  }
  return out;
}

function imageExportObject(img, src) {
  const o = { src };
  if (img.caption) o.caption = img.caption;
  if (img.width) o.width = img.width;
  if (img.height) o.height = img.height;
  return o;
}

function buildConnectionSet(conn) {
  const items = conn.items.map((it) => {
    const node = nodeById(it.nodeId);
    if (!node || node.kind === 'note') return null;
    const pins = pinsToYamlValue(it.pins);
    return pins === null ? node.name : { [node.name]: pins };
  });
  if (items.some((i) => i === null)) return null;

  // Connector-to-connector sets are mates and need arrow entries between them.
  const nodes = conn.items.map((it) => nodeById(it.nodeId));
  if (conn.items.length === 2 && nodes[0].kind === 'connector' && nodes[1].kind === 'connector') {
    const a = (conn.items[0].pins || '').trim();
    const b = (conn.items[1].pins || '').trim();
    if (a && b) {
      const count = pinListLength(a);
      if (pinListLength(b) !== count) return null; // caller warns
      return [items[0], Array(count).fill('-->'), items[1]];
    }
    return [nodes[0].name, '==>', nodes[1].name];
  }
  return items;
}

function exportYamlDoc(srcBase) {
  const images = collectImages(srcBase);
  const imageByNode = new Map(images.map((i) => [i.node.id, i]));
  const out = {};

  const metadata = Object.assign({}, doc.metadata || {});
  const noteTexts = doc.nodes.filter((n) => n.kind === 'note').map((n) => (n.text || '').trim()).filter(Boolean);
  if (noteTexts.length) {
    metadata.notes = [metadata.notes, noteTexts.join('\n\n')].filter(Boolean).join('\n\n');
  }
  if (Object.keys(metadata).length) out.metadata = metadata;
  if (doc.options && Object.keys(doc.options).length) out.options = doc.options;
  if (doc.tweak && Object.keys(doc.tweak).length) out.tweak = doc.tweak;

  const connectors = {};
  const cables = {};
  for (const n of doc.nodes) {
    if (n.kind === 'note') continue;
    const attrs = Object.assign({}, n.attrs);
    if (attrs.image && attrs.image.src) {
      const f = imageByNode.get(n.id);
      attrs.image = imageExportObject(attrs.image, f ? f.path : attrs.image.src);
    } else {
      delete attrs.image;
    }
    if (Array.isArray(attrs.pinlabels) && attrs.pinlabels.length === 0) delete attrs.pinlabels;
    if (n.kind === 'cable') {
      // WireViz requires bare lengths/gauges as YAML numbers (strings must carry a unit).
      for (const key of ['length', 'gauge']) {
        const v = attrs[key];
        if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) attrs[key] = Number(v.trim());
      }
    }
    for (const k of Object.keys(attrs)) {
      if (attrs[k] === '' || attrs[k] === null || attrs[k] === undefined) delete attrs[k];
    }
    if (n.kind === 'connector') connectors[n.name] = attrs;
    else cables[n.name] = attrs;
  }
  if (Object.keys(connectors).length) out.connectors = connectors;
  if (Object.keys(cables).length) out.cables = cables;

  const sets = [];
  for (const conn of doc.connections) {
    const s = buildConnectionSet(conn);
    if (s) sets.push(s);
  }
  if (sets.length) out.connections = sets;
  return { yaml: jsyaml.dump(out, { lineWidth: -1, noRefs: true }), images };
}

function exportWarnings() {
  const dups = duplicateNames();
  if (dups.size) toast('Duplicate designators: ' + [...dups].join(', ') + ' — WireViz requires unique names', true);
  for (const conn of doc.connections) {
    const nodes = conn.items.map((it) => nodeById(it.nodeId)).filter(Boolean);
    if (conn.items.length === 2 && nodes.length === 2 &&
        nodes[0].kind === 'connector' && nodes[1].kind === 'connector') {
      const a = (conn.items[0].pins || '').trim();
      const b = (conn.items[1].pins || '').trim();
      if (a && b && pinListLength(a) !== pinListLength(b)) {
        toast('Mate pin count mismatch: ' + nodes[0].name + ' vs ' + nodes[1].name, true);
      }
    }
  }
}

/* ============================== YAML import ============================== */

function pinsFromYamlValue(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => String(x)).join(',');
  return String(v);
}

function importYaml(text) {
  const data = jsyaml.load(text);
  if (!data || typeof data !== 'object') throw new Error('YAML did not parse to an object');
  if (!data.connectors && !data.cables) throw new Error('No "connectors" or "cables" section found');

  const templates = Object.assign({}, data.connectors || {}, data.cables || {});
  const kindOf = (name) => (data.connectors && data.connectors[name] ? 'connector' : 'cable');

  const newDoc = emptyDoc();
  newDoc.metadata = Object.assign({}, data.metadata || {});
  newDoc.options = Object.assign({}, data.options || {});
  newDoc.tweak = Object.assign({}, data.tweak || {});
  if (newDoc.metadata.notes) {
    const n = defaultNode('note');
    n.text = String(newDoc.metadata.notes);
    delete newDoc.metadata.notes;
    newDoc.nodes.push(n);
  }

  const nodeByName = new Map(); // designator -> node
  const ensureNode = (designator, templateName) => {
    if (nodeByName.has(designator)) return nodeByName.get(designator);
    const tmpl = templates[templateName] || {};
    const n = {
      id: uid(),
      kind: kindOf(templateName),
      name: designator,
      x: 0, y: 0,
      attrs: JSON.parse(JSON.stringify(tmpl)),
    };
    if (n.attrs.image && typeof n.attrs.image === 'object') {
      // Imported file paths cannot be embedded; keep the reference as-is.
      n.attrs.image = { src: String(n.attrs.image.src || ''), caption: n.attrs.image.caption || '' };
    }
    newDoc.nodes.push(n);
    nodeByName.set(designator, n);
    return n;
  };

  const sets = Array.isArray(data.connections) ? data.connections : [];
  const sideCount = new Map(); // node id -> {left: 0, right: 0}
  for (const set of sets) {
    if (!Array.isArray(set)) continue;
    const parsed = [];
    for (const item of set) {
      if (typeof item === 'string') {
        if (isArrow(item)) { parsed.push(null); continue; }
        // bare designator (possibly template instance "Y.Y1" or unnamed "Y.")
        const { template, designator } = splitDesignator(item);
        if (!designator) { parsed.push(null); continue; }
        const node = ensureNode(designator, template);
        parsed.push({ node, pins: '' });
      } else if (item && typeof item === 'object') {
        const key = Object.keys(item)[0];
        const { template, designator } = splitDesignator(key);
        if (!designator) { parsed.push(null); continue; }
        const node = ensureNode(designator, template);
        parsed.push({ node, pins: pinsFromYamlValue(item[key]) });
      } else {
        parsed.push(null);
      }
    }
    const parts = parsed.filter(Boolean);
    if (!parts.length) continue;
    const conn = { id: uid(), items: parts.map((p) => ({ nodeId: p.node.id, pins: p.pins })) };
    newDoc.connections.push(conn);
    // layout hints: first item leans left, last item leans right
    if (parts.length > 1) {
      bumpSide(sideCount, parts[0].node.id, 'left');
      bumpSide(sideCount, parts[parts.length - 1].node.id, 'right');
    }
  }

  layoutImported(newDoc, sideCount);
  return newDoc;
}

function isArrow(s) {
  return /^(-{2,}|<{1,2}-{2,}>{0,2}|={2,}|<{1,2}={2,}>{0,2}|={2,}>{1,2})$/.test(s.trim()) ||
    ['--', '<--', '<-->', '-->', '==', '<==', '<==>', '==>'].includes(s.trim());
}

function splitDesignator(key) {
  const s = String(key);
  const dot = s.indexOf('.');
  if (dot === -1) return { template: s, designator: s };
  const template = s.slice(0, dot);
  let designator = s.slice(dot + 1);
  if (!designator) designator = template + '_auto' + Math.floor(Math.random() * 900 + 100);
  return { template, designator };
}

function bumpSide(map, id, side) {
  const e = map.get(id) || { left: 0, right: 0 };
  e[side]++;
  map.set(id, e);
}

function layoutImported(newDoc, sideCount) {
  const cols = { left: [], mid: [], right: [] };
  for (const n of newDoc.nodes) {
    if (n.kind === 'note') { cols.mid.push(n); continue; }
    const s = sideCount.get(n.id);
    if (!s) cols.left.push(n);
    else if (s.right > 0 && s.left === 0) cols.right.push(n);
    else if (s.left > 0 && s.right === 0) cols.left.push(n);
    else cols.mid.push(n);
  }
  const colX = { left: 60, mid: 400, right: 740 };
  for (const col of Object.keys(cols)) {
    let y = 60;
    for (const n of cols[col]) { n.x = colX[col]; n.y = y; y += 150; }
  }
}

/* ============================== canvas rendering ============================== */

function applyView() {
  worldEl.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.scale + ')');
}

function screenToWorld(sx, sy) {
  const rect = canvasEl.getBoundingClientRect();
  return { x: (sx - rect.left - view.x) / view.scale, y: (sy - rect.top - view.y) / view.scale };
}

function imageDisplaySize(img) {
  const natW = img.natW || 120, natH = img.natH || 80;
  let w = 120, h = (120 * natH) / natW;
  if (h > 90) { h = 90; w = (90 * natW) / natH; }
  return { w: Math.round(w), h: Math.round(h) };
}

function nodeSize(n) {
  if (n.kind === 'note') {
    const lines = wrapText(n.text || '', 26);
    return { w: 180, h: 26 + lines.length * 14 + 10 };
  }
  const img = n.attrs.image && n.attrs.image.src ? imageDisplaySize(n.attrs.image) : null;
  let contentH = 22 + 16; // title + subtitle
  if (img) contentH += img.h + 6;
  if (n.kind === 'connector') {
    const labels = (n.attrs.pinlabels || []);
    contentH += labels.length ? Math.min(labels.length, 12) * 13 + 4 : 18;
  } else {
    contentH += 16 + 16; // swatches + info line
  }
  return { w: 150, h: Math.max(64, contentH + 8) };
}

function wrapText(text, width) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    let line = '';
    for (const word of raw.split(/\s+/)) {
      if ((line + ' ' + word).trim().length > width && line) { out.push(line); line = word; }
      else line = (line + ' ' + word).trim();
    }
    out.push(line);
  }
  return out.filter((l, i) => l !== '' || i === 0);
}

function cableSwatches(n) {
  const wc = parseInt(n.attrs.wirecount, 10) || 0;
  let colors = null;
  if (Array.isArray(n.attrs.colors) && n.attrs.colors.length) colors = n.attrs.colors;
  else if (n.attrs.color_code && COLOR_CODES[n.attrs.color_code]) colors = COLOR_CODES[n.attrs.color_code];
  if (!colors) return [];
  const out = [];
  for (let i = 0; i < wc; i++) out.push(colors[i % colors.length]);
  return out;
}

function cableInfoLine(n) {
  const parts = [];
  const wc = parseInt(n.attrs.wirecount, 10);
  if (wc) parts.push(wc + ' wire' + (wc > 1 ? 's' : ''));
  if (n.attrs.gauge) parts.push(String(n.attrs.gauge));
  if (n.attrs.length) parts.push(String(n.attrs.length) + (/\d$/.test(String(n.attrs.length)) ? ' m' : ''));
  if (n.attrs.shield === true || n.attrs.shield === 'true') parts.push('shield');
  if (n.attrs.category === 'bundle') parts.push('bundle');
  return parts.join(' · ');
}

function renderCanvas() {
  worldEl.textContent = '';
  svgEl('rect', { x: -5000, y: -5000, width: 10000, height: 10000, fill: 'url(#grid)' }, worldEl);

  // connections first (under nodes)
  for (const conn of doc.connections) renderConnection(conn);
  for (const n of doc.nodes) renderNode(n);

  if (drag && drag.type === 'connect') {
    svgEl('line', {
      class: 'temp-line',
      x1: drag.from.x, y1: drag.from.y, x2: drag.to.x, y2: drag.to.y,
    }, worldEl);
  }
  applyView();
}

function anchorFor(node, side) {
  const size = nodeSize(node);
  const cx = node.x + (side === 'right' ? size.w : 0);
  const cy = node.y + size.h / 2;
  return { x: cx, y: cy };
}

function renderConnection(conn) {
  const pts = conn.items.map((it) => nodeById(it.nodeId)).filter(Boolean);
  if (pts.length < 2) return;
  const g = svgEl('g', { class: 'conn' + (isSelected('connection', conn.id) ? ' selected' : ''), 'data-conn': conn.id }, worldEl);

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const rightward = b.x + nodeSize(b).w / 2 > a.x + nodeSize(a).w / 2;
    const p1 = anchorFor(a, rightward ? 'right' : 'left');
    const p2 = anchorFor(b, rightward ? 'left' : 'right');
    const dx = Math.max(36, Math.abs(p2.x - p1.x) / 2) * (rightward ? 1 : -1);
    const d = 'M ' + p1.x + ' ' + p1.y + ' C ' + (p1.x + dx) + ' ' + p1.y + ', ' + (p2.x - dx) + ' ' + p2.y + ', ' + p2.x + ' ' + p2.y;
    svgEl('path', { class: 'conn-line', d, 'marker-end': 'url(#arrow)' }, g);
    svgEl('path', { class: 'conn-hit', d }, g);

    // label: pins of the participant after this segment's start (cable pins or mate)
    const item = conn.items[i + 1];
    const itemNode = nodeById(item.nodeId);
    let label = '';
    if (itemNode && itemNode.kind === 'cable') label = itemNode.name + ': ' + (item.pins || '');
    else if (itemNode && itemNode.kind === 'connector' && i === 0 && pts.length === 2) label = 'mate';
    if (label) {
      const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2 - 6;
      svgEl('text', { class: 'conn-label', x: mx, y: my, 'text-anchor': 'middle' }, g).textContent = label;
    }
  }
}

function renderNode(n) {
  const size = nodeSize(n);
  const g = svgEl('g', {
    class: 'node ' + n.kind + (isSelected('node', n.id) ? ' selected' : ''),
    'data-id': n.id,
    transform: 'translate(' + n.x + ',' + n.y + ')',
  }, worldEl);

  svgEl('rect', { class: 'node-box', width: size.w, height: size.h, rx: 8 }, g);
  svgEl('text', { class: 'node-name', x: 10, y: 17 }, g).textContent = n.kind === 'note' ? 'Note' : n.name;

  let y = 32;
  if (n.kind !== 'note') {
    const sub = [n.attrs.type, n.attrs.subtype].filter(Boolean).join(' · ');
    svgEl('text', { class: 'node-sub', x: 10, y: y }, g).textContent = sub;
    y += 8;
  }

  const img = n.attrs.image && n.attrs.image.src ? n.attrs.image : null;
  if (img && img.src.startsWith('data:')) {
    const dim = imageDisplaySize(img);
    svgEl('image', {
      href: img.src, x: (size.w - dim.w) / 2, y: y, width: dim.w, height: dim.h,
      preserveAspectRatio: 'xMidYMid meet',
    }, g);
    y += dim.h + 6;
  }

  if (n.kind === 'connector') {
    const labels = n.attrs.pinlabels || [];
    if (labels.length) {
      const shown = labels.slice(0, 12);
      shown.forEach((lab, i) => {
        svgEl('text', { class: 'node-line', x: 10, y: y + 11 + i * 13 }, g)
          .textContent = (i + 1) + ': ' + lab;
      });
      if (labels.length > 12) {
        svgEl('text', { class: 'node-info', x: 10, y: y + 11 + 12 * 13 }, g).textContent = '+' + (labels.length - 12) + ' more';
      }
    } else {
      const pc = parseInt(n.attrs.pincount, 10);
      svgEl('text', { class: 'node-info', x: 10, y: y + 14 }, g).textContent = pc ? pc + ' pins' : '';
    }
  } else if (n.kind === 'cable') {
    const sw = cableSwatches(n);
    sw.slice(0, 9).forEach((c, i) => {
      svgEl('rect', {
        x: 10 + i * 15, y: y + 2, width: 13, height: 10, rx: 2,
        fill: colorHex(c), stroke: '#94a3b8', 'stroke-width': 0.5,
      }, g);
    });
    if (sw.length > 9) {
      svgEl('text', { class: 'node-info', x: 10 + 9 * 15 + 2, y: y + 11 }, g).textContent = '+' + (sw.length - 9);
    }
    y += 16;
    svgEl('text', { class: 'node-info', x: 10, y: y + 12 }, g).textContent = cableInfoLine(n);
  } else {
    const lines = wrapText(n.text || '', 26);
    lines.slice(0, 10).forEach((line, i) => {
      svgEl('text', { class: 'node-line', x: 10, y: y + 12 + i * 14 }, g).textContent = line;
    });
  }

  if (n.kind !== 'note') {
    svgEl('circle', { class: 'handle', cx: 0, cy: size.h / 2, r: 5, 'data-handle': 'left', 'data-node': n.id }, g);
    svgEl('circle', { class: 'handle', cx: size.w, cy: size.h / 2, r: 5, 'data-handle': 'right', 'data-node': n.id }, g);
  }
  return g;
}

function colorHex(c) {
  const s = String(c || '').toUpperCase();
  if (COLOR_HEX[s]) return COLOR_HEX[s];
  if (/^#[0-9A-F]{6}$/.test(s)) return s;
  // striped colors like GNYE: use first band
  const first = s.slice(0, 2);
  return COLOR_HEX[first] || '#cccccc';
}

function isSelected(type, id) {
  return selection && selection.type === type && selection.id === id;
}

/* ============================== interactions ============================== */

canvasEl.addEventListener('pointerdown', (e) => {
  const handleTarget = e.target.closest && e.target.closest('.handle');
  const nodeTarget = e.target.closest && e.target.closest('.node');
  const connTarget = e.target.closest && e.target.closest('.conn-hit');

  if (handleTarget) {
    const node = nodeById(handleTarget.getAttribute('data-node'));
    if (node) {
      const side = handleTarget.getAttribute('data-handle');
      const a = anchorFor(node, side);
      const w = screenToWorld(e.clientX, e.clientY);
      drag = { type: 'connect', fromNode: node, from: a, to: w };
      canvasEl.setPointerCapture(e.pointerId);
    }
  } else if (nodeTarget) {
    const node = nodeById(nodeTarget.getAttribute('data-id'));
    if (node) {
      select('node', node.id);
      const w = screenToWorld(e.clientX, e.clientY);
      drag = { type: 'node', id: node.id, dx: w.x - node.x, dy: w.y - node.y, moved: false };
      canvasEl.setPointerCapture(e.pointerId);
      renderCanvas();
      renderInspector();
    }
  } else if (connTarget) {
    const conn = connById(connTarget.parentNode.getAttribute('data-conn'));
    if (conn) { select('connection', conn.id); renderCanvas(); renderInspector(); }
  } else {
    select(null);
    drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    canvasEl.setPointerCapture(e.pointerId);
    renderCanvas();
    renderInspector();
  }
});

canvasEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (drag.type === 'pan') {
    view.x = drag.vx + (e.clientX - drag.sx);
    view.y = drag.vy + (e.clientY - drag.sy);
    applyView();
  } else if (drag.type === 'node') {
    const node = nodeById(drag.id);
    if (node) {
      const w = screenToWorld(e.clientX, e.clientY);
      node.x = Math.round(w.x - drag.dx);
      node.y = Math.round(w.y - drag.dy);
      drag.moved = true;
      renderCanvas();
    }
  } else if (drag.type === 'connect') {
    drag.to = screenToWorld(e.clientX, e.clientY);
    renderCanvas();
  }
});

canvasEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.type === 'connect') {
    // elementsFromPoint (plural) so overlay lines cannot swallow the drop.
    const candidates = document.elementsFromPoint(e.clientX, e.clientY);
    const nodeTarget = candidates.map((c) => c.closest && c.closest('.node')).find(Boolean);
    if (nodeTarget) {
      const toNode = nodeById(nodeTarget.getAttribute('data-id'));
      if (toNode && toNode.id !== drag.fromNode.id) connect(drag.fromNode, toNode);
    }
  } else if (drag.type === 'node' && drag.moved) {
    scheduleAutosave();
    updateYamlView();
  }
  drag = null;
  renderCanvas();
});

canvasEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const rect = canvasEl.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const newScale = clamp(view.scale * factor, 0.25, 4);
  const k = newScale / view.scale;
  view.x = mx - (mx - view.x) * k;
  view.y = my - (my - view.y) * k;
  view.scale = newScale;
  applyView();
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (selection) { deleteSelection(); e.preventDefault(); }
  } else if (e.key === 'Escape') {
    select(null); renderCanvas(); renderInspector();
  } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveProject();
  }
});

function select(type, id) {
  selection = type ? { type, id } : null;
}

function deleteSelection() {
  if (!selection) return;
  if (selection.type === 'node') {
    doc.nodes = doc.nodes.filter((n) => n.id !== selection.id);
    for (const c of doc.connections) {
      c.items = c.items.filter((it) => it.nodeId !== selection.id);
    }
    doc.connections = doc.connections.filter((c) => c.items.length >= 1);
  } else {
    doc.connections = doc.connections.filter((c) => c.id !== selection.id);
  }
  select(null);
  refreshAll();
}

function connect(a, b) {
  if (a.kind === 'note' || b.kind === 'note') { toast('Notes cannot be connected'); return; }
  if (a.kind === 'cable' && b.kind === 'cable') {
    toast('Cables cannot connect directly — use a simple connector as a splice', true);
    return;
  }
  // extend a partial set that ends with this cable
  if (a.kind === 'cable' && b.kind === 'connector') {
    const partial = doc.connections.find((c) =>
      c.items.length && c.items[c.items.length - 1].nodeId === a.id &&
      !c.items.some((i) => i.nodeId === b.id));
    if (partial) { partial.items.push({ nodeId: b.id, pins: defaultPins(b) }); finishConnect(); return; }
  }
  // prepend a connector to a partial set that starts with this cable
  if (a.kind === 'connector' && b.kind === 'cable') {
    const partial = doc.connections.find((c) =>
      c.items.length && c.items[0].nodeId === b.id &&
      !c.items.some((i) => i.nodeId === a.id));
    if (partial) { partial.items.unshift({ nodeId: a.id, pins: defaultPins(a) }); finishConnect(); return; }
  }
  // dedupe identical 2-participant sets
  const exists = doc.connections.some((c) => c.items.length === 2 &&
    ((c.items[0].nodeId === a.id && c.items[1].nodeId === b.id) ||
     (c.items[0].nodeId === b.id && c.items[1].nodeId === a.id)));
  if (exists) { toast('Already connected'); return; }

  doc.connections.push({
    id: uid(),
    items: [
      { nodeId: a.id, pins: defaultPins(a) },
      { nodeId: b.id, pins: defaultPins(b) },
    ],
  });
  finishConnect();
}

function finishConnect() {
  refreshAll();
  scheduleAutosave();
}

/* ============================== inspector ============================== */

function field(labelText, inputEl, wrapperParent) {
  const wrap = el('div', { class: 'field' }, wrapperParent);
  const lbl = el('label', {}, wrap);
  lbl.textContent = labelText;
  if (labelText && inputEl.tagName !== 'LABEL') {
    if (!inputEl.id) inputEl.id = 'fld' + (++fieldSeq);
    lbl.htmlFor = inputEl.id;
  }
  wrap.appendChild(inputEl);
  return wrap;
}

let fieldSeq = 0;

function textInput(value, onchange) {
  const i = el('input', { type: 'text', value: value == null ? '' : value });
  i.addEventListener('input', () => onchange(i.value));
  return i;
}

function numInput(value, onchange) {
  const i = el('input', { type: 'number', value: value == null ? '' : value });
  i.addEventListener('input', () => onchange(i.value === '' ? '' : parseInt(i.value, 10)));
  return i;
}

function checkInput(value, label, onchange) {
  const wrap = el('label', { class: 'check' });
  const i = el('input', { type: 'checkbox' });
  i.checked = !!value;
  i.addEventListener('change', () => onchange(i.checked));
  wrap.appendChild(i);
  wrap.appendChild(document.createTextNode(' ' + label));
  return wrap;
}

function areaInput(value, onchange, rows) {
  const t = el('textarea', { rows: rows || 4 });
  t.value = value == null ? '' : value;
  t.addEventListener('input', () => onchange(t.value));
  return t;
}

function selectInput(value, options, onchange) {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', { value: o.value });
    opt.textContent = o.label;
    s.appendChild(opt);
  }
  s.value = value || '';
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

function renderInspector() {
  inspectorEl.textContent = '';
  if (!selection) {
    el('p', { class: 'inspector-empty' }, inspectorEl).textContent =
      'Select a block or connection to edit it.';
    return;
  }

  if (selection.type === 'node') {
    const n = nodeById(selection.id);
    if (!n) { select(null); return renderInspector(); }
    renderNodeInspector(n);
  } else {
    const c = connById(selection.id);
    if (!c) { select(null); return renderInspector(); }
    renderConnectionInspector(c);
  }
}

function renderNodeInspector(n) {
  el('h2', {}, inspectorEl).textContent =
    n.kind === 'connector' ? 'Connector' : n.kind === 'cable' ? 'Cable' : 'Note';

  if (n.kind !== 'note') {
    const nameInput = textInput(n.name, (v) => {
      n.name = v.trim();
      nameInput.classList.toggle('invalid', duplicateNames().has(n.name));
      refreshCanvas();
    });
    field('Designator (unique)', nameInput, inspectorEl);
    if (duplicateNames().has(n.name)) nameInput.classList.add('invalid');
  }

  if (n.kind === 'note') {
    field('Text', areaInput(n.text, (v) => { n.text = v; refreshCanvas(); }, 6), inspectorEl);
  } else {
    field('Type', textInput(n.attrs.type, (v) => { n.attrs.type = v; refreshCanvas(); }), inspectorEl);

    if (n.kind === 'connector') {
      field('Subtype', textInput(n.attrs.subtype, (v) => { n.attrs.subtype = v; refreshCanvas(); }), inspectorEl);
      field('Pin count', numInput(n.attrs.pincount, (v) => {
        n.attrs.pincount = v === '' ? '' : v;
        refreshCanvas();
      }), inspectorEl);
      field('Pin labels (one per line)', areaInput(
        (n.attrs.pinlabels || []).join('\n'),
        (v) => {
          const lines = v.split('\n').map((s) => s.trim());
          while (lines.length && lines[lines.length - 1] === '') lines.pop();
          n.attrs.pinlabels = lines;
          refreshCanvas();
        }
      , 6), inspectorEl);
      field('', checkInput(n.attrs.style === 'simple', 'Simple (single-pin) connector', (v) => {
        if (v) n.attrs.style = 'simple'; else delete n.attrs.style;
        refreshCanvas();
      }), inspectorEl);
    } else {
      field('Wire count', numInput(n.attrs.wirecount, (v) => { n.attrs.wirecount = v === '' ? '' : v; refreshCanvas(); }), inspectorEl);
      field('Color code', selectInput(n.attrs.color_code, [
        { value: '', label: '(none)' },
        ...Object.keys(COLOR_CODES).map((k) => ({ value: k, label: k })),
      ], (v) => { if (v) n.attrs.color_code = v; else delete n.attrs.color_code; refreshCanvas(); }), inspectorEl);
      field('Colors (comma-sep, overrides code)', textInput(
        Array.isArray(n.attrs.colors) ? n.attrs.colors.join(',') : '',
        (v) => {
          const list = v.split(',').map((s) => s.trim()).filter(Boolean);
          if (list.length) n.attrs.colors = list; else delete n.attrs.colors;
          refreshCanvas();
        }
      ), inspectorEl);
      field('Gauge', textInput(n.attrs.gauge, (v) => { n.attrs.gauge = v; refreshCanvas(); }), inspectorEl);
      field('Length', textInput(n.attrs.length, (v) => { n.attrs.length = v; refreshCanvas(); }), inspectorEl);
      field('', checkInput(n.attrs.shield === true, 'Shielded', (v) => {
        if (v) n.attrs.shield = true; else delete n.attrs.shield;
        refreshCanvas();
      }), inspectorEl);
      field('', checkInput(n.attrs.category === 'bundle', 'Bundle (per-wire BOM)', (v) => {
        if (v) n.attrs.category = 'bundle'; else delete n.attrs.category;
        refreshCanvas();
      }), inspectorEl);
    }

    field('Notes', areaInput(n.attrs.notes, (v) => { if (v) n.attrs.notes = v; else delete n.attrs.notes; refreshCanvas(); }, 3), inspectorEl);
    renderImageFields(n);
  }

  const actions = el('div', { class: 'inspector-actions' }, inspectorEl);
  el('button', { class: 'danger', onclick: () => { select('node', n.id); deleteSelection(); } }, actions)
    .textContent = 'Delete block';
}

function renderImageFields(n) {
  el('h2', {}, inspectorEl).textContent = 'Image';
  const img = n.attrs.image;
  if (img && img.src) {
    const preview = el('img', { class: 'image-preview', src: img.src, alt: 'block image' }, inspectorEl);
    preview.onerror = () => preview.remove();
    field('Caption', textInput(img.caption || '', (v) => { img.caption = v; refreshCanvas(); }), inspectorEl);
    const row = el('div', { class: 'field-row' }, inspectorEl);
    field('Width (pt)', numInput(img.width, (v) => { img.width = v; refreshCanvas(); }), row);
    field('Height (pt)', numInput(img.height, (v) => { img.height = v; refreshCanvas(); }), row);
    const actions = el('div', { class: 'inspector-actions' }, inspectorEl);
    el('button', { onclick: () => { pendingImageNode = n; $('file-image').click(); } }, actions).textContent = 'Replace image';
    el('button', { class: 'danger', onclick: () => { delete n.attrs.image; refreshAll(); } }, actions).textContent = 'Remove image';
  } else {
    el('p', { class: 'hint' }, inspectorEl).textContent =
      'Attach a photo or drawing to this block. It is embedded in the project and included in exports and renders.';
    const actions = el('div', { class: 'inspector-actions' }, inspectorEl);
    el('button', { onclick: () => { pendingImageNode = n; $('file-image').click(); } }, actions).textContent = 'Add image…';
  }
}

function renderConnectionInspector(c) {
  el('h2', {}, inspectorEl).textContent = 'Connection';
  el('p', { class: 'hint' }, inspectorEl).textContent =
    'Participants in order. Pins accept single values (1), ranges (1-4), or lists (1,3,5). Cables use wire numbers; "s" targets the shield.';
  c.items.forEach((item, idx) => {
    const node = nodeById(item.nodeId);
    if (!node) return;
    const row = el('div', { class: 'part-row' }, inspectorEl);
    el('span', { class: 'part-name', title: node.name }, row).textContent = node.name;
    const input = el('input', { type: 'text', value: item.pins || '', placeholder: node.kind === 'connector' ? 'pins' : 'wires' });
    input.addEventListener('input', () => { item.pins = input.value.trim(); refreshCanvas(); });
    row.appendChild(input);
    el('button', {
      title: 'Remove participant',
      onclick: () => {
        c.items.splice(idx, 1);
        if (c.items.length < 2) doc.connections = doc.connections.filter((x) => x.id !== c.id);
        select(null);
        refreshAll();
      },
    }, row).textContent = '×';
  });
  const actions = el('div', { class: 'inspector-actions' }, inspectorEl);
  el('button', { class: 'danger', onclick: () => { select('connection', c.id); deleteSelection(); } }, actions)
    .textContent = 'Delete connection';
}

/* ============================== panels & lists ============================== */

function renderConnectionList() {
  connectionListEl.textContent = '';
  if (!doc.connections.length) {
    const li = el('li', { class: 'empty' }, connectionListEl);
    li.textContent = 'No connections yet.';
    return;
  }
  for (const c of doc.connections) {
    const li = el('li', { class: isSelected('connection', c.id) ? 'selected' : '' }, connectionListEl);
    li.textContent = c.items.map((it) => {
      const n = nodeById(it.nodeId);
      if (!n) return '?';
      return it.pins ? n.name + ':' + it.pins : n.name;
    }).join(' — ');
    li.addEventListener('click', () => {
      select('connection', c.id);
      renderCanvas(); renderInspector(); renderConnectionList();
    });
  }
}

const updateYamlView = debounce(() => {
  exportWarnings();
  yamlViewEl.value = exportYamlDoc('images').yaml;
}, 120);

function switchTab(tab) {
  document.querySelectorAll('.tabs .tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('tab-yaml').classList.toggle('hidden', tab !== 'yaml');
  $('tab-preview').classList.toggle('hidden', tab !== 'preview');
}

function refreshCanvas() {
  renderCanvas();
  renderConnectionList();
  updateYamlView();
}

function refreshAll() {
  refreshCanvas();
  renderInspector();
}

/* ============================== image upload ============================== */

$('file-image').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !pendingImageNode) return;
  const node = pendingImageNode;
  pendingImageNode = null;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Normalize to PNG and cap size so projects stay small and Graphviz can read them.
      const maxDim = 480;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      node.attrs.image = {
        src: c.toDataURL('image/png'),
        caption: (node.attrs.image && node.attrs.image.caption) || '',
        natW: c.width,
        natH: c.height,
      };
      refreshAll();
      scheduleAutosave();
      toast('Image added to ' + node.name);
    };
    img.onerror = () => toast('Could not read that image', true);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

/* ============================== render (Pyodide + viz.js) ============================== */

function ensureViz() {
  if (!vizInstancePromise) {
    vizInstancePromise = window.Viz.instance().then((viz) => {
      // Bridge used by the patched graphviz.pipe() inside Pyodide.
      window.wvRenderDot = (src, fmt) => {
        const r = viz.render(String(src), { format: fmt || 'svg' });
        if (r && typeof r === 'object' && 'output' in r) {
          if (r.status !== 'success') {
            const msgs = (r.errors || []).map((e2) => e2.message || String(e2)).join('; ');
            throw new Error('Graphviz: ' + msgs);
          }
          return r.output;
        }
        return r;
      };
      return viz;
    });
  }
  return vizInstancePromise;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (window.loadPyodide) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

function ensurePyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      await loadScriptOnce(PYODIDE_BASE + 'pyodide.js');
      const py = await window.loadPyodide({ indexURL: PYODIDE_BASE });
      setStatus('Installing WireViz…');
      await py.loadPackage('micropip');
      await py.pyimport('micropip').install('wireviz');
      py.runPython(PATCH_PY);
      return py;
    })();
  }
  return pyodidePromise;
}

async function renderDiagram() {
  switchTab('preview');
  const btn = $('btn-render');
  btn.disabled = true;
  try {
    setStatus('Starting Graphviz engine…');
    const viz = await ensureViz();
    setStatus('Loading Python runtime (first run ~15 MB)…');
    const py = await ensurePyodide();

    setStatus('Preparing images…');
    const images = collectImages('/wv_images');
    try { viz.module.FS.mkdir('/wv_images'); } catch (e) { /* exists */ }
    try { py.FS.mkdir('/wv_images'); } catch (e) { /* exists */ }
    for (const img of images) {
      viz.module.FS.writeFile(img.path, img.bytes); // Graphviz reads these for layout
      py.FS.writeFile(img.path, img.bytes);          // wireviz embeds these into the SVG
    }

    setStatus('Rendering with WireViz…');
    const { yaml } = exportYamlDoc('/wv_images');
    py.globals.set('wv_yaml_in', yaml);
    let svg = py.runPython('from wireviz import wireviz\nwireviz.parse(wv_yaml_in, return_types="svg")');
    // wireviz's data-URI embed adds a space after the comma; normalize for browsers.
    svg = svg.replace(/base64, /g, 'base64,');
    previewHolderEl.textContent = '';
    const holder = document.createElement('div');
    holder.innerHTML = svg;
    const svgElOut = holder.querySelector('svg');
    if (svgElOut) {
      svgElOut.removeAttribute('width');
      svgElOut.removeAttribute('height');
      svgElOut.style.width = '100%';
      svgElOut.style.height = 'auto';
    }
    previewHolderEl.appendChild(holder);
    setStatus('Rendered with WireViz (in-browser)');
  } catch (err) {
    console.error(err);
    previewHolderEl.textContent = '';
    const pre = el('pre', { class: 'render-error' }, previewHolderEl);
    pre.textContent = 'Render failed:\n' + (err && err.message ? err.message : String(err));
    setStatus('Render failed');
  } finally {
    btn.disabled = false;
  }
}

/* ============================== project i/o ============================== */

function saveProject() {
  const name = (doc.metadata && doc.metadata.title) || 'harness';
  downloadBlob(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }),
    sanitizeFilename(name) + '.wvproj.json');
}

function exportYamlFile() {
  exportWarnings();
  const { yaml } = exportYamlDoc('images');
  const name = (doc.metadata && doc.metadata.title) || 'harness';
  downloadBlob(new Blob([yaml], { type: 'text/yaml' }), sanitizeFilename(name) + '.yml');
  toast('YAML exported. Images export inside the bundle (.zip).');
}

function exportZipBundle() {
  exportWarnings();
  const { yaml, images } = exportYamlDoc('images');
  const name = sanitizeFilename((doc.metadata && doc.metadata.title) || 'harness');
  const files = { 'harness.yml': fflate.strToU8(yaml) };
  for (const img of images) files[img.path] = img.bytes;
  const zipped = fflate.zipSync(files);
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), name + '_wireviz.zip');
  toast('Bundle exported: harness.yml + images/ — ready for the wireviz CLI.');
}

function loadProjectJSON(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.nodes)) throw new Error('Not a WireViz GUI project file');
  doc = data;
  doc.connections = doc.connections || [];
  select(null);
  fitView();
  refreshAll();
  scheduleAutosave();
}

function openFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    try {
      if (text.trim().startsWith('{')) {
        loadProjectJSON(text);
        toast('Project opened');
      } else {
        doc = importYaml(text);
        select(null);
        fitView();
        refreshAll();
        scheduleAutosave();
        toast('YAML imported');
      }
    } catch (err) {
      toast('Open failed: ' + err.message, true);
    }
  };
  reader.readAsText(file);
}

function applyYamlEdits() {
  try {
    const newDoc = importYaml(yamlViewEl.value);
    doc = newDoc;
    select(null);
    fitView();
    refreshAll();
    scheduleAutosave();
    toast('YAML applied');
  } catch (err) {
    toast('YAML error: ' + err.message, true);
  }
}

const scheduleAutosave = debounce(() => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch (e) { /* quota */ }
}, 400);

/* ============================== view helpers ============================== */

function fitView() {
  if (!doc.nodes.length) { view = { x: 40, y: 40, scale: 1 }; applyView(); return; }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of doc.nodes) {
    const s = nodeSize(n);
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + s.w); maxY = Math.max(maxY, n.y + s.h);
  }
  const rect = canvasEl.getBoundingClientRect();
  const pad = 40;
  const scale = clamp(Math.min(
    (rect.width - pad * 2) / Math.max(1, maxX - minX),
    (rect.height - pad * 2) / Math.max(1, maxY - minY)
  ), 0.25, 2);
  view.scale = scale;
  view.x = (rect.width - (maxX - minX) * scale) / 2 - minX * scale;
  view.y = (rect.height - (maxY - minY) * scale) / 2 - minY * scale;
  applyView();
}

/* ============================== demo document ============================== */

function demoDoc() {
  const d = emptyDoc();
  d.metadata = { title: 'Demo harness', description: 'Sample created by WireViz GUI — edit or replace it.' };
  const x1 = {
    id: uid(), kind: 'connector', name: 'X1', x: 60, y: 60,
    attrs: {
      type: 'D-Sub', subtype: 'female', pincount: 9,
      pinlabels: ['DCD', 'RX', 'TX', 'DTR', 'GND', 'DSR', 'RTS', 'CTS', 'RI'],
    },
  };
  const w1 = {
    id: uid(), kind: 'cable', name: 'W1', x: 400, y: 90,
    attrs: { gauge: '0.25 mm2', length: '0.2', color_code: 'DIN', wirecount: 3, shield: true },
  };
  const x2 = {
    id: uid(), kind: 'connector', name: 'X2', x: 740, y: 80,
    attrs: { type: 'Molex KK 254', subtype: 'female', pincount: 3, pinlabels: ['GND', 'RX', 'TX'] },
  };
  const note = { id: uid(), kind: 'note', name: '', x: 400, y: 320, text: 'Select a block to edit it.\nDrag handles to connect.\nDelete key removes selection.', attrs: {} };
  d.nodes = [x1, w1, x2, note];
  d.connections = [
    { id: uid(), items: [
      { nodeId: x1.id, pins: '5,2,3' },
      { nodeId: w1.id, pins: '1,2,3' },
      { nodeId: x2.id, pins: '1,3,2' },
    ] },
    { id: uid(), items: [
      { nodeId: x1.id, pins: '5' },
      { nodeId: w1.id, pins: 's' },
    ] },
  ];
  return d;
}

/* ============================== wire up ui ============================== */

document.querySelectorAll('.palette-item').forEach((b) => {
  b.addEventListener('click', () => {
    const n = defaultNode(b.dataset.kind);
    const rect = canvasEl.getBoundingClientRect();
    const w = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    n.x = Math.round(w.x - 75 + (doc.nodes.length % 5) * 24);
    n.y = Math.round(w.y - 40 + (doc.nodes.length % 5) * 24);
    doc.nodes.push(n);
    select('node', n.id);
    refreshAll();
    scheduleAutosave();
  });
});

$('btn-new').addEventListener('click', () => {
  if (doc.nodes.length && !confirm('Discard the current design?')) return;
  doc = emptyDoc();
  select(null);
  refreshAll();
  scheduleAutosave();
});

$('btn-open').addEventListener('click', () => $('file-open').click());
$('file-open').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) openFile(f);
});
$('btn-save').addEventListener('click', saveProject);
$('btn-import-yaml').addEventListener('click', () => $('file-open').click());
$('btn-export-yaml').addEventListener('click', exportYamlFile);
$('btn-export-zip').addEventListener('click', exportZipBundle);
$('btn-render').addEventListener('click', renderDiagram);
$('btn-copy-yaml').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(yamlViewEl.value); toast('YAML copied'); }
  catch (e) { yamlViewEl.select(); document.execCommand('copy'); toast('YAML copied'); }
});
$('btn-download-yaml').addEventListener('click', exportYamlFile);
$('btn-apply-yaml').addEventListener('click', applyYamlEdits);

document.querySelectorAll('.tabs .tab').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

$('panel-toggle').addEventListener('click', () => {
  const panel = $('bottom-panel');
  panel.classList.toggle('collapsed');
  $('panel-toggle').textContent = panel.classList.contains('collapsed') ? '▴' : '▾';
});

$('zoom-in').addEventListener('click', () => { view.scale = clamp(view.scale * 1.2, 0.25, 4); applyView(); });
$('zoom-out').addEventListener('click', () => { view.scale = clamp(view.scale / 1.2, 0.25, 4); applyView(); });
$('zoom-fit').addEventListener('click', fitView);

window.addEventListener('resize', debounce(applyView, 100));

/* ============================== boot ============================== */

(function boot() {
  let restored = null;
  try { restored = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  if (restored) {
    try {
      const data = JSON.parse(restored);
      if (data && Array.isArray(data.nodes)) doc = data;
    } catch (e) { /* fall through to demo */ }
  }
  if (!doc) doc = demoDoc();
  refreshAll();
})();
