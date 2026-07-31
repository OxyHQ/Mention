package earth.mention.widgets.posts

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.appwidget.components.Scaffold
import androidx.glance.appwidget.cornerRadius
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
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
 * The trending-posts card: ONE post from Explore, rotating, as a full-bleed tonal
 * container.
 *
 * The shape, top to bottom: a BRAND ROW saying where this came from, the POST TEXT as the
 * emphasised element, a MEDIA SLOT, and a BOTTOM BAR carrying the byline, the rotation's
 * position pips and the control that advances them.
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
internal fun PostsWidgetContent(rotation: PostsRotation) {
    val widgetSize = LocalSize.current
    val design = postsCardSize(widgetSize.width, widgetSize.height)
    val padding = if (design == PostsCardSize.SMALL) {
        PostsCardDimensions.PADDING_SMALL
    } else {
        PostsCardDimensions.PADDING
    }
    val contentColor = GlanceTheme.colors.onPrimaryContainer

    Scaffold(
        // The tonal container IS the widget — there is no chrome outside it. The corner
        // comes from `Scaffold`, which applies the launcher's own
        // `system_app_widget_background_radius` on API 31+; setting one here would draw a
        // second, mismatched curve just inside the host's.
        backgroundColor = GlanceTheme.colors.primaryContainer,
        horizontalPadding = 0.dp,
    ) {
        Box(GlanceModifier.fillMaxSize().padding(padding)) {
            val post = rotation.current
            if (post == null) {
                PostsEmptyContent(contentColor)
            } else {
                PostCard(
                    post = post,
                    rotation = rotation,
                    design = design,
                    cardWidth = widgetSize.width,
                    padding = padding,
                    contentColor = contentColor,
                )
            }
        }
    }
}

@Composable
private fun PostCard(
    post: WidgetPost,
    rotation: PostsRotation,
    design: PostsCardSize,
    cardWidth: Dp,
    padding: Dp,
    contentColor: ColorProvider,
) {
    val context = LocalContext.current
    val text = truncateToBudget(
        text = post.text,
        budget = textBudgetChars(
            size = design,
            availableWidthDp = cardWidth.value - padding.value * 2,
            // The user's font-size setting. Left out, a card at a 1.3 scale would hand its
            // TextView a third more text than fits and let it clip mid-word.
            fontScale = context.resources.configuration.fontScale,
        ),
    )

    Column(
        modifier = GlanceModifier
            .fillMaxSize()
            // The card is the PRIMARY tap target and it opens the post — 48dp minimum by a
            // wide margin. The one thing that competes for a tap is the advance control in the
            // bottom bar, which is deliberately 48dp of a corner: everywhere else on the card,
            // including all of the text and the picture, still opens the post.
            .semantics { contentDescription = cardContentDescription(context, post, text) }
            .clickable(actionStartActivity(openInAppIntent(context, postUrl(context, post)))),
    ) {
        BrandRow(contentColor)

        if (text.isNotEmpty()) {
            Spacer(GlanceModifier.height(PostsCardDimensions.BLOCK_SPACING))
            Text(
                text = text,
                style = PostsCardTextStyles.body(contentColor, design),
                // The second guard on truncation: `truncateToBudget` cut the string against
                // an estimate, and this bounds what happens if that estimate ran low.
                maxLines = textMaxLines(design),
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }

        // The card's ONE flexible element, which is what absorbs whatever height the
        // placement actually has: the picture grows into it, and where there is no picture it
        // is empty space that keeps the byline on the bottom edge.
        MediaSlot(post = post, design = design, cardWidth = cardWidth)
        Byline(post = post, rotation = rotation, design = design, contentColor = contentColor)
    }
}

/**
 * Whose widget this is, and where the post came from.
 *
 * Deliberately the quietest thing on the card: Explore is context for the post, not a
 * headline of its own.
 */
@Composable
private fun BrandRow(contentColor: ColorProvider) {
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
            modifier = GlanceModifier.size(PostsCardDimensions.BRAND_MARK_SIZE),
            colorFilter = ColorFilter.tint(contentColor),
        )
        Spacer(GlanceModifier.width(PostsCardDimensions.BRAND_SPACING))
        Text(
            text = context.getString(R.string.mention_posts_widget_eyebrow),
            style = PostsCardTextStyles.brand(contentColor),
            maxLines = 1,
            modifier = GlanceModifier.semantics { contentDescription = "" },
        )
    }
}

