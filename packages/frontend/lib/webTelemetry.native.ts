// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
