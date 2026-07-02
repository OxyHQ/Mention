/**
 * Feed Module Registry
 *
 * Holds every registered feed module (source / signal / filter) keyed by id and
 * resolves them with kind-checked getters. Mirrors `FeedAPIRegistry`'s
 * conventions but stores composable modules instead of whole feed classes; the
 * generic `FeedEngine` consumes it to run a `FeedDefinition`.
 */

import type { FeedModule, SourceModule, SignalModule, FilterModule } from './types';

export class FeedModuleRegistry {
  private modules = new Map<string, FeedModule>();

  /** Register (or replace) a module under its id. */
  register(module: FeedModule): void {
    this.modules.set(module.id, module);
  }

  /** Whether any module is registered under `id` (regardless of kind). */
  has(id: string): boolean {
    return this.modules.has(id);
  }

  /** Resolve a SOURCE module by id, or `undefined` when absent / a different kind. */
  getSource(id: string): SourceModule | undefined {
    const module = this.modules.get(id);
    return module?.kind === 'source' ? module : undefined;
  }

  /** Resolve a SIGNAL module by id, or `undefined` when absent / a different kind. */
  getSignal(id: string): SignalModule | undefined {
    const module = this.modules.get(id);
    return module?.kind === 'signal' ? module : undefined;
  }

  /** Resolve a FILTER module by id, or `undefined` when absent / a different kind. */
  getFilter(id: string): FilterModule | undefined {
    const module = this.modules.get(id);
    return module?.kind === 'filter' ? module : undefined;
  }
}

export const feedModuleRegistry = new FeedModuleRegistry();
