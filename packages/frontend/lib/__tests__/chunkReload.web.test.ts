import { isChunkLoadError } from '../chunkReload.web';

jest.mock('@oxy.so/core/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
}));

describe('isChunkLoadError', () => {
  it.each([
    ['a Metro async-require failure', Object.assign(new Error('x'), { name: 'AsyncRequireError' })],
    ['a webpack-style chunk failure', new Error('Loading chunk 12 failed.')],
    [
      'a dynamic import failure',
      new TypeError('Failed to fetch dynamically imported module: https://x/y.js'),
    ],
    // The 2026-09-30 outage: the shared chunk 404ed, so the first module that
    // needed something from it threw this.
    ['a module from a chunk that never loaded', new Error('Requiring unknown module "908".')],
  ])('recognises %s', (_label, error) => {
    expect(isChunkLoadError(error)).toBe(true);
  });

  it.each([
    ['an ordinary error', new Error('Network request failed')],
    ['nothing', null],
    ['a string that is not a chunk failure', 'boom'],
  ])('ignores %s', (_label, error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});

describe('chunk error recovery', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  function register() {
    jest.resetModules();
    const listeners: Record<string, (event: unknown) => void> = {};
    const reload = jest.fn();
    const storage = new Map<string, string>();
    const fakeWindow = {
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        listeners[type] = listener;
      },
      location: { reload },
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
    const { registerChunkErrorRecovery } = require('../chunkReload.web');
    registerChunkErrorRecovery();
    return { listeners, reload };
  }

  it('leaves a handled script load failure to its caller', () => {
    const { listeners, reload } = register();
    listeners.error({ target: { src: '/_expo/static/js/web/account.js' } });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads once for an unhandled lazy chunk rejection', () => {
    const { listeners, reload } = register();
    const reason = Object.assign(new Error('offline'), { name: 'AsyncRequireError' });
    listeners.unhandledrejection({ reason });
    listeners.unhandledrejection({ reason });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads for an uncaught missing shared module', () => {
    const { listeners, reload } = register();
    listeners.error({ error: new Error('Requiring unknown module "908".') });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
