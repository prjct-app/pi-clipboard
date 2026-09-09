import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";

import {
  convertToPng,
  resizeImage,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getImageDimensions,
  imageFallback,
  Image,
  truncateToWidth,
  visibleWidth,
  type Component,
  type ImageDimensions,
  type TUI,
} from "@earendil-works/pi-tui";

import { decodePng, encodePng, type RgbaImage } from "./png.ts";
import { blit, createImage, fillRoundedRect, fitWithin, strokeRoundedRect, type Rgba } from "./raster.ts";

const CLIPBOARD_IMAGE_NAME_SOURCE = "pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.(?:png|jpe?g|webp|gif)";
const CLIPBOARD_IMAGE_FILENAME = new RegExp(CLIPBOARD_IMAGE_NAME_SOURCE, "gi");
const CLIPBOARD_IMAGE_BASENAME = new RegExp(`^${CLIPBOARD_IMAGE_NAME_SOURCE}$`, "i");
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const WIDGET_KEY = "pi-image-preview";
const DEFAULT_POLL_INTERVAL_MS = 150;
const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;
const CARD_WIDTH_CELLS = 14;
const FALLBACK_CARD_WIDTH_CELLS = 28;
const CARD_GAP_CELLS = 1;
const MAX_CARDS_PER_ROW = 6;
const CARD_WIDTH_PX = 160;
const CARD_HEIGHT_PX = 112;
const CARD_GAP_PX = 8;
const THUMBNAIL_INSET_PX = 8;
const THUMBNAIL_WIDTH_PX = CARD_WIDTH_PX - THUMBNAIL_INSET_PX * 2;
const THUMBNAIL_HEIGHT_PX = CARD_HEIGHT_PX - THUMBNAIL_INSET_PX * 2;
const CARD_RADIUS_PX = 16;
const CARD_BORDER_PX = 2;
const THUMBNAIL_RADIUS_PX = 12;
const CARD_FILL: Rgba = [0x11, 0x18, 0x27, Math.round(0.92 * 255)];
const CARD_BORDER: Rgba = [0x9c, 0xa3, 0xaf, 255];

interface PreviewSource {
  filePath: string;
  data: Buffer;
  mimeType: string;
  dimensions: ImageDimensions;
}

interface GalleryLayout {
  columns: number;
  rows: number;
  displayWidth: number;
  displayHeight: number;
}

interface RenderedGallery {
  signature: string;
  image: Image;
}

interface Scheduler {
  setInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

export interface ImagePreviewOptions {
  pollIntervalMs?: number;
  scheduler?: Scheduler;
}

const systemScheduler: Scheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle),
};

/** Resolve only filenames produced by Pi's native clipboard flow. */
export function clipboardImagePaths(editorText: string): string[] {
  const paths = new Set<string>();
  const matcher = new RegExp(CLIPBOARD_IMAGE_FILENAME.source, CLIPBOARD_IMAGE_FILENAME.flags);
  for (const match of editorText.matchAll(matcher)) {
    const fileName = match[0];
    const filePath = resolve(tmpdir(), fileName);
    if (editorText.includes(filePath)) paths.add(filePath);
  }
  return [...paths];
}

