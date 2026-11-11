import {
  Blocks,
  Brush,
  Code2,
  Compass,
  EyeOff,
  Filter,
  Globe2,
  Layers,
  MonitorSmartphone,
  ShieldCheck,
  Sparkles,
  Terminal,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';

/**
 * Category icons are stored as stable string keys in the database
 * (`Category.icon`), so the DB never depends on a React component.
 */
export const categoryIcons: Record<string, LucideIcon> = {
  shield: ShieldCheck,
  filter: Filter,
  waypoints: Waypoints,
  code: Code2,
  sparkles: Sparkles,
  eyeoff: EyeOff,
  terminal: Terminal,
  layers: Layers,
  globe: Globe2,
  blocks: Blocks,
  brush: Brush,
  monitor: MonitorSmartphone,
};

export const fallbackCategoryIcon = Compass;

export function resolveCategoryIcon(key?: string): LucideIcon {
  if (!key) return fallbackCategoryIcon;
  return categoryIcons[key] ?? fallbackCategoryIcon;
}
