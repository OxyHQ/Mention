/**
 * FeedTuner — composable post-fetch filtering pipeline.
 *
 * Replaces inline filtering scattered across the old feed controller.
 * Each tuner function is a pure (slices, context) => slices transform.
 */

import { FeedPostSlice } from '@mention/shared-types';

export interface TunerContext {
  viewerId?: string;
  preferences: {
    languages?: string[];
    hideReposts?: boolean;
    hideReplies?: boolean;
    hideSensitive?: boolean;
    muteWords?: Array<{ value: string; targets: ('content' | 'tag')[] }>;
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
    const { removeReposts } = require('./tuners/removeReposts');
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
      .tune(removeReposts)
      .tune(removeReplies)
      .tune(filterByLanguage)
      .tune(deduplicateSlices);
  }
}
