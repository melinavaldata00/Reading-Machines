// ─────────────────────────────────────────────────────────
//  co-read.js
//  Co-Read — machine reads, human edits, machine reads again.
//
//  Key structural fix: each group keeps a CLEAN "truth" layer
//  (the plain text, rendered in a real font) that is the ONLY
//  thing ever fed back into Tesseract for re-reading — and a
//  separate TEXTURED visual layer (the dotted/grid outline
//  look) that is display-only and never itself becomes input.
//  This breaks the feedback loop where re-reading our own
//  textured drawing made the machine progressively worse at
//  finding word boundaries, collapsing everything into solid
//  black masses after a few iterations.
//
//  Each loop/re-read REPLACES the current state — no layer
//  accumulation. Degradation is driven by each shape's own
//  measured complexity (edge density + size), not by how many
//  iterations have run.
// ─────────────────────────────────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

// ── STATE ─────────────────────────────────────────────────
const S = {
  originalImg: null,
  W: 0, H: 0,
  timeline: [],
  currentIdx: -1,
  selectedGroup: null,
  selectedGroups: [],
  editMode: true,
  nextGroupId: 0,
  // words render at a tidy, ordered position by default instead of the
  // raw scattered OCR coordinates — see layoutFlow() below. Off = the
  // words' literal position in the source image.
  flowLayout: true,
};

const svgDoc = document.getElementById('svg-doc');
const stage  = document.getElementById('stage');

// ── progress ──────────────────────────────────────────────
function prog(show, pct, txt) {
  document.getElementById('prog').classList.toggle('show', show);
  if (pct !== undefined) document.getElementById('prog-fill').style.width = Math.round(pct * 100) + '%';
  if (txt !== undefined) document.getElementById('prog-txt').textContent = txt;
}

function avgConf(groups) {
  if (!groups.length) return 0;
  return groups.reduce((s, g) => s + effectiveConf(g), 0) / groups.length;
}
function effectiveConf(g) {
  return (g.manualConf !== null && g.manualConf !== undefined) ? g.manualConf : g.conf;
}

const SHAPE_THRESHOLD = 8;

function updateStats() {
  const st = S.timeline[S.currentIdx];
  const el = document.getElementById('stats');
  if (!st) { el.textContent = 'no document yet'; return; }
  const nShapes = st.groups.filter(g => !g.textOverridden && effectiveConf(g) < SHAPE_THRESHOLD).length;
  el.innerHTML = `
    ${st.label}<br>
    words: <b>${st.groups.length}</b> — shapes: <b>${nShapes}</b><br>
    avg confidence: <b>${st.avgConf.toFixed(1)}%</b>
  `;
}

function updateTimelineUI() {
  const slider = document.getElementById('timeline-slider');
  slider.max   = Math.max(S.timeline.length - 1, 0);
  slider.value = S.currentIdx;
  slider.disabled = S.timeline.length <= 1;
  document.getElementById('timeline-pos').textContent =
    `state ${S.currentIdx} / ${S.timeline.length - 1}`;
}

// ── stage / svg sizing ──────────────────────────────────────
function fitStage() {
  const area = document.getElementById('canvas-area');
  const maxW = area.clientWidth  - 32;
  const maxH = area.clientHeight - 32;
  const ratio = Math.min(maxW / S.W, maxH / S.H, 1);
  const dispW = Math.round(S.W * ratio);
  const dispH = Math.round(S.H * ratio);
  stage.style.width  = dispW + 'px';
  stage.style.height = dispH + 'px';
  svgDoc.setAttribute('viewBox', `0 0 ${S.W} ${S.H}`);
  svgDoc.setAttribute('width',  dispW);
  svgDoc.setAttribute('height', dispH);
}

// ── locally-adaptive threshold (Otsu's method), computed per word ──
// a single flat threshold for the whole page works fine for crisp
// re-typeset text, but a real photograph has uneven lighting and
// blurred letter edges — a flat threshold collapses blurry words into
// solid blobs, losing all internal letter detail. computing the
// threshold from each word's own local pixel histogram adapts to its
// actual contrast, regardless of lighting elsewhere on the page.
function computeLocalThreshold(imageData, bx, by, bw, bh, fullW) {
  const data = imageData.data;
  const hist = new Array(256).fill(0);
  let total = 0;

  for (let y = 0; y < bh; y++) {
    const py = by + y;
    if (py < 0) continue;
    for (let x = 0; x < bw; x++) {
      const px = bx + x;
      if (px < 0 || px >= fullW) continue;
      const idx = (py * fullW + px) * 4;
      if (idx + 2 >= data.length) continue;
      const lum = Math.round((data[idx] + data[idx + 1] + data[idx + 2]) / 3);
      hist[lum]++;
      total++;
    }
  }
  if (total === 0) return 128;

  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, maxVar = 0, threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) { maxVar = varBetween; threshold = t; }
  }
  return threshold;
}

// ── shape complexity, measured directly from pixels ────────
function measureComplexity(imageData, bx, by, bw, bh, fullW, threshold = 128) {
  const data = imageData.data;
  const get = (x, y) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return 255;
    const idx = ((by + y) * fullW + (bx + x)) * 4;
    return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
  };
  const isDark = (x, y) => get(x, y) < threshold;

  let edgeCount = 0;
  const area = Math.max(1, bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const dark = isDark(x, y);
      const right = isDark(x + 1, y);
      const down  = isDark(x, y + 1);
      if (dark !== right || dark !== down) edgeCount++;
    }
  }
  const edgeDensity = edgeCount / area;
  const sizeFactor  = 1 / Math.sqrt(area);
  return edgeDensity * 5 + sizeFactor * 8;
}

// ── visual texture extraction (display-only, never fed back) ──
// Cells are rendered as round dots rather than square tiles — a halftone
// look reads as a recognisable pattern of the underlying letterform, where
// a grid of squares just reads as noise/pixelation.
function circleDot(cx, cy, r) {
  if (r <= 0) return '';
  return `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 `;
}

// average darkness (0..1) of a cell, sampled on a small internal grid so the
// dot size can respond to how much ink is actually in that cell, like a
// print halftone, instead of a hard in/out test.
function cellDarkFraction(get, threshold, x, y, step) {
  const samples = 3;
  let dark = 0, total = 0;
  for (let sy = 0; sy < samples; sy++) {
    for (let sx = 0; sx < samples; sx++) {
      const px = x + Math.floor((sx + 0.5) * step / samples);
      const py = y + Math.floor((sy + 0.5) * step / samples);
      total++;
      if (get(px, py) < threshold) dark++;
    }
  }
  return total ? dark / total : 0;
}

// each dot also gets a fixed random direction/reach (_da/_dm), assigned
// once at extraction time — this is what the "disperse" control in the
// edit panel later uses to scatter the shape apart from within, rather
// than moving the word as a rigid block.
function makeDot(x, y, r) {
  return { x, y, r, _da: Math.random() * Math.PI * 2, _dm: Math.random() };
}

