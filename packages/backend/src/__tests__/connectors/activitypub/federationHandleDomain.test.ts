/**
 * The handle-domain decision (`federationHandleDomain.ts`) and the actor
 * document's FEP-2c59 `webfinger` property. Off by default: with no handle domain,
 * or an empty rollout, every account and every actor document is what it was.
 */
import { describe, expect, it } from 'bun:test';
import {
  INSTANCE_ACTOR_USERNAME,
  createLocalActorBuilder,
  createUrlBuilders,
} from '@oxy.so/federation';
import {
  actorWebfingerProperty,
  createFederationHandlePolicy,
  federationHandlePolicy,
  handleDomainFor,
  isHandlePolicyActive,
  isHandleSwitched,
  localAcct,
  withActorWebfinger,
  withFederationHandleBuilder,
} from '../../../connectors/activitypub/federationHandleDomain';

const EARTH = 'mention.earth';
const ORG = 'mention.org';

const policy = (accounts: 'all' | string[], handleDomain: string | undefined = ORG) =>
  createFederationHandlePolicy({ federationDomain: EARTH, handleDomain, accounts });

describe('the handle-domain policy', () => {
  it('is off in this process (no FEDERATION_HANDLE_DOMAIN in the test environment)', () => {
    expect(federationHandlePolicy.handleDomain).toBe(federationHandlePolicy.federationDomain);
    expect(isHandlePolicyActive(federationHandlePolicy)).toBe(false);
    expect(localAcct(federationHandlePolicy, 'alice')).toBe(
      `alice@${federationHandlePolicy.federationDomain}`,
    );
  });

  it('switches nobody without a distinct handle domain, whatever the list says', () => {
    for (const unset of [
      createFederationHandlePolicy({ federationDomain: EARTH }),
      createFederationHandlePolicy({
        federationDomain: EARTH,
        handleDomain: null,
        accounts: 'all',
      }),
      policy('all', EARTH),
      policy(['alice'], `www.${EARTH}`),
    ]) {
      expect(isHandlePolicyActive(unset)).toBe(false);
      expect(isHandleSwitched(unset, 'alice')).toBe(false);
      expect(handleDomainFor(unset, 'alice')).toBe(EARTH);
    }
  });

  it('switches nobody with an empty rollout list', () => {
    const empty = policy([]);
    expect(isHandlePolicyActive(empty)).toBe(false);
    expect(isHandleSwitched(empty, 'alice')).toBe(false);
    expect(localAcct(empty, 'alice')).toBe(`alice@${EARTH}`);
  });

  it('switches exactly the listed accounts, case-insensitively', () => {
    const qa = policy(['OxyQA', ' bob ']);
    expect(isHandlePolicyActive(qa)).toBe(true);
    expect(isHandleSwitched(qa, 'oxyqa')).toBe(true);
    expect(isHandleSwitched(qa, 'OXYQA')).toBe(true);
    expect(isHandleSwitched(qa, 'bob')).toBe(true);
    expect(isHandleSwitched(qa, 'alice')).toBe(false);
    expect(handleDomainFor(qa, 'oxyqa')).toBe(ORG);
    expect(handleDomainFor(qa, 'alice')).toBe(EARTH);
  });

  it('switches every account for `all`, but never the instance actor', () => {
    const all = policy('all');
    expect(isHandleSwitched(all, 'alice')).toBe(true);
    expect(isHandleSwitched(all, INSTANCE_ACTOR_USERNAME)).toBe(false);
    expect(isHandleSwitched(policy([INSTANCE_ACTOR_USERNAME]), INSTANCE_ACTOR_USERNAME)).toBe(
      false,
    );
    expect(isHandleSwitched(all, '')).toBe(false);
  });

  it('keeps the username as given in the acct label', () => {
    expect(localAcct(policy(['alice']), 'Alice')).toBe(`Alice@${ORG}`);
    expect(localAcct(policy(['alice']), 'Bob')).toBe(`Bob@${EARTH}`);
  });
});

const urls = createUrlBuilders(EARTH, EARTH);
const engineBuilder = createLocalActorBuilder({
  domain: EARTH,
  urls,
  media: { resolveAvatar: () => null, resolveBanner: () => null },
});
const params = {
  username: 'alice',
  displayName: 'Alice',
  bio: 'hi',
  publicKey: { keyId: `${urls.actor('alice')}#main-key`, publicKeyPem: 'PEM' },
  alsoKnownAs: ['https://mastodon.example/users/alice'],
};

describe('the actor document (FEP-2c59 `webfinger`)', () => {
  it('is the engine builder itself while the policy is off', () => {
    expect(withFederationHandleBuilder(engineBuilder, policy([]))).toBe(engineBuilder);
    expect(withFederationHandleBuilder(engineBuilder, policy('all', EARTH))).toBe(engineBuilder);
  });

  it('is byte-identical for an unswitched account while others have switched', () => {
    const build = withFederationHandleBuilder(engineBuilder, policy(['bob']));
    expect(JSON.stringify(build(params))).toBe(JSON.stringify(engineBuilder(params)));
    expect(build(params)).not.toHaveProperty('webfinger');
  });

  it('adds `webfinger: user@<handle domain>` after preferredUsername and changes nothing else', () => {
    const build = withFederationHandleBuilder(engineBuilder, policy(['alice']));
    const engine = engineBuilder(params);
    const switched = build(params);
    expect(switched.webfinger).toBe(`alice@${ORG}`);
    const keys = Object.keys(switched);
    expect(keys[keys.indexOf('preferredUsername') + 1]).toBe('webfinger');
    const { webfinger: _webfinger, ...rest } = switched;
    expect(rest).toEqual(engine);
    // The identity and the profile link stay on the federation domain.
    expect(switched.id).toBe(`https://${EARTH}/ap/users/alice`);
    expect(switched.inbox).toBe(`https://${EARTH}/ap/users/alice/inbox`);
    expect(switched.preferredUsername).toBe('alice');
    expect(switched.url).toBe(`https://${EARTH}/@alice`);
    expect(switched.alsoKnownAs).toEqual(engine.alsoKnownAs);
    expect(switched.publicKey).toEqual(engine.publicKey);
  });

  it('lowercases the handle and never adds a second property', () => {
    expect(actorWebfingerProperty(policy('all'), 'Alice')).toBe(`alice@${ORG}`);
    expect(actorWebfingerProperty(policy(['bob']), 'alice')).toBeUndefined();
    const doubled = withActorWebfinger(
      { id: 'x', webfinger: 'stale@example.test', preferredUsername: 'alice' },
      'alice',
      policy('all'),
    );
    expect(doubled).toEqual({ id: 'x', preferredUsername: 'alice', webfinger: `alice@${ORG}` });
    expect(withActorWebfinger({ id: 'x' }, 'alice', policy('all'))).toEqual({
      id: 'x',
      webfinger: `alice@${ORG}`,
    });
    const untouched = { id: 'x' };
    expect(withActorWebfinger(untouched, 'alice', policy([]))).toBe(untouched);
  });
});
