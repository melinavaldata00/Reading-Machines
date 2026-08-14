// ─────────────────────────────────────────────────────────
//  ocr-to-indesign.jsx  —  ExtendScript per InDesign 2026
//
//  confidenza → tipografia + colore + opacità
//  90-100  ABC Favorit Regular     · colore campionato dall'immagine originale · grande      · 100%
//  60-89   ABC Gaisyr Mono Regular · colore campionato dall'immagine originale · medio-grande· 100%
//  30-59   ABC Gaisyr Mono Regular · colore campionato dall'immagine originale · medio       · 100%
//  0-29    forma geometrica        · colore campionato dall'immagine originale · grande/piena· 55%
//
//  Il colore non è più una palette fissa (nero/blu/rosso/verde) -- ogni
//  frame esportato da position-zero.html porta il proprio "color" (hex),
//  già campionato e reso vivace dal tool web; questo script lo riusa
//  direttamente invece di ignorarlo.
//
//  MOLTIPLICAZIONE (solo testo, conf >= 30): una parola letta al 100%
//  resta un'unica istanza pulita; più la confidenza scende, più volte
//  quella stessa parola viene ridisegnata (fino a ~7 copie a confidenza
//  30), ciascuna leggermente spostata/ruotata rispetto all'originale --
//  l'incertezza della macchina diventa ripetizione/eco sulla pagina. Le
//  forme geometriche (conf < 30) NON si moltiplicano più -- restano
//  sempre una sola istanza, e la loro varietà viene dalla forma stessa
//  (vedi shapeFromText), non dalla ripetizione.
// ─────────────────────────────────────────────────────────

var BASE_SIZE = 14;

// ── COLORE: swatch RGB per-parola, da f.color ("#rrggbb") ──────────
// prima: 4 swatch CMYK fissi (nero/blu/rosso/verde) assegnati per fascia
// di confidenza, senza nessun legame con i colori reali della foto.
var colorCache = {};
function hexToRgbArray(hex) {
  if (!hex) return null;
  var m = String(hex).replace("#", "");
  if (m.length !== 6) return null;
  var r = parseInt(m.substring(0, 2), 16);
  var g = parseInt(m.substring(2, 4), 16);
  var b = parseInt(m.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r, g, b];
}
function getOrCreateRgbColor(doc, hex) {
  var rgb = hexToRgbArray(hex);
  if (!rgb) return null;
  var name = "ocr " + hex.toUpperCase();
  if (colorCache[hex]) return colorCache[hex];
  var existing = doc.colors;
  for (var ci = 0; ci < existing.length; ci++) {
    if (existing[ci].name === name) { colorCache[hex] = existing[ci]; return existing[ci]; }
  }
  var c = doc.colors.add();
  c.name       = name;
  c.model      = ColorModel.PROCESS;
  c.space      = ColorSpace.RGB;
  c.colorValue = rgb;
  colorCache[hex] = c;
  return c;
}

// ── FONT MAP ─────────────────────────────────────────────
// dimensioni ampliate su tutte le fasce (soprattutto quelle in ABC
// Gaisyr, prima quasi illeggibili: la fascia 30-59 arrivava a
// BASE_SIZE*0.35 = 4.9pt in sola outline al 15% di opacità) e opacità
// portata al 100% ovunque -- nessuna fascia resta più sbiadita/outline.
function arizonaFromConf(conf) {
  if (conf >= 90) return {
    family:    "ABC Favorit Unlicensed Trial",
    style:     "Regular",
    size:      BASE_SIZE * 3.2,   // dominante
    tracking:  0,
    leading:   BASE_SIZE * 3.6,
    fill:      true,
    stroke:    0,
    opacity:   100
  };
  if (conf >= 60) return {
    family:    "ABC Gaisyr Mono Unlicensed Trial",
    style:     "Regular",
    size:      BASE_SIZE * 2.4,   // era 1.0 -- Gaisyr molto più grande
    tracking:  20,
    leading:   BASE_SIZE * 2.8,
    fill:      true,
    stroke:    0,
    opacity:   100
  };
  if (conf >= 30) return {
    family:    "ABC Gaisyr Mono Unlicensed Trial",
    style:     "Regular",
    size:      BASE_SIZE * 1.6,   // era 0.35 ("quasi invisibile") -- ora chiaramente leggibile
    tracking:  60,
    leading:   BASE_SIZE * 2.0,
    fill:      true,              // era outline-only (fill:false) -- ora riempito, si legge
    stroke:    0,
    opacity:   100
  };
  return null; // → forma geometrica
}

