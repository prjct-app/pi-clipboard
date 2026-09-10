import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { setCapabilities, visibleWidth, type Component } from "@earendil-works/pi-tui";

import imagePreview, { clipboardImagePaths, createImagePreviewExtension } from "../index.ts";

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_8X8 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAACKADAAQAAAABAAAACAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgACAAIAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A/NP7eP8An5/8f/8Ar0fbx/z8/wDj/wD9euPor+0v9UcF/L+C/wAj+tv9Z8X/ADfn/mf/2Q==",
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
        { terminal: { rows: 40, columns: 80 }, requestRender: () => {} },
        { fg: (_color: string, text: string) => text },
      );
    },
    hasWidget() { return widgetFactory !== undefined; },
  };
}

function visible(component: Component, width = 80): string[] {
  return component.render(width)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .filter((line) => line.trim());
}

async function eventually(assertion: () => void, timeoutMs = 2000): Promise<void> {
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
    const output = visible(h.widget()!, 200).join("\n");
    assert.match(output, /\[Image: .*pi-clipboard-.*image\/png.*1x1\]/);
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
    await eventually(() => assert.equal(visible(h.widget()!, 200).join("\n").match(/\[Image:/g)?.length, 2));

    h.setEditorText(second);
    await h.scheduler.tick();
    await eventually(() => {
      const output = visible(h.widget()!, 200).join("\n");
      assert.equal(output.match(/\[Image:/g)?.length, 1);
      assert.ok(output.includes(second));
    });

    h.setEditorText("");
    await h.scheduler.tick();
    await eventually(() => assert.equal(h.hasWidget(), false));
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(first, { force: true });
    rmSync(second, { force: true });
  }
});

test("an inline-image terminal receives a bounded Kitty placement per attachment", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(path);
    const component = h.widget()!;
    const lines = component.render(24);
    assert.ok(lines.some((line) => line.includes("\x1b_Ga=T")));
    assert.ok(lines.every((line) => visibleWidth(line) <= 24));
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(path, { force: true });
  }
});

test("Kitty placements always carry PNG payloads, converting JPEG with Pi's converter", async () => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.jpg`);
  writeFileSync(path, JPEG_8X8);

  try {
    const h = await harness(path);
    const component = h.widget()!;
    const output = component.render(60).join("\n");
    const chunks = [...output.matchAll(/\x1b_G[^;]*;([A-Za-z0-9+/=]*)\x1b\\/g)];
    assert.ok(chunks.some((match) => match[0].includes("a=T")));
    const payload = Buffer.from(chunks.map((match) => match[1]).join(""), "base64");
    assert.deepEqual([...payload.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(path, { force: true });
  }
});

test("iTerm2 terminals receive the native inline image sequence", async () => {
  setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(path);
    const output = h.widget()!.render(60).join("\n");
    assert.ok(output.includes("\x1b]1337;File="));
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
  } finally {
    rmSync(path, { force: true });
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

test("session shutdown removes the widget, polling timer, and tracked temp files", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  const h = await harness(path);
  assert.ok(h.hasWidget());
  await h.handlers.get("session_shutdown")?.({}, h.ctx);
  assert.equal(h.hasWidget(), false);
  assert.equal(h.scheduler.cleared, true);
  assert.equal(h.scheduler.callback, undefined);
  assert.equal(existsSync(path), false);
});

test("removing a path from the editor keeps the file until the session closes", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(path, PNG_1X1);

  try {
    const h = await harness(path);
    await eventually(() => assert.ok(h.hasWidget()));

    h.setEditorText("");
    await h.scheduler.tick();
    await eventually(() => assert.equal(h.hasWidget(), false));
    assert.equal(existsSync(path), true);

    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(path, { force: true });
  }
});

test("session shutdown never deletes files the extension did not preview", async () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false });
  const previewed = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const untracked = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  writeFileSync(previewed, PNG_1X1);
  writeFileSync(untracked, PNG_1X1);

  try {
    const h = await harness(previewed);
    await eventually(() => assert.ok(h.hasWidget()));
    await h.handlers.get("session_shutdown")?.({}, h.ctx);
    assert.equal(existsSync(previewed), false);
    assert.equal(existsSync(untracked), true);
  } finally {
    rmSync(previewed, { force: true });
    rmSync(untracked, { force: true });
  }
});

test("path discovery accepts only exact Pi clipboard paths in the system temp directory", () => {
  const valid = join(tmpdir(), `pi-clipboard-${randomUUID()}.png`);
  const copiedName = valid.slice(valid.lastIndexOf("pi-clipboard-"));
  assert.deepEqual(clipboardImagePaths(`${valid} ${valid}`), [valid]);
  assert.deepEqual(clipboardImagePaths(`/project/${copiedName}`), []);
  assert.deepEqual(clipboardImagePaths("/tmp/screenshot.png"), []);
});
