/**
 * Resolve a bottom anchor from Bloom's occupied-edge registry.
 *
 * A positive occupied edge is already safe-area-aware, so the device inset must
 * never be added to it. Native falls back to its safe area only when no surface
 * claims the edge; web has no native home-indicator fallback.
 */
export function resolveBottomEdgeInset(
  occupiedBottomEdge: number,
  safeAreaBottom: number,
  isWeb: boolean,
): number {
  if (occupiedBottomEdge > 0) return occupiedBottomEdge;
  return isWeb ? 0 : safeAreaBottom;
}
