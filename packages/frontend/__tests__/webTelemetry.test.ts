import {
  __webTelemetryForTests,
  initializeWebTelemetry,
  recordWebNavigation,
} from '@/lib/webTelemetry.web';

jest.mock('web-vitals', () => ({
  onCLS: jest.fn(),
  onINP: jest.fn(),
  onLCP: jest.fn(),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('web telemetry cardinality guards', () => {
  beforeEach(() => {
    __webTelemetryForTests.reset();
    Object.defineProperty(window, 'addEventListener', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(window, 'removeEventListener', {
      configurable: true,
      value: jest.fn(),
    });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/' },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
    __webTelemetryForTests.reset();
  });

  it('removes identifiers from route labels', () => {
    expect(__webTelemetryForTests.routeBucket('/p/507f1f77bcf86cd799439011'))
      .toBe('/post');
    expect(__webTelemetryForTests.routeBucket('/@alice@remote.example'))
      .toBe('/profile');
    expect(__webTelemetryForTests.routeBucket('/unknown/private-value'))
      .toBe('/other');
  });

  it('maps browser-specific history restores to the bounded vocabulary', () => {
    expect(__webTelemetryForTests.normalizeNavigation('back-forward-cache'))
      .toBe('back-forward');
    expect(__webTelemetryForTests.normalizeNavigation('unexpected'))
      .toBe('other');
  });

  it('stays inert when the anonymous capability probe does not opt in', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: { webTelemetry: false } }),
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    const addListener = window.addEventListener as jest.Mock;

    const cleanup = initializeWebTelemetry();
    recordWebNavigation('/p/private-post-id');
    await flushPromises();
    cleanup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      __webTelemetryForTests.capabilitiesEndpoint,
      expect.objectContaining({
        method: 'GET',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization');
    expect(addListener.mock.calls.some(([event]) => event === 'error')).toBe(false);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('registers and removes listeners only after an explicit capability', async () => {
    jest.useFakeTimers();
    const fetchMock = jest.fn().mockImplementation(
      async (_url: string, options?: RequestInit) => (
        options?.method === 'GET'
          ? {
              ok: true,
              json: async () => ({ capabilities: { webTelemetry: true } }),
            }
          : { ok: true, json: async () => ({}) }
      ),
    );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    const addListener = window.addEventListener as jest.Mock;
    const removeListener = window.removeEventListener as jest.Mock;

    const cleanup = initializeWebTelemetry();
    await flushPromises();

    expect(addListener.mock.calls.some(([event]) => event === 'error')).toBe(true);
    expect(addListener.mock.calls.some(([event]) => event === 'pagehide')).toBe(true);

    recordWebNavigation('/search/private-query');
    jest.advanceTimersByTime(1_000);
    await flushPromises();
    const postCall = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(postCall?.[1]?.headers).toEqual({
      'Content-Type': 'text/plain;charset=UTF-8',
    });

    cleanup();
    expect(removeListener.mock.calls.some(([event]) => event === 'error')).toBe(true);
    expect(removeListener.mock.calls.some(([event]) => event === 'pagehide')).toBe(true);
  });

  it('aborts an in-flight probe without registering listeners or posting', () => {
    let probeSignal: AbortSignal | undefined;
    const fetchMock = jest.fn().mockImplementation(
      (_url: string, options?: RequestInit) => {
        probeSignal = options?.signal ?? undefined;
        return new Promise(() => undefined);
      },
    );
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    const addListener = window.addEventListener as jest.Mock;

    const cleanup = initializeWebTelemetry();
    cleanup();

    expect(probeSignal?.aborted).toBe(true);
    expect(addListener.mock.calls.some(([event]) => event === 'error')).toBe(false);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('single-flights initialization and reuses the cached capability', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ capabilities: { webTelemetry: false } }),
    });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });

    const cleanup = initializeWebTelemetry();
    const duplicateCleanup = initializeWebTelemetry();
    await flushPromises();
    duplicateCleanup();
    cleanup();

    const remountCleanup = initializeWebTelemetry();
    await flushPromises();
    remountCleanup();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
