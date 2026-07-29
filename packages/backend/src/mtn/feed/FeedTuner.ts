/**
 * FeedTuner — composable post-fetch filtering pipeline.
 *
 * Replaces inline filtering scattered across the old feed controller.
 * Each tuner function is a pure (slices, context) => slices transform.
 */

import { FeedPostSlice } from '@mention/shared-types';
import type { MuteWordRule } from '../../services/safety/muteWordMatcher';

export interface TunerContext {
  viewerId?: string;
  /**
   * The viewer's followed-author ids (Oxy ∪ accepted federated), for tuners whose
   * rules are scoped by whether the viewer follows the author — today the
   * `exclude-following` scope on a muted word. Passed as the list the caller
   * already has; a tuner indexes it only if one of its rules needs it. Absent means
   * "follows nobody relevant", so such a rule then applies to every author.
   */
  followedAuthorIds?: readonly string[];
  preferences: {
    languages?: string[];
    hideBoosts?: boolean;
    hideReplies?: boolean;
    hideSensitive?: boolean;
    muteWords?: MuteWordRule[];
    hiddenPostIds?: Set<string>;
    labelPreferences?: Record<string, 'show' | 'warn' | 'blur' | 'hide'>;
  };
}

export type TunerFn = (slices: FeedPostSlice[], ctx: TunerContext) => FeedPostSlice[];

export class FeedTuner {
  private fns: TunerFn[] = [];

  /** Add a tuner function to the pipeline. Chainable. */
  tune(fn: TunerFn): this {
    this.fns.push(fn);
    return this;
  }

  /** Run all tuner functions in order. */
  apply(slices: FeedPostSlice[], context: TunerContext): FeedPostSlice[] {
    let result = slices;
    for (const fn of this.fns) {
      result = fn(result, context);
    }
    return result;
  }

  /** Create a new FeedTuner with the default tuner pipeline. */
  static default(): FeedTuner {
    // Lazy import to avoid circular deps
    const { removeBoosts } = require('./tuners/removeBoosts');
    const { removeReplies } = require('./tuners/removeReplies');
    const { deduplicateSlices } = require('./tuners/deduplicateSlices');
    const { filterByLanguage } = require('./tuners/filterByLanguage');
    const { filterSensitiveContent } = require('./tuners/filterSensitiveContent');
    const { filterMuteWords } = require('./tuners/filterMuteWords');
    const { filterHiddenPosts } = require('./tuners/filterHiddenPosts');

    return new FeedTuner()
      .tune(filterHiddenPosts)
      .tune(filterMuteWords)
      .tune(filterSensitiveContent)
      .tune(removeBoosts)
      .tune(removeReplies)
      .tune(filterByLanguage)
      .tune(deduplicateSlices);
  }
}
