/** Tiny class-name joiner — avoids pulling in clsx/tailwind-merge. */
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
