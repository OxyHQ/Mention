import { createScopedLogger } from '@/lib/logger';
import { authenticatedClient } from '@/utils/api';

const logger = createScopedLogger('MuteWordsService');

/**
 * Where a muted word is matched. `content` matches post body text;
 * `tag` matches a post's hashtags.
 */
export type MuteWordTarget = 'content' | 'tag';

/**
 * Which authors a muted word applies to. `all` mutes everyone;
 * `exclude-following` leaves accounts you follow unaffected.
 */
export type MuteWordActorTarget = 'all' | 'exclude-following';

/**
 * Serialized muted word as returned by the backend `/mute-words` API.
 * A hashtag is stored tag-only (`targets === ['tag']`) with the leading
 * `#` stripped and the value lowercased.
 */
export interface SerializedMuteWord {
    id: string;
    value: string;
    targets: MuteWordTarget[];
    actorTarget: MuteWordActorTarget;
    createdAt: string;
}

/** Body accepted by `POST /mute-words`. */
interface CreateMuteWordBody {
    value: string;
    targets?: MuteWordTarget[];
    actorTarget?: MuteWordActorTarget;
}

/** Shared success envelope returned by the backend. */
interface ApiEnvelope<T> {
    data: T;
    message?: string;
    success?: boolean;
}

const MUTE_WORDS_PATH = '/mute-words';

/**
 * Returns true when a serialized muted word represents a hashtag, i.e. it is
 * stored tag-only (`targets === ['tag']`). The list UI renders these with a
 * leading `#`; everything else is a word/phrase rendered as-is.
 */
export function isHashtagMuteWord(word: Pick<SerializedMuteWord, 'targets'>): boolean {
    return word.targets.length === 1 && word.targets[0] === 'tag';
}

/**
 * The display label for a muted word: `#value` for hashtags, `value` for words.
 */
export function muteWordDisplayValue(word: SerializedMuteWord): string {
    return isHashtagMuteWord(word) ? `#${word.value}` : word.value;
}

export const muteWordsService = {
    /** Fetch all muted words for the current user, newest first. */
    async list(): Promise<SerializedMuteWord[]> {
        const response = await authenticatedClient.get<ApiEnvelope<SerializedMuteWord[]>>(MUTE_WORDS_PATH);
        return response.data.data ?? [];
    },

    /**
     * Create a muted word. A raw input starting with `#` is sent as a tag-only
     * entry (`targets: ['tag']`) so the backend stores a clean hashtag that
     * round-trips for display; a plain word is sent without `targets` so the
     * backend applies its default (`['content', 'tag']`). Idempotent server-side:
     * an existing entry returns 200 with the existing record.
     */
    async create(rawInput: string): Promise<SerializedMuteWord> {
        const value = rawInput.trim();
        const isHashtag = value.startsWith('#');
        const body: CreateMuteWordBody = isHashtag ? { value, targets: ['tag'] } : { value };

        logger.debug('Creating mute word', { isHashtag });
        const response = await authenticatedClient.post<ApiEnvelope<SerializedMuteWord>>(MUTE_WORDS_PATH, body);
        return response.data.data;
    },

    /** Remove a muted word by id. */
    async remove(id: string): Promise<void> {
        logger.debug('Removing mute word', { id });
        await authenticatedClient.delete<ApiEnvelope<{ success: true }>>(`${MUTE_WORDS_PATH}/${id}`);
    },
};
