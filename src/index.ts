import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, resolve } from "node:path";

import {
  convertToPng,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  getImageDimensions,
  Image,
  imageFallback,
  Text,
  type Component,
  type ImageDimensions,
} from "@earendil-works/pi-tui";

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
const PREVIEW_MAX_WIDTH_CELLS = 60;
const PREVIEW_MAX_HEIGHT_CELLS = 12;

interface PreviewSource {
  filePath: string;
  base64: string;
  mimeType: string;
  dimensions: ImageDimensions;
  /** PNG variant for Kitty placements (f=100 only decodes PNG). Undefined while unconverted. */
  kittyBase64?: string;
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
      const base64 = data.toString("base64");
      return {
        filePath,
        base64,
        mimeType,
        dimensions: getImageDimensions(base64, mimeType) ?? { widthPx: 800, heightPx: 600 },
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Delete a clipboard image previously previewed by this session. Revalidates
 * the same containment rules used for reads before unlinking, so only real
 * Pi-owned temporary clipboard files are removed; anything else stays put.
 */
async function deleteClipboardImage(filePath: string): Promise<void> {
  if (dirname(resolve(filePath)) !== resolve(tmpdir())) return;
  if (!CLIPBOARD_IMAGE_BASENAME.test(basename(filePath))) return;
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) return;
    await unlink(filePath);
  } catch {
    // Already removed or unreadable; nothing to clean up.
  }
}

/**
 * Kitty graphics placements (f=100) only decode PNG, so non-PNG sources need a
 * PNG variant. Conversion uses Pi's native `convertToPng` (bundled WASM, no
 * external tools) and runs once per source, off the render path.
 */
async function prepareKittyVariant(source: PreviewSource): Promise<void> {
  if (source.mimeType === "image/png") {
    source.kittyBase64 = source.base64;
    return;
  }
  try {
    const converted = await convertToPng(source.base64, source.mimeType);
    source.kittyBase64 = converted?.data;
  } catch {
    source.kittyBase64 = undefined;
  }
}

/**
 * Renders one native Pi `Image` per clipboard attachment inside a `Container`.
 * The `Image` component owns Kitty/iTerm2 placement and the `[Image: ...]`
 * text fallback for terminals without inline-image support.
 */
class ClipboardPreviewGallery implements Component {
  private container?: Container;
  private containerKey?: string;

  constructor(
    private readonly sources: PreviewSource[],
    private readonly fallbackColor: (text: string) => string,
  ) {}

  private build(): Container {
    const kitty = getCapabilities().images === "kitty";
    const container = new Container();
    for (const source of this.sources) {
      if (kitty && !source.kittyBase64) {
        const label = imageFallback(source.mimeType, source.dimensions, source.filePath);
        container.addChild(new Text(this.fallbackColor(label), 1, 0));
        continue;
      }
      container.addChild(new Image(
        kitty ? source.kittyBase64! : source.base64,
        kitty ? "image/png" : source.mimeType,
        { fallbackColor: this.fallbackColor },
        {
          maxWidthCells: PREVIEW_MAX_WIDTH_CELLS,
          maxHeightCells: PREVIEW_MAX_HEIGHT_CELLS,
          filename: source.filePath,
        },
        source.dimensions,
      ));
    }
    return container;
  }

  render(width: number): string[] {
    if (this.sources.length === 0) return [];
    const key = [
      getCapabilities().images ?? "none",
      ...this.sources.map((source) => `${source.filePath} ${source.kittyBase64 ? "png" : "raw"}`),
    ].join("\0");
    if (!this.container || this.containerKey !== key) {
      this.container = this.build();
      this.containerKey = key;
    }
    return this.container.render(Math.max(1, width));
  }

  invalidate(): void {
    this.container?.invalidate();
  }

  dispose(): void {
    this.container = undefined;
    this.containerKey = undefined;
  }
}

function renderPreviewWidget(ctx: ExtensionContext, sources: PreviewSource[]): void {
  if (sources.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  const snapshot = [...sources];
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) =>
    new ClipboardPreviewGallery(snapshot, (text) => theme.fg("muted", text)));
}

export function createImagePreviewExtension(options: ImagePreviewOptions = {}) {
  const scheduler = options.scheduler ?? systemScheduler;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return function imagePreview(pi: ExtensionAPI): void {
    let timer: ReturnType<typeof setInterval> | undefined;
    let generation = 0;
    let activeContext: ExtensionContext | undefined;
    let sources = new Map<string, PreviewSource>();
    let trackedFiles = new Set<string>();
    let syncInFlight = false;
    let syncAgain = false;

    const stop = (ctx?: ExtensionContext) => {
      generation += 1;
      if (timer) scheduler.clearInterval(timer);
      timer = undefined;
      activeContext = undefined;
      sources = new Map();
      trackedFiles = new Set();
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
        .map(async (path) => {
          const source = await readPreviewSource(path);
          if (source) await prepareKittyVariant(source);
          return [path, source] as const;
        }));
      if (expectedGeneration !== generation || ctx !== activeContext) return;

      for (const [path, source] of additions) {
        if (source && !sources.has(path)) {
          sources.set(path, source);
          trackedFiles.add(path);
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

    pi.on("session_shutdown", async (_event, ctx) => {
      const tracked = [...trackedFiles];
      stop(ctx);
      await Promise.all(tracked.map(deleteClipboardImage));
    });
  };
}

export default createImagePreviewExtension();
