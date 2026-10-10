import { useEffect } from 'react';
import { subscribeToSafetyFilterChanges } from '@/stores/safetyInvalidation';
import { subscribeToBylineChanges } from '@/stores/bylineInvalidation';

/**
 * Read a MOUNTED feed again when a rule changes what it may show.
 *
 * A muted word or the sensitive-content toggle changes what the server is
 * willing to send; a channel turning its byline on or off rewrites the author
 * list of every post it published, and with the byline off the writer's id was
 * never sent here at all. Either way a feed on screen cannot re-derive its own
 * contents — it has to ask again. The warm-start staleness check
 * (`stores/feedStaleness`) covers feeds that are unmounted when the rule
 * changes; this covers the common case, where the settings screen was pushed
 * OVER a feed that stays mounted underneath and would never run that check.
 *
 * One subscription per authority, so each module's signal stays testable on
 * its own. `reload` should be stable: a new identity re-subscribes.
 */
export function useReloadOnFeedRuleChange(enabled: boolean, reload: () => unknown): void {
    useEffect(() => {
        if (!enabled) return;
        const onChange = () => {
            void reload();
        };
        const unsubscribeSafety = subscribeToSafetyFilterChanges(onChange);
        const unsubscribeByline = subscribeToBylineChanges(onChange);
        return () => {
            unsubscribeSafety();
            unsubscribeByline();
        };
    }, [enabled, reload]);
}
