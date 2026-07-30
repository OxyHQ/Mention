package earth.mention.widgets.feedcard

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.background
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.Text
import androidx.glance.unit.ColorProvider
import earth.mention.widgets.R
import earth.mention.widgets.trends.openInAppIntent

/**
 * THE feed card: ONE post from Explore, rotating, as a full-bleed tonal
 * container.
 *
 * The shape, top to bottom: a BRAND ROW saying where this came from, the POST TEXT as the
 * emphasised element, a MEDIA SLOT, and a small BYLINE with the rotation's position pips.
 *
 * ONE POST AT A TIME is the load-bearing decision, and it is about payload rather than
 * taste. Several posts with their attachments means an avatar and a thumbnail per post in
 * every declared size of the same `RemoteViews`, which is exactly the shape that overruns
 * the transaction and renders a blank widget. Rotating means the parcel carries at most one
 * avatar and one thumbnail per design.
 *
 * Written against the real explore feed rather than a happy path — over 30 consecutive
 * posts, 20% had attached media, 57% had a link preview, a third had neither, and the text
 * ran from 0 to 1708 characters. So every element here is optional except the brand row and
 * the byline, and each one collapses without leaving a hole.
 *
 * What Material 3 Expressive contributes on a surface that cannot animate: the tonal
 * container, an emphasised type scale, the rounded shape scale, and dynamic wallpaper
 * colour. Not shape morphing and not springy motion — this is `RemoteViews`, it does not
 * animate at all.
 */