function extractContours(imageData, bx, by, bw, bh, fullW, degradation = 0, baseThreshold = 128) {
  const data = imageData.data;
  const spread = 5 + degradation * 4;
  const threshold = baseThreshold + (Math.random() - 0.5) * spread;

  const get = (x, y) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return 255;
    const idx = ((by + y) * fullW + (bx + x)) * 4;
    return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
  };
  const isDark = (x, y) => get(x, y) < threshold;

  const grid = [];
  for (let y = 0; y < bh; y++) {
    const row = [];
    for (let x = 0; x < bw; x++) row.push(isDark(x, y) ? 1 : 0);
    grid.push(row);
  }

  const dots = [];
  const baseStep = Math.max(3, Math.floor(Math.min(bw, bh) / 12));
  const step = Math.max(3, Math.round(baseStep * (1 + degradation * 0.2)));
  const offX = Math.floor(Math.random() * step);
  const offY = Math.floor(Math.random() * step);
  const dropout = Math.min(0.14, degradation * 0.028);
  const r = step * 0.36;

  for (let y = -offY; y < bh; y += step) {
    for (let x = -offX; x < bw; x += step) {
      const gx = Math.max(0, Math.min(bw - 1, x));
      const gy = Math.max(0, Math.min(bh - 1, y));
      if (!grid[gy][gx]) continue;
      if (Math.random() < dropout) continue;
      const right = x + step < bw ? grid[gy][Math.min(bw - 1, x + step)] : 0;
      const down  = y + step < bh ? grid[Math.min(bh - 1, y + step)][gx] : 0;
      const left  = x - step >= 0 ? grid[gy][Math.max(0, x - step)] : 0;
      const up    = y - step >= 0 ? grid[Math.max(0, y - step)][gx] : 0;
      if (!right || !down || !left || !up) {
        dots.push(makeDot(x + step / 2, y + step / 2, r));
      }
    }
  }
  return dots;
}

function extractSilhouette(imageData, bx, by, bw, bh, fullW, degradation = 0, baseThreshold = 128) {
  const data = imageData.data;
  const spread = 5 + degradation * 4;
  const threshold = baseThreshold + (Math.random() - 0.5) * spread;

  const get = (x, y) => {
    if (x < 0 || y < 0 || x >= bw || y >= bh) return 255;
    const idx = ((by + y) * fullW + (bx + x)) * 4;
    return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
  };

  const baseStep = Math.max(3, Math.floor(Math.min(bw, bh) / 12));
  const step = Math.max(3, Math.round(baseStep * (1 + degradation * 0.2)));
  const offX = Math.floor(Math.random() * step);
  const offY = Math.floor(Math.random() * step);
  const dropout = Math.min(0.1, degradation * 0.018);
  const maxR = step * 0.56;

  const dots = [];
  for (let y = -offY; y < bh; y += step) {
    for (let x = -offX; x < bw; x += step) {
      const frac = cellDarkFraction(get, threshold, Math.max(0, x), Math.max(0, y), step);
      if (frac <= 0.08) continue;
      if (Math.random() < dropout) continue;
      const r = maxR * Math.sqrt(frac);
      dots.push(makeDot(x + step / 2, y + step / 2, r));
    }
  }
  return dots;
}

// ── geometric shape fallback for illegible groups ───────────
function shapeKindFromText(txt) {
  const c = (txt || '').trim().charAt(0).toUpperCase();
  if ('O0CQDGU'.indexOf(c) >= 0) return 'circle';
  if ('AVWMXKYZ'.indexOf(c) >= 0) return 'triangle';
  return 'rect';
}
function buildShapePath(kind, w, h) {
  if (kind === 'circle') {
    const rx = w / 2, ry = h / 2;
    return `M ${rx*2} ${ry} A ${rx} ${ry} 0 1 1 0 ${ry} A ${rx} ${ry} 0 1 1 ${rx*2} ${ry} Z`;
  }
  if (kind === 'triangle') return `M ${w/2} 0 L ${w} ${h} L 0 ${h} Z`;
  return `M 0 0 L ${w} 0 L ${w} ${h} L 0 ${h} Z`;
}

// ── render one group's VISUAL representation (display-only) ──
function renderGroupVisual(g) {
  const gEl = document.createElementNS(SVG_NS, 'g');
  gEl.setAttribute('class', 'outline-group');
  gEl.dataset.id = g.id;
  const cx = g.cx, cy = g.cy;
  // skewX/skewY give each word a fake-perspective tilt (like it's being
  // viewed at an angle) independent of rotation — applied between rotate
  // and scale so the slant reads relative to the word's own upright axis.
  gEl.setAttribute('transform',
    `translate(${cx} ${cy}) rotate(${g.rotation}) skewX(${g.skewX || 0}) skewY(${g.skewY || 0}) scale(${g.scale / 100}) translate(${-cx} ${-cy})`);

  const conf = effectiveConf(g);
  const greyOf = pct => Math.round(255 - (pct / 100) * 180);
  // how legible this word's texture reads scales with its (machine or
  // manually overridden) confidence -- previously every word between the
  // shape-fallback threshold and 100% got the exact same fixed opacity, so
  // a 95%-confidence word looked just as faint/sparse as a 10%-confidence
  // one. 0 at the shape-fallback edge, 1 at high confidence.
  const legibility = Math.max(0, Math.min(1, (conf - SHAPE_THRESHOLD) / (95 - SHAPE_THRESHOLD)));

  if (g.textOverridden) {
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', g.x + g.w / 2);
    t.setAttribute('y', g.y + g.h / 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.style.fontFamily = `"${g.fontFamily || 'ABC Gaisyr'}", monospace, serif`;
    t.style.fontStyle = g.fontStyle || 'normal';
    t.style.fontSize = Math.max(8, g.h * 0.82) + 'px';
    t.style.fill = g.customColor || '#000000';
    if (g.fill > 0) t.style.fillOpacity = g.fill / 100;
    else t.style.fillOpacity = 1;
    t.textContent = g.text;
    gEl.appendChild(t);
  } else if (conf < SHAPE_THRESHOLD || g.paths.length === 0) {
    const kind = shapeKindFromText(g.text);
    const d = buildShapePath(kind, g.w, g.h);
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('transform', `translate(${g.x} ${g.y})`);
    const shapeColor = g.customColor || '#000000';
    const shapeOpacity = (g.customOpacity !== undefined ? g.customOpacity : 100) / 100;
    p.style.fill = g.customColor || '#000000';
    p.style.fillOpacity = (g.fill / 100) * shapeOpacity;
    p.style.stroke = shapeColor;
    p.style.strokeOpacity = shapeOpacity;
    p.style.strokeWidth = '1';
    gEl.appendChild(p);
  } else {
    const strokeColor = g.customColor || '#000000';
    const opacity = (g.customOpacity !== undefined ? g.customOpacity : 100) / 100;

    // "disperse" scatters each dot from where it was extracted, along its
    // own fixed random direction (_da/_dm, assigned once when the dot was
    // created) — the shape gradually decomposes into a loose cloud as the
    // slider goes up, instead of the whole word sliding around as a block.
    const disperseAmt = (g.disperseAmount || 0) / 100;
    const maxReach = Math.max(g.w, g.h) * 0.9;
    const dotsToPath = dots => dots.reduce((d, dot) => {
      const reach = disperseAmt * maxReach * dot._dm;
      const dx = Math.cos(dot._da) * reach;
      const dy = Math.sin(dot._da) * reach;
      return d + circleDot(dot.x + dx, dot.y + dy, dot.r);
    }, '');

    // legibility base — the silhouette (all dark cells, not just edges) drawn
    // as a soft, low, fixed-opacity fill underneath the sparse edge texture.
    // This is what actually reads as a letterform at a glance; the dotted
    // outline on top still carries the "machine-read" texture, but no longer
    // has to do the job of legibility on its own.
    const silhouette = g.fillPaths || [];
    if (silhouette.length) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', dotsToPath(silhouette));
      p.setAttribute('transform', `translate(${g.x} ${g.y})`);
      p.style.fill = g.customColor || '#000000';
      // raised from the old 0.28/0.6 floor — the silhouette is what
      // actually reads as a letterform, so it needs to carry more
      // weight than the sparse edge texture on top of it. Floor now
      // ramps with legibility too: a high-confidence word should read
      // clearly, not sit at the same faint opacity as a barely-read one.
      const silhouetteFloor = 0.30 + legibility * 0.55;
      p.style.fillOpacity = Math.max(silhouetteFloor, g.fill / 100) * opacity;
      p.style.stroke = 'none';
      gEl.appendChild(p);
    }

    if (g.paths.length) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', dotsToPath(g.paths));
      p.setAttribute('transform', `translate(${g.x} ${g.y})`);
      // this is the "machine-read texture" layer, not the legibility
      // base (that's the silhouette above) — it should read as a light
      // marking on top of the word, not compete with it. Dots get a
      // soft fill of their own instead of being hollow rings (an
      // unfilled circle at full stroke opacity reads as a wiry, busy
      // outline), and the stroke itself is toned down rather than full
      // opacity by default.
      p.style.fill = g.customColor || '#000000';
      const texFloor = 0.14 + legibility * 0.30;
      p.style.fillOpacity = Math.max(texFloor, g.fill / 100) * opacity;
      p.style.stroke = strokeColor;
      p.style.strokeOpacity = (0.35 + legibility * 0.4) * opacity;
      p.style.strokeWidth = '0.75';
      gEl.appendChild(p);
    }
  }
  return gEl;
}

