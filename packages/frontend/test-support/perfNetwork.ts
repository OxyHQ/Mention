// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Request log for the feed row-cost harness; see `perfSetup.ts`. */
export interface RecordedRequest {
  method: string;
  endpoint: string;
}

export const perfNetwork: RecordedRequest[] = [];

export function recordRequest(method: string, endpoint: string): void {
  perfNetwork.push({ method, endpoint });
}

export function takeRequests(): RecordedRequest[] {
  return perfNetwork.splice(0, perfNetwork.length);
}
