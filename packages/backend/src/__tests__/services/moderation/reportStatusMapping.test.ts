import { describe, expect, it } from 'vitest';
import { DECISION_OUTCOMES, DECISION_STATUSES } from '@oxyhq/crowdsource-contracts';

import { REPORT_STATUSES } from '../../../db/schema/moderation';
import {
  legacyStatusForOutcome,
  reportStateForDecision,
} from '../../../services/moderation/reportStatus';

/**
 * The compatibility mapping §14.3 asks for, as a table.
 *
 * `status` is the field clients have already shipped against, so it keeps working
 * while `localStatus` carries the new axis — and both are derived here rather than
 * written from more than one place. The invariant worth guarding is narrow and
 * absolute: only an outcome that IS a verdict may produce a verdict.
 */
describe('report status mapping', () => {
  it('maps only the two verdict outcomes to a verdict', () => {
    expect(legacyStatusForOutcome('violation')).toBe('resolved');
    expect(legacyStatusForOutcome('no_violation')).toBe('dismissed');
  });

  it.each(['insufficient_context', 'inconclusive', 'content_unavailable', 'duplicate', 'escalated'])(
    'maps %s to reviewed, never to dismissed',
    (outcome) => {
      /**
       * A jury engaged and produced no verdict. `dismissed` would read as "nothing was
       * wrong" — turning "we could not tell" into innocence, which is the collapse the
       * invariants forbid.
       */
      expect(legacyStatusForOutcome(outcome)).toBe('reviewed');
    },
  );

  it('maps an outcome this version has never seen to reviewed', () => {
    // §10.11: a newer CrowdSource must not be able to silently produce a verdict here.
    expect(legacyStatusForOutcome('some_outcome_from_2027')).toBe('reviewed');
  });

  it('covers every outcome the contract currently defines', () => {
    /**
     * A vacuity floor against the contract itself. If CrowdSource adds an outcome, this
     * asserts the mapping still answers for it — and the answer is `reviewed` unless
     * somebody deliberately decides otherwise, which is the safe default rather than a
     * crash or an invented verdict.
     */
    for (const outcome of DECISION_OUTCOMES) {
      const mapped = legacyStatusForOutcome(outcome);
      expect(REPORT_STATUSES as readonly string[]).toContain(mapped);
      if (outcome !== 'violation' && outcome !== 'no_violation') {
        expect(mapped).toBe('reviewed');
      }
    }
  });

  it('closes the report only for a terminal decision status', () => {
    const terminal = ['final', 'corrected'];
    for (const decisionStatus of DECISION_STATUSES) {
      const state = reportStateForDecision({ outcome: 'violation', decisionStatus });
      expect(state.localStatus).toBe(terminal.includes(decisionStatus) ? 'closed' : 'submitted');
    }
  });

  it('leaves a superseded revision unable to close the report', () => {
    /**
     * A superseded revision is not the current answer for the case. Letting it close the
     * report would end Mention's side of a case on the strength of a decision that has
     * already been replaced.
     */
    expect(
      reportStateForDecision({ outcome: 'violation', decisionStatus: 'superseded' }).localStatus,
    ).toBe('submitted');
  });
});
