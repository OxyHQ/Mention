import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const registry = { kind: 'connector-registry' };
  return {
    registry,
    registerPostFederator: vi.fn(),
    ConnectorRegistry: vi.fn(function ConnectorRegistry() {
      return registry;
    }),
  };
});

vi.mock('../../services/serviceRegistry', () => ({
  registerPostFederator: mocks.registerPostFederator,
}));
vi.mock('../../connectors/ConnectorRegistry', () => ({
  ConnectorRegistry: mocks.ConnectorRegistry,
}));
vi.mock('../../connectors/activitypub/ActivityPubConnector', () => ({
  activityPubConnector: { id: 'activitypub' },
}));
vi.mock('../../connectors/activitypub/constants', () => ({
  FEDERATION_ENABLED: false,
}));
vi.mock('../../connectors/atproto/AtprotoConnector', () => ({
  atprotoConnector: { id: 'atproto' },
}));
vi.mock('../../connectors/atproto/constants', () => ({
  ATPROTO_ENABLED: false,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.registerPostFederator.mockClear();
  mocks.ConnectorRegistry.mockClear();
});

describe('connector runtime bootstrap', () => {
  it('has no registration side effect on import and initializes once explicitly', async () => {
    const connectors = await import('../../connectors');

    expect(mocks.ConnectorRegistry).toHaveBeenCalledOnce();
    expect(mocks.registerPostFederator).not.toHaveBeenCalled();

    expect(connectors.initConnectors()).toBe(mocks.registry);
    expect(connectors.initConnectors()).toBe(mocks.registry);
    expect(mocks.registerPostFederator).toHaveBeenCalledOnce();
    expect(mocks.registerPostFederator).toHaveBeenCalledWith(mocks.registry);
  });
});