// ── SHAPE TYPE from first char + word id ──────────────────
// solo 5 forme ammesse: cerchio, triangolo, diamante, esagono, stella
// (niente più rettangolo/pentagono). Ogni gruppo di lettere pesca da un
// sottoinsieme di queste 5, scelto a rotazione tramite l'id della parola
// così anche parole con la stessa lettera iniziale non escono sempre
// con la stessa forma identica.
function shapeFromText(txt, id) {
  var c = (txt + "").replace(/^\s+/, "").charAt(0).toUpperCase();
  var groups = {
    round:   ["circle", "hexagon"],
    pointed: ["triangle", "star"],
    square:  ["diamond", "hexagon"],
  };
  var group;
  if ("O0CQDGU".indexOf(c) >= 0) group = groups.round;
  else if ("AVWMXKYZ".indexOf(c) >= 0) group = groups.pointed;
  else group = groups.square;
  var idx = (typeof id === "number" && id >= 0) ? id % group.length : 0;
  return group[idx];
}

// crea la page item giusta per ogni kind. il cerchio ha un costruttore
// dedicato; triangolo/diamante/esagono/stella sono tutti poligoni
// regolari (o a stella), il cui numero di lati/inset va impostato nelle
// polygonPreferences del documento PRIMA di chiamare polygons.add() --
// è l'unico modo scriptabile per controllarne la forma in InDesign.
function buildShapeItem(kind) {
  if (kind === "circle") return page.ovals.add();
  var sides = 3, inset = 0;
  if (kind === "triangle") { sides = 3; inset = 0; }
  if (kind === "diamond")  { sides = 4; inset = 0; }
  if (kind === "hexagon")  { sides = 6; inset = 0; }
  if (kind === "star")     { sides = 5; inset = 45; }
  doc.polygonPreferences.polygonNumberOfSides = sides;
  doc.polygonPreferences.polygonStarInset     = inset;
  return page.polygons.add();
}

// ── LOG ──────────────────────────────────────────────────
var logFile = File(Folder.desktop + "/ocr-indesign-log.txt");
logFile.open("w");
function log(msg) { logFile.writeln(msg); }

// ── READ JSON ────────────────────────────────────────────
// il tool web salva sempre come "ocr-skeleton.json" -- ma se un file con
// quel nome esiste già nella cartella di destinazione, il browser spesso
// lo rinomina in automatico ("ocr-skeleton (1).json", "(2)" ecc.) invece
// di sovrascriverlo in silenzio. Invece di pretendere il nome esatto,
// cerca qualunque "ocr-skeleton*.json" nella cartella dello script e usa
// il più recente -- funziona sempre, indipendentemente da come il
// browser ha effettivamente chiamato il file scaricato.
var scriptFolder    = File($.fileName).parent;
var jsonCandidates   = scriptFolder.getFiles("ocr-skeleton*.json");
var jsonFile = null;
if (jsonCandidates && jsonCandidates.length) {
  jsonCandidates.sort(function(a, b) { return b.modified - a.modified; });
  jsonFile = jsonCandidates[0];
}

if (!jsonFile) {
  log("ERRORE: nessun ocr-skeleton*.json trovato in " + scriptFolder.fsName);
  logFile.close();
  exit();
}
log("json: " + jsonFile.fsName + (jsonCandidates.length > 1 ? "  (più recente di " + jsonCandidates.length + " trovati)" : ""));

jsonFile.open("r");
var data = eval("(" + jsonFile.read() + ")");
jsonFile.close();
log("frames: " + data.frames.length + "  canvas: " + data.canvas.w + "x" + data.canvas.h);

// ── DOCUMENT ─────────────────────────────────────────────
var doc  = app.activeDocument;
var page = doc.pages[0];

doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
doc.viewPreferences.verticalMeasurementUnits   = MeasurementUnits.POINTS;

page.resize(
  CoordinateSpaces.INNER_COORDINATES,
  AnchorPoint.TOP_LEFT_ANCHOR,
  ResizeMethods.REPLACING_CURRENT_DIMENSIONS_WITH,
  [data.canvas.w, data.canvas.h]
);

// ── HELPERS ───────────────────────────────────────────────
function applyRotation(item, angle) {
  if (angle && angle !== 0) {
    item.rotationAngle = -angle;
  }
}

// fallback swatch for words whose f.color is missing/unreadable (e.g. a
// cross-origin gallery image the web tool couldn't sample from) -- still
// created once here so there's always something valid to fall back to.
var cFallback = getOrCreateRgbColor(doc, "#1f130d");

function colorForFrame(f) {
  return getOrCreateRgbColor(doc, f.color) || cFallback;
}

function makeOutlineText(f, az) {
  var tf = page.textFrames.add();
  var fh = Math.max(f.h, az.size * 1.5);
  tf.geometricBounds = [f.y, f.x, f.y + fh, f.x + f.w];
  tf.textFramePreferences.insetSpacing = [0, 0, 0, 0];

  try {
    tf.texts[0].appliedFont = app.fonts.itemByName(az.family + "\t" + az.style);
  } catch(e) {
    try { tf.texts[0].appliedFont = app.fonts.itemByName(az.family); } catch(e2) {
      log("font mancante: " + az.family);
    }
  }

  tf.texts[0].pointSize = az.size;
  tf.texts[0].tracking  = az.tracking;
  tf.texts[0].leading   = az.leading;
  tf.contents = f.text;

  // colore campionato dall'immagine originale per QUESTA parola, non più
  // un colore fisso per fascia di confidenza.
  var col = colorForFrame(f);
  if (az.fill) {
    tf.texts[0].fillColor    = col;
    tf.texts[0].strokeColor  = doc.swatches.itemByName("None");
    tf.texts[0].strokeWeight = 0;
  } else {
    tf.texts[0].fillColor    = doc.swatches.itemByName("None");
    tf.texts[0].strokeColor  = col;
    tf.texts[0].strokeWeight = az.stroke;
  }

  // opacità sempre al 100% -- forzata qui, non più letta da az.opacity,
  // così vale anche se in futuro qualche fascia tornasse a definirne una
  // più bassa.
  tf.transparencySettings.blendingSettings.opacity = 100;

  try { tf.fit(FitOptions.FRAME_TO_CONTENT); } catch(e) {}
  var attempts = 0;
  while (tf.overflows && attempts < 20) {
    var b = tf.geometricBounds;
    tf.geometricBounds = [b[0], b[1], b[2], b[3] + az.size * 2];
    try { tf.fit(FitOptions.FRAME_TO_CONTENT); } catch(e) {}
    attempts++;
  }
  applyRotation(tf, f.rotation);

  tf.strokeColor = "None";
  tf.fillColor   = "None";
  tf.label = "ocr_text_" + f.id + "_conf" + f.conf;
  return tf;
}

// forme grandi e piene, ispirate al riferimento fornito (blob grigi
// sovrapposti di un poster) -- non più piccoli contorni tratteggiati
// della sola area della parola, ma blocchi ingranditi, centrati sullo
// stesso punto del box originale, così si accavallano con le parole/
// forme vicine invece di restare isolati ciascuno nel proprio riquadro.
var SHAPE_SCALE = 3.2; // quanto più grande della sua parola originale
// opacità volutamente non al 100% qui -- a differenza del testo (dove il
// 100% fisso risolveva un bug di leggibilità), qui la trasparenza è ciò
// che fa leggere la sovrapposizione tra forme come strati, non come un
// blocco opaco che ne nasconde un altro.
var SHAPE_OPACITY = 55;

