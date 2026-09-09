import type { RgbaImage } from "./png.ts";

export type Rgba = readonly [r: number, g: number, b: number, a: number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Box-filter resample (area average when shrinking, nearest when enlarging). */
export function resample(image: RgbaImage, width: number, height: number): RgbaImage {
  if (width === image.width && height === image.height) return image;
  const out = createImage(width, height);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.max(y0 + 1, Math.min(image.height, Math.ceil((y + 1) * scaleY)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.max(x0 + 1, Math.min(image.width, Math.ceil((x + 1) * scaleX)));
      let r = 0; let g = 0; let b = 0; let a = 0; let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          const alpha = image.data[i + 3]!;
          r += image.data[i]! * alpha;
          g += image.data[i + 1]! * alpha;
          b += image.data[i + 2]! * alpha;
          a += alpha;
          count += 1;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round(a / count);
    }
  }
  return out;
}

/** Scale to fit inside the box while preserving aspect ratio (enlarging allowed). */
export function fitWithin(image: RgbaImage, maxWidth: number, maxHeight: number): RgbaImage {
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  return resample(image, width, height);
}

/** Anti-aliased coverage (0..1) of the pixel at (px, py) by a rounded rectangle. */
export function roundedRectCoverage(px: number, py: number, rect: Rect, radius: number): number {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const dx = Math.abs(px + 0.5 - (rect.x + rect.width / 2)) - (rect.width / 2 - r);
  const dy = Math.abs(py + 0.5 - (rect.y + rect.height / 2)) - (rect.height / 2 - r);
  const distance = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
  return Math.min(1, Math.max(0, 0.5 - distance));
}

function blendPixel(canvas: RgbaImage, x: number, y: number, color: Rgba, coverage: number): void {
  if (coverage <= 0 || x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 4;
  const sa = (color[3] / 255) * coverage;
  if (sa <= 0) return;
  const da = canvas.data[i + 3]! / 255;
  const outA = sa + da * (1 - sa);
  for (let c = 0; c < 3; c += 1) {
    canvas.data[i + c] = Math.round((color[c]! * sa + canvas.data[i + c]! * da * (1 - sa)) / outA);
  }
  canvas.data[i + 3] = Math.round(outA * 255);
}

function forEachPixel(rect: Rect, canvas: RgbaImage, visit: (x: number, y: number) => void): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(canvas.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(canvas.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) visit(x, y);
  }
}

export function fillRoundedRect(canvas: RgbaImage, rect: Rect, radius: number, color: Rgba): void {
  forEachPixel(rect, canvas, (x, y) => blendPixel(canvas, x, y, color, roundedRectCoverage(x, y, rect, radius)));
}

/** Stroke drawn inside `rect`, `width` pixels wide, following its rounded outline. */
export function strokeRoundedRect(canvas: RgbaImage, rect: Rect, radius: number, width: number, color: Rgba): void {
  const inner: Rect = { x: rect.x + width, y: rect.y + width, width: rect.width - width * 2, height: rect.height - width * 2 };
  forEachPixel(rect, canvas, (x, y) => {
    const coverage = roundedRectCoverage(x, y, rect, radius) - roundedRectCoverage(x, y, inner, radius - width);
    blendPixel(canvas, x, y, color, coverage);
  });
}

/** Source-over blit; when `mask` is given, source alpha is clipped to that rounded rectangle. */
export function blit(canvas: RgbaImage, image: RgbaImage, left: number, top: number, mask?: { rect: Rect; radius: number }): void {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const cx = left + x;
      const cy = top + y;
      const coverage = mask ? roundedRectCoverage(cx, cy, mask.rect, mask.radius) : 1;
      const i = (y * image.width + x) * 4;
      blendPixel(canvas, cx, cy, [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!, image.data[i + 3]!], coverage);
    }
  }
}
