import type { IPost } from '../models/Post';
import type { CreatePostParams } from './PostCreationService';

/**
 * Late-bound registry that breaks the runtime circular dependency between
 * `FederationService` and `PostCreationService`.
 *
 * Both services are singletons that reference each other: `PostCreationService`
 * calls `FederationService.federateNewPost` when a new local post is created, and
 * `FederationService` calls `PostCreationService.create` when importing federated
 * notes/boosts. Importing one from the other directly would form a CommonJS load
 * cycle (the second module loads while the first is still partially initialized).
 *
 * Instead, each service registers its singleton here at module load, and the
 * other resolves it lazily at call time via the typed accessors below. This
 * pays the cost once (a property read) instead of `require()`-resolving a module
 * on every federation job, and keeps the dependency contract explicit and typed
 * with no `any`.
 */

/** The subset of `PostCreationService` that `FederationService` depends on. */
export interface PostCreator {
  create(params: CreatePostParams): Promise<IPost>;
}

/** The subset of `FederationService` that `PostCreationService` depends on. */
export interface PostFederator {
  federateNewPost(
    post: {
      _id: unknown;
      content: { text?: string };
      hashtags?: string[];
      mentions?: string[];
      visibility: string;
      createdAt: string;
    },
    senderOxyUserId: string,
    senderUsername: string,
  ): Promise<void>;
}

let postCreator: PostCreator | null = null;
let postFederator: PostFederator | null = null;

/** Register the post-creation singleton. Called once at module load. */
export function registerPostCreator(instance: PostCreator): void {
  postCreator = instance;
}

/** Register the federation singleton. Called once at module load. */
export function registerPostFederator(instance: PostFederator): void {
  postFederator = instance;
}

/**
 * Resolve the registered post-creation singleton. Throws if accessed before
 * `PostCreationService` has been loaded — a programming error, since both
 * services are loaded at server bootstrap before any federation job runs.
 */
export function getPostCreator(): PostCreator {
  if (!postCreator) {
    throw new Error('PostCreator not registered: PostCreationService must be loaded before use');
  }
  return postCreator;
}

/**
 * Resolve the registered federation singleton. Throws if accessed before
 * `FederationService` has been loaded — a programming error, since both
 * services are loaded at server bootstrap before any post is created.
 */
export function getPostFederator(): PostFederator {
  if (!postFederator) {
    throw new Error('PostFederator not registered: FederationService must be loaded before use');
  }
  return postFederator;
}
