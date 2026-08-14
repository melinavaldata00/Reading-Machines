/*
  OCR SKELETON — IMPORT TO INDESIGN
  ----------------------------------
  Reads a JSON file exported by the "OCR Skeleton" web tool
  (Reading Machines / tools/position-zero.html → "↓ json") and rebuilds
  the recognised layout in InDesign: one text frame per recognised word,
  positioned / rotated / sized exactly as computed in the browser, with
  font, tracking, leading and opacity driven by the OCR confidence value,
  text coloured from that word's own average colour in the original
  source image, and all frames threaded in reading order.

  HOW TO RUN
  ----------
  1. In InDesign: File > Scripts > open the Scripts panel (Window > Utilities > Scripts).
  2. Right-click the "User" folder in the panel → "Reveal in Finder/Explorer".
  3. Drop this file into that folder, then double-click its name in the panel.
     (Or simply: File > Scripts > Other Script… and pick this file directly —
     no need to install it if you're only running it once.)
  4. A dialog will ask you to pick the .json file exported by the OCR Skeleton
     tool. Pick it. The script creates a new document sized to the original
     image and builds the layout automatically.

  NOTES
  -----
  - 1 JSON unit (px) = 1 InDesign point. If the source image is very large,
    the whole layout is scaled down automatically to fit InDesign's maximum
    page size — a message at the end tells you if that happened.
  - The four "arizona" fonts referenced by the export (ABCArizonaSerif,
    ABCArizonaText, ABCArizonaMix, ABCArizonaSans — Trial cuts) must be
    installed and active for the styling to apply. If one isn't found, the
    word falls back to ABC Gaisyr (sized up noticeably so it still reads as
    intentional) if that's installed, or InDesign's own default font as a
    last resort — the end-of-run summary lists which words were affected,
    and by which fallback.
  - Every word frame is forced fully opaque, regardless of what the JSON's
    opacity value says.
  - Everything happens inside a single undo step (Edit > Undo once to
    remove the whole thing).
*/

