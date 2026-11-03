/** Explicit local payer capability; never an application/server credential. */
export interface LocalProviderTestBinding {
  apiUrl: string;
  intentId: string;
  clientSecret: string;
}
export function localProviderTestBinding(
  href: string,
  enabled: boolean,
): LocalProviderTestBinding | null {
  if (!enabled) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const intentId = fragment.get('peable_test_intent');
  const clientSecret = fragment.get('peable_test_secret');
  if (
    !intentId ||
    !/^pi_[A-Za-z0-9_-]+$/.test(intentId) ||
    !clientSecret ||
    clientSecret.length > 512
  )
    return null;
  return { apiUrl: 'http://127.0.0.1:4310', intentId, clientSecret };
}
export function isTestProviderAction(action: { kind: string; publishableKey?: string }): boolean {
  return action.kind === 'client_secret' && !!action.publishableKey?.startsWith('pk_test_');
}
export function localProviderPhase(status: string): 'entry' | 'pending' | 'success' | 'failure' {
  if (status === 'settled') return 'success';
  if (['expired', 'rejected', 'underpaid'].includes(status)) return 'failure';
  if (['created', 'requires_action', 'failed'].includes(status)) return 'entry';
  return 'pending';
}

/** Local harness only: credentials remain in component memory and errors never echo response bodies. */
export async function createLocalProviderTestBinding(
  operationKey: string,
  href: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<LocalProviderTestBinding> {
  const url = new URL(href);
  if (!enabled || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '8110')
    throw new Error('Local test checkout is unavailable.');
  const response = await fetch('http://127.0.0.1:4310/__local/checkout-test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Peable-Local-Test': '1',
      'Idempotency-Key': operationKey,
    },
    body: '{}',
    signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Local test checkout is unavailable.');
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== 'object' ||
    !('intentId' in data) ||
    !('clientSecret' in data) ||
    typeof data.intentId !== 'string' ||
    !/^pi_[A-Za-z0-9_-]+$/.test(data.intentId) ||
    typeof data.clientSecret !== 'string' ||
    !data.clientSecret ||
    data.clientSecret.length > 512
  )
    throw new Error('Local test checkout is unavailable.');
  return {
    apiUrl: 'http://127.0.0.1:4310',
    intentId: data.intentId,
    clientSecret: data.clientSecret,
  };
}
