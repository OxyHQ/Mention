export type BootMilestone =
  | 'fonts-ready'
  | 'cache-owner-established'
  | 'auth-resolved'
  | 'route-mounted'
  | 'primary-request-start'
  | 'content-ready';

export function recordBootMilestone(_name: BootMilestone): void {
  // Browser-only telemetry.
}

export function initializeWebTelemetry(): () => void {
  return () => undefined;
}

export function recordWebNavigation(_pathname: string): void {
  // Browser-only telemetry.
}
