export type RGB = [number, number, number];

export interface SceneTheme {
  background: RGB;
  palette: RGB[];
}

const DARK_PALETTE: RGB[] = [
  [0.26, 0.59, 0.98],
  [0.96, 0.62, 0.10],
  [0.20, 0.73, 0.40],
  [0.91, 0.30, 0.24],
  [0.61, 0.35, 0.71],
  [0.10, 0.74, 0.74],
  [0.85, 0.65, 0.13],
  [0.55, 0.55, 0.60],
];

const LIGHT_PALETTE: RGB[] = [
  [0.15, 0.45, 0.80],
  [0.80, 0.45, 0.05],
  [0.10, 0.55, 0.25],
  [0.75, 0.15, 0.10],
  [0.45, 0.20, 0.58],
  [0.05, 0.55, 0.55],
  [0.65, 0.48, 0.05],
  [0.38, 0.38, 0.42],
];

const SCIENTIFIC_PALETTE: RGB[] = [
  [0.40, 0.76, 0.65],
  [0.99, 0.55, 0.38],
  [0.55, 0.63, 0.80],
  [0.91, 0.54, 0.76],
  [0.65, 0.85, 0.33],
  [1.00, 0.85, 0.18],
  [0.90, 0.77, 0.58],
  [0.70, 0.70, 0.70],
];

const NAMED_THEMES: Record<string, SceneTheme> = {
  dark:       { background: [0.118, 0.118, 0.118], palette: DARK_PALETTE },
  light:      { background: [0.941, 0.941, 0.941], palette: LIGHT_PALETTE },
  scientific: { background: [1.0,   1.0,   1.0  ], palette: SCIENTIFIC_PALETTE },
};

/** Returns the palette for `name`. Falls back to dark for unknown names including "auto". */
export function getThemePalette(name: string): RGB[] {
  return (NAMED_THEMES[name] ?? NAMED_THEMES.dark).palette;
}

/**
 * Returns the background RGB for `name`, or null for "auto".
 * Callers must call readThemeBackground() themselves when null is returned.
 */
export function getThemeBackground(name: string): RGB | null {
  if (name === "auto") return null;
  return (NAMED_THEMES[name] ?? NAMED_THEMES.dark).background;
}
