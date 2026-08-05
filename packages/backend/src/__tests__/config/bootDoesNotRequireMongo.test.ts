/**
 * `validateEnvironment` must never demand `MONGODB_URI` again.
 *
 * The web service loads no Mongo — zero of the modules under `dist/` that
 * require `mongoose`/`mongodb` are reachable from `dist/server.js` — yet
 * `server.ts` called this function and it refused to boot without the variable.
 * That is the shape this file exists to stop coming back: a required-variable
 * list outliving the dependency it was written for, where the symptom is a
 * refusal to start rather than anything a type or a build can see.
 *
 * ## Why the second case is the load-bearing one
 *
 * "It does not throw" is satisfied by a `validateEnvironment` that does nothing
 * at all, so on its own it cannot tell a fixed validator from a broken one. The
 * production case supplies the floor: it deliberately withholds a DIFFERENT
 * required variable, asserts the error names THAT one, and only then asserts
 * `MONGODB_URI` is absent from the same message. A validator that stopped
 * collecting would fail the first assertion before it could pass the second.
 *
 * Mutation-tested both ways: restoring `if (!config.mongoUri)
 * missing.push('MONGODB_URI')` turns both cases red, and emptying the `missing`
 * list turns the production case red.
 *
 * `src/config/index.ts` snapshots `process.env` at MODULE scope
 * (`const environment = parseRuntimeEnvironment(process.env)`), so each case has
 * to set the environment BEFORE importing it and `vi.resetModules()` between
 * cases. Importing it once and mutating `process.env` afterwards would measure
 * the snapshot taken by whichever case ran first.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Enough of a production environment to reach the checks under test.
 *
 * The two secrets carry real length because the zod schema enforces a 32-char
 * minimum on them; a short placeholder fails at `parseRuntimeEnvironment`, which
 * is BEFORE `validateEnvironment` ever runs — so the case would go red for a
 * reason that has nothing to do with what it asserts.
 */
const PRODUCTION_BASELINE = {
  NODE_ENV: 'production',
  MENTION_PUBLIC_API_URL: 'https://api.mention.earth',
  MENTION_MCP_JWT_SECRET: 'mcp-jwt-secret-for-this-test-0123456789',
  IP_HASH_SALT: 'ip-hash-salt-for-this-test-0123456789',
} as const;

const originalEnv = { ...process.env };

async function loadValidator(
  overrides: Record<string, string | undefined>,
): Promise<() => void> {
  vi.resetModules();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const { validateEnvironment } = await import('../../config');
  return validateEnvironment;
}

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  vi.resetModules();
});

describe('validateEnvironment', () => {
  it('boots without MONGODB_URI', async () => {
    const validateEnvironment = await loadValidator({
      NODE_ENV: 'test',
      MONGODB_URI: undefined,
    });
    expect(() => validateEnvironment()).not.toThrow();
  });

  it('never names MONGODB_URI, even while reporting a variable that IS required', async () => {
    const validateEnvironment = await loadValidator({
      ...PRODUCTION_BASELINE,
      FRONTEND_URL: undefined,
      MONGODB_URI: undefined,
    });

    let message = '';
    try {
      validateEnvironment();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // The floor: prove the validator is still collecting before reading the
    // absence of anything from its output.
    expect(message).toContain('FRONTEND_URL');
    expect(message).not.toContain('MONGODB_URI');
  });

  it('does not name MONGODB_URI when it IS set either', async () => {
    // The variable still reaches the process on a deployment that has not
    // dropped it yet, and it must be as inert present as absent — otherwise the
    // two cases above would pass on a validator that merely inverted the check.
    const validateEnvironment = await loadValidator({
      ...PRODUCTION_BASELINE,
      FRONTEND_URL: undefined,
      MONGODB_URI: 'mongodb://127.0.0.1:27017/mention',
    });

    let message = '';
    try {
      validateEnvironment();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('FRONTEND_URL');
    expect(message).not.toContain('MONGODB_URI');
  });
});
