/**
 * FeedTuner — composable post-fetch filtering pipeline.
 *
 * Replaces inline filtering scattered across the old feed controller.
 * Each tuner function is a pure (slices, context) => slices transform.
 */

import { FeedPostSlice } from '@mention/shared-types';
import type { MuteWordRule } from '../../services/safety/muteWordMatcher';
// STATIC, not the `require()` these replaced.
//
// That `require()` was there "to avoid circular deps", but the cycle it guarded
// against does not exist: every tuner imports exactly one thing from this module,
// the `TunerContext` TYPE, which is erased at compile time and leaves no runtime
// edge to be circular. What it did instead was throw
// `Cannot find module './tuners/removeBoosts'` under vitest, where a CommonJS
// `require` cannot resolve a `.ts` sibling — so `FeedTuner.default()` raised on
// every call and EVERY controller path that produces slices answered 500. In
// tests only, which is why it went unnoticed: the whole tuner pipeline (mute
// words, hidden posts, dedupe) was unreachable from any end-to-end test.
import { removeBoosts } from './tuners/removeBoosts';
import { removeReplies } from './tuners/removeReplies';
import { deduplicateSlices } from './tuners/deduplicateSlices';
import { filterSensitiveContent } from './tuners/filterSensitiveContent';
import { filterMuteWords } from './tuners/filterMuteWords';
import { filterHiddenPosts } from './tuners/filterHiddenPosts';

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
    return new FeedTuner()
      .tune(filterHiddenPosts)
      .tune(filterMuteWords)
      .tune(filterSensitiveContent)
      .tune(removeBoosts)
      .tune(removeReplies)
      .tune(deduplicateSlices);
  }
}
