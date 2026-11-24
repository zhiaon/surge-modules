/**
 * First entry vs. revisit, for entrance motion.
 *
 * Every page remounts when the reader leaves and comes back from the bottom
 * tab bar. Replaying the entrance animation there is not just cosmetic: content
 * is put back at `opacity: 0` for a frame or two, and anything that scrolled
 * above the viewport can stay hidden because IntersectionObserver never fires
 * for it. Entrance motion is a first-impression device, so it plays for the
 * first page of a document load and nothing else.
 *
 * Read during render, set from an effect: every component in the first page's
 * first commit is rendered before any effect runs, so all of them still see
 * `true` and the initial entry keeps its animation.
 */

let documentHasPainted = false;

export function isFirstEntry(): boolean {
  return !documentHasPainted;
}

export function markPainted(): void {
  documentHasPainted = true;
}

/** Test/HMR helper. */
export function resetEntrySession(): void {
  documentHasPainted = false;
}
