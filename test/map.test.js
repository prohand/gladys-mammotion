import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { MAP_HEIGHT, MAP_WIDTH, renderMap, toCameraImage } from '../src/map/render.js';

const square = (x, y, size) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

// Color of a pixel of a decoded JPEG (approximate: JPEG is lossy).
function pixel(image, x, y) {
  const i = (Math.round(y) * image.width + Math.round(x)) * 4;
  return [...image.data.subarray(i, i + 3)];
}

const near = (color, expected) => color.every((c, i) => Math.abs(c - expected[i]) < 40);

test('the map is a JPEG Gladys accepts, zones in green, the mower in red', () => {
  const buffer = renderMap({
    zones: [
      { name: 'Devant', points: square(0, 0, 10), selected: true },
      { name: 'Côté Sud', points: square(20, 0, 10), selected: false },
    ],
    obstacles: [square(6, 6, 2)],
    mower: { x: 2, y: 2 },
  });
  const image = toCameraImage(buffer);
  assert.match(image, /^image\/jpg;base64,/);
  assert.ok(buffer.length < 150 * 1024, `${buffer.length} bytes`);
  const decoded = jpeg.decode(buffer);
  assert.equal(decoded.width, MAP_WIDTH);
  assert.equal(decoded.height, MAP_HEIGHT);
  // 30 m wide map in 592 px: 19.7 px/m, centered vertically, north up.
  const scale = (MAP_WIDTH - 48) / 30;
  const top = (MAP_HEIGHT - 10 * scale) / 2;
  const at = (x, y) => pixel(decoded, 24 + x * scale, top + (10 - y) * scale);
  assert.ok(near(at(2, 2), [229, 57, 53]), 'mower');
  assert.ok(near(at(1, 8.5), [102, 187, 106]), 'zone of the next job');
  assert.ok(near(at(28, 9), [197, 225, 165]), 'other zone');
  assert.ok(near(at(7, 7), [189, 189, 189]), 'no-go zone');
  assert.ok(near(at(15, 5), [236, 239, 236]), 'background');
});

test('without a map, the image says so', () => {
  const decoded = jpeg.decode(renderMap({ message: 'Carte pas encore lue' }));
  assert.equal(decoded.width, MAP_WIDTH);
  // Some dark text in the middle of an empty background.
  let dark = 0;
  for (let x = 0; x < MAP_WIDTH; x++) {
    if (pixel(decoded, x, MAP_HEIGHT / 2).every((c) => c < 100)) dark++;
  }
  assert.ok(dark > 20);
});
