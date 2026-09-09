import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { setCapabilities, visibleWidth, type Component } from "@earendil-works/pi-tui";

import imagePreview, { clipboardImagePaths, createImagePreviewExtension } from "../index.ts";
import { decodePng, encodePng } from "../src/png.ts";
import { createImage, fitWithin, roundedRectCoverage } from "../src/raster.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type WidgetFactory = (tui: unknown, theme: unknown) => Component;

class FakeScheduler {
  callback?: () => void;
  cleared = false;

  setInterval(callback: () => void): ReturnType<typeof setInterval> {
    this.callback = callback;
    this.cleared = false;
    return { unref() {} } as ReturnType<typeof setInterval>;
  }

  clearInterval(): void {
    this.cleared = true;
    this.callback = undefined;
  }

  async tick(): Promise<void> {
    this.callback?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function harness(initialText = "", mode = "tui") {
  const handlers = new Map<string, Function>();
  const scheduler = new FakeScheduler();
  let editorText = initialText;
  let widgetFactory: WidgetFactory | undefined;
  let renders = 0;

  createImagePreviewExtension({ scheduler: scheduler as never })({
    on: (name: string, handler: Function) => handlers.set(name, handler),
  } as never);

  const ctx = {
    mode,
    ui: {
      getEditorText: () => editorText,
      setEditorComponent: () => assert.fail("image-preview must not replace Pi's editor"),
      setWidget: (_key: string, content: WidgetFactory | undefined) => { widgetFactory = content; },
    },
  };

  await handlers.get("session_start")?.({}, ctx);

  return {
    ctx,
    handlers,
    scheduler,
    setEditorText(value: string) { editorText = value; },
    getEditorText() { return editorText; },
    widget() {
      return widgetFactory?.(
        { terminal: { rows: 40, columns: 80 }, requestRender: () => { renders += 1; } },
        { fg: (_color: string, text: string) => text },
      );
    },
    hasWidget() { return widgetFactory !== undefined; },
    renders: () => renders,
  };
}

function visible(component: Component, width = 80): string[] {
  return component.render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .filter((line) => line.trim());
}

async function eventually(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("uses a widget and discovers an existing native Pi clipboard attachment", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(path);
    assert.equal(h.getEditorText(), path);
    assert.ok(h.hasWidget());
    assert.match(visible(h.widget()!).join("\n"), /\[Image: .*image\/png.*1x1\]/);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(path, { force: true });
  }
});

test("polling adds all native attachments and removes previews when paths disappear", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const first = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const second = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(first, PNG_1X1);
  writeFileSync(second, PNG_1X1);

  try {
    const h = await harness("");
    assert.equal(h.hasWidget(), false);

    h.setEditorText(`${first} ${second}`);
    await h.scheduler.tick();
    await eventually(() => assert.ok(h.hasWidget()));
    const gallery = visible(h.widget()!).join("\n");
    assert.equal(gallery.match(/\[Image:/g)?.length, 2);
    assert.equal(visible(h.widget()!)[0].match(/╭/g)?.length, 2);

    h.setEditorText(second);
    await h.scheduler.tick();
    await eventually(() => assert.equal(visible(h.widget()!).join("\n").match(/\[Image:/g)?.length, 1));

    h.setEditorText("");
    await h.scheduler.tick();
    await eventually(() => assert.equal(h.hasWidget(), false));
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(first, { force: true });
    rmSync(second, { force: true });
  }
});

test("an inline-image terminal receives a real bounded image placement", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(path);
    const component = h.widget()!;
    await eventually(() => {
      const lines = component.render(24);
      assert.ok(lines.some((line) => line.includes("\x1b_G")));
      assert.ok(lines.every((line) => visibleWidth(line) <= 24));
    });
    assert.ok(h.renders() > 0);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(path, { force: true });
  }
});

test("multiple images render as one horizontal gallery placement", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const first = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const second = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(first, PNG_1X1);
  writeFileSync(second, PNG_1X1);

  try {
    const h = await harness(`${first} ${second}`);
    const component = h.widget()!;
    await eventually(() => {
      const output = component.render(80).join("\n");
      assert.equal(output.match(/\x1b_Ga=T/g)?.length, 1);
    });
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(first, { force: true });
    rmSync(second, { force: true });
  }
});

