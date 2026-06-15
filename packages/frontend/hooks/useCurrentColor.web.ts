/**
 * Resolves the value an SVG icon should use for `currentColor`.
 *
 * On web the CSS cascade is intact: SVG `fill="currentColor"` /
 * `stroke="currentColor"` inherits the `color` of the nearest `text-*`
 * ancestor for free. So the literal `'currentColor'` keyword is exactly right
 * and we keep the working behaviour untouched. (The native variant reads the
 * resolved color from react-native-css since RN has no cascade.)
 */
export function useCurrentColor(): string {
  return 'currentColor';
}
