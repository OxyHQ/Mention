import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Can this process act as Mention" — the question three call sites used to ask
 * as "do I have the key pair".
 *
 * They stopped being the same question the day the ECS task role could prove it
 * (oxy ADR 0026). Left as three separate checks, removing the pair from the task
 * definition would have switched community notes off, switched inference off and
 * left the purge script refusing to start, each in a different file and each
 * reading like its own bug.
 */

async function load(environment: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  return (await import('../../runtime/serviceIdentity')).canAuthenticateAsService;
}

beforeEach(() => {
  vi.stubEnv('OXY_SERVICE_API_KEY', '');
  vi.stubEnv('OXY_SERVICE_API_SECRET', '');
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '');
  vi.stubEnv('AWS_CONTAINER_CREDENTIALS_FULL_URI', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('acting as Mention against Oxy', () => {
  it('says no in a checkout with neither an attestation nor a key pair', async () => {
    const canAuthenticateAsService = await load({});

    expect(canAuthenticateAsService()).toBe(false);
  });

  it('says yes on a task role alone, with no secret anywhere', async () => {
    // ECS sets this on every task and nothing else does, which is why it is the
    // honest test for "this process can prove what it is".
    const canAuthenticateAsService = await load({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
    });

    expect(canAuthenticateAsService()).toBe(true);
  });

  it('says yes on a service api key where there is no task role', async () => {
    const canAuthenticateAsService = await load({
      OXY_SERVICE_API_KEY: 'mention-key',
      OXY_SERVICE_API_SECRET: 'mention-secret',
    });

    expect(canAuthenticateAsService()).toBe(true);
  });

  it('never sees half a key pair, because config refuses one', async () => {
    // Worth pinning rather than asserting `false` here: a half pair does not
    // reach this function at all — `config` rejects it while parsing, so the
    // process fails to boot with a message naming the missing half instead of
    // running with an identity that would fail on its first request.
    await expect(load({ OXY_SERVICE_API_KEY: 'mention-key' })).rejects.toThrow(
      /OXY_SERVICE_API_KEY and OXY_SERVICE_API_SECRET must be configured together/,
    );
  });
});

/**
 * The fourth call site. Classification spends through the Kaana edge as Mention,
 * and the boot check that guards it still asked for the key pair — so the first
 * deployment to switch it on in ECS, where the task role attests and no pair
 * exists, would refuse to start and the obvious fix would be the pair coming back.
 */
async function loadValidation(environment: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv('POST_CLASSIFICATION_ENABLED', 'true');
  for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value);
  return (await import('../../config')).validateEnvironment;
}

describe('switching classification on', () => {
  it('boots on a task role alone, with no secret anywhere', async () => {
    const validateEnvironment = await loadValidation({
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/abc',
    });

    expect(() => validateEnvironment()).not.toThrow();
  });

  it('boots on a key pair where there is no task role', async () => {
    const validateEnvironment = await loadValidation({
      OXY_SERVICE_API_KEY: 'mention-key',
      OXY_SERVICE_API_SECRET: 'mention-secret',
    });

    expect(() => validateEnvironment()).not.toThrow();
  });

  it('refuses to boot with neither, naming both ways to fix it', async () => {
    const validateEnvironment = await loadValidation({});

    expect(() => validateEnvironment()).toThrow(
      /an Oxy service identity \(ECS task role, or OXY_SERVICE_API_KEY\/OXY_SERVICE_API_SECRET\)/,
    );
  });
});