function makeShape(f) {
  var kind  = shapeFromText(f.text, f.id);
  var shape = buildShapeItem(kind);

  var cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  var sw = f.w * SHAPE_SCALE, sh = f.h * SHAPE_SCALE;
  var sx = cx - sw / 2, sy = cy - sh / 2;
  shape.geometricBounds = [sy, sx, sy + sh, sx + sw];

  // era: contorno verde fisso, spessore 0.75, opacità 8% (praticamente
  // invisibile), poi contorno pieno + tratteggio interno. Ora è la forma
  // stessa a essere piena (nessun contorno), nel colore campionato di
  // questa parola.
  shape.fillColor    = colorForFrame(f);
  shape.strokeColor  = doc.swatches.itemByName("None");
  shape.transparencySettings.blendingSettings.opacity = SHAPE_OPACITY;

  applyRotation(shape, f.rotation);
  shape.label = "ocr_shape_" + f.id + "_conf" + f.conf;
  return shape;
}

// ── MOLTIPLICAZIONE: più incerta la lettura, più la parola si ripete ──
// Una parola letta al 100% resta un'unica istanza pulita. Man mano che
// la confidenza scende, la stessa parola/forma viene ridisegnata più
// volte, ciascuna leggermente spostata/ruotata rispetto all'originale --
// l'incertezza della macchina diventa letteralmente ripetizione/eco sulla
// pagina, invece di una singola istanza statica indipendente dalla
// confidenza.
function copiesForConf(conf) {
  var t = Math.max(0, Math.min(100, conf)) / 100;
  return Math.round(1 + (1 - t) * 6); // 1 copia a 100% conf. -> fino a 7 a 0%
}

// una variante "eco" di f: stessa parola/forma/colore/confidenza, sulla
// STESSA riga dell'originale (stessa y) -- le copie si susseguono in
// orizzontale, alternando a destra/sinistra della parola originale,
// invece di scivolare anche in verticale come prima. Si legge come una
// ripetizione in fila ("parola parola parola parola") invece di uno
// sciame sparso sulla pagina. Solo un lieve tremore di rotazione resta,
// per non renderle un copia-incolla troppo meccanico.
function jitterFrame(f, idx) {
  var gap  = f.w * 0.25; // spazio tra una copia e la successiva sulla riga
  var step = Math.ceil(idx / 2);
  var dir  = (idx % 2 === 1) ? 1 : -1; // alterna: 1=destra, 2=sinistra, 3=destra, ...
  var x    = f.x + dir * step * (f.w + gap);
  var rotJitter = (Math.random() - 0.5) * 10; // gradi -- solo un lieve tremore
  return {
    id:       f.id + "_m" + idx,
    x:        x,
    y:        f.y, // stessa riga dell'originale, mai spostata in verticale
    w:        f.w,
    h:        f.h,
    text:     f.text,
    conf:     f.conf,
    color:    f.color,
    rotation: (f.rotation || 0) + rotJitter,
  };
}

// ── MAIN LOOP ─────────────────────────────────────────────
var frames   = data.frames;
var nText    = 0;
var nShapes  = 0;
var nSkipped = 0;

for (var i = 0; i < frames.length; i++) {
  var f  = frames[i];

  if (f.w <= 0 || f.h <= 0) { nSkipped++; continue; }
  if (!f.text || f.text.replace(/\s/g,"") === "") { nSkipped++; continue; }

  var az = arizonaFromConf(f.conf);

  if (az === null) {
    // conf < 30 → forma geometrica: sempre una sola istanza, mai
    // moltiplicata -- la varietà qui viene dalla forma stessa (vedi
    // shapeFromText), non dalla ripetizione.
    try {
      makeShape(f);
      nShapes++;
    } catch(e) {
      log("errore shape " + i + ": " + e.message);
      nSkipped++;
    }
  } else {
    // conf >= 30 → testo: la moltiplicazione resta solo qui.
    var copies = copiesForConf(f.conf);
    for (var c = 0; c < copies; c++) {
      var variant = (c === 0) ? f : jitterFrame(f, c);
      try {
        makeOutlineText(variant, az);
        nText++;
      } catch(e) {
        log("errore testo " + i + "." + c + ": " + e.message);
        nSkipped++;
      }
    }
  }
}

log("testo: " + nText + "  forme: " + nShapes + "  saltati: " + nSkipped);
logFile.close();
logFile.execute();