@Composable
internal fun FeedCardContent(spec: FeedCardSpec, state: FeedCardState) {
    val context = LocalContext.current
    val widgetSize = LocalSize.current
    val design = feedCardSize(widgetSize.width, widgetSize.height)
    val padding = cardPadding(design)
    val post = (state as? FeedCardState.Rotating)?.rotation?.current
    // Computed here rather than inside the card, because the card's ACCESSIBILITY description
    // now lives on the outermost box and must name the same string the card draws. One call,
    // one answer, no chance of the two drifting.
    val cardText = post?.let {
        truncateToBudget(
            text = it.text,
            budget = textBudgetChars(
                size = design,
                availableWidthDp = widgetSize.width.value - padding.value * 2,
                cardHeight = widgetSize.height,
                // The user's font-size setting. Left out, a card at a 1.3 scale would hand its
                // TextView a third more text than fits and let it clip mid-word.
                fontScale = context.resources.configuration.fontScale,
            ),
        )
    }.orEmpty()
    val background = cardBackgroundBitmap(spec, post)
    // The one place this module reads a colour the theme did not choose. Over a photograph
    // the theme's `onPrimaryContainer` is a coin toss against the picture; with no
    // photograph it is exactly right. See [OVER_IMAGE_CONTENT_COLOR].
    val contentColor = if (background == null) {
        GlanceTheme.colors.onPrimaryContainer
    } else {
        OVER_IMAGE_CONTENT_COLOR
    }

    // A plain `Box`, not `Scaffold`, and the reason is geometric rather than stylistic.
    //
    // `Scaffold` applies a vertical padding of its own and exposes only `horizontalPadding`,
    // so the height its content actually receives is smaller than `LocalSize` by an amount
    // this file cannot name. Everything here — how many lines fit, whether the brand row
    // survives, how tall the text block is — is arithmetic against that height, and an
    // unknown subtrahend makes the whole sum wrong in the one direction that shows: the last
    // child, the byline, gets clipped. That is the avatar being cut off at small sizes.
    //
    // Nothing is lost with it. The tonal container is one `background` modifier. The rounded
    // corner was never `Scaffold`'s to give on this surface: the launcher clips widget
    // content to `system_app_widget_background_radius` itself, which this module verified on
    // a real launcher — the pixel just inside the widget's box but outside the card's arc is
    // wallpaper, at all four corners. Below API 31 Glance's own `cornerRadius` does nothing
    // either way.
    // The tap target and its press feedback belong on the OUTERMOST box, not on the padded
    // content inside it. On the inner one the launcher draws the pressed state within the
    // padding, so a card that is one tap target looks like a smaller button floating inside
    // itself. Here it covers the whole widget, which is what the card is.
    //
    // Only when there is a post to open. The signed-out and empty states carry their own
    // button, and a whole-card tap behind it would give the reader two targets for one action.
    val cardModifier = GlanceModifier
        .fillMaxSize()
        .background(GlanceTheme.colors.primaryContainer)
        .let { base ->
            if (post == null) {
                base
            } else {
                base
                    .semantics {
                        contentDescription = cardContentDescription(context, post, cardText)
                    }
                    .clickable(actionStartActivity(openInAppIntent(context, postUrl(context, post))))
            }
        }

    Box(cardModifier) {
        Box(GlanceModifier.fillMaxSize()) {
            if (background != null) {
                Image(
                    provider = ImageProvider(background),
                    // The author's alt text where there is one, so the picture is not
                    // silently dropped from the card's announcement now that it is the
                    // background. Null — not an empty string — where there is none, so a
                    // screen reader skips it rather than announcing an unlabelled image.
                    contentDescription = post?.imageAlt,
                    modifier = GlanceModifier.fillMaxSize(),
                    // CROP, not FillBounds: the bitmap is decoded at a fixed size that has
                    // nothing to do with this placement (which is what lets every
                    // composition share one), so the launcher is the thing that knows how to
                    // make it fit. Cropping keeps the photograph's proportions; stretching
                    // it to the card would not.
                    contentScale = ContentScale.Crop,
                )
            }
            Box(GlanceModifier.fillMaxSize().padding(padding)) {
                // Three states, one branch each, and the reason they are distinguished is on
                // `FeedCardState`: "nothing fetched yet" and "no session" look identical on a
                // card and mean opposite things to the reader.
                when (state) {
                    is FeedCardState.SignedOut -> FeedCardMessage(
                        spec = spec,
                        message = context.getString(state.message),
                        contentColor = contentColor,
                    )

                    is FeedCardState.Rotating -> {
                        if (post == null) {
                            FeedCardMessage(
                                spec = spec,
                                message = context.getString(spec.emptyMessage),
                                contentColor = contentColor,
                            )
                        } else {
                            PostCard(
                                spec = spec,
                                post = post,
                                text = cardText,
                                design = design,
                                cardHeight = widgetSize.height,
                                contentColor = contentColor,
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * The post's picture, decoded once for every composition of this update, or `null` when there
 * is nothing to draw.
 *
 * `null` is the ordinary case as much as the exceptional one: a third of the feed carries no
 * image, and a file that failed to cache looks the same from here. Both mean the card falls
 * back to its tonal container, which is a design rather than a fallback.
 *
 * The decode is keyed and shared through [FeedCardBitmapCache] rather than held in a
 * `remember`, and that is not an optimisation: `remember` is per composition, and Glance
 * composes this card once per size the launcher offers, so a remembered bitmap would be a
 * second copy of the same picture in the same parcel. See [FEED_CARD_WORST_CASE_BITMAP_BYTES].
 */
@Composable
private fun cardBackgroundBitmap(spec: FeedCardSpec, post: WidgetPost?): Bitmap? {
    val context = LocalContext.current
    val url = post?.imageUrl ?: return null

    // `remember` still, so a redraw that changes nothing does not re-enter the cache on the
    // launcher's clock — but keyed on the URL alone, since the size is a constant.
    return remember(url) {
        val size = cardBackgroundBitmapSize()
        FeedCardBitmapCache.getOrDecode(FeedCardBitmapCache.backgroundKey(url, size)) {
            val file = spec.images.fileForComposition(context, url) ?: return@getOrDecode null
            FeedImageRenderer.decodeCardBackground(file, size, IMAGE_SCRIM_ALPHA)
        }
    }
}

@Composable
private fun PostCard(
    spec: FeedCardSpec,
    post: WidgetPost,
    text: String,
    design: FeedCardSize,
    cardHeight: Dp,
    contentColor: ColorProvider,
) {
    val context = LocalContext.current

    // No tap target here: the whole card carries it, from the outermost box, so the pressed
    // state covers the widget rather than stopping at the padding.
    Column(modifier = GlanceModifier.fillMaxSize()) {
        val fontScale = context.resources.configuration.fontScale
        val lines = textMaxLines(design, cardHeight, fontScale)

        if (showsBrandRow(design, cardHeight, fontScale)) {
            BrandRow(spec = spec, contentColor = contentColor)
        }

        // `lines == 0` is a real state, not a guard: at the smallest placement the byline and
        // the padding already fill the card, and drawing one line anyway is what sliced a line
        // of text through the middle. A picture with an attribution is the honest card there.
        if (text.isNotEmpty() && lines > 0) {
            // Only when there is a brand row to be separated FROM. With no brand row the text
            // begins straight after the card's padding, and a spacer there is 8dp spent on
            // nothing — 8dp that at the small placement is a whole second line of the post.
            if (showsBrandRow(design, cardHeight, fontScale)) {
                Spacer(GlanceModifier.height(FeedCardDimensions.BLOCK_SPACING))
            }
            Text(
                text = text,
                style = FeedCardTextStyles.body(contentColor, design),
                // The second guard on truncation: `truncateToBudget` cut the string against
                // an estimate, and this bounds what happens if that estimate ran low.
                maxLines = lines,
                // THE TEXT takes the leftover height, not a spacer. It used to be the other
                // way round — a weighted `Spacer` below claimed every spare pixel, so a long
                // post was cut while the room it needed sat empty underneath it. The brand
                // row still sits at the top and the byline still hugs the bottom, because the
                // weight is what pushes them apart; the difference is which of them may grow.
                // An EXPLICIT height, not a weight. A weighted text block negotiates its
                // height with the launcher at layout time, and when its own measurement
                // disagrees with what the column has left, the byline gets pushed down —
                // which is what "the avatar sits on top of the text" was at the smallest
                // sizes. Every child now has a height this file already computed, so the sum
                // cannot exceed the card and nothing can be pushed out of it.
                modifier = GlanceModifier
                    .height(textBlockHeightDp(design, fontScale, lines).dp)
                    .semantics { contentDescription = "" },
            )
        }

        // The leftover goes here, so the brand row stays at the top and the byline hugs the
        // bottom whether or not there is any text.
        Spacer(GlanceModifier.defaultWeight())

        Byline(spec = spec, post = post, design = design, contentColor = contentColor)
    }
}

/**
 * Whose widget this is, and where the post came from.
 *
 * Deliberately the quietest thing on the card: Explore is context for the post, not a
 * headline of its own.
 */
@Composable
private fun BrandRow(spec: FeedCardSpec, contentColor: ColorProvider) {
    val context = LocalContext.current
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        Image(
            provider = ImageProvider(R.drawable.mention_widget_brand),
            // The words beside it say the same thing, and the card's own description
            // already names the app.
            contentDescription = null,
            modifier = GlanceModifier.size(FeedCardDimensions.BRAND_MARK_SIZE),
            colorFilter = ColorFilter.tint(contentColor),
        )
        Spacer(GlanceModifier.width(FeedCardDimensions.BRAND_SPACING))
        Text(
            text = context.getString(spec.eyebrow),
            style = FeedCardTextStyles.brand(contentColor),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
    }
}

/**
 * Who wrote it, and where the rotation is.
 *
 * SMALL AND SECONDARY BY DESIGN, and that is also the content mitigation on this surface:
 * post content is filtered server-side by the discovery sources' safety match, but an
 * author's DISPLAY NAME is an identity field no content filter covers, and offensive ones
 * exist in the real feed. The answer is that the byline never competes with the post —
 * not a name filter, and not silently dropping the post.
 */
@Composable
private fun Byline(
    spec: FeedCardSpec,
    post: WidgetPost,
    design: FeedCardSize,
    contentColor: ColorProvider,
) {
    Spacer(GlanceModifier.height(FeedCardDimensions.BLOCK_SPACING))
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        BylineAvatar(spec = spec, post = post)
        // Takes the slack, so a long display name shrinks rather than pushing the handle off
        // the end of the row.
        Row(
            modifier = GlanceModifier.defaultWeight(),
            verticalAlignment = Alignment.Vertical.CenterVertically,
        ) {
            Text(
                text = post.authorName,
                style = FeedCardTextStyles.bylineName(contentColor),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
            // The handle is what the smallest design gives up: at 250 × 110dp a name plus a
            // federated handle (`verge@mastodon.social`) does not fit on one line, and the
            // name is the half that identifies the author.
            val handle = bylineHandle(post)
            if (design != FeedCardSize.SMALL && handle.isNotEmpty()) {
                Spacer(GlanceModifier.width(FeedCardDimensions.BYLINE_SPACING))
                Text(
                    text = handle,
                    style = FeedCardTextStyles.bylineHandle(contentColor),
                    maxLines = 1,
                    modifier = GlanceModifier.semantics { contentDescription = "" },
                )
            }
        }
    }
}

/**
 * The author's picture, or nothing.
 *
 * Nothing, rather than a monogram or a silhouette: the name is right beside it, so a
 * placeholder would add a shape without adding information.
 */
@Composable
private fun BylineAvatar(spec: FeedCardSpec, post: WidgetPost) {
    val context = LocalContext.current
    val url = avatarUrl(context, post)

    // Through the shared cache for the same reason the background is: one instance across the
    // compositions of one update is one copy in the parcel. Measured — with the avatar decoded
    // per composition the launcher reported 264,224 bytes for a card whose two bitmaps come to
    // 251,680, the difference being a second copy of this 12.5KB circle.
    val bitmap = remember(url) {
        val size = avatarBitmapSize()
        if (url == null || size == null) {
            null
        } else {
            FeedCardBitmapCache.getOrDecode(FeedCardBitmapCache.avatarKey(url, size)) {
                val file = spec.images.fileForComposition(context, url)
                    ?: return@getOrDecode null
                FeedImageRenderer.decodeCircular(file, size)
            }
        }
    }

    if (bitmap != null) {
        Image(
            provider = ImageProvider(bitmap),
            // The name beside it is the label; announcing the picture as well would read the
            // author twice.
            contentDescription = null,
            modifier = GlanceModifier.size(FeedCardDimensions.AVATAR_SIZE),
            contentScale = ContentScale.FillBounds,
        )
        Spacer(GlanceModifier.width(FeedCardDimensions.BYLINE_SPACING))
    }
}

/**
 * Shown only when there has never been a successful fetch.
 *
 * A failed refresh leaves the previous rotation in place, so this is a first-run state
 * rather than an error state — and there is deliberately no spinner: a widget that rests on
 * a spinner looks broken every time the user glances at it.
 */
@Composable
private fun FeedCardMessage(spec: FeedCardSpec, message: String, contentColor: ColorProvider) {
    val context = LocalContext.current
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = message,
            style = FeedCardTextStyles.emptyMessage(contentColor),
            // Two lines rather than one: "Sign in to see the accounts you follow" does not
            // fit on a single line of a 250dp card, and a signed-out reader is precisely the
            // one who cannot afford the explanation to be clipped.
            maxLines = 2,
        )
        Spacer(GlanceModifier.height(FeedCardDimensions.BLOCK_SPACING))
        FilledButton(
            text = context.getString(R.string.mention_feed_widget_open_app),
            onClick = actionStartActivity(
                openInAppIntent(context, spec.feedScreenUrl(context)),
            ),
            maxLines = 1,
        )
    }
}
