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
