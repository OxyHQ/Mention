/**
 * A handle the author typed means the account on THEIR network.
 *
 * Two real posts made this concrete. Both are bridge-flattened retweets —
 * bird.makeup and mastox do not emit an `Announce`, they publish an ordinary
 * Note whose body begins `RT: @author` — so there is no boost to model and the
 * original author survives ONLY as a bare handle in the text:
 *
 *   "RT: @Julio_Rodr_ ¡Tres años de [@Canal Red](canalred_tv@mastox.eu)…"
 *
 * Note the contrast inside that one body: the mention the Note carried in its
 * `tag` array is a hydrated placeholder, while `@Julio_Rodr_` is prose. Copied
 * across unqualified it reads as a LOCAL name, so anything that links it points
 * at whoever holds that name here.
 */

import { identityDomainOfActor } from '../../../connectors/activitypub/identityDomain';
import { qualifyBareHandles } from '@mention/shared-types/textEntities';

describe('identityDomainOfActor', () => {
  it('prefers the RE-LABELLED network over the host the copy arrived through', () => {
    // The distinction the whole bridge policy exists for: `domain` addresses the
    // bridge, `networkAcct` names the account.
    expect(identityDomainOfActor({ networkAcct: 'pabloiglesias@x.com', domain: 'mastox.eu' }))
      .toBe('x.com');
  });

  /**
   * An ordinary instance is deliberately NOT answered for. `@alice` on
   * mastodon.social already means alice there and already resolves, so
   * qualifying it would lengthen the body of every federated post to say what a
   * reader could already act on — measured: 1,266 of 5,000 sampled production
   * posts would have been rewritten, and the samples were ordinary Finnish and
   * Dutch Mastodon posts. A bridged handle does not resolve until it carries its
   * network, which is the whole difference.
   */
  it('answers for a RE-LABELLED actor only, never an ordinary one', () => {
    expect(identityDomainOfActor({ networkAcct: undefined, domain: 'mastodon.social' }))
      .toBeUndefined();
    expect(identityDomainOfActor({ networkAcct: 'wired@x.com', domain: 'bird.makeup' }))
      .toBe('x.com');
  });

  it('ignores a malformed networkAcct rather than qualifying onto a guess', () => {
    // Malformed means we cannot tell which network this identity is on, so the
    // body is left alone — never qualified onto the bridge host it arrived
    // through, which is what the old `domain` fallback would have done.
    for (const networkAcct of ['pabloiglesias', 'pabloiglesias@', '@x.com', '   ']) {
      expect(identityDomainOfActor({ networkAcct, domain: 'mastox.eu' })).toBeUndefined();
    }
  });

  it('answers undefined when nothing is known, leaving a body untouched', () => {
    expect(identityDomainOfActor(null)).toBeUndefined();
    expect(identityDomainOfActor({ networkAcct: undefined, domain: undefined })).toBeUndefined();
  });
});

describe('a bridge-flattened retweet', () => {
  it('turns the only reference the bridge left behind into a followable handle', () => {
    const body = 'RT: @Julio_Rodr_ ¡Tres años de Canal Red navegando a contracorriente!';
    expect(qualifyBareHandles(body, 'x.com'))
      .toBe('RT: @Julio_Rodr_@x.com ¡Tres años de Canal Red navegando a contracorriente!');
  });

  it('leaves a mention the Note already carried in its tag array alone', () => {
    // The hydrated form is a different entity to the scanner, so it can be
    // neither double-qualified nor disturbed. Asserted because the two forms sit
    // side by side in the real post this came from.
    const body = 'RT: @BoGardiner1 [@Mehdi Hasan](mehdirhasan@x.com) remember this?';
    expect(qualifyBareHandles(body, 'x.com'))
      .toBe('RT: @BoGardiner1@x.com [@Mehdi Hasan](mehdirhasan@x.com) remember this?');
  });

  it('qualifies onto the NETWORK, never onto the bridge that carried the copy', () => {
    const domain = identityDomainOfActor({ networkAcct: 'pabloiglesias@x.com', domain: 'mastox.eu' });
    expect(qualifyBareHandles('RT: @Julio_Rodr_ hola', domain ?? '')).toContain('@Julio_Rodr_@x.com');
    expect(qualifyBareHandles('RT: @Julio_Rodr_ hola', domain ?? '')).not.toContain('mastox.eu');
  });
});
