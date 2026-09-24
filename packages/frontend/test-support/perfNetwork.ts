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
