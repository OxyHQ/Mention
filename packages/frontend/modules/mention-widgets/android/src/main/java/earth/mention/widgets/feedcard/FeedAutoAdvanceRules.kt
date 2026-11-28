package earth.mention.widgets.feedcard

/** What one tick of a feed widget's auto-advance chain does. */
internal data class AutoAdvanceTick(val advance: Boolean, val rearm: Boolean)

/**
 * What a tick should do with the screen in this state — and the answer to the ONE question on
 * these widgets that a wrong answer freezes forever.
 *
 * Skipping the turn with the screen off is obvious: cycling a widget nobody can see costs
 * battery and buys nothing. Re-arming ANYWAY is the part that was wrong, and it was wrong in
 * the direction that cannot be noticed from a screenshot.
 *
 * The chain is the only clock these cards have. Its links are one-time requests, each enqueued
 * by the one before, so a link that ends without enqueueing the next ENDS THE CHAIN — and the
 * places that would start it again are `onEnabled`, which fires once, and `onUpdate`, which the
 * framework calls when the widget is created, when the app is updated, after a reboot, or on a
 * `updatePeriodMillis` tick that these providers set to 0. None of those is "the screen came
 * back on". So a tick that returned early on a dark screen left the rotation stopped until the
 * next reboot, which is exactly what a frozen widget looks like — and while the cards still had
 * chevrons the reader could step them by hand, so nobody found out.
 *
 * Re-arming on every tick means the chain survives the screen going off. The cost is a job that
 * wakes to check a boolean while the screen is dark; the platform is the right thing to throttle
 * that (Doze batches it into maintenance windows, and app-standby quota slows it further),
 * rather than this code deciding to stop and hoping something starts it again.
 *
 * Shared by both widgets deliberately: they had the same bug, and a rule about the one clock
 * they each depend on should not be written twice.
 */
internal fun autoAdvanceTick(screenInteractive: Boolean): AutoAdvanceTick = AutoAdvanceTick(
    advance = screenInteractive,
    rearm = true,
)