// ── render a state's groups onto the live, visible SVG ──────
function renderState(st) {
  svgDoc.innerHTML = '';
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', 0); bg.setAttribute('y', 0);
  bg.setAttribute('width', S.W); bg.setAttribute('height', S.H);
  bg.setAttribute('fill', '#ffffff');
  svgDoc.appendChild(bg);

  st.groups.forEach(g => {
    const gEl = renderGroupVisual(g);

    const hit = document.createElementNS(SVG_NS, 'rect');
    hit.setAttribute('class', 'hit');
    hit.setAttribute('x', g.x); hit.setAttribute('y', g.y);
    hit.setAttribute('width', g.w); hit.setAttribute('height', g.h);
    gEl.appendChild(hit);

    // selection is drawn as its own dashed marquee rect rather than by
    // overriding each path's stroke — paths already carry inline colors
    // (custom or default), which would otherwise always win over a CSS
    // ".selected" rule and make the selection invisible.
    if (S.selectedGroups.includes(g)) {
      gEl.classList.add('selected');
      const sel = document.createElementNS(SVG_NS, 'rect');
      sel.setAttribute('class', 'sel-outline');
      sel.setAttribute('x', g.x - 3);
      sel.setAttribute('y', g.y - 3);
      sel.setAttribute('width', g.w + 6);
      sel.setAttribute('height', g.h + 6);
      gEl.appendChild(sel);
    }

    if (S.editMode) {
      gEl.addEventListener('mousedown', e => startDrag(e, g, gEl));
      gEl.addEventListener('click', e => e.stopPropagation());
    }
    svgDoc.appendChild(gEl);
  });
}

function draw() {
  const st = S.timeline[S.currentIdx];
  if (!st) return;
  renderState(st);
}

