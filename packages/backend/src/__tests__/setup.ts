/**
 * Global test setup for the backend package.
 *
 * Mocks heavy external dependencies so unit tests run fast without
 * requiring a live MongoDB, Redis, or Oxy API connection.
 */
import { vi } from 'vitest';

// --- Mongoose / MongoDB ---
// Prevent any module from opening a real database connection during tests.
//
// The DEFAULT export must be stubbed too, not just the named ones. Application
// code (models, one-shot scripts) reaches mongoose via `import mongoose from
// 'mongoose'`, and spreading `actual` re-exports the REAL Mongoose singleton as
// `default` — so `mongoose.connect()` bypassed this mock entirely and opened a
// socket to localhost:27017, stalling for the 30s server-selection timeout.
//
// The singleton is proxied rather than cloned: `Schema`, `model`, `Types` et al.
// are prototype methods that a spread would drop, and they must stay real.
vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');

  const connect = vi.fn().mockResolvedValue(undefined);
  const disconnect = vi.fn().mockResolvedValue(undefined);

  const mongooseSingleton = new Proxy(actual.default, {
    get(target, property) {
      if (property === 'connect') return connect;
      if (property === 'disconnect') return disconnect;
      return Reflect.get(target, property, target);
    },
  });

  return {
    ...actual,
    default: mongooseSingleton,
    connect,
    disconnect,
    connection: {
      ...actual.connection,
      readyState: 1,
    },
  };
});

// --- Redis ---
vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: false,
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  }),
}));

// --- Logger (suppress output during tests) ---
vi.mock('../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// --- Pino (direct imports) ---
vi.mock('pino', () => ({
  default: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  })),
}));
