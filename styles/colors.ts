function lightenColor(hex: string, percent: number): string {
  const num = parseInt(hex.slice(1), 16);
  const amt = Math.round(2.55 * percent);
  const R = (num >> 16) + amt;
  const G = (num >> 8 & 0x00FF) + amt;
  const B = (num & 0x0000FF) + amt;
  return `#${(0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1).toUpperCase()}`;
}

const primaryColor = '#ff0000';

export const colors = {
  primaryColor,
  primaryLight: '#ffffff',
  primaryLight_1: '#DDF3F5',
  COLOR_BLACK: '#000',
  COLOR_BLACK_LIGHT_1: '#111111',
  COLOR_BLACK_LIGHT_2: '#1e1e1e',
  COLOR_BLACK_LIGHT_3: '#3c3c3c',
  COLOR_BLACK_LIGHT_4: '#5e5e5e',
  COLOR_BLACK_LIGHT_5: '#949494',
  COLOR_BLACK_LIGHT_6: '#ededed',
  COLOR_BACKGROUND: lightenColor(primaryColor, 90),
}