// ── render the CLEAN "truth" layer — plain text, real font ──
// This is the ONLY representation ever rasterized and fed back
// into Tesseract. It is a plain, legible typeset rendering, so
// re-reading never degrades in quality due to our own textured
// drawing choices. Variation between reads comes from the
// randomized threshold inside the visual-texture extraction
// functions, applied AFTER this clean read — not from feeding
// the noisy display layer back into the machine.
function renderTruthLayer(st) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S.W} ${S.H}`);
  svg.setAttribute('width', S.W);
  svg.setAttribute('height', S.H);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', S.W); bg.setAttribute('height', S.H);
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  st.groups.forEach(g => {
    if (!g.text || !g.text.trim()) return;
    const gEl = document.createElementNS(SVG_NS, 'g');
    // truth layer ignores visual scale — always renders at natural size
    // so Tesseract can reliably re-read the text in subsequent iterations

    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', g.x + g.w / 2);
    t.setAttribute('y', g.y + g.h / 2);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'central');
    t.style.fontFamily = "Georgia, 'Times New Roman', serif";
    t.style.fontSize = Math.max(24, g.h * 0.8) + 'px';
    t.style.fill = '#000000';
    t.textContent = g.text;
    gEl.appendChild(t);
    svg.appendChild(gEl);
  });

  return svg;
}

// ── rasterize an SVG element to an offscreen canvas ─────────
// optional `scale` renders at a higher pixel density than W×H —
// safe here because the content is vector paths/text, not a
// photograph, so upscaling costs nothing in quality.
function svgElementToCanvas(svgEl, W, H, scale = 1) {
  return new Promise(resolve => {
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgEl);
    const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);

    const cw = Math.round(W * scale), ch = Math.round(H * scale);

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = (e) => {
      console.error('svgElementToCanvas: image failed to load', e);
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').fillStyle = '#fff';
      canvas.getContext('2d').fillRect(0, 0, cw, ch);
      resolve(canvas);
    };
    img.src = url;
  });
}

// rasterize the visual (textured) layer — used only for PNG export
function svgToCanvas(st, W, H, scale = 1) {
  const offscreenSvg = document.createElementNS(SVG_NS, 'svg');
  offscreenSvg.setAttribute('viewBox', `0 0 ${S.W} ${S.H}`);
  offscreenSvg.setAttribute('width', S.W);
  offscreenSvg.setAttribute('height', S.H);
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', S.W); bg.setAttribute('height', S.H);
  bg.setAttribute('fill', '#ffffff');
  offscreenSvg.appendChild(bg);
  st.groups.forEach(g => offscreenSvg.appendChild(renderGroupVisual(g)));
  return svgElementToCanvas(offscreenSvg, W, H, scale);
}

// rasterize the clean truth layer — this is what gets re-read by Tesseract
function truthToCanvas(st, W, H) {
  const svg = renderTruthLayer(st);
  return svgElementToCanvas(svg, W, H);
}

// ── OCR via Tesseract.js ──────────────────────────────────
async function runOCR(imageSource, onProgress) {
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
    }
  });
  const result = await worker.recognize(imageSource);
  await worker.terminate();
  const words = result.data.words || [];
  return words
    .map(w => ({
      x: w.bbox.x0, y: w.bbox.y0,
      w: w.bbox.x1 - w.bbox.x0, h: w.bbox.y1 - w.bbox.y0,
      text: w.text, conf: w.confidence,
      lineNum: (w.line_num !== undefined ? w.line_num : Math.floor(w.bbox.y0 / 30)),
    }))
    // Drop weak detections here, before they ever become a group — on a
    // busy graphic poster (as opposed to a plain scanned document),
    // Tesseract throws off hundreds of near-zero-confidence fragments
    // from decorative elements, textures, etc. Previously every one of
    // those still became a group and, since it fell under
    // SHAPE_THRESHOLD, got rendered as a generic geometric placeholder —
    // which is what turned the whole page into confetti. Cutting them
    // here means fewer, more trustworthy shapes overall, instead of one
    // shape per scrap the OCR barely registered.
    // A short 1-2 char result is disproportionately likely to be OCR
    // noise (stray marks misread as "l", ".", "-", etc.), so those need
    // a notably higher bar than a real multi-letter word does.
    .filter(b => {
      const txt = b.text.trim();
      if (b.w <= 8 || b.h <= 8 || txt.length < 1) return false;
      const MIN_CONF = txt.length <= 2 ? 55 : 30;
      return b.conf >= MIN_CONF;
    });
}

// ── flow layout: reposition words into an ordered, non-overlapping
// reading flow instead of their raw scattered OCR coordinates, so the
// result reads as an actual composed page rather than a field of
// independent elements floating at arbitrary points. Reading order
// (line, then original left-to-right position within it) is preserved
// from the source; a row breaks whenever the source's own OCR line
// number changes, which keeps the source's real line structure intact
// even though position is no longer literal. If a single column of
// rows would run past the bottom of the canvas, rows are split across
// side-by-side columns instead of spilling off the page.
// Mutates each group with flowX/flowY — doesn't touch x/y itself, so
// this can always be computed regardless of which layout is currently
// active (see the layout toggle below).
function layoutFlow(groups) {
  if (!groups.length) return;
  const MARGIN   = Math.max(24, S.W * 0.03);
  const ROW_GAP  = 14;
  const WORD_GAP = 16;
  const usableW  = Math.max(100, S.W - 2 * MARGIN);
  const usableH  = Math.max(100, S.H - 2 * MARGIN);

  const ordered = groups.slice().sort((a, b) => {
    if (a.lineNum !== b.lineNum) return a.lineNum - b.lineNum;
    return a.originalX - b.originalX;
  });

  // Phase 1 — group into rows.
  const rows = [];
  let row = [], rowW = 0, prevLine = null;
  ordered.forEach(g => {
    const isNewLine = prevLine !== null && g.lineNum !== prevLine;
    const wouldOverflow = row.length && (rowW + WORD_GAP + g.w) > usableW;
    if (isNewLine || wouldOverflow) {
      rows.push(row);
      row = []; rowW = 0;
    }
    row.push(g);
    rowW += (row.length > 1 ? WORD_GAP : 0) + g.w;
    prevLine = g.lineNum;
  });
  if (row.length) rows.push(row);

  const rowHeights = rows.map(r => Math.max(...r.map(g => g.h)));
  const totalRowsH = rowHeights.reduce((s, h) => s + h, 0) + ROW_GAP * Math.max(0, rows.length - 1);

  // Phase 2 — split rows across columns if one column would run too tall.
  const neededCols = Math.max(1, Math.ceil(totalRowsH / usableH));
  const colWidth   = usableW / neededCols;
  const rowsPerCol = Math.ceil(rows.length / neededCols);

  let col = 0, cursorY = MARGIN;
  rows.forEach((r, ri) => {
    if (ri > 0 && ri % rowsPerCol === 0 && col < neededCols - 1) {
      col++;
      cursorY = MARGIN;
    }
    let cursorX = MARGIN + col * colWidth;
    r.forEach(g => {
      g.flowX = cursorX;
      g.flowY = cursorY;
      cursorX += g.w + WORD_GAP;
    });
    cursorY += rowHeights[ri] + ROW_GAP;
  });
}


// ── build new groups from a fresh OCR pass ──────────────────
function extractGroupsFromCanvas(srcCanvas, boxes, prevGroups) {
  const ctx = srcCanvas.getContext('2d', { willReadFrequently: true });
  const imgData = ctx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);

  function overlapArea(a, b) {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    if (x2 <= x1 || y2 <= y1) return 0;
    return (x2 - x1) * (y2 - y1);
  }

  const groups = boxes.map(b => {
    const localThreshold = computeLocalThreshold(imgData, b.x, b.y, b.w, b.h, srcCanvas.width);
    const complexity = measureComplexity(imgData, b.x, b.y, b.w, b.h, srcCanvas.width, localThreshold);

    // find the best-overlapping group from the previous state, if any —
    // used both for the manual-confidence-driven degradation below and
    // to smooth this word's confidence across iterations
    let best = null;
    if (prevGroups && prevGroups.length) {
      let bestArea = 0;
      for (const pg of prevGroups) {
        const a = overlapArea(b, pg);
        if (a > bestArea) { bestArea = a; best = pg; }
      }
    }

    let extraDegradation = 0;
    if (best && best.manualConf !== null && best.manualConf !== undefined) {
      extraDegradation = Math.max(0, (60 - best.manualConf) / 20);
    }

    // smooth confidence across iterations: Tesseract's confidence for the
    // exact same rendered text varies slightly run to run, which used to
    // make words flicker between legible and shape-replaced with nothing
    // actually having changed. Blending with the previous reading turns
    // that noise into a gradual trajectory instead — manual overrides are
    // never smoothed, they take effect immediately.
    let conf = b.conf;
    if (best && (best.manualConf === null || best.manualConf === undefined)) {
      conf = best.conf * 0.6 + b.conf * 0.4;
    }

    // a confidently-read word should extract as a denser, cleaner dot
    // pattern than a shaky one — previously degradation only tracked pixel
    // complexity, so an easily machine-readable word could still come out
    // sparse and hard to read just because its letterforms were visually
    // busy. High conf trims degradation (denser dots, less dropout); low
    // conf leaves it untouched.
    const confRelief = Math.max(0, (conf - 50) / 25);
    const degradation = Math.max(0, complexity + extraDegradation - confRelief);

    const paths     = extractContours(imgData, b.x, b.y, b.w, b.h, srcCanvas.width, degradation, localThreshold);
    const fillPaths = extractSilhouette(imgData, b.x, b.y, b.w, b.h, srcCanvas.width, degradation, localThreshold);

    // C: automatic scale from confidence
    const confScale = conf >= 90 ? 180 : conf >= 60 ? 100 : conf >= 30 ? 55 : 40;

    return {
      id: S.nextGroupId++,
      text: b.text,
      conf,
      complexity,
      lineNum: b.lineNum,
      originalX: b.x,   // literal OCR position, kept so the layout toggle can switch back to it
      originalY: b.y,
      manualConf: null,
      textOverridden: false,
      fill: 0,
      x: b.x, y: b.y, w: b.w, h: b.h,
      cx: b.x + b.w / 2, cy: b.y + b.h / 2,
      paths,
      fillPaths,
      scale: confScale,
      rotation: 0,
      skewX: 0,
      skewY: 0,
      customColor: null,
      customOpacity: 100,
      fontFamily: 'ABC Gaisyr',
      fontStyle: 'normal',
      disperseAmount: 0,
    };
  }).filter(g => g.paths.length > 0 || g.conf < SHAPE_THRESHOLD);

  // compute the ordered, non-overlapping flow position for every
  // surviving group, then apply it (or the raw original position) as
  // the active x/y depending on the current layout mode.
  layoutFlow(groups);
  groups.forEach(g => {
    g.x = S.flowLayout ? g.flowX : g.originalX;
    g.y = S.flowLayout ? g.flowY : g.originalY;
    g.cx = g.x + g.w / 2;
    g.cy = g.y + g.h / 2;
  });

  return groups;
}

// ── initial upload ────────────────────────────────────────
// shared by the file-picker/drop path (which resolves to a data URL) and
// the gallery path (which just points at a static file under
// tools/images/Reading Loop/) -- both just need an <img> and a src usable
// as the SVG background's xlink:href.
function applyLoadedImage(img, srcForSvg, displayName) {
  S.originalImg = img;
  S.W = img.naturalWidth;
  S.H = img.naturalHeight;
  S.timeline = [];
  S.currentIdx = -1;
  S.selectedGroup = null;
  S.selectedGroups = [];
  S.editMode = true;
  document.getElementById('fname').textContent = displayName;
  document.getElementById('drop').classList.add('gone');
  fitStage();

  svgDoc.innerHTML = '';
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', S.W); bg.setAttribute('height', S.H);
  bg.setAttribute('fill', '#ffffff');
  svgDoc.appendChild(bg);
  const imgEl = document.createElementNS(SVG_NS, 'image');
  imgEl.setAttributeNS('http://www.w3.org/1999/xlink', 'href', srcForSvg);
  imgEl.setAttribute('width', S.W); imgEl.setAttribute('height', S.H);
  svgDoc.appendChild(imgEl);

  document.getElementById('edit-panel').classList.remove('show');
  document.getElementById('btn-run').disabled = false;
  document.getElementById('btn-loop').disabled = true;
  document.getElementById('btn-reread').disabled = true;
  document.getElementById('btn-show-origin').disabled = true;
  document.getElementById('btn-show-current').disabled = true;
  document.getElementById('btn-svg').disabled = true;
  document.getElementById('btn-png').disabled = true;
  document.body.classList.remove('stage-results');
  updateTimelineUI();
  updateStats();
}

function loadImage(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => applyLoadedImage(img, e.target.result, file.name);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function loadImageFromURL(url, displayName) {
  const img = new Image();
  img.onload = () => applyLoadedImage(img, url, displayName);
  img.onerror = () => alert('Could not load ' + displayName);
  img.src = url;
}

document.getElementById('btn-import').addEventListener('click', () => {
  document.getElementById('file-input').click();
});
document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files[0]) loadImage(e.target.files[0]);
});
document.getElementById('file-input-drop').addEventListener('change', e => {
  if (e.target.files[0]) loadImage(e.target.files[0]);
});
const dropEl = document.getElementById('drop');
dropEl.addEventListener('dragover', e => { e.preventDefault(); dropEl.classList.add('drag'); });
dropEl.addEventListener('dragleave', () => dropEl.classList.remove('drag'));
dropEl.addEventListener('drop', e => {
  e.preventDefault();
  dropEl.classList.remove('drag');
  if (e.dataTransfer.files[0]) loadImage(e.dataTransfer.files[0]);
});

// ── gallery: pick from a curated folder instead of the OS file picker ──
// tools/images/Reading Loop/manifest.json lists the filenames currently
// in that folder -- drop more images in there and re-run the small
// manifest generator (or just add the filename to the JSON by hand) to
// make them show up here.
const GALLERY_DIR = 'images/Reading Loop';
let galleryLoaded = false;

function openGallery() {
  document.getElementById('gallery-overlay').classList.add('show');
  if (galleryLoaded) return;
  const grid = document.getElementById('gallery-grid');
  fetch(GALLERY_DIR + '/manifest.json')
    .then(r => r.json())
    .then(names => {
      galleryLoaded = true;
      if (!names.length) {
        grid.innerHTML = '<div class="gallery-empty">no images in ' + GALLERY_DIR + '</div>';
        return;
      }
      names.forEach(name => {
        const url = GALLERY_DIR + '/' + encodeURIComponent(name);
        const thumb = document.createElement('div');
        thumb.className = 'gallery-thumb';
        thumb.style.backgroundImage = `url("${url}")`;
        thumb.title = name;
        thumb.addEventListener('click', () => {
          loadImageFromURL(url, name);
          document.getElementById('gallery-overlay').classList.remove('show');
        });
        grid.appendChild(thumb);
      });
    })
    .catch(() => {
      grid.innerHTML = '<div class="gallery-empty">could not load the image list</div>';
    });
}

document.getElementById('btn-gallery').addEventListener('click', openGallery);
document.getElementById('btn-gallery-close').addEventListener('click', () => {
  document.getElementById('gallery-overlay').classList.remove('show');
});
document.getElementById('gallery-overlay').addEventListener('click', e => {
  if (e.target.id === 'gallery-overlay') e.target.classList.remove('show');
});

// ── first read: original photo → OCR → groups → state 0 ────
// ── silent pre-processing for OCR ────────────────────────
// Applied invisibly before every OCR pass on the original image.
// Maximises contrast on coloured posters/images by converting to
// grayscale using a luminance inversion trick that helps Tesseract
// separate text from vivid backgrounds.
function preprocessImageForOCR(img) {
  const srcW = img.naturalWidth  || img.width;
  const srcH = img.naturalHeight || img.height;
  // upscale small images (helps Tesseract read small text) but cap the
  // processed size for large ones — a real phone photo is easily 12+
  // megapixels, and doubling that would mean tens of millions of pixels
  // to allocate and binarize for no real accuracy benefit. Target roughly
  // 2200px on the long edge either way.
  const TARGET_LONG_EDGE = 2200;
  const longEdge = Math.max(srcW, srcH);
  const scale = Math.min(2, TARGET_LONG_EDGE / longEdge) || 1;
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const d = imgData.data;

  // 1. convert to luminance-maximised grayscale
  // standard luma weights but boosted contrast via power curve
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i+1], b = d[i+2];
    // use max channel trick: helps on vivid hue-vs-hue combos (red on black etc)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const maxC = Math.max(r, g, b);
    const gray = Math.round(lum * 0.6 + maxC * 0.4); // blend standard + max channel
    d[i] = d[i+1] = d[i+2] = gray;
  }

  // 2. contrast stretch: find min/max and expand to full 0-255
  let min = 255, max = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] < min) min = d[i];
    if (d[i] > max) max = d[i];
  }
  const range = max - min || 1;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.round(((d[i] - min) / range) * 255);
    d[i] = d[i+1] = d[i+2] = v;
  }

  // 3. adaptive binarization in 32px blocks — via an integral image
  // (summed-area table), so each pixel's local mean is a handful of array
  // look-ups instead of resampling a ~65x65 window from scratch. The old
  // per-pixel nested loop was O(w*h*260): fine on a small test image, but
  // on a real, unresized phone photo (e.g. 3000x4000, doubled to 6000x8000
  // by the upscale above = 48 megapixels) it took 20-30+ seconds of
  // uninterrupted main-thread work — long enough that the tab reads as
  // frozen and the page can look like it silently failed. This produces
  // the exact same result, in well under a second even at that size.
  const block = 32;
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += d[(y * w + x) * 4];
      integral[(y + 1) * (w + 1) + (x + 1)] = integral[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - block), y1 = Math.min(h - 1, y + block);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - block), x1 = Math.min(w - 1, x + block);
      const A = integral[y0 * (w + 1) + x0];
      const B = integral[y0 * (w + 1) + (x1 + 1)];
      const C = integral[(y1 + 1) * (w + 1) + x0];
      const D = integral[(y1 + 1) * (w + 1) + (x1 + 1)];
      const cnt = (x1 - x0 + 1) * (y1 - y0 + 1);
      const mean = (D - B - C + A) / cnt;
      const idx = (y*w+x)*4;
      const val = d[idx] < mean - 8 ? 0 : 255;
      out[idx] = out[idx+1] = out[idx+2] = val; out[idx+3] = 255;
    }
  }
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  return { canvas: c, scale };
}

document.getElementById('btn-run').addEventListener('click', async () => {
  document.getElementById('btn-run').disabled = true;
  prog(true, 0, 'reading original image…');
  try {
    // pre-process silently before OCR
    const { canvas: procCanvas, scale } = preprocessImageForOCR(S.originalImg);
    const boxes = await runOCR(procCanvas, p => prog(true, p * 0.7, Math.round(p * 100) + '%'));
    // scale coordinates back to original image space
    boxes.forEach(b => { b.x = Math.round(b.x/scale); b.y = Math.round(b.y/scale); b.w = Math.round(b.w/scale); b.h = Math.round(b.h/scale); });

    const canvas = document.createElement('canvas');
    canvas.width = S.W; canvas.height = S.H;
    canvas.getContext('2d').drawImage(S.originalImg, 0, 0, S.W, S.H);

    const groups = extractGroupsFromCanvas(canvas, boxes, null);

    S.timeline = [{
      kind: 'origin',
      groups: groups,
      avgConf: avgConf(boxes),
      label: 'state 0 — first reading',
    }];
    S.currentIdx = 0;

    updateTimelineUI();
    updateStats();
    draw();

    document.getElementById('btn-loop').disabled = false;
    document.getElementById('btn-reread').disabled = false;
    document.getElementById('btn-show-origin').disabled = false;
    document.getElementById('btn-show-current').disabled = false;
    document.getElementById('btn-svg').disabled = false;
    document.getElementById('btn-png').disabled = false;
    document.body.classList.add('stage-results');
  } catch (e) {
    prog(true, 0, 'error: ' + e.message);
    setTimeout(() => prog(false), 3000);
    document.getElementById('btn-run').disabled = false;
    return;
  }
  prog(false);
});

// ── auto-loop: re-read the CLEAN layer each time, replace state ──
document.getElementById('btn-loop').addEventListener('click', async () => {
  const n = parseInt(document.getElementById('loop-n').value);
  document.getElementById('btn-loop').disabled = true;
  S.timeline = S.timeline.slice(0, S.currentIdx + 1);
  document.getElementById('btn-reread').disabled = true;

  for (let i = 0; i < n; i++) {
    const prevState = S.timeline[S.timeline.length - 1];
    prog(true, i / n, `iteration ${i + 1}/${n}…`);

    const truthCanvas = await truthToCanvas(prevState, S.W, S.H);
    const boxes = await runOCR(truthCanvas, p => prog(true, (i + p) / n, `iter ${i + 1}/${n} — ${Math.round(p * 100)}%`));
    const newGroups = extractGroupsFromCanvas(truthCanvas, boxes, prevState.groups);

    S.timeline.push({
      kind: 'auto',
      groups: newGroups,
      avgConf: avgConf(boxes),
      label: `state ${S.timeline.length} — iteration ${i + 1}`,
    });

    S.currentIdx = S.timeline.length - 1;
    updateTimelineUI();
    updateStats();
    draw();
  }

  // back on the final, latest state once the loop is done — re-enable editing
  S.editMode = true;
  draw();

  prog(false);
  document.getElementById('btn-loop').disabled = false;
  document.getElementById('btn-reread').disabled = false;
});

// ── selection + drag + edit panel ───────────────────────────
let dragState = null;

// populate the edit panel from the "primary" (last-clicked) selected group.
// with several groups selected, style sliders (scale/rotation/fill/color/
// opacity) apply to the whole selection when changed — only the text field
// and the confidence override stay single-target, since those are
// meaningfully per-word.
function populateEditPanel(g) {
  const panel = document.getElementById('edit-panel');
  panel.classList.add('show');

  document.getElementById('ep-text').value     = g.text;
  document.getElementById('ep-scale').value    = g.scale;
  document.getElementById('ep-color').value    = g.customColor || '#000000';
  document.getElementById('ep-opacity').value  = g.customOpacity !== undefined ? g.customOpacity : 100;
  document.getElementById('ep-rotation').value = g.rotation;
  document.getElementById('ep-skew-x').value   = g.skewX || 0;
  document.getElementById('ep-skew-y').value   = g.skewY || 0;
  document.getElementById('ep-fill').value     = g.fill;
  document.getElementById('ep-conf').value     = Math.round(effectiveConf(g));
  document.getElementById('ep-disperse').value = g.disperseAmount || 0;

  document.getElementById('ep-as-text').classList.toggle('on', !!g.textOverridden);
  document.getElementById('ep-font-controls').style.display = g.textOverridden ? 'block' : 'none';
  document.querySelectorAll('#ep-font-controls .font-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.font === (g.fontFamily || 'ABC Gaisyr'));
  });
  document.querySelectorAll('#ep-font-controls .style-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.style === (g.fontStyle || 'normal'));
  });

  const n = S.selectedGroups.length;
  const extra = n > 1 ? `<br>+ ${n - 1} more selected — drag / delete / front / back / style apply to all` : '';
  document.getElementById('ep-meta').innerHTML =
    `machine confidence: ${g.conf.toFixed(0)}%<br>shape complexity: ${(g.complexity || 0).toFixed(2)}${extra}`;
}

// additive=true (shift/cmd/ctrl-click): toggles g in/out of the current
// multi-selection. additive=false: replaces the selection with just g.
function selectGroup(g, gEl, additive) {
  if (additive && S.selectedGroups.includes(g)) {
    S.selectedGroups = S.selectedGroups.filter(sg => sg !== g);
    S.selectedGroup = S.selectedGroups[S.selectedGroups.length - 1] || null;
    if (S.selectedGroup) populateEditPanel(S.selectedGroup);
    else document.getElementById('edit-panel').classList.remove('show');
    draw(); // redraw so the dashed selection marquee reflects the new set immediately
    return;
  }
  if (!additive) S.selectedGroups = [];
  S.selectedGroups.push(g);
  S.selectedGroup = g;
  populateEditPanel(g);
  draw(); // redraw so the dashed selection marquee appears immediately, not just on next drag
}

function startDrag(e, g, gEl) {
  e.preventDefault();
  e.stopPropagation();
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  if (additive) {
    selectGroup(g, gEl, true);
  } else if (!(S.selectedGroups.length > 1 && S.selectedGroups.includes(g))) {
    // fresh single selection — unless g is already part of a larger
    // multi-selection, in which case a plain drag moves the whole group
    selectGroup(g, gEl, false);
  }
  if (!S.selectedGroups.includes(g)) return; // just toggled off — no drag

  const scaleX = stage.clientWidth  / S.W;
  const scaleY = stage.clientHeight / S.H;
  dragState = {
    groups: S.selectedGroups.map(sg => ({
      g: sg, origX: sg.x, origY: sg.y, origCx: sg.cx, origCy: sg.cy,
    })),
    startX: e.clientX, startY: e.clientY,
    scaleX, scaleY,
  };
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', endDrag);
}
function onDrag(e) {
  if (!dragState) return;
  const dx = (e.clientX - dragState.startX) / dragState.scaleX;
  const dy = (e.clientY - dragState.startY) / dragState.scaleY;
  dragState.groups.forEach(entry => {
    entry.g.x  = entry.origX + dx;
    entry.g.y  = entry.origY + dy;
    entry.g.cx = entry.origCx + dx;
    entry.g.cy = entry.origCy + dy;
  });
  draw();
}
function endDrag() {
  dragState = null;
  document.removeEventListener('mousemove', onDrag);
  document.removeEventListener('mouseup', endDrag);
}

// ── edit panel: draggable by its header, so it can be moved off the word
// it's currently editing when the panel happens to land on top of it ──
(function () {
  const panel  = document.getElementById('edit-panel');
  const handle = document.getElementById('edit-panel-handle');
  let start = null;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const parentRect = panel.offsetParent.getBoundingClientRect();
    const rect = panel.getBoundingClientRect();
    // switch from the default left/bottom CSS to an explicit left/top,
    // anchored at wherever the panel currently sits, so the drag starts
    // from its real on-screen position with no jump
    const initLeft = rect.left - parentRect.left;
    const initTop  = rect.top  - parentRect.top;
    panel.style.left   = initLeft + 'px';
    panel.style.top    = initTop + 'px';
    panel.style.bottom = 'auto';
    start = { x: e.clientX, y: e.clientY, left: initLeft, top: initTop };
    document.addEventListener('mousemove', onPanelDrag);
    document.addEventListener('mouseup', endPanelDrag);
  });

  function onPanelDrag(e) {
    if (!start) return;
    const parentRect = panel.offsetParent.getBoundingClientRect();
    const maxLeft = Math.max(0, parentRect.width  - panel.offsetWidth);
    const maxTop  = Math.max(0, parentRect.height - panel.offsetHeight);
    let newLeft = start.left + (e.clientX - start.x);
    let newTop  = start.top  + (e.clientY - start.y);
    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
    newTop  = Math.max(0, Math.min(newTop, maxTop));
    panel.style.left = newLeft + 'px';
    panel.style.top  = newTop + 'px';
  }
  function endPanelDrag() {
    start = null;
    document.removeEventListener('mousemove', onPanelDrag);
    document.removeEventListener('mouseup', endPanelDrag);
  }
})();

document.getElementById('ep-close').addEventListener('click', () => {
  document.getElementById('edit-panel').classList.remove('show');
  document.querySelectorAll('.outline-group').forEach(e => e.classList.remove('selected'));
  S.selectedGroup = null;
  S.selectedGroups = [];
});
document.getElementById('ep-text').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  S.selectedGroup.text = e.target.value;
  S.selectedGroup.textOverridden = true;
  draw();
});
// style sliders/pickers act on the whole current selection, not just the
// primary group — this is what makes selecting several words at once useful
document.getElementById('ep-scale').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.scale = v; });
  draw();
});
document.getElementById('ep-rotation').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.rotation = v; });
  draw();
});
// perspective — fake-3D tilt via 2D skew, independent of rotation
document.getElementById('ep-skew-x').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.skewX = v; });
  draw();
});
document.getElementById('ep-skew-y').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.skewY = v; });
  draw();
});
document.getElementById('ep-fill').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.fill = v; });
  draw();
});
document.getElementById('ep-conf').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  S.selectedGroup.manualConf = parseInt(e.target.value);
  document.getElementById('ep-meta').innerHTML =
    `read as: "${S.selectedGroup.text}"<br>machine confidence: ${S.selectedGroup.conf.toFixed(0)}%<br>override: ${S.selectedGroup.manualConf}%`;
});
document.getElementById('ep-color').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = e.target.value;
  S.selectedGroups.forEach(g => { g.customColor = v; });
  draw();
});
document.getElementById('ep-color-reset').addEventListener('click', () => {
  if (!S.selectedGroup) return;
  S.selectedGroups.forEach(g => { g.customColor = null; });
  document.getElementById('ep-color').value = '#000000';
  draw();
});
document.getElementById('ep-opacity').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.customOpacity = v; });
  draw();
});

// ── show-as-text + font (batch, like the style controls above) ─────
document.getElementById('ep-as-text').addEventListener('click', () => {
  if (!S.selectedGroup) return;
  const turnOn = !S.selectedGroup.textOverridden;
  S.selectedGroups.forEach(g => { g.textOverridden = turnOn; });
  populateEditPanel(S.selectedGroup);
  draw();
});
document.querySelectorAll('#ep-font-controls .font-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!S.selectedGroup) return;
    const font = btn.dataset.font;
    S.selectedGroups.forEach(g => {
      g.fontFamily = font;
      if (font === 'MillionaireScript') g.fontStyle = 'normal';
    });
    populateEditPanel(S.selectedGroup);
    draw();
  });
});
document.querySelectorAll('#ep-font-controls .style-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!S.selectedGroup) return;
    if (S.selectedGroup.fontFamily === 'MillionaireScript') return;
    const style = btn.dataset.style;
    S.selectedGroups.forEach(g => { if (g.fontFamily !== 'MillionaireScript') g.fontStyle = style; });
    populateEditPanel(S.selectedGroup);
    draw();
  });
});

// ── layout: align selection, disperse ───────────────────────
function alignSelection(mode) {
  if (S.selectedGroups.length < 2) return;
  if (mode === 'left') {
    const target = Math.min(...S.selectedGroups.map(g => g.x));
    S.selectedGroups.forEach(g => { g.x = target; g.cx = g.x + g.w / 2; });
  } else if (mode === 'right') {
    const target = Math.max(...S.selectedGroups.map(g => g.x + g.w));
    S.selectedGroups.forEach(g => { g.x = target - g.w; g.cx = g.x + g.w / 2; });
  } else if (mode === 'center') {
    const target = S.selectedGroups.reduce((s, g) => s + g.cx, 0) / S.selectedGroups.length;
    S.selectedGroups.forEach(g => { g.cx = target; g.x = g.cx - g.w / 2; });
  }
  draw();
}
document.getElementById('ep-align-left').addEventListener('click', () => alignSelection('left'));
document.getElementById('ep-align-center').addEventListener('click', () => alignSelection('center'));
document.getElementById('ep-align-right').addEventListener('click', () => alignSelection('right'));

// scatters the dots that make up each selected word's shape (see
// dotsToPath in renderGroupVisual) rather than moving the word itself —
// the word's position/bounding box is untouched.
document.getElementById('ep-disperse').addEventListener('input', e => {
  if (!S.selectedGroup) return;
  const v = parseInt(e.target.value);
  S.selectedGroups.forEach(g => { g.disperseAmount = v; });
  draw();
});

// multiply — tiles copies of each selected word across the whole canvas,
// in a loose grid (mild per-cell jitter + rotation so it doesn't read as
// a rigid, mechanical repeat). Each copy is its own independent group —
// draggable, editable, deletable — not a display trick, so anything already
// possible on a single word (skew, disperse, "show as text"...) also works
// on any one of the copies afterward.
function multiplySelection() {
  if (!S.selectedGroups.length) return;
  const st = S.timeline[S.currentIdx];
  if (!st) return;

  const margin = 16;
  const usableW = Math.max(1, S.W - margin * 2);
  const usableH = Math.max(1, S.H - margin * 2);
  const added = [];

  S.selectedGroups.forEach(orig => {
    const ow = orig.w * (orig.scale / 100);
    const oh = orig.h * (orig.scale / 100);
    const stepX = Math.max(ow + 20, 36);
    const stepY = Math.max(oh + 16, 26);
    const cols = Math.max(1, Math.floor(usableW / stepX));
    const rows = Math.max(1, Math.floor(usableH / stepY));

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const jx = (Math.random() - 0.5) * stepX * 0.2;
        const jy = (Math.random() - 0.5) * stepY * 0.2;
        const x = margin + c * stepX + jx;
        const y = margin + r * stepY + jy;
        // skip the cell that would land right on top of the original
        if (Math.abs(x - orig.x) < stepX * 0.5 && Math.abs(y - orig.y) < stepY * 0.5) continue;

        const clone = {
          ...orig,
          id: S.nextGroupId++,
          x, y,
          cx: x + orig.w / 2,
          cy: y + orig.h / 2,
          // own flow/original position, so this copy doesn't snap back to
          // the source word's spot the next time the layout toggle is used
          flowX: x, flowY: y,
          originalX: x, originalY: y,
          rotation: (orig.rotation || 0) + (Math.random() - 0.5) * 14,
        };
        st.groups.push(clone);
        added.push(clone);
      }
    }
  });

  if (added.length) {
    S.selectedGroups = added;
    S.selectedGroup = added[added.length - 1];
    populateEditPanel(S.selectedGroup);
  }
  updateStats();
  draw();
}
document.getElementById('ep-multiply').addEventListener('click', multiplySelection);

document.getElementById('ep-front').addEventListener('click', () => {
  if (!S.selectedGroups.length) return;
  const st = S.timeline[S.currentIdx];
  S.selectedGroups.forEach(g => {
    const idx = st.groups.indexOf(g);
    if (idx >= 0) { st.groups.splice(idx, 1); st.groups.push(g); }
  });
  draw();
});
document.getElementById('ep-back').addEventListener('click', () => {
  if (!S.selectedGroups.length) return;
  const st = S.timeline[S.currentIdx];
  [...S.selectedGroups].reverse().forEach(g => {
    const idx = st.groups.indexOf(g);
    if (idx >= 0) { st.groups.splice(idx, 1); st.groups.unshift(g); }
  });
  draw();
});
document.getElementById('ep-delete').addEventListener('click', () => {
  if (!S.selectedGroups.length) return;
  const st = S.timeline[S.currentIdx];
  S.selectedGroups.forEach(g => {
    const idx = st.groups.indexOf(g);
    if (idx >= 0) st.groups.splice(idx, 1);
  });
  document.getElementById('edit-panel').classList.remove('show');
  S.selectedGroup = null;
  S.selectedGroups = [];
  updateStats();
  draw();
});

// ── re-read after manual edits — replace, read the clean layer ──
document.getElementById('btn-reread').addEventListener('click', async () => {
  S.timeline = S.timeline.slice(0, S.currentIdx + 1);
  const st = S.timeline[S.currentIdx];
  prog(true, 0, 're-reading edited composition…');

  const truthCanvas = await truthToCanvas(st, S.W, S.H);
  const boxes = await runOCR(truthCanvas, p => prog(true, p, Math.round(p * 100) + '%'));
  const newGroups = extractGroupsFromCanvas(truthCanvas, boxes, st.groups);

  S.timeline.push({
    kind: 'edit',
    groups: newGroups,
    avgConf: avgConf(boxes),
    label: `state ${S.timeline.length} — after human edit`,
  });

  S.currentIdx = S.timeline.length - 1;
  S.editMode = true;
  document.getElementById('btn-reread').disabled = false;
  document.getElementById('edit-panel').classList.remove('show');
  S.selectedGroup = null;
  S.selectedGroups = [];

  updateTimelineUI();
  updateStats();
  draw();
  prog(false);
});

// ── timeline scrubbing ─────────────────────────────────────
document.getElementById('timeline-slider').addEventListener('input', e => {
  S.currentIdx = parseInt(e.target.value);
  S.editMode = true;
  document.getElementById('btn-reread').disabled = false;
  document.getElementById('edit-panel').classList.remove('show');
  S.selectedGroup = null;
  S.selectedGroups = [];
  updateTimelineUI();
  updateStats();
  draw();
});

// ── compare with origin ────────────────────────────────────
document.getElementById('btn-show-origin').addEventListener('click', () => {
  document.getElementById('timeline-slider').value = 0;
  document.getElementById('timeline-slider').dispatchEvent(new Event('input'));
});
document.getElementById('btn-show-current').addEventListener('click', () => {
  const last = S.timeline.length - 1;
  document.getElementById('timeline-slider').value = last;
  document.getElementById('timeline-slider').dispatchEvent(new Event('input'));
});

// ── loop-n slider label ────────────────────────────────────
document.getElementById('loop-n').addEventListener('input', e => {
  document.getElementById('loop-n-v').textContent = e.target.value;
});

// ── click on svg background closes edit panel ──────────────
svgDoc.addEventListener('click', e => {
  if (!S.editMode || e.target.closest('.outline-group')) return;
  document.querySelectorAll('.outline-group').forEach(el => el.classList.remove('selected'));
  document.getElementById('edit-panel').classList.remove('show');
  S.selectedGroup = null;
  S.selectedGroups = [];
});

// ── export ───────────────────────────────────────────────
function buildExportSvg(st) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('xmlns', SVG_NS);
  svg.setAttribute('viewBox', `0 0 ${S.W} ${S.H}`);
  svg.setAttribute('width', S.W);
  svg.setAttribute('height', S.H);

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', S.W); bg.setAttribute('height', S.H);
  bg.setAttribute('fill', '#ffffff');
  svg.appendChild(bg);

  st.groups.forEach(g => svg.appendChild(renderGroupVisual(g)));
  return svg;
}

document.getElementById('btn-svg').addEventListener('click', () => {
  const st = S.timeline[S.currentIdx];
  if (!st) return;
  const exportSvg = buildExportSvg(st);
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(exportSvg);
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'co-read.svg';
  a.click();
});
document.getElementById('btn-png').addEventListener('click', async () => {
  const st = S.timeline[S.currentIdx];
  if (!st) return;
  const EXPORT_MAX = 3000;
  const scale = Math.max(1, Math.min(4, EXPORT_MAX / Math.max(S.W, S.H)));
  const canvas = await svgToCanvas(st, S.W, S.H, scale);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'co-read.png';
  a.click();
});

window.addEventListener('resize', () => { if (S.W) { fitStage(); draw(); } });
// ── layout toggle — flow (tidy, ordered) vs original (raw OCR position) ──
// Both positions are already computed and stored on every group
// (flowX/flowY, originalX/originalY) at read time, so toggling here is
// just picking which one is currently active — no need to recompute.
document.getElementById('btn-layout').addEventListener('click', () => {
  S.flowLayout = !S.flowLayout;
  document.getElementById('btn-layout').textContent = S.flowLayout ? 'layout — flow' : 'layout — original';
  document.getElementById('btn-layout').classList.toggle('on', S.flowLayout);
  const st = S.timeline[S.currentIdx];
  if (st) {
    st.groups.forEach(g => {
      g.x = S.flowLayout ? g.flowX : g.originalX;
      g.y = S.flowLayout ? g.flowY : g.originalY;
      g.cx = g.x + g.w / 2;
      g.cy = g.y + g.h / 2;
    });
    draw();
  }
});
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data && e.data.type === 'open-guide') {
    document.getElementById('guide-overlay').classList.add('show');
  }
});
document.getElementById('btn-guide-close').addEventListener('click', () => {
  document.getElementById('guide-overlay').classList.remove('show');
});
document.getElementById('guide-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'guide-overlay') e.currentTarget.classList.remove('show');
});