(function () {

  // ── minimal JSON polyfill (only used if the ExtendScript engine lacks
  //    native JSON — recent InDesign versions have it built in) ─────────
  if (typeof JSON === "undefined") {
    JSON = {};
  }
  if (typeof JSON.parse !== "function") {
    JSON.parse = function (text) {
      // eval-based fallback: fine here because the input is our own
      // trusted export, never arbitrary/untrusted user data.
      return eval("(" + text + ")");
    };
  }

  // ── base typographic scale ─────────────────────────────────────────
  var BASE_SIZE = 12;              // pt — "arizona.size" is an offset from this
  var MAX_PAGE_DIM = 15000;        // pt — safety margin under InDesign's page-size ceiling
  var FALLBACK_FONT = "ABC Gaisyr";      // used when a word's own ABCArizona* font isn't installed
  var FALLBACK_SIZE_BOOST = 1.75;        // how much bigger that fallback text renders

  function log(msg) { $.writeln("[ocr-skeleton-import] " + msg); }

  function pickJsonFile() {
    var f = File.openDialog("Select the OCR Skeleton JSON export", "*.json");
    if (!f) return null;
    f.encoding = "UTF-8";
    f.open("r");
    var raw = f.read();
    f.close();
    return raw;
  }

  function applyFontSafe(textRange, fontName) {
    try {
      var f = app.fonts.itemByName(fontName);
      if (f.status !== FontStatus.INSTALLED) return false;
      textRange.appliedFont = f;
      return true;
    } catch (e) {
      return false;
    }
  }

  // ── colour: each frame's exported "#rrggbb" is the average colour of
  //    that word's own patch in the original source image (sampled by the
  //    web tool before export) — applying it here is what lets the rebuilt
  //    layout keep the photo's colours instead of defaulting to flat black.
  function hexToRgb(hex) {
    if (!hex) return null;
    var m = String(hex).replace("#", "");
    if (m.length !== 6) return null;
    var r = parseInt(m.substring(0, 2), 16);
    var g = parseInt(m.substring(2, 4), 16);
    var b = parseInt(m.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return [r, g, b];
  }

  function getColorSwatch(doc, cache, hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return null;
    if (cache[hex]) return cache[hex];

    var name = "OCR " + hex.toUpperCase();
    var swatch = null;
    try {
      var existing = doc.colors.itemByName(name);
      if (existing.isValid) swatch = existing;
    } catch (e) {}
    if (!swatch) {
      try {
        swatch = doc.colors.add({
          model: ColorModel.PROCESS,
          space: ColorSpace.RGB,
          colorValue: rgb,
          name: name
        });
      } catch (e) {
        return null;
      }
    }
    cache[hex] = swatch;
    return swatch;
  }

  function main() {
    var raw = pickJsonFile();
    if (!raw) { return; }

    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      alert("Couldn't read that file as JSON:\n" + e.message);
      return;
    }
    if (!data || !data.frames || !data.frames.length) {
      alert("This JSON has no frames to place — nothing to do.");
      return;
    }

    var canvasW = (data.canvas && data.canvas.w) || 1000;
    var canvasH = (data.canvas && data.canvas.h) || 1000;

    var scale = 1;
    if (canvasW > MAX_PAGE_DIM || canvasH > MAX_PAGE_DIM) {
      scale = Math.min(MAX_PAGE_DIM / canvasW, MAX_PAGE_DIM / canvasH);
    }

    var doc = app.documents.add();
    doc.viewPreferences.horizontalMeasurementUnits = MeasurementUnits.POINTS;
    doc.viewPreferences.verticalMeasurementUnits   = MeasurementUnits.POINTS;
    doc.documentPreferences.pageWidth  = canvasW * scale;
    doc.documentPreferences.pageHeight = canvasH * scale;
    doc.documentPreferences.facingPages = false;

    // rotate frames around their own center, not the default top-left corner
    if (app.windows.length) {
      app.activeWindow.transformReferencePoint = AnchorPoint.CENTER_ANCHOR;
    }

    var page = doc.pages[0];
    var byId = {};
    var missingFonts = {};
    var order = [];
    var colorCache = {}; // hex -> swatch, so repeated colours reuse one swatch instead of duplicating
    var fallbackFontCount = 0; // how many words landed on the Gaisyr fallback instead of their real Arizona font

    for (var i = 0; i < data.frames.length; i++) {
      var fr = data.frames[i];

      var x = fr.x * scale, y = fr.y * scale;
      var w = Math.max(2, fr.w * scale), h = Math.max(2, fr.h * scale);

      var frame = page.textFrames.add();
      frame.geometricBounds = [y, x, y + h, x + w];

      if (fr.rotation) {
        frame.rotationAngle = fr.rotation;
      }

      if (fr.text) {
        frame.contents = fr.text;
        var tr = frame.texts[0];
        var ar = fr.arizona || {};
        var fontName = ar.font || "";

        tr.pointSize = Math.max(4, BASE_SIZE + (ar.size || 0));
        if (ar.tracking !== undefined) tr.tracking = ar.tracking;
        if (ar.leading  !== undefined) tr.leading  = tr.pointSize * (ar.leading / 100);

        if (fontName && !applyFontSafe(tr, fontName)) {
          missingFonts[fontName] = (missingFonts[fontName] || 0) + 1;
          // the ABCArizona* trial fonts this export is styled for often
          // aren't installed -- rather than leave that text in whatever
          // generic default InDesign happens to substitute, fall back to
          // ABC Gaisyr (used everywhere else in this project, much more
          // likely to actually be installed) and size it up noticeably so
          // it still reads as an intentional, legible word rather than a
          // dim, unstyled placeholder next to the words that did get
          // their real Arizona styling.
          if (applyFontSafe(tr, FALLBACK_FONT)) {
            tr.pointSize = tr.pointSize * FALLBACK_SIZE_BOOST;
            if (ar.leading !== undefined) tr.leading = tr.pointSize * (ar.leading / 100);
            fallbackFontCount++;
          }
        }

        if (fr.color) {
          var swatch = getColorSwatch(doc, colorCache, fr.color);
          if (swatch) {
            try { tr.fillColor = swatch; } catch (e) {}
          }
        }

        // always fully opaque -- forced unconditionally rather than trusting
        // fr.arizona.opacity from the JSON, so this holds even against an
        // export made before opacity was fixed on the web-tool side.
        try {
          frame.transparencySettings.blendingSettings.opacity = 100;
        } catch (e) {}
      }

      byId[fr.id] = frame;
      order.push(fr);
    }

    // thread frames in reading order, following thread_next exactly as exported
    for (var j = 0; j < order.length; j++) {
      var f2 = order[j];
      if (f2.thread_next !== null && f2.thread_next !== undefined && byId[f2.thread_next]) {
        try { byId[f2.id].nextTextFrame = byId[f2.thread_next]; } catch (e) {}
      }
    }

    var summary = "Placed " + order.length + " frame(s) on a "
      + Math.round(canvasW * scale) + "×" + Math.round(canvasH * scale) + "pt page.";
    if (scale < 1) {
      summary += "\n\nSource canvas was larger than InDesign's page limit — scaled down "
        + Math.round(scale * 1000) / 10 + "%.";
    }
    var missingList = [];
    for (var k in missingFonts) missingList.push(k + " (" + missingFonts[k] + "×)");
    if (missingList.length) {
      summary += "\n\nFont(s) not found/installed:\n" + missingList.join("\n");
      if (fallbackFontCount) {
        summary += "\n\n" + fallbackFontCount + " word(s) fell back to " + FALLBACK_FONT
          + " at " + Math.round((FALLBACK_SIZE_BOOST - 1) * 100) + "% larger, so they still read"
          + " intentionally rather than sitting in InDesign's own default font.";
      }
      var totalMissing = 0;
      for (var k2 in missingFonts) totalMissing += missingFonts[k2];
      var trueDefaultCount = totalMissing - fallbackFontCount;
      if (trueDefaultCount > 0) {
        summary += "\n\n" + trueDefaultCount + " word(s) — " + FALLBACK_FONT
          + " isn't installed either — left in InDesign's own default font.";
      }
    }
    alert(summary);
  }

  if (app.documents.length >= 0) {
    app.doScript(main, ScriptLanguage.JAVASCRIPT, undefined,
      UndoModes.ENTIRE_SCRIPT, "Import OCR Skeleton JSON");
  }

})();
