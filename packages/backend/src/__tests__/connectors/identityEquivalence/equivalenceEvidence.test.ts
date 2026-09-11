import { describe, expect, it } from 'vitest';
import {
  evaluateEquivalence,
  type EquivalenceSide,
} from '../../../connectors/identityEquivalence/equivalenceEvidence';
import type { CrossNetworkIdentityClaim } from '../../../connectors/identityEquivalence/identityClaims';

/**
 * WHETHER TWO IDENTITIES ARE ONE PERSON, DECIDED FROM WHAT EACH ONE PUBLISHES.
 *
 * The asymmetry is the whole design: a link must be hard to create and easy to
 * withdraw, because the two failures are not comparable. A missed merge shows a
 * reader two cards instead of one. A wrong merge hands somebody's profile — their
 * followers, their posts, their name — to whoever holds the same handle on the
 * other network.
 *
 * So one-way is never enough. Anybody can publish
 * `alsoKnownAs: https://www.threads.net/@zuck`; what nobody but Zuckerberg can do
 * is make the Threads account point back.
 */

function claim(
  subject: string,
  target: string,
  kind: CrossNetworkIdentityClaim['kind'] = 'also-known-as',
): CrossNetworkIdentityClaim {
  return { subject, subjectActorUri: `uri:${subject}`, target, kind, source: `src:${target}` };
}

function side(identity: string, claims: CrossNetworkIdentityClaim[]): EquivalenceSide {
  return { identity, claims };
}

const IG = 'zuck@instagram.com';
const THREADS = 'zuck@threads.net';

describe('evaluateEquivalence — what links', () => {
  it('links a reviewed pair whose two identities each assert the other', () => {
    const verdict = evaluateEquivalence(
      side(IG, [claim(IG, THREADS)]),
      side(THREADS, [claim(THREADS, IG)]),
    );

    expect(verdict).toMatchObject({ linked: true, reason: 'bidirectional-assertion' });
    expect(verdict.evidence).toHaveLength(2);
  });

  it('links on a verified profile link in each direction, not only alsoKnownAs', () => {
    const verdict = evaluateEquivalence(
      side(IG, [claim(IG, THREADS, 'verified-profile-link')]),
      side(THREADS, [claim(THREADS, IG, 'verified-profile-link')]),
    );

    expect(verdict.linked).toBe(true);
  });

  /**
   * A first-party statement is the OPERATOR's, not either account's, so it is not
   * one account vouching for another — it is the account system saying these are
   * one entry in it. That is the authority the bidirectional bar exists to
   * substitute for, so it stands alone.
   */
  it('links on a single first-party statement from either side', () => {
    expect(
      evaluateEquivalence(side(IG, [claim(IG, THREADS, 'first-party-link')]), side(THREADS, []))
        .linked,
    ).toBe(true);
    expect(
      evaluateEquivalence(side(IG, []), side(THREADS, [claim(THREADS, IG, 'first-party-link')]))
        .linked,
    ).toBe(true);
  });

  it('does not care which side is passed first', () => {
    const forwards = evaluateEquivalence(
      side(IG, [claim(IG, THREADS)]),
      side(THREADS, [claim(THREADS, IG)]),
    );
    const backwards = evaluateEquivalence(
      side(THREADS, [claim(THREADS, IG)]),
      side(IG, [claim(IG, THREADS)]),
    );

    expect(forwards.linked).toBe(backwards.linked);
    expect(forwards.reason).toBe(backwards.reason);
  });
});

describe('evaluateEquivalence — what it refuses, and what it says about it', () => {
  it('refuses a one-way assertion, and names the half it has', () => {
    const verdict = evaluateEquivalence(side(IG, [claim(IG, THREADS)]), side(THREADS, []));

    expect(verdict).toMatchObject({ linked: false, reason: 'one-way-claim-only' });
    // A pair halfway through linking and two strangers are different situations;
    // a report that cannot tell them apart is not worth reading.
    expect(verdict.evidence).toHaveLength(1);
  });

  it('refuses two silent identities as no-claims, not as a one-way miss', () => {
    expect(evaluateEquivalence(side(IG, []), side(THREADS, []))).toMatchObject({
      linked: false,
      reason: 'no-claims',
      evidence: [],
    });
  });

  /**
   * THE INVARIANT THE WHOLE LAYER EXISTS TO PRESERVE. `('x','nate')` and
   * `('instagram','nate')` are unrelated strings that happen to match, and no
   * amount of asserting can make two networks nobody paired into one person.
   */
  it('refuses an unreviewed pair even when both sides assert each other', () => {
    const igNate = 'nate@instagram.com';
    const xNate = 'nate@x.com';

    expect(
      evaluateEquivalence(
        side(igNate, [claim(igNate, xNate)]),
        side(xNate, [claim(xNate, igNate)]),
      ),
    ).toMatchObject({ linked: false, reason: 'pair-not-reviewed' });
  });

  it('refuses a network paired with itself — that is the within-network merge', () => {
    expect(
      evaluateEquivalence(
        side('a@instagram.com', [claim('a@instagram.com', 'b@instagram.com')]),
        side('b@instagram.com', [claim('b@instagram.com', 'a@instagram.com')]),
      ),
    ).toMatchObject({ linked: false, reason: 'pair-not-reviewed' });
  });

  it('refuses a malformed identity rather than guessing a network out of it', () => {
    expect(evaluateEquivalence(side('zuck', []), side(THREADS, []))).toMatchObject({
      linked: false,
      reason: 'pair-not-reviewed',
    });
  });

  /**
   * Two accounts asserting a THIRD account is not the two of them asserting each
   * other. Without this the layer would link anyone who happened to link the same
   * popular profile.
   */
  it('refuses claims that point somewhere other than at each other', () => {
    expect(
      evaluateEquivalence(
        side(IG, [claim(IG, 'someone@threads.net')]),
        side(THREADS, [claim(THREADS, 'someone@instagram.com')]),
      ),
    ).toMatchObject({ linked: false, reason: 'no-claims' });
  });

  it('refuses a claim whose subject is not the side that carried it', () => {
    // A row mis-attributed at read time must not be able to vouch for anybody.
    expect(
      evaluateEquivalence(
        side(IG, [claim('someone@instagram.com', THREADS)]),
        side(THREADS, [claim(THREADS, IG)]),
      ),
    ).toMatchObject({ linked: false, reason: 'one-way-claim-only' });
  });
});
