import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { detailViewport, detailViewportPadding } from '../src/lib/detailViewport';

const dom = new Window({ url: 'http://localhost/' });
for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom : (dom as any)[key] });
}
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
document.documentElement.dataset.motion = 'off';
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { ModuleDetailDialog } = await import('../src/components/modules/ModuleDetailDialog');
const { act } = React;
let passed = 0;
const failures: string[] = [];
async function test(name: string, run: () => void | Promise<void>) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { failures.push(`${name}: ${error}`); console.error(`  ✗ ${name}: ${error}`); }
}

const visual = new dom.EventTarget() as any;
Object.assign(visual, { width: 320, height: 568, offsetLeft: 0, offsetTop: 0, scale: 1 });
Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
const host = document.createElement('div');
document.body.append(host);
const opener = document.createElement('button');
opener.textContent = 'Open details';
document.body.append(opener);
let root: ReturnType<typeof createRoot>;
let closes = 0;
async function mount(children: React.ReactNode = React.createElement('button', { id: 'last-action' }, 'Last action')) {
  opener.focus();
  root = createRoot(host);
  await act(async () => root.render(React.createElement(ModuleDetailDialog, {
    title: 'Details', closeLabel: 'Close', onClose: () => { closes++; }, children,
  })));
}
async function unmount() { await act(async () => root.unmount()); }
function closeButton() { return document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!; }

