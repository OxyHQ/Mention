/**
 * FeedAPI Registry
 *
 * Resolves FeedDescriptor → FeedAPI instance.
 * Replaces FeedStrategyFactory.
 */

import { FeedDescriptor, parseFeedDescriptor, FeedDescriptorSource } from '@mention/shared-types';
import { FeedAPI, FeedContext } from './FeedAPI';

type FeedFactory = (params: string[], context: FeedContext) => FeedAPI;

export class FeedAPIRegistry {
  private factories = new Map<FeedDescriptorSource, FeedFactory>();

  register(source: FeedDescriptorSource, factory: FeedFactory): void {
    this.factories.set(source, factory);
  }

  resolve(descriptor: FeedDescriptor, context: FeedContext): FeedAPI | null {
    const { source, params } = parseFeedDescriptor(descriptor);
    const factory = this.factories.get(source);
    if (!factory) return null;
    return factory(params, context);
  }

  getSupportedSources(): FeedDescriptorSource[] {
    return Array.from(this.factories.keys());
  }
}

export const feedAPIRegistry = new FeedAPIRegistry();
