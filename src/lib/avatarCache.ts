/**
 * GitHub avatar cache.
 *
 * A plain <img> flashes empty while each avatar downloads — bad when a sheet
 * renders a list of 23 repos at once and every avatar pops in late. This
 * module keeps the decoded URLs in an in-memory set so a re-render (opening a
 * detail, switching pages) paints instantly; the browser cache handles the
 * actual HTTP reuse.
 *
 * Avatars are stable per-user, so a page-lifetime cache is correct.
 */

const seen = new Set<string>();

/** Marks a URL as already loaded once its image decoded. */
export function markAvatarLoaded(url: string): void {
  seen.add(url);
}

export function isAvatarKnown(url: string): boolean {
  return seen.has(url);
}

/**
 * Pre-warms avatars for a batch of owners. Fires the downloads once; later
 * renders hit the browser cache and never flash.
 */
export function warmAvatars(owners: string[], size = 76): void {
  if (typeof window === 'undefined') return;
  for (const owner of owners) {
    const url = `https://github.com/${owner}.png?size=${size}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const img = new Image();
    img.src = url;
  }
}
