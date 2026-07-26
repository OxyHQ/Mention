export function initializeWebTelemetry(): () => void {
  return () => undefined;
}

export function recordWebNavigation(_pathname: string): void {
  // Browser-only telemetry.
}
