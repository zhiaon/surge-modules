import assert from 'node:assert';
import { jumpAvailability } from '../src/components/layout/ScrollJumps';

/**
 * The two scroll buttons only exist to spare a long drag; a page that already
 * fits, or a position where the click would do nothing, must not show one.
 * These cases pin the boundaries so a later tweak cannot resurrect a dead
 * button (the classic "tap does nothing" bug).
 */

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg}`);
  }
}

const VIEWPORT = 800;
/** A page tall enough that both directions are meaningful. */
const TALL = 4000;
/** Total scrollable distance for TALL at VIEWPORT. */
const TALL_MAX = TALL - VIEWPORT; // 3200

test('a page that fits the viewport shows neither button', () => {
  assert.deepEqual(jumpAvailability(0, VIEWPORT, VIEWPORT), { canUp: false, canDown: false });
  assert.deepEqual(jumpAvailability(0, 700, VIEWPORT), { canUp: false, canDown: false });
});

test('at the very top of a long page only "jump down" is offered', () => {
  assert.deepEqual(jumpAvailability(0, TALL, VIEWPORT), { canUp: false, canDown: true });
});

test('just below the threshold the top button appears', () => {
  assert.deepEqual(jumpAvailability(239, TALL, VIEWPORT), { canUp: false, canDown: true });
  assert.deepEqual(jumpAvailability(241, TALL, VIEWPORT), { canUp: true, canDown: true });
});

test('mid page both buttons are usable', () => {
  assert.deepEqual(jumpAvailability(TALL_MAX / 2, TALL, VIEWPORT), { canUp: true, canDown: true });
});

test('the bottom edge hides "jump down" but keeps "back to top"', () => {
  assert.deepEqual(jumpAvailability(TALL_MAX, TALL, VIEWPORT), { canUp: true, canDown: false });
});

test('sub-pixel leftovers at the bottom still count as the bottom', () => {
  // iOS reports fractional scroll heights under pinch-zoom; without the slack
  // the button would stay visible on a page that cannot scroll any further.
  assert.equal(jumpAvailability(TALL_MAX - 1, TALL, VIEWPORT).canDown, false);
  assert.equal(jumpAvailability(TALL_MAX - 4, TALL, VIEWPORT).canDown, false);
  assert.equal(jumpAvailability(TALL_MAX - 8, TALL, VIEWPORT).canDown, true);
});

test('a short-but-scrollable page never offers a downward jump', () => {
  // Only 100px of travel: scrolling down is not worth a button, but once the
  // reader is past 240px the upward one is.
  assert.equal(jumpAvailability(0, VIEWPORT + 100, VIEWPORT).canDown, false);
  assert.equal(jumpAvailability(50, VIEWPORT + 100, VIEWPORT).canUp, false);
});

console.log(`\nscroll-jumps: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
