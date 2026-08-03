/**
 * The sweep window a test hands `publishDuePosts`, asserted to be in the PAST.
 *
 * ## What this guards, and what it does NOT
 *
 * `ScheduledPostPublisher.publishDuePosts(now)` is scoped to NOTHING: its
 * predicate is `status = 'scheduled' and scheduled_for <= now`, with no owner,
 * no test-fixture prefix and no id. Every test file shares one Postgres
 * database, so a sweep here reaches every other file's scheduled posts — and it
 * does not merely read them. It flips `status`, sends notifications and
 * triggers outbound federation.
 *
 * Today that never happens, and it is disarmed by TWO conditions, both of which
 * hold by accident:
 *
 *  a. both runners inject a fixed `now` seven months in the past, so the window
 *     excludes every other file's posts, which are seeded at `Date.now() + …`;
 *  b. no other test file seeds a scheduled post whose time has already passed.
 *
 * **This assertion covers PART of (a), and nothing of (b).** Stated precisely,
 * because a tripwire that claims more than it does is worse than none:
 *
 *  - it FIRES when a runner passes a window that reaches the present, e.g.
 *    `publishDuePosts(new Date())` — mutation-tested;
 *  - it CANNOT fire when someone calls `publishDuePosts()` with **no argument**,
 *    because then this function is not on the path at all. The default
 *    parameter is `new Date()`, so that edit is both plausible and invisible
 *    here. Nothing short of the publisher itself refusing an unscoped sweep
 *    closes that one.
 *  - it CANNOT see (b) at all: a new fixture in an unrelated file with a past
 *    `scheduledFor` walks into whatever window is open, and nothing here
 *    notices.
 *
 * The real fix is an isolated database for the suites that run globally-scoped
 * jobs, which removes (b) by construction because no other file's posts exist to
 * sweep. This is the stopgap until that lands, and it is worth having precisely
 * because "it holds by accident" is a comment rather than a mechanism — so it
 * is made to throw.
 */
/**
 * How far behind real time a window has to sit to count as deliberate.
 *
 * NOT `>= Date.now()`, and the difference is the whole guard. That version was
 * written first and a mutation SURVIVED it: replacing a runner's fixed date
 * with `new Date()` still passed, because the `new Date()` at the call site is
 * captured microseconds BEFORE the `Date.now()` read inside this function, so
 * it compares as strictly in the past. A guard against "reaching the present"
 * that a value captured in the present slips through is exactly the narrower
 * question this whole effort exists to stop asking.
 *
 * An hour discriminates cleanly: every legitimate fixed test date is months
 * behind, and any real-now expression is within milliseconds.
 */
const MINIMUM_LAG_MS = 60 * 60 * 1000;

export function pastSweepWindow(now: Date): Date {
  if (now.getTime() >= Date.now() - MINIMUM_LAG_MS) {
    throw new Error(
      `publishDuePosts was handed ${now.toISOString()}, which is not meaningfully ` +
        'in the past. ' +
        'The sweep is scoped to nothing — `status = \'scheduled\' and ' +
        'scheduled_for <= now` — so a window reaching the present publishes ' +
        "every other test file's due scheduled posts, sending their " +
        'notifications and federating their content. Keep the injected date ' +
        'behind real time, or give this suite its own database.'
    );
  }
  return now;
}
