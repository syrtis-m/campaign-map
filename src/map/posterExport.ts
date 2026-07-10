import maplibregl, { type StyleSpecification } from "maplibre-gl";

/**
 * v1 poster export (docs/03 Phase 5: "poster export first"). Renders a
 * *separate, offscreen* MapLibre map rather than capturing the live map's
 * canvas — the live map is created without `preserveDrawingBuffer` (see
 * MapView.onOpen), so its WebGL backbuffer can't be reliably read back after
 * the browser composites a frame. This offscreen-map abstraction is also the
 * hook the fuller roadmap item (300dpi tiled render) builds on: it swaps in
 * N offscreen renders per campaign tile instead of one.
 */
export interface PosterOptions {
  style: StyleSpecification;
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  widthPx: number; // output width, e.g. 2000
  heightPx: number; // output height, preserve view aspect
  title: string;
  transformRequest: maplibregl.RequestTransformFunction;
  /** Overridable for tests / non-default timeouts; defaults to 15000ms. */
  idleTimeoutMs?: number;
}

/** Given the live map's on-screen canvas size and a target output width,
 * compute the output height that preserves the live view's aspect ratio.
 * Pure so it's unit-testable without a WebGL context. */
export function posterDimensions(
  canvasWidthPx: number,
  canvasHeightPx: number,
  targetWidthPx: number
): { width: number; height: number } {
  const aspect = canvasHeightPx / canvasWidthPx;
  return { width: Math.round(targetWidthPx), height: Math.round(targetWidthPx * aspect) };
}

const TITLE_BAR_PX = 96;
const DEFAULT_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_BG_COLOR = "#1a1a1a";
const DEFAULT_FG_COLOR = "#f0f0f0";

/** Pulls a background color out of the style's `background` layer paint, if
 * present, so the title bar reads as an extension of the map rather than a
 * jarring default. Keep it simple — no attempt to resolve stops/expressions. */
function backgroundColorFromStyle(style: StyleSpecification): string {
  const bg = style.layers?.find((l) => l.type === "background");
  const paint = (bg as { paint?: { "background-color"?: unknown } } | undefined)?.paint;
  const color = paint?.["background-color"];
  return typeof color === "string" ? color : DEFAULT_BG_COLOR;
}

function waitForIdle(map: maplibregl.Map, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Campaign Map: poster render timed out waiting for map to idle (${timeoutMs}ms)`));
    }, timeoutMs);
    const onIdle = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      map.off("error", onError);
      resolve();
    };
    const onError = (e: { error?: Error }): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      map.off("idle", onIdle);
      reject(e.error ?? new Error("Campaign Map: poster render map errored before idle"));
    };
    map.once("idle", onIdle);
    map.once("error", onError);
  });
}

function canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob || blob.size === 0) {
        reject(new Error("Campaign Map: poster canvas produced an empty blob (0 bytes)"));
        return;
      }
      blob
        .arrayBuffer()
        .then(resolve)
        .catch((err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
    }, "image/png");
  });
}

export async function renderPoster(opts: PosterOptions): Promise<ArrayBuffer> {
  const container = document.createElement("div");
  container.style.position = "absolute";
  container.style.left = "-99999px";
  container.style.top = "-99999px";
  container.style.width = `${opts.widthPx}px`;
  container.style.height = `${opts.heightPx}px`;
  document.body.appendChild(container);

  let map: maplibregl.Map | null = null;
  try {
    map = new maplibregl.Map({
      container,
      style: opts.style,
      center: opts.center,
      zoom: opts.zoom,
      bearing: opts.bearing,
      pitch: opts.pitch,
      preserveDrawingBuffer: true,
      attributionControl: false,
      interactive: false,
      transformRequest: opts.transformRequest,
      fadeDuration: 0,
    });

    await waitForIdle(map, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

    const mapCanvas = map.getCanvas();
    const outCanvas = document.createElement("canvas");
    outCanvas.width = opts.widthPx;
    outCanvas.height = opts.heightPx + TITLE_BAR_PX;
    const ctx = outCanvas.getContext("2d");
    if (!ctx) throw new Error("Campaign Map: poster export could not acquire a 2D canvas context");

    const bgColor = backgroundColorFromStyle(opts.style);
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, outCanvas.width, TITLE_BAR_PX);

    ctx.drawImage(mapCanvas, 0, TITLE_BAR_PX, opts.widthPx, opts.heightPx);

    ctx.fillStyle = DEFAULT_FG_COLOR;
    ctx.textBaseline = "middle";
    ctx.font = "600 32px sans-serif";
    ctx.fillText(opts.title, 32, TITLE_BAR_PX / 2 - 8);
    ctx.font = "16px sans-serif";
    ctx.globalAlpha = 0.7;
    ctx.fillText("Campaign Map", 32, TITLE_BAR_PX / 2 + 24);
    ctx.globalAlpha = 1;

    return await canvasToArrayBuffer(outCanvas);
  } finally {
    map?.remove();
    container.remove();
  }
}
