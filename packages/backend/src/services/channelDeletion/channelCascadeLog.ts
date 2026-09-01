/**
 * The one name this cascade answers to.
 *
 * Every log line and every error message the channel deletion produces — across
 * the target read, the binding table, the run accounting, the federation
 * broadcasts and the counter repair — carries this prefix, so a single filter
 * follows one run through all of them. Written once, because a second spelling
 * would split a run's evidence in half exactly when somebody is reading it.
 */
export const LOG_PREFIX = '[ChannelDeletion]';
