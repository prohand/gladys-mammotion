// -----------------------------------------------------------------------------
// Map image of a mower, shown by the camera widget of the dashboard.
//
// Drawn from the map read on the mower (see MammotionClient.getMap): the
// mowing zones (bright green: zones of the next job, pale green: the others)
// with their name, the no-go zones (grey) and the mower (red dot). North is
// up, as near as the map frame allows: the points are in the frame of the RTK
// base, turned by its heading, which the cloud does not give.
//
// A small software drawing (filled polygons, lines, dots, a 5 x 7 font), then
// a JPEG (jpeg-js, pure JavaScript): Gladys takes `image/jpg;base64,...`
// images up to 150 KB.
// -----------------------------------------------------------------------------

import jpeg from 'jpeg-js';
import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphPixels, printable } from './font.js';

export const MAP_WIDTH = 640;
export const MAP_HEIGHT = 480;
const MARGIN = 24;
const JPEG_QUALITY = 85;

const COLORS = {
  background: [236, 239, 236],
  zone: [102, 187, 106],
  zoneOff: [197, 225, 165],
  zoneBorder: [46, 125, 50],
  obstacle: [189, 189, 189],
  obstacleBorder: [117, 117, 117],
  mower: [229, 57, 53],
  mowerRing: [255, 255, 255],
  mowerEdge: [66, 66, 66],
  text: [33, 33, 33],
  halo: [255, 255, 255],
};

class Canvas {
  constructor(width, height, color) {
    this.width = width;
    this.height = height;
    this.data = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      this.data.set([...color, 255], i * 4);
    }
  }

  pixel(x, y, color) {
    const px = Math.round(x);
    const py = Math.round(y);
    if (px < 0 || py < 0 || px >= this.width || py >= this.height) {
      return;
    }
    this.data.set(color, (py * this.width + px) * 4);
  }

  /** Fill a polygon (even-odd rule), scanline by scanline. */
  fillPolygon(points, color) {
    if (points.length < 3) {
      return;
    }
    const ys = points.map((p) => p[1]);
    const top = Math.max(0, Math.floor(Math.min(...ys)));
    const bottom = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    for (let y = top; y <= bottom; y++) {
      const scan = y + 0.5;
      const crossings = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[(i + 1) % points.length];
        if (y1 <= scan !== y2 <= scan) {
          crossings.push(x1 + ((scan - y1) * (x2 - x1)) / (y2 - y1));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const from = Math.max(0, Math.ceil(crossings[i] - 0.5));
        const to = Math.min(this.width - 1, Math.floor(crossings[i + 1] - 0.5));
        for (let x = from; x <= to; x++) {
          this.data.set(color, (y * this.width + x) * 4);
        }
      }
    }
  }

  fillCircle(cx, cy, radius, color) {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) {
          this.pixel(x, y, color);
        }
      }
    }
  }

  /** Outline of a closed polygon, `width` pixels wide. */
  strokePolygon(points, color, width = 2) {
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        this.fillCircle(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, width / 2, color);
      }
    }
  }

  /** Text centered on (cx, cy), each font pixel drawn `size` x `size`, with a halo. */
  text(value, cx, cy, size = 2) {
    const text = printable(value);
    const advance = (GLYPH_WIDTH + 1) * size;
    const width = text.length * advance - size;
    let left = Math.round(cx - width / 2);
    // Keep the label inside the image.
    left = Math.max(2, Math.min(this.width - width - 2, left));
    const top = Math.round(cy - (GLYPH_HEIGHT * size) / 2);
    for (const [color, offsets] of [
      [COLORS.halo, [-1, 0, 1]],
      [COLORS.text, [0]],
    ]) {
      [...text].forEach((char, i) => {
        for (const [gx, gy] of glyphPixels(char)) {
          for (const dx of offsets) {
            for (const dy of offsets) {
              for (let sx = 0; sx < size; sx++) {
                for (let sy = 0; sy < size; sy++) {
                  this.pixel(
                    left + i * advance + gx * size + sx + dx,
                    top + gy * size + sy + dy,
                    color,
                  );
                }
              }
            }
          }
        }
      });
    }
  }

  toJpeg() {
    return jpeg.encode({ data: this.data, width: this.width, height: this.height }, JPEG_QUALITY)
      .data;
  }
}

/** Center of a polygon (area-weighted; the mean of the points for a flat one). */
function centroid(points) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(area) < 1e-6) {
    const n = points.length;
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * area), cy / (3 * area)];
}

/**
 * Draw the map of a mower as a JPEG.
 * @param {{ zones?: Array<{ name: string, points: Array<{x: number, y: number}>, selected?: boolean }>,
 *   obstacles?: Array<Array<{x: number, y: number}>>, mower?: { x: number, y: number } | null,
 *   message?: string, width?: number, height?: number }} map
 * @returns {Buffer} JPEG image
 */
export function renderMap({
  zones = [],
  obstacles = [],
  mower = null,
  message = 'Map not read yet',
  width = MAP_WIDTH,
  height = MAP_HEIGHT,
}) {
  const canvas = new Canvas(width, height, COLORS.background);
  const drawn = zones.filter((z) => z.points?.length >= 3);
  const all = [...drawn.flatMap((z) => z.points), ...obstacles.flat(), ...(mower ? [mower] : [])];
  if (drawn.length === 0 || all.length === 0) {
    canvas.text(message, width / 2, height / 2);
    return canvas.toJpeg();
  }

  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const [minX, maxX, minY, maxY] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const scale = Math.min(
    (width - 2 * MARGIN) / Math.max(maxX - minX, 1),
    (height - 2 * MARGIN) / Math.max(maxY - minY, 1),
  );
  // Centered, north (y) up.
  const offsetX = (width - (maxX - minX) * scale) / 2;
  const offsetY = (height - (maxY - minY) * scale) / 2;
  const screen = (p) => [offsetX + (p.x - minX) * scale, offsetY + (maxY - p.y) * scale];

  const zoneShapes = drawn.map((z) => ({ ...z, shape: z.points.map(screen) }));
  for (const zone of zoneShapes) {
    canvas.fillPolygon(zone.shape, zone.selected === false ? COLORS.zoneOff : COLORS.zone);
  }
  for (const zone of zoneShapes) {
    canvas.strokePolygon(zone.shape, COLORS.zoneBorder);
  }
  for (const obstacle of obstacles.filter((o) => o.length >= 3)) {
    const shape = obstacle.map(screen);
    canvas.fillPolygon(shape, COLORS.obstacle);
    canvas.strokePolygon(shape, COLORS.obstacleBorder);
  }
  for (const zone of zoneShapes) {
    const [cx, cy] = centroid(zone.shape);
    canvas.text(zone.name, cx, cy);
  }
  if (mower) {
    const [mx, my] = screen(mower);
    canvas.fillCircle(mx, my, 10, COLORS.mowerEdge);
    canvas.fillCircle(mx, my, 9, COLORS.mowerRing);
    canvas.fillCircle(mx, my, 7, COLORS.mower);
  }
  return canvas.toJpeg();
}

/** JPEG as Gladys takes it (publishCameraImage / onGetImage). */
export function toCameraImage(jpegBuffer) {
  return `image/jpg;base64,${jpegBuffer.toString('base64')}`;
}