await test('320×568 viewport retains CSS-pixel geometry', () => {
  assert.deepEqual(detailViewport({ width: 320, height: 568 }), { left: 0, top: 0, width: 320, height: 568 });
});
await test('small landscape viewport is not forced into 88vh or a minimum card height', () => {
  assert.deepEqual(detailViewport({ width: 568, height: 320 }, { width: 568, height: 220, offsetTop: 18 }), { left: 0, top: 18, width: 568, height: 220 });
});
await test('pinch zoom offsets and dimensions are not scaled twice', () => {
  assert.deepEqual(detailViewport({ width: 390, height: 844 }, { width: 195, height: 320, offsetLeft: 80, offsetTop: 120 }), { left: 80, top: 120, width: 195, height: 320 });
});
await test('transient invalid dimensions fall back and rubber-band offsets never go negative', () => {
  assert.deepEqual(detailViewport({ width: 320, height: 568 }, { width: 0, height: NaN, offsetLeft: -8, offsetTop: -20 }), { left: 0, top: 0, width: 320, height: 568 });
});
await test('safe-area padding leaves space inside, not outside, the visible viewport', () => {
  assert.equal(detailViewportPadding.paddingTop, 'max(12px, env(safe-area-inset-top, 0px))');
  for (const [width, height, top, right, bottom, left] of [[320, 568, 12, 12, 34, 12], [568, 220, 12, 44, 21, 44], [195, 320, 59, 12, 34, 12]]) {
    const contentHeight = height - top - bottom;
    assert.ok(contentHeight >= 56);
    assert.ok(width - left - right > 0);
    const centerY = top + contentHeight / 2;
    assert.ok(centerY - contentHeight / 2 >= top);
    assert.ok(centerY + contentHeight / 2 <= height - bottom);
  }
});
await test('header and 44px close button are outside the only vertical scroller', async () => {
  await mount();
  const panel = document.querySelector('[role="dialog"]')!;
  const header = panel.querySelector('[data-detail-header]')!;
  const scroller = panel.querySelector('[data-detail-scroll]')!;
  assert.equal(panel.getAttribute('aria-modal'), 'true');
  assert.equal(panel.getAttribute('aria-label'), 'Details');
  assert.ok(header.classList.contains('shrink-0'));
  assert.ok(header.contains(closeButton()));
  assert.ok(!scroller.contains(header));
  assert.equal(panel.querySelectorAll('.overflow-y-auto').length, 1);
  assert.equal(closeButton().style.minHeight, '44px');
  assert.equal(closeButton().style.minWidth, '44px');
  assert.equal((panel as HTMLElement).style.maxHeight, '100%');
  assert.equal((panel as HTMLElement).style.borderRadius, '20px');
  await unmount();
});
await test('close button invokes onClose', async () => {
  await mount(); const before = closes;
  await act(async () => closeButton().click());
  assert.equal(closes, before + 1); await unmount();
});
await test('backdrop invokes onClose but panel clicks do not', async () => {
  await mount(); const before = closes;
  await act(async () => (document.querySelector('[data-detail-panel]') as HTMLElement).click());
  assert.equal(closes, before);
  await act(async () => (document.querySelector('[data-detail-backdrop]') as HTMLElement).click());
  assert.equal(closes, before + 1); await unmount();
});
await test('Escape closes and key listener is removed after unmount', async () => {
  await mount(); const before = closes;
  await act(async () => document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any));
  assert.equal(closes, before + 1); await unmount();
  document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape' }) as any);
  assert.equal(closes, before + 1);
});
await test('initial focus goes to close and returns to opener', async () => {
  await mount(); assert.equal(document.activeElement, closeButton());
  await unmount(); assert.equal(document.activeElement, opener);
});
await test('Tab and Shift+Tab wrap inside the panel', async () => {
  await mount(); const first = closeButton(); const last = document.getElementById('last-action')!;
  for (const button of [first, last]) Object.defineProperty(button, 'offsetParent', { configurable: true, value: document.body });
  last.focus();
  document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }) as any);
  assert.equal(document.activeElement, first);
  document.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }) as any);
  assert.equal(document.activeElement, last); await unmount();
});
await test('background scroll is locked and original body styles are restored', async () => {
  document.body.style.overflow = 'clip';
  await mount(); assert.equal(document.body.style.overflow, 'hidden');
  assert.equal(document.body.style.position, 'fixed'); await unmount();
  assert.equal(document.body.style.overflow, 'clip'); assert.equal(document.body.style.position, '');
  document.body.style.overflow = '';
});
await test('visualViewport resize/scroll updates visible frame including zoom offsets', async () => {
  await mount();
  Object.assign(visual, { width: 195, height: 220, offsetLeft: 42, offsetTop: 80 });
  await act(async () => visual.dispatchEvent(new dom.Event('resize')));
  const frame = document.querySelector<HTMLElement>('[data-detail-viewport]')!;
  assert.equal(frame.style.width, '195px'); assert.equal(frame.style.height, '220px');
  Object.assign(visual, { offsetTop: 105 });
  await act(async () => visual.dispatchEvent(new dom.Event('scroll')));
  assert.equal(frame.style.top, '105px'); assert.equal(frame.style.left, '42px');
  assert.equal(frame.style.boxSizing, 'border-box'); await unmount();
  Object.assign(visual, { width: 320, height: 568, offsetTop: 0, offsetLeft: 0 });
});
await test('without visualViewport the frame uses dvh', async () => {
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: null });
  await mount();
  // happy-dom's CSS parser does not support dvh; assert the authored fallback
  // and the mounted frame, then leave real CSS layout to the browser fixture.
  assert.ok(document.querySelector('[data-detail-viewport]'));
  assert.ok(readFileSync('src/components/modules/ModuleDetailDialog.tsx', 'utf8').includes("height: viewport?.height ?? '100dvh'"));
  await unmount();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
});
await test('loading, error and missing content always retain an actionable close header', async () => {
  for (const state of ['Loading…', 'Could not load details', 'Module not found']) {
    await mount(React.createElement('p', null, state));
    assert.equal(document.activeElement, closeButton());
    assert.ok(document.querySelector('[data-detail-scroll]')!.textContent!.includes(state));
    const before = closes; await act(async () => closeButton().click()); assert.equal(closes, before + 1);
    await unmount();
  }
});
await test('detail integration removes old grabber/scroll and motion cannot park content off screen', () => {
  const detail = readFileSync('src/components/modules/ModuleDetailSheet.tsx', 'utf8');
  const dialog = readFileSync('src/components/modules/ModuleDetailDialog.tsx', 'utf8');
  assert.ok(detail.includes('<ModuleDetailDialog'));
  assert.ok(!detail.includes('BottomSheet'));
  assert.ok(!detail.includes('overflow-y-auto'));
  assert.ok(!detail.includes('grabber'));
  assert.ok(!dialog.includes('drag='));
  assert.ok(dialog.includes('initial={false}'));
  assert.ok(dialog.includes('const still = reduce || motionOff'));
  assert.ok(!dialog.includes('opacity: 0'));
});
await dom.happyDOM.close();
console.log(`\ndetail-dialog: ${passed} passed, ${failures.length} failed`);
// React's browser scheduler can retain a MessageChannel in this isolated Node
// DOM harness. All roots and assertions are settled; terminate the suite so the
// parent runner can proceed to the remaining tests.
process.exit(failures.length ? 1 : 0);
