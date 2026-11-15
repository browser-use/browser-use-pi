import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Page, mousePath } from '../dist/page.js';

afterEach(() => mock.restoreAll());

/** A page over a fake connection that records mouse events and reports the tab's visibility. */
function fakePage(visibility = 'visible') {
  const mouse = [];
  const connection = {
    timeoutMs: 1000,
    async send(method, params) {
      if (method === 'Runtime.evaluate') return { result: { value: [visibility, 1280, 800] } };
      if (method === 'Input.dispatchMouseEvent') mouse.push({ ...params });
      return {};
    },
  };
  return {
    page: Page.deferred(connection, async () => ({ targetId: 't', sessionId: 's' })),
    mouse,
  };
}

test('a mouse path curves inside the viewport and ends exactly on the target', () => {
  for (let i = 0; i < 200; i++) {
    const path = mousePath({ x: 5, y: 790 }, { x: 1234.5, y: 17.25 }, 1280, 800);
    assert.ok(path.length >= 10 && path.length <= 15);
    assert.deepEqual(path.at(-1), { x: 1234.5, y: 17.25 });
    assert.ok(path.every((p) => p.x >= 0 && p.x < 1280 && p.y >= 0 && p.y < 800));
  }
});

test('clickAt travels from the last pointer position, then presses and releases on the target', async () => {
  // Math.random() = 0.5 puts the Bezier control point on the midpoint: the path is the straight line.
  mock.method(Math, 'random', () => 0.5);
  const { page, mouse } = fakePage();
  await page.clickAt(100, 100);
  mouse.length = 0;
  await page.clickAt(700, 400);
  const moves = mouse.filter((e) => e.type === 'mouseMoved');
  assert.ok(moves.length >= 10, `${moves.length} moves`);
  for (const [i, { x, y }] of moves.entries()) {
    assert.ok(Math.abs((x - 100) * 300 - (y - 100) * 600) < 1e-6, `move ${i} is on the line`);
    assert.ok(x > (moves[i - 1]?.x ?? 100), `move ${i} advances from the last position`);
  }
  assert.deepEqual(
    mouse.slice(-3).map(({ type, x, y }) => [type, x, y]),
    [
      ['mouseMoved', 700, 400],
      ['mousePressed', 700, 400],
      ['mouseReleased', 700, 400],
    ],
  );
});

test('a raw mouse event moves the start of the next path', async () => {
  mock.method(Math, 'random', () => 0.5);
  const { page, mouse } = fakePage();
  await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 50, y: 60 });
  mouse.length = 0;
  await page.clickAt(150, 60);
  const first = mouse[0];
  assert.equal(first.y, 60);
  assert.ok(first.x > 50 && first.x < 60, `first move ${first.x} starts next to 50`);
});

test('a hidden tab gets one move, not a path', async () => {
  const { page, mouse } = fakePage('hidden');
  await page.clickAt(10, 20);
  assert.deepEqual(
    mouse.map(({ type, x, y }) => [type, x, y]),
    [
      ['mouseMoved', 10, 20],
      ['mousePressed', 10, 20],
      ['mouseReleased', 10, 20],
    ],
  );
});
