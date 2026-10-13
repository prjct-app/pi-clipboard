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

const IMAGE_EXTENSION_SOURCE = "(?:png|jpe?g|webp|gif)";
const UUID_CLIPBOARD_IMAGE_NAME_SOURCE = `pi-clipboard-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${IMAGE_EXTENSION_SOURCE}`;
const TIMESTAMPED_CLIPBOARD_IMAGE_NAME_SOURCE = `clipboard-[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])-(?:[01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]-[0-9a-f]{8}\\.${IMAGE_EXTENSION_SOURCE}`;
const CLIPBOARD_IMAGE_NAME_SOURCE = `(?:${UUID_CLIPBOARD_IMAGE_NAME_SOURCE}|${TIMESTAMPED_CLIPBOARD_IMAGE_NAME_SOURCE})`;
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
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;
const PREVIEW_MAX_WIDTH_CELLS = 60;
const PREVIEW_MAX_HEIGHT_CELLS = 12;

type PreviewSource = Readonly<{
  filePath: string;
  base64: string;
  mimeType: string;
  dimensions: ImageDimensions;
  /** PNG variant for Kitty placements (f=100 only decodes PNG). Undefined when conversion failed. */
  kittyBase64?: string;
}>;

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

/** Resolve only filenames produced by Pi's native clipboard flows. */
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
async function withKittyVariant(source: PreviewSource): Promise<PreviewSource> {
  if (source.mimeType === "image/png") return { ...source, kittyBase64: source.base64 };
  try {
    const converted = await convertToPng(source.base64, source.mimeType);
    return { ...source, kittyBase64: converted?.data };
  } catch {
    return source;
  }
}

/**
 * The previews after the editor changed: images no longer referenced leave, newly read ones join.
 * Returns the same map when nothing changed, so callers can skip a redraw.
 */
export function nextSources<T>(
  current: ReadonlyMap<string, T>,
  paths: readonly string[],
  additions: readonly (readonly [string, T | undefined])[],
): ReadonlyMap<string, T> {
  const referenced = new Set(paths);
  const kept = [...current].filter(([path]) => referenced.has(path));
  const added = additions.filter((entry): entry is readonly [string, T] => entry[1] !== undefined && !current.has(entry[0]));
  return kept.length === current.size && added.length === 0 ? current : new Map([...kept, ...added]);
}

/**
 * Renders one native Pi `Image` per clipboard attachment inside a `Container`.
 * The `Image` component owns Kitty/iTerm2 placement and the `[Image: ...]`
 * text fallback for terminals without inline-image support.
 */
class ClipboardPreviewGallery implements Component {
  /** Render cache: rebuilt only when the terminal's image support or the sources change. */
  private cache?: Readonly<{ key: string; container: Container }>;

  constructor(
    private readonly sources: readonly PreviewSource[],
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
    if (this.cache?.key !== key) this.cache = { key, container: this.build() };
    return this.cache.container.render(Math.max(1, width));
  }

  invalidate(): void {
    this.cache?.container.invalidate();
  }

  dispose(): void {
    this.cache = undefined;
  }
}

/** The editor's text, or undefined when the editor cannot be read right now. */
function readEditorText(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.ui.getEditorText();
  } catch {
    return undefined;
  }
}

function renderPreviewWidget(ctx: ExtensionContext, sources: readonly PreviewSource[]): void {
  if (sources.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) =>
    new ClipboardPreviewGallery(sources, (text) => theme.fg("muted", text)));
}

/** Everything the preview knows, as one immutable value that is replaced on every change. */
type PreviewState = Readonly<{
  timer: ReturnType<typeof setInterval> | undefined;
  /** Bumped on every stop, so a sync that started earlier never writes into a newer session. */
  generation: number;
  activeContext: ExtensionContext | undefined;
  sources: ReadonlyMap<string, PreviewSource>;
  /** Clipboard files shown in this session, deleted when the session ends. */
  trackedFiles: ReadonlySet<string>;
  syncInFlight: boolean;
  syncAgain: boolean;
}>;

const idleState = (generation: number): PreviewState => ({
  timer: undefined,
  generation,
  activeContext: undefined,
  sources: new Map(),
  trackedFiles: new Set(),
  syncInFlight: false,
  syncAgain: false,
});

export function createImagePreviewExtension(options: ImagePreviewOptions = {}) {
  const scheduler = options.scheduler ?? systemScheduler;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  return function imagePreview(pi: ExtensionAPI): void {
    // The one cell that changes: it holds the current state value, which is always replaced, never edited.
    const session: { state: PreviewState } = { state: idleState(0) };
    const set = (change: Partial<PreviewState>): void => {
      session.state = { ...session.state, ...change };
    };
    const isCurrent = (ctx: ExtensionContext, generation: number): boolean =>
      generation === session.state.generation && ctx === session.state.activeContext;

    const stop = (ctx?: ExtensionContext) => {
      if (session.state.timer) scheduler.clearInterval(session.state.timer);
      session.state = idleState(session.state.generation + 1);
      if (ctx?.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
    };

    const syncOnce = async (ctx: ExtensionContext, expectedGeneration: number) => {
      const editorText = readEditorText(ctx);
      if (editorText === undefined) return;

      const paths = clipboardImagePaths(editorText);
      const additions = await Promise.all(paths
        .filter((path) => !session.state.sources.has(path))
        .map(async (path) => {
          const source = await readPreviewSource(path);
          return [path, source && await withKittyVariant(source)] as const;
        }));
      if (!isCurrent(ctx, expectedGeneration)) return;

      const sources = nextSources(session.state.sources, paths, additions);
      if (sources === session.state.sources) return;
      set({ sources, trackedFiles: new Set([...session.state.trackedFiles, ...sources.keys()]) });
      renderPreviewWidget(ctx, [...sources.values()]);
    };

    // Editor changes that arrive during a sync are folded into one more pass, never run in parallel.
    const drain = async (ctx: ExtensionContext, expectedGeneration: number): Promise<void> => {
      set({ syncAgain: false });
      await syncOnce(ctx, expectedGeneration);
      if (session.state.syncAgain && isCurrent(ctx, expectedGeneration)) return drain(ctx, expectedGeneration);
    };

    const sync = async (ctx: ExtensionContext, expectedGeneration: number) => {
      if (session.state.syncInFlight) {
        set({ syncAgain: true });
        return;
      }
      set({ syncInFlight: true });
      try {
        await drain(ctx, expectedGeneration);
      } finally {
        set({ syncInFlight: false });
      }
    };

    pi.on("session_start", async (_event, ctx) => {
      stop();
      if (ctx.mode !== "tui") return;

      set({ activeContext: ctx });
      const expectedGeneration = session.state.generation;
      await sync(ctx, expectedGeneration);
      if (!isCurrent(ctx, expectedGeneration)) return;

      const timer = scheduler.setInterval(() => {
        void sync(ctx, expectedGeneration);
      }, pollIntervalMs);
      timer.unref?.();
      set({ timer });
    });

    pi.on("session_shutdown", async (event, ctx) => {
      const tracked = [...session.state.trackedFiles];
      stop(ctx);
      if (event.reason !== "reload") await Promise.all(tracked.map(deleteClipboardImage));
    });
  };
}

export default createImagePreviewExtension();
