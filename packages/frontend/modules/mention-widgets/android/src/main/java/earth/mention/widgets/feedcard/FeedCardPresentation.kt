package earth.mention.widgets.feedcard

import android.content.Context
import android.net.Uri
import earth.mention.widgets.R

/**
 * Turning a [WidgetPost] into the things the launcher shows and opens.
 *
 * Everything here needs a `Context` — a string resource, or a configured origin — which
 * is what separates it from `FeedCardModel.kt`. Every rule mirrors an existing in-app one
 * and cites it: a post has to read and behave the same on the home screen as it does in
 * the app, and a widget is the surface where a divergence is least likely to be noticed.
 */

/** Web origin the widget deep-links into; see `res/values/config.xml`. */
internal fun webBaseUrl(context: Context): String =
    context.getString(R.string.mention_widget_web_base_url).trimEnd('/')

/**
 * What tapping the card opens: the post's own screen.
 *
 * `/p/<id>` is the app's post route (`app/(app)/p/[id].tsx`) and the same path the
 * backend serves an OG shell for, so the link works whether it is opened by the app or
 * — if the app is ever uninstalled while a widget survives — by a browser.
 */
internal fun postUrl(context: Context, post: WidgetPost): String =
    "${webBaseUrl(context)}/p/${Uri.encode(post.id)}"


/**
 * Absolute URL for an Oxy media reference, at [variant].
 *
 * THE ONE PLACE in this widget that builds a media URL, and it exists because a widget
 * runs outside the JS runtime: the ecosystem's canonical resolver is
 * `oxyServices.getFileDownloadUrl(id, variant)`, and a Kotlin `BroadcastReceiver` cannot
 * call it. So the origin is a string resource — the same native mirror the module already
 * keeps for the API and web origins, overridable the same way, and deliberately ONE
 * chokepoint rather than a URL built at each call site.
 *
 * [reference] is passed through UNCHANGED when it is already absolute. A federated
 * actor's picture is either a bare Oxy file id, once we have re-hosted it, or the remote
 * URL until then, and the DTO makes no distinction between the two.
 *
 * Everything else the card draws needs no resolution at all: `MediaItem.thumbUrl` and a
 * link preview's `image` are absolute and server-resolved before they reach us
 * (`MediaItem` in packages/shared-types/src/post.ts — "Backends populate this so the
 * frontend never computes URLs from `id`").
 */
internal fun oxyFileUrl(context: Context, reference: String, variant: String): String {
    if (reference.startsWith("http://") || reference.startsWith("https://")) return reference
    val base = context.getString(R.string.mention_widget_media_base_url).trimEnd('/')
    return "$base/${Uri.encode(reference)}?variant=$variant"
}

/**
 * Variant the byline's avatar is fetched at.
 *
 * `w96` mirrors `MEDIA_VARIANT_AVATAR` (packages/shared-types/src/post.ts), which is what
 * every avatar in the app is rendered at — so the widget's request hits a variant the CDN
 * has already generated and warmed rather than adding a cold one. It is also the right
 * size on its own terms: the byline's avatar is 28dp, which is 84 pixels on a 3x screen.
 */
private const val AVATAR_VARIANT = "w96"

/** The byline avatar's URL, or `null` for an author with no picture. */
internal fun avatarUrl(context: Context, post: WidgetPost): String? =
    post.authorAvatar?.let { reference -> oxyFileUrl(context, reference, AVATAR_VARIANT) }

/**
 * Both of a post's image URLs, resolved — what the cache downloads for the post on screen.
 */
internal fun postImageUrls(context: Context, post: WidgetPost): List<String> =
    listOfNotNull(post.imageUrl, avatarUrl(context, post))

/**
 * Every image URL the whole rotation references — what the cache is allowed to KEEP.
 *
 * Wider than what is downloaded, on purpose: images arrive lazily as the rotation reaches
 * each post, and keeping the set means one full cycle re-downloads nothing while anything
 * left over from a previous fetch is still evicted.
 */
internal fun rotationImageUrls(context: Context, posts: List<WidgetPost>): List<String> =
    posts.flatMap { post -> postImageUrls(context, post) }

/**
 * The byline's handle, with its `@`, or EMPTY when the author's handle is unknown.
 *
 * Empty is a real case and not a defensive one: the backend's degraded author summary
 * carries an empty username precisely so that an unresolved user id can never be rendered
 * as a handle. The byline then shows the display name alone.
 */
internal fun bylineHandle(post: WidgetPost): String =
    if (post.authorHandle.isEmpty()) "" else "@${post.authorHandle}"

/**
 * What TalkBack reads for the card, which is one tap target.
 *
 * The post first and the author second, in that order, because that is the order the card
 * is designed to be read in — and the alternative would announce a display name before
 * the content that gives it context.
 */
internal fun cardContentDescription(context: Context, post: WidgetPost, text: String): String =
    context.getString(
        R.string.mention_feed_widget_card_description,
        text.ifEmpty { context.getString(R.string.mention_feed_widget_no_text) },
        post.authorName,
    )
