/**
 * Global test setup for the backend package.
 *
 * Mocks heavy external dependencies so unit tests run fast without
 * requiring a live MongoDB, Redis, or Oxy API connection.
 */
import { vi } from 'vitest';

// --- Mongoose / MongoDB ---
// Prevent any module from opening a real database connection during tests.
vi.mock('mongoose', async () => {
  const actual = await vi.importActual<typeof import('mongoose')>('mongoose');
  return {
    ...actual,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
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
