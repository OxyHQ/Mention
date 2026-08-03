import type { MediaItem } from '@mention/shared-types';
import type { IPost } from '../models/Post';
import type { CreatePostParams } from './PostCreationService';

/**
 * Late-bound registry that breaks the runtime circular dependency between the
 * network connectors and `PostCreationService`.
 *
 * They reference each other: `PostCreationService` asks the registered
 * `PostFederator` (the connector registry) to federate a new local post, and a
 * connector calls `PostCreationService.create` when importing federated
 * notes/boosts. Importing one from the other directly would form a CommonJS load
 * cycle (the second module loads while the first is still partially initialized).
 *
 * Instead, each side registers its runtime instance here and the other resolves
 * it lazily through the typed accessors below. Post creation is registered by
 * its service module; connector registration is an explicit bootstrap step.
 * This pays the cost once (a property read) instead of `require()`-resolving a
 * module on every federation job, and keeps the contract typed with no `any`.
 */

/** The subset of `PostCreationService` a connector depends on. */
export interface PostCreator {
  create(params: CreatePostParams): Promise<IPost>;
}

/** The subset of the connector registry that `PostCreationService` depends on. */
export interface PostFederator {
  federateNewPost(
    post: {
      _id: unknown;
      content: { text?: string; media?: MediaItem[] };
      hashtags?: string[];
      mentions?: string[];
      visibility: string;
      createdAt: string;
      // A boost carries an empty body; the connector re-routes it to an Announce
      // rather than a blank Create(Note). Threaded through so the seam preserves it.
      boostOf?: string | null;
      // A reply carries the parent's Post id; the connector emits `inReplyTo` + a
      // parent-author Mention and delivers to the parent author's inbox. Threaded
      // through so the seam preserves it (the `POST /posts` reply path).
      parentPostId?: string | null;
    },
    senderOxyUserId: string,
    senderUsername: string,
    /**
     * OTHER local accounts whose remote followers should also receive this
     * activity, on top of the sender's own. Set only for a cross-account thread,
     * where each entry answers an account the reader may not follow; see
     * `connectors/threadFederation.ts` for what that does and does not buy.
     * Network-neutral on purpose — each connector decides what "that account's
     * audience" means on its own network.
     */
    alsoDeliverToAudiencesOf?: string[],
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
 * `PostCreationService` has been loaded — a programming error, since application
 * composition loads both services before any federation job runs.
 */
export function getPostCreator(): PostCreator {
  if (!postCreator) {
    throw new Error('PostCreator not registered: PostCreationService must be loaded before use');
  }
  return postCreator;
}

/**
 * Resolve the registered federation singleton. Throws if accessed before the
 * connector registry has been initialized — a programming error, since runtime
 * bootstrap registers it before any post can be created.
 */
export function getPostFederator(): PostFederator {
  if (!postFederator) {
    throw new Error('PostFederator not registered: the connector registry must be loaded before use');
  }
  return postFederator;
}
