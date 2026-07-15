import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * v1 atlas export: a PDF built from the map plus location notes (the notes ARE
 * the gazetteer). Composes a multi-page PDF:
 * a cover page with the campaign's poster render (see posterExport.ts,
 * reused as-is — this module never touches MapLibre/WebGL) followed by
 * gazetteer pages listing every canon location with its note body preview.
 *
 * Deliberately pure w.r.t. rendering: this module takes already-rendered PNG
 * bytes and already-read note bodies, and never touches the DOM, the map, or
 * the Vault — MapView.exportAtlas() is the only thing that gathers those.
 */
export interface AtlasLocation {
  name: string;
  type: string;
  point: [number, number] | null;
  body: string;
}

export interface AtlasOptions {
  title: string;
  coverPng: ArrayBuffer;
  coverWidth: number;
  coverHeight: number;
  locations: AtlasLocation[];
}

const LANDSCAPE_PAGE: [number, number] = [842, 595]; // A4 landscape, points
const PORTRAIT_PAGE: [number, number] = [595, 842]; // A4 portrait, points
const MARGIN = 40;
const TITLE_SIZE = 28;
const NAME_SIZE = 13;
const META_SIZE = 10;
const BODY_SIZE = 10;
const LINE_GAP = 4;
const ENTRY_GAP = 10;
const BODY_WRAP_CHARS = 92;
const BODY_MAX_LINES = 4;

const INK = rgb(0.1, 0.1, 0.1);
const MUTED_INK = rgb(0.35, 0.35, 0.35);
const BODY_INK = rgb(0.2, 0.2, 0.2);

/**
 * Greedily wraps `text` into lines no longer than `maxChars`, breaking only
 * on whitespace (never mid-word — a single word longer than `maxChars` is
 * left on its own line rather than split). Pure so it's unit-testable
 * without a PDF/font context. Collapses internal whitespace/newlines since
 * note bodies are drawn line-by-line onto a fixed-width text column anyway.
 */
export function wrapText(text: string, maxChars: number): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [];

  const words = normalized.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// Unicode code points for "smart" punctuation and space variants that
// commonly show up in real note prose but fall outside pdf-lib's
// WinAnsi-encoded StandardFonts (which throw on unsupported characters).
const LEFT_SINGLE_QUOTES = /[‘‚′]/g; // ' ‚ ′
const RIGHT_SINGLE_QUOTE = /’/g; // '
const LEFT_DOUBLE_QUOTES = /[“„″]/g; // " „ ″
const RIGHT_DOUBLE_QUOTE = /”/g; // "
const DASHES = /[–—]/g; // – —
const ELLIPSIS = /…/g; // …
const UNICODE_SPACES = /[  -  　]/g; // nbsp, en/em spaces, etc.
// eslint-disable-next-line no-control-regex
const NON_WINANSI = /[^\x00-\xFF]/g;
// C0 controls (\x00-\x1F minus tab/lf/cr, stripped separately below), DEL,
// and the C1 control block (\x80-\x9F) — the latter sits inside \x00-\xFF so
// NON_WINANSI won't catch it, but several of those code points (this
// module hit \x9F in testing) have no WinAnsi/cp1252 glyph and make
// pdf-lib's StandardFonts throw.
// eslint-disable-next-line no-control-regex
const NON_PRINTABLE_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Maps common "smart" punctuation to ASCII and drops anything else outside
 * the printable WinAnsi range (emoji, non-Latin scripts, control chars) so a
 * gazetteer entry never crashes the whole export over one fancy character in
 * one note.
 */
export function sanitizeForPdf(text: string): string {
  const mapped = text
    .replace(LEFT_SINGLE_QUOTES, "'")
    .replace(RIGHT_SINGLE_QUOTE, "'")
    .replace(LEFT_DOUBLE_QUOTES, '"')
    .replace(RIGHT_DOUBLE_QUOTE, '"')
    .replace(DASHES, "-")
    .replace(ELLIPSIS, "...")
    .replace(UNICODE_SPACES, " ");
  return mapped.replace(NON_WINANSI, "?").replace(NON_PRINTABLE_CONTROL, "");
}

function formatCoords(point: [number, number] | null): string {
  if (!point) return "no coordinates";
  return `${point[0].toFixed(2)}, ${point[1].toFixed(2)}`;
}

export async function buildAtlasPdf(opts: AtlasOptions): Promise<ArrayBuffer> {
  const doc = await PDFDocument.create();
  const titleFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const bodyFont = await doc.embedFont(StandardFonts.Helvetica);

  // --- Cover page ---
  const coverPage = doc.addPage(LANDSCAPE_PAGE);
  const { width: coverPageW, height: coverPageH } = coverPage.getSize();

  coverPage.drawText(sanitizeForPdf(opts.title), {
    x: MARGIN,
    y: coverPageH - MARGIN - TITLE_SIZE,
    size: TITLE_SIZE,
    font: titleFont,
    color: INK,
  });

  const coverImage = await doc.embedPng(opts.coverPng);
  const imageAreaTop = coverPageH - MARGIN - TITLE_SIZE - 20;
  const imageAreaHeight = imageAreaTop - MARGIN;
  const imageAreaWidth = coverPageW - MARGIN * 2;
  // Scale from the embedded PNG's own intrinsic dimensions, not the caller's
  // coverWidth/coverHeight — renderPoster's output PNG is taller than
  // coverWidth x coverHeight by its title-bar strip (see posterExport.ts's
  // TITLE_BAR_PX), so using the nominal dimensions here would stretch the
  // image and squash the map render.
  const scale = Math.min(imageAreaWidth / coverImage.width, imageAreaHeight / coverImage.height);
  const drawW = coverImage.width * scale;
  const drawH = coverImage.height * scale;
  coverPage.drawImage(coverImage, {
    x: MARGIN + (imageAreaWidth - drawW) / 2,
    y: MARGIN + (imageAreaHeight - drawH) / 2,
    width: drawW,
    height: drawH,
  });

  // --- Gazetteer pages ---
  let page = doc.addPage(PORTRAIT_PAGE);
  const { height: gazPageH } = page.getSize();
  let y = gazPageH - MARGIN;

  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage(PORTRAIT_PAGE);
      y = gazPageH - MARGIN;
    }
  };

  for (const loc of opts.locations) {
    const bodyLines = wrapText(sanitizeForPdf(loc.body), BODY_WRAP_CHARS).slice(0, BODY_MAX_LINES);
    const blockHeight =
      NAME_SIZE + LINE_GAP + META_SIZE + LINE_GAP + bodyLines.length * (BODY_SIZE + LINE_GAP) + ENTRY_GAP;
    ensureSpace(blockHeight);

    y -= NAME_SIZE;
    page.drawText(sanitizeForPdf(loc.name) || "(unnamed)", { x: MARGIN, y, size: NAME_SIZE, font: titleFont, color: INK });
    y -= LINE_GAP;

    y -= META_SIZE;
    page.drawText(`${sanitizeForPdf(loc.type)} - (${formatCoords(loc.point)})`, {
      x: MARGIN,
      y,
      size: META_SIZE,
      font: bodyFont,
      color: MUTED_INK,
    });
    y -= LINE_GAP;

    for (const line of bodyLines) {
      y -= BODY_SIZE;
      page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font: bodyFont, color: BODY_INK });
      y -= LINE_GAP;
    }
    y -= ENTRY_GAP;
  }

  const bytes = await doc.save();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