/**
 * The card's picture, TAKING WHATEVER HEIGHT IS LEFT — or nothing at all.
 *
 * THE BAND IS ALWAYS EMITTED and it is always the card's one flexible element. That is the
 * fix for the empty strip a reader could see under the text: the brand row, the text and the
 * byline each take the height they need, and this takes the rest, so the picture grows into
 * space that used to be a gap. Where there is no picture the band is an empty weighted
 * spacer, which draws nothing and keeps the byline on the bottom edge — dropping it
 * altogether would let the whole card cluster at the top of a taller placement.
 *
 * The text keeps its priority by construction rather than by arithmetic: it is
 * `wrap_content` and this is the weighted child, so a `LinearLayout` measures the text first
 * and hands the remainder here. A post that fills every line it is allowed leaves the
 * picture little or nothing; a one-line post leaves it a lot.
 *
 * NO PICTURE is three ordinary cases, not exceptions: the small design has no band content
 * ([imageSlotBaseHeight] is `null` there), the post has no image (a third of the feed), or
 * the image failed to cache. A placeholder frame in any of them would make a perfectly good
 * text post look like a failed load.
 *
 * WHY THE BITMAP IS STILL A FIXED SIZE, when the container is not. A composition cannot know
 * the height the launcher will hand this view — `SizeMode.Responsive` composes for a
 * DECLARED size and the real placement is at least that big — and bitmaps are the thing that
 * overruns the `RemoteViews` transaction. So the bitmap is decoded for
 * [imageSlotBaseHeight], the height the band has when there is no slack, and
 * `ContentScale.Crop` covers a taller band by scaling and cropping instead of stretching.
 * A grown band therefore costs a softer picture and never a byte of payload
 * ([POSTS_WORST_CASE_BITMAP_BYTES] does not move), which is the right way round: a slightly
 * soft thumbnail beats a blank widget.
 *
 * The corner is rounded TWICE, and both are load-bearing. `PostsImageRenderer` rounds the
 * pixels, which is the only thing that works below API 31 and is exact while the band is at
 * its base height; `cornerRadius` re-rounds the view for the case `Crop` has cut those
 * pixels away, which it can only do on API 31+. An API 23–30 device with a grown band gets a
 * square-cornered picture — the one visual cost of flexing, and the reason to prefer
 * composing for the real size if that becomes an option.
 *
 * The bitmap is decoded HERE, in the composition, because `SizeMode.Responsive` composes
 * each declared size separately and each one wants a bitmap scaled for its own band — the
 * same reason the sparkline rasterises inside its composable. It is a read from the app's
 * cache directory, never a fetch: `PostsRefreshWorker` has already put the file there.
 */
@Composable
private fun ColumnScope.MediaSlot(post: WidgetPost, design: PostsCardSize, cardWidth: Dp) {
    val context = LocalContext.current
    val baseHeight = imageSlotBaseHeight(design)
    val slotWidth = imageSlotWidth(design, cardWidth)

    // ONE `remember`, called unconditionally and holding everything that depends on the
    // size — the same discipline as the sparkline's rasterisation. Decoding on every
    // recomposition would re-scale the same picture each time the store emits, and the store
    // emits on every rotation tick.
    val bitmap = remember(post.imageUrl, slotWidth, baseHeight) {
        val url = post.imageUrl
        val size = if (baseHeight == null) null else thumbnailBitmapSize(slotWidth, baseHeight)
        val file = if (url == null) null else PostsImageCache.fileForComposition(context, url)
        if (size == null || file == null) {
            null
        } else {
            PostsImageRenderer.decodeCropped(
                file = file,
                size = size,
                // The radius in the bitmap's own pixels rather than in dp, so the curve comes
                // out at 20dp on screen after the launcher scales the bitmap into the band.
                cornerRadiusPx = PostsCardDimensions.IMAGE_CORNER_RADIUS.value *
                    (size.widthPx / slotWidth.value),
            )
        }
    }

    if (bitmap == null) {
        Spacer(GlanceModifier.defaultWeight())
    } else {
        Spacer(GlanceModifier.height(PostsCardDimensions.BLOCK_SPACING))
        Image(
            provider = ImageProvider(bitmap),
            // The author's alt text when there is one. Null — not an empty string — where
            // there is none, so a screen reader skips a decorative image instead of
            // announcing an unlabelled one.
            contentDescription = post.imageAlt,
            modifier = GlanceModifier
                .fillMaxWidth()
                .defaultWeight()
                .cornerRadius(PostsCardDimensions.IMAGE_CORNER_RADIUS),
            // Cover, not stretch: the band's aspect is decided by the launcher and the
            // bitmap's by this composition, so the two do not match and `FillBounds` would
            // squash the photograph by however much the band grew.
            contentScale = ContentScale.Crop,
        )
    }
}