test("the gallery wraps and keeps rounded transparent corners", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const paths = Array.from({ length: 7 }, () => join(tmpdir(), `pi-clipboard-${randomUUID()}.png`));
  for (const path of paths) writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(paths.join(" "));
    const component = h.widget()!;
    let galleryData = Buffer.alloc(0);
    await eventually(() => {
      const output = component.render(80).join("\n");
      const chunks = [...output.matchAll(/\x1b_G[^;]*;([A-Za-z0-9+/=]*)\x1b\\/g)];
      assert.equal(chunks.filter((match) => match[0].includes("a=T")).length, 1);
      galleryData = Buffer.from(chunks.map((match) => match[1]).join(""), "base64");
      assert.ok(galleryData.length > 0);
    });

    const gallery = decodePng(galleryData);
    assert.ok(gallery);
    assert.deepEqual({ width: gallery.width, height: gallery.height }, { width: 832, height: 232 });
    assert.equal(gallery.data[3], 0);
    assert.ok(gallery.data[((56 * gallery.width + 80) * 4) + 3]! > 0);
    assert.equal(gallery.data[((56 * gallery.width + 164) * 4) + 3], 0);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    for (const path of paths) rmSync(path, { force: true });
  }
});

test("ordinary image paths and non-TUI sessions remain untouched", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const h = await harness("notes/screenshot.png");
  assert.equal(h.hasWidget(), false);
  await h.handlers.get("session_shutdown")?.({}, h.ctx);

  const handlers = new Map<string, Function>();
  imagePreview({ on: (name: string, handler: Function) => handlers.set(name, handler) } as never);
  const ctx = {
    mode: "rpc",
    ui: new Proxy({}, { get() { throw new Error("Unexpected terminal API"); } }),
  };
  await assert.doesNotReject(async () => handlers.get("session_start")?.({}, ctx));
});

test("clipboard-shaped symbolic links are not read or previewed", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const target = join(tmpdir(), `image-preview-target-${randomUUID()}.png`);
  const link = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(target, PNG_1X1);
  symlinkSync(target, link);

  try {
    const h = await harness(link);
    assert.equal(h.hasWidget(), false);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true });
  }
});

test("oversized clipboard-shaped files are not loaded into a preview", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);
  truncateSync(path, 50 * 1024 * 1024 + 1);

  try {
    const h = await harness(path);
    assert.equal(h.hasWidget(), false);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(path, { force: true });
  }
});

test("session shutdown removes the widget and polling timer", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(path);
    assert.ok(h.hasWidget());
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    assert.equal(h.hasWidget(), false);
    assert.equal(h.scheduler.cleared, true);
    assert.equal(h.scheduler.callback, undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("path discovery accepts only exact Pi clipboard paths in the system temp directory", () => {
  const valid = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const copiedName = valid.slice(valid.lastIndexOf("pi-clipboard-"));
  assert.deepEqual(clipboardImagePaths(`${valid} ${valid}`), [valid]);
  assert.deepEqual(clipboardImagePaths(`/project/${copiedName}`), []);
  assert.deepEqual(clipboardImagePaths("/tmp/screenshot.png"), []);
});

test("the bundled PNG codec round-trips pixels and rejects non-PNG data", () => {
  const image = createImage(3, 2);
  image.data.set([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  const decoded = decodePng(encodePng(image));
  assert.ok(decoded);
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 3, height: 2 });
  assert.deepEqual([...decoded.data], [...image.data]);
  assert.equal(decodePng(Buffer.from("not a png")), null);
});

test("thumbnails fit inside their box and rounded corners clip only the corners", () => {
  const wide = fitWithin(createImage(400, 100), 144, 96);
  assert.deepEqual({ width: wide.width, height: wide.height }, { width: 144, height: 36 });
  const tall = fitWithin(createImage(50, 100), 144, 96);
  assert.deepEqual({ width: tall.width, height: tall.height }, { width: 48, height: 96 });

  const box = { x: 0, y: 0, width: 144, height: 96 };
  assert.equal(roundedRectCoverage(0, 0, box, 12), 0);
  assert.equal(roundedRectCoverage(72, 48, box, 12), 1);
  assert.equal(roundedRectCoverage(0, 48, box, 12), 1);
});