async function readPreviewSource(filePath: string): Promise<PreviewSource | undefined> {
  if (dirname(resolve(filePath)) !== resolve(tmpdir())) return undefined;
  const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()];
  if (!mimeType || !CLIPBOARD_IMAGE_BASENAME.test(basename(filePath))) return undefined;

  try {
    const before = await lstat(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_PREVIEW_FILE_BYTES) return undefined;

    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      const after = await lstat(filePath);
      if (
        !opened.isFile()
        || after.isSymbolicLink()
        || opened.size > MAX_PREVIEW_FILE_BYTES
        || opened.dev !== after.dev
        || opened.ino !== after.ino
      ) return undefined;

      const data = await handle.readFile();
      return {
        filePath,
        data,
        mimeType,
        dimensions: getImageDimensions(data.toString("base64"), mimeType) ?? { widthPx: 800, heightPx: 600 },
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function galleryLayout(width: number, count: number): GalleryLayout {
  const available = Math.max(1, width);
  const columns = Math.min(
    count,
    MAX_CARDS_PER_ROW,
    Math.max(1, Math.floor((available + CARD_GAP_CELLS) / (CARD_WIDTH_CELLS + CARD_GAP_CELLS))),
  );
  const rows = Math.ceil(count / columns);
  return {
    columns,
    rows,
    displayWidth: Math.min(available, columns * CARD_WIDTH_CELLS + (columns - 1) * CARD_GAP_CELLS),
    displayHeight: rows * 7 + Math.max(0, rows - 1),
  };
}

function padLine(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

async function thumbnailPixels(source: PreviewSource): Promise<RgbaImage | undefined> {
  let png: Uint8Array | undefined;
  try {
    const resized = await resizeImage(source.data, source.mimeType, {
      maxWidth: THUMBNAIL_WIDTH_PX,
      maxHeight: THUMBNAIL_HEIGHT_PX,
    });
    const converted = resized ? await convertToPng(resized.data, resized.mimeType) : null;
    if (converted) png = Buffer.from(converted.data, "base64");
  } catch {
    png = undefined;
  }
  if (!png && source.mimeType === "image/png") png = source.data;
  const decoded = png ? decodePng(png) : null;
  return decoded ? fitWithin(decoded, THUMBNAIL_WIDTH_PX, THUMBNAIL_HEIGHT_PX) : undefined;
}

async function roundedCard(source: PreviewSource): Promise<RgbaImage> {
  const card = createImage(CARD_WIDTH_PX, CARD_HEIGHT_PX);
  const outline = { x: 0, y: 0, width: CARD_WIDTH_PX, height: CARD_HEIGHT_PX };
  fillRoundedRect(card, {
    x: CARD_BORDER_PX / 2,
    y: CARD_BORDER_PX / 2,
    width: CARD_WIDTH_PX - CARD_BORDER_PX,
    height: CARD_HEIGHT_PX - CARD_BORDER_PX,
  }, CARD_RADIUS_PX - CARD_BORDER_PX / 2, CARD_FILL);
  strokeRoundedRect(card, outline, CARD_RADIUS_PX, CARD_BORDER_PX, CARD_BORDER);

  const thumbnail = await thumbnailPixels(source);
  if (thumbnail) {
    const box = { x: THUMBNAIL_INSET_PX, y: THUMBNAIL_INSET_PX, width: THUMBNAIL_WIDTH_PX, height: THUMBNAIL_HEIGHT_PX };
    const left = box.x + Math.floor((box.width - thumbnail.width) / 2);
    const top = box.y + Math.floor((box.height - thumbnail.height) / 2);
    blit(card, thumbnail, left, top, { rect: box, radius: THUMBNAIL_RADIUS_PX });
  }
  return card;
}

async function buildGallery(sources: PreviewSource[], layout: GalleryLayout): Promise<Buffer> {
  const cards = await Promise.all(sources.map(roundedCard));
  const width = layout.columns * CARD_WIDTH_PX + (layout.columns - 1) * CARD_GAP_PX;
  const height = layout.rows * CARD_HEIGHT_PX + (layout.rows - 1) * CARD_GAP_PX;
  const gallery = createImage(width, height);
  cards.forEach((card, index) => {
    blit(
      gallery,
      card,
      (index % layout.columns) * (CARD_WIDTH_PX + CARD_GAP_PX),
      Math.floor(index / layout.columns) * (CARD_HEIGHT_PX + CARD_GAP_PX),
    );
  });
  return encodePng(gallery);
}

class ImagePreviewGallery implements Component {
  private gallery?: RenderedGallery;
  private pendingSignature?: string;
  private buildGeneration = 0;

  constructor(
    private readonly tui: TUI,
    private readonly sources: PreviewSource[],
    private readonly fallbackColor: (text: string) => string,
  ) {}

  private renderFallback(width: number): string[] {
    const innerWidth = Math.max(1, Math.min(FALLBACK_CARD_WIDTH_CELLS - 2, width - 2));
    const cardWidth = innerWidth + 2;
    const columns = Math.max(1, Math.floor((width + CARD_GAP_CELLS) / (cardWidth + CARD_GAP_CELLS)));
    const lines: string[] = [];

    for (let start = 0; start < this.sources.length; start += columns) {
      const row = this.sources.slice(start, start + columns);
      const cards = row.map((source) => {
        const label = imageFallback(source.mimeType, source.dimensions);
        return [
          `╭${"─".repeat(innerWidth)}╮`,
          `│${padLine(this.fallbackColor(label), innerWidth)}│`,
          `╰${"─".repeat(innerWidth)}╯`,
        ];
      });
      for (let line = 0; line < 3; line += 1) {
        lines.push(cards.map((card) => card[line]).join(" "));
      }
    }

    return lines;
  }

  private requestGallery(layout: GalleryLayout, signature: string): void {
    if (this.pendingSignature === signature) return;
    this.pendingSignature = signature;
    const generation = ++this.buildGeneration;

    void buildGallery(this.sources, layout).then((data) => {
      if (generation !== this.buildGeneration) return;
      this.gallery = {
        signature,
        image: new Image(data.toString("base64"), "image/png", {
          fallbackColor: this.fallbackColor,
        }, {
          maxWidthCells: layout.displayWidth,
          maxHeightCells: layout.displayHeight,
        }),
      };
      this.pendingSignature = undefined;
      this.tui.requestRender();
    }).catch(() => {
      if (generation !== this.buildGeneration) return;
      this.pendingSignature = undefined;
      this.tui.requestRender();
    });
  }

  render(width: number): string[] {
    if (this.sources.length === 0) return [];
    if (!getCapabilities().images) return this.renderFallback(width);

    const layout = galleryLayout(width, this.sources.length);
    const signature = `${this.sources.map((source) => source.filePath).join("\0")}\0${layout.columns}`;
    if (this.gallery?.signature === signature) return this.gallery.image.render(width);

    this.requestGallery(layout, signature);
    return this.renderFallback(width);
  }

  invalidate(): void {
    this.gallery?.image.invalidate();
  }

  dispose(): void {
    this.buildGeneration += 1;
    this.gallery?.image.invalidate();
    this.gallery = undefined;
  }
}

function renderPreviewWidget(ctx: ExtensionContext, sources: PreviewSource[]): void {
  if (sources.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const snapshot = [...sources];
  ctx.ui.setWidget(WIDGET_KEY, (tui, theme) =>
    new ImagePreviewGallery(tui, snapshot, (text) => theme.fg("muted", text)));
}

export function createImagePreviewExtension(options: ImagePreviewOptions = {}) {
  const scheduler = options.scheduler ?? systemScheduler;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return function imagePreview(pi: ExtensionAPI): void {
    let timer: ReturnType<typeof setInterval> | undefined;
    let generation = 0;
    let activeContext: ExtensionContext | undefined;
    let sources = new Map<string, PreviewSource>();
    let syncInFlight = false;
    let syncAgain = false;

    const stop = (ctx?: ExtensionContext) => {
      generation += 1;
      if (timer) scheduler.clearInterval(timer);
      timer = undefined;
      activeContext = undefined;
      sources = new Map();
      syncInFlight = false;
      syncAgain = false;
      if (ctx?.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    };

    const syncOnce = async (ctx: ExtensionContext, expectedGeneration: number) => {
      let editorText: string;
      try {
        editorText = ctx.ui.getEditorText();
      } catch {
        return;
      }

      const paths = clipboardImagePaths(editorText);
      const pathSet = new Set(paths);
      let changed = false;

      for (const path of sources.keys()) {
        if (!pathSet.has(path)) {
          sources.delete(path);
          changed = true;
        }
      }

      const additions = await Promise.all(paths
        .filter((path) => !sources.has(path))
        .map(async (path) => [path, await readPreviewSource(path)] as const));
      if (expectedGeneration !== generation || ctx !== activeContext) return;

      for (const [path, source] of additions) {
        if (source && !sources.has(path)) {
          sources.set(path, source);
          changed = true;
        }
      }

      if (changed) renderPreviewWidget(ctx, [...sources.values()]);
    };

    const sync = async (ctx: ExtensionContext, expectedGeneration: number) => {
      if (syncInFlight) {
        syncAgain = true;
        return;
      }
      syncInFlight = true;
      try {
        do {
          syncAgain = false;
          await syncOnce(ctx, expectedGeneration);
        } while (syncAgain && expectedGeneration === generation && ctx === activeContext);
      } finally {
        syncInFlight = false;
      }
    };

    pi.on("session_start", async (_event, ctx) => {
      stop();
      if (ctx.mode !== "tui") return;

      activeContext = ctx;
      const expectedGeneration = generation;
      await sync(ctx, expectedGeneration);
      if (expectedGeneration !== generation || ctx !== activeContext) return;

      timer = scheduler.setInterval(() => {
        void sync(ctx, expectedGeneration);
      }, pollIntervalMs);
      timer.unref?.();
    });

    pi.on("session_shutdown", (_event, ctx) => {
      stop(ctx);
    });
  };
}

export default createImagePreviewExtension();