/**
 * Who wrote it, where the rotation is, and the control that moves it — the card's bottom
 * bar.
 *
 * The byline itself is SMALL AND SECONDARY BY DESIGN, and that is also the content
 * mitigation on this surface: post content is filtered server-side by the discovery
 * sources' safety match, but an author's DISPLAY NAME is an identity field no content
 * filter covers, and offensive ones exist in the real feed. The answer is that the byline
 * never competes with the post — not a name filter, and not silently dropping the post.
 *
 * The row is 48dp tall wherever it carries the control, against the avatar's 28dp
 * everywhere else, and [imageSlotBaseHeight] has already given those 20dp back.
 */
@Composable
private fun Byline(
    post: WidgetPost,
    rotation: PostsRotation,
    design: PostsCardSize,
    contentColor: ColorProvider,
) {
    Spacer(GlanceModifier.height(PostsCardDimensions.BLOCK_SPACING))
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        BylineAvatar(post)
        // Takes the slack, so a long display name shrinks rather than pushing the pips or
        // the control off the end of the row.
        Row(
            modifier = GlanceModifier.defaultWeight(),
            verticalAlignment = Alignment.Vertical.CenterVertically,
        ) {
            Text(
                text = post.authorName,
                style = PostsCardTextStyles.bylineName(contentColor),
                maxLines = 1,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
            // The handle is what every design but the widest gives up. On a 250dp card the
            // byline row now shares its width with five pips and a 48dp control, which leaves
            // about 72dp for the name alone — a name plus a federated handle
            // (`verge@mastodon.social`) does not fit beside them, and the name is the half
            // that identifies the author.
            val handle = bylineHandle(post)
            if (design == PostsCardSize.LARGE && handle.isNotEmpty()) {
                Spacer(GlanceModifier.width(PostsCardDimensions.BYLINE_SPACING))
                Text(
                    text = handle,
                    style = PostsCardTextStyles.bylineHandle(contentColor),
                    maxLines = 1,
                    modifier = GlanceModifier.semantics { contentDescription = "" },
                )
            }
        }
        // Together or not at all: dots without the control beside them are the swipe
        // affordance this surface cannot offer.
        if (showsAdvanceControl(design, rotation.posts.size)) {
            RotationPips(rotation = rotation, contentColor = contentColor)
            AdvanceControl(rotation = rotation)
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
private fun BylineAvatar(post: WidgetPost) {
    val context = LocalContext.current
    val url = avatarUrl(context, post)

    val bitmap = remember(url) {
        val size = avatarBitmapSize()
        val file = if (url == null) null else PostsImageCache.fileForComposition(context, url)
        if (size == null || file == null) null else PostsImageRenderer.decodeCircular(file, size)
    }

    if (bitmap != null) {
        Image(
            provider = ImageProvider(bitmap),
            // The name beside it is the label; announcing the picture as well would read the
            // author twice.
            contentDescription = null,
            modifier = GlanceModifier.size(PostsCardDimensions.AVATAR_SIZE),
            contentScale = ContentScale.FillBounds,
        )
        Spacer(GlanceModifier.width(PostsCardDimensions.BYLINE_SPACING))
    }
}

/**
 * Where in the rotation this post is.
 *
 * An INDICATOR for the control beside it, which is the only reading that has ever been
 * honest on this surface: dots on their own mean "swipeable" to anyone who has used a
 * phone, and a `RemoteViews` widget has no gestures at all. [showsAdvanceControl] is what
 * keeps the two together, so this draws unconditionally and never has to ask whether the
 * card can be advanced.
 *
 * The filled pip is [PostsRotation.position] — the same normalisation the drawn post came
 * through, so the highlight cannot point at a different post than the card is showing.
 */
@Composable
private fun RotationPips(rotation: PostsRotation, contentColor: ColorProvider) {
    Spacer(GlanceModifier.width(PostsCardDimensions.BYLINE_SPACING))
    Row(verticalAlignment = Alignment.Vertical.CenterVertically) {
        rotation.posts.indices.forEach { index ->
            if (index != 0) {
                Spacer(GlanceModifier.width(PostsCardDimensions.PIP_SPACING))
            }
            Image(
                provider = ImageProvider(
                    if (index == rotation.position) {
                        R.drawable.mention_widget_pip
                    } else {
                        R.drawable.mention_widget_pip_dim
                    },
                ),
                contentDescription = null,
                modifier = GlanceModifier.size(PostsCardDimensions.PIP_SIZE),
                colorFilter = ColorFilter.tint(contentColor),
            )
        }
    }
}

/**
 * The one thing on this card that can move the rotation: NEXT.
 *
 * FORWARD ONLY, and that is a decision rather than an omission. The byline row on a 250dp
 * card — the default placement — has 218dp of content width, and the avatar, its gap, five
 * pips and one 48dp control already leave about 72dp for the author's name; a second 48dp
 * control would cut that to roughly 16dp, which is not a byline. Forward alone still reaches
 * every post, because the rotation is a ring of five: the post "before" this one is four
 * taps away, and it is the same four taps a reader would need to come back round to it
 * anyway. The pips say where the ring is, and say nothing about direction.
 *
 * Glance's own `CircleIconButton` rather than a hand-built `Box`, for the same reason the
 * trends title bar uses it: it carries Material's shape, the ripple, and the pre-API-31
 * fallbacks that a `cornerRadius` modifier does not have. Filled, in the theme's `primary`
 * against the card's `primaryContainer`, because the defect being fixed here was a reader who
 * could not tell there was anything to press — a quiet outline would be the same mistake in a
 * different shape.
 *
 * It sits INSIDE the card's own clickable, which stays the primary target: the post is what
 * the card is for, and this is 48dp of its bottom corner.
 */
@Composable
private fun AdvanceControl(rotation: PostsRotation) {
    val context = LocalContext.current
    Spacer(GlanceModifier.width(PostsCardDimensions.BYLINE_SPACING))
    CircleIconButton(
        imageProvider = ImageProvider(R.drawable.mention_widget_next),
        contentDescription = advanceContentDescription(context, rotation),
        backgroundColor = GlanceTheme.colors.primary,
        contentColor = GlanceTheme.colors.onPrimary,
        modifier = GlanceModifier.size(PostsCardDimensions.ADVANCE_CONTROL_SIZE),
        onClick = actionRunCallback<PostsAdvanceAction>(),
    )
}

/**
 * Shown only when there has never been a successful fetch.
 *
 * A failed refresh leaves the previous rotation in place, so this is a first-run state
 * rather than an error state — and there is deliberately no spinner: a widget that rests on
 * a spinner looks broken every time the user glances at it.
 */
@Composable
private fun PostsEmptyContent(contentColor: ColorProvider) {
    val context = LocalContext.current
    Column(
        modifier = GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
    ) {
        Text(
            text = context.getString(R.string.mention_posts_widget_empty),
            style = PostsCardTextStyles.emptyMessage(contentColor),
            maxLines = 1,
        )
        Spacer(GlanceModifier.height(PostsCardDimensions.BLOCK_SPACING))
        FilledButton(
            text = context.getString(R.string.mention_posts_widget_open_app),
            onClick = actionStartActivity(openInAppIntent(context, exploreScreenUrl(context))),
            maxLines = 1,
        )
    }
}
