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
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.components.CircleIconButton
import androidx.glance.appwidget.components.FilledButton
import androidx.glance.appwidget.components.Scaffold
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
 * The trending-posts card: ONE post from Explore, rotating, as a full-bleed tonal
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
            // The card is the PRIMARY tap target, opening the post — 48dp minimum by a wide
            // margin. The rotation controls sit inside it and do compete for the tap, on
            // purpose: `RemoteViews` dispatches to the innermost view with an `onClick`, so a
            // tap on a chevron steps the rotation and a tap anywhere else opens the post. That
            // is the only reason two nested targets are acceptable here — the inner ones are
            // the full 48dp, so neither is a near-miss for the other.
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

        // Absorbs whatever height the placement actually has, so the brand row stays at the
        // top and the image and byline hug the bottom.
        Spacer(GlanceModifier.defaultWeight())

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
 * The card's picture, or NOTHING AT ALL.
 *
 * Emits no view and no gap in three cases, all of them ordinary rather than exceptional:
 * the small design has no slot, the post has no image (a third of the feed), or the image
 * failed to cache. A placeholder frame in any of them would make a perfectly good text post
 * look like a failed load.
 *
 * The bitmap is decoded HERE, in the composition, because `SizeMode.Responsive` composes
 * each declared size separately and each one wants a bitmap scaled for its own slot — the
 * same reason the sparkline rasterises inside its composable. It is a read from the app's
 * cache directory, never a fetch: `PostsRefreshWorker` has already put the file there.
 */
@Composable
private fun MediaSlot(post: WidgetPost, design: PostsCardSize, cardWidth: Dp) {
    val context = LocalContext.current
    val slotHeight = imageSlotHeight(design)
    val slotWidth = imageSlotWidth(design, cardWidth)

    // ONE `remember`, called unconditionally and holding everything that depends on the
    // size — the same discipline as the sparkline's rasterisation. Decoding on every
    // recomposition would re-scale the same picture each time the store emits, and the store
    // emits on every rotation tick.
    val bitmap = remember(post.imageUrl, slotWidth, slotHeight) {
        val url = post.imageUrl
        val size = if (slotHeight == null) null else thumbnailBitmapSize(slotWidth, slotHeight)
        val file = if (url == null) null else PostsImageCache.fileForComposition(context, url)
        if (size == null || file == null) {
            null
        } else {
            PostsImageRenderer.decodeCropped(
                file = file,
                size = size,
                // The radius in the bitmap's own pixels rather than in dp, so the curve comes
                // out at 20dp on screen after the launcher scales the bitmap into the slot.
                cornerRadiusPx = PostsCardDimensions.IMAGE_CORNER_RADIUS.value *
                    (size.widthPx / slotWidth.value),
            )
        }
    }

    if (bitmap != null && slotHeight != null) {
        Spacer(GlanceModifier.height(PostsCardDimensions.BLOCK_SPACING))
        Image(
            provider = ImageProvider(bitmap),
            // The author's alt text when there is one. Null — not an empty string — where
            // there is none, so a screen reader skips a decorative image instead of
            // announcing an unlabelled one.
            contentDescription = post.imageAlt,
            modifier = GlanceModifier.fillMaxWidth().height(slotHeight),
            // The bitmap was already cropped to this slot's aspect ratio, so nothing is
            // distorted or cropped a second time here.
            contentScale = ContentScale.FillBounds,
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
        // Takes the slack, so a long display name shrinks rather than pushing the pips off
        // the end of the row.
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
            // The handle is what the smallest design gives up: at 250 × 110dp the byline
            // shares its row with the pips, and a name plus a federated handle
            // (`verge@mastodon.social`) does not fit beside them.
            val handle = bylineHandle(post)
            if (design != PostsCardSize.SMALL && handle.isNotEmpty()) {
                Spacer(GlanceModifier.width(PostsCardDimensions.BYLINE_SPACING))
                Text(
                    text = handle,
                    style = PostsCardTextStyles.bylineHandle(contentColor),
                    maxLines = 1,
                    modifier = GlanceModifier.semantics { contentDescription = "" },
                )
            }
        }
        RotationControls(rotation = rotation, design = design, contentColor = contentColor)
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
 * Where in the rotation this post is, and how to move through it.
 *
 * ## Why the pips needed controls beside them
 *
 * They used to be indicators only, on the reasoning that a widget cannot be swiped — which is
 * true: `RemoteViews` has no gestures and Glance exposes none, so no app can put a swipe here.
 * But dots that cannot be dragged read as a broken carousel rather than as a position
 * readout, because dots mean "swipe me" everywhere else. Taps are the input a widget does
 * have, so the affordance the pips imply now exists (see `PostsRotationControl.kt`).
 *
 * ## Why the controls are dropped at [PostsCardSize.SMALL]
 *
 * The tap target is 48dp and is not shrunk to fit: at 250 × 110dp the byline already gives up
 * the author's handle for want of room, and two 48dp targets would take the byline to nearly
 * half the card's height — leaving the post itself, which is the content, with two lines.
 * Dropping the least-essential control as the surface narrows is this module's existing rule
 * (and the documented behaviour of Google's own canonical toolbar layout).
 *
 * That size is not left without movement: the automatic turn
 * (`PostsAutoAdvanceWorker`) runs at every size, so the smallest card is a glance surface that
 * cycles on its own, and the pips still say "one of five".
 *
 * Nothing at all is drawn for a rotation of one, where a single pip would say nothing and
 * there is nowhere to step to.
 */
@Composable
private fun RotationControls(
    rotation: PostsRotation,
    design: PostsCardSize,
    contentColor: ColorProvider,
) {
    if (rotation.posts.size <= 1) return

    val context = LocalContext.current
    val current = normalizeRotationIndex(rotation.index, rotation.posts.size)

    Spacer(GlanceModifier.width(PostsCardDimensions.BYLINE_SPACING))
    Row(verticalAlignment = Alignment.Vertical.CenterVertically) {
        if (design != PostsCardSize.SMALL) {
            RotationStepButton(
                icon = R.drawable.mention_widget_chevron_left,
                label = context.getString(R.string.mention_posts_widget_previous),
                action = actionRunCallback<PreviousPostAction>(),
            )
        }
        rotation.posts.indices.forEach { index ->
            if (index != 0) {
                Spacer(GlanceModifier.width(PostsCardDimensions.PIP_SPACING))
            }
            Image(
                provider = ImageProvider(
                    if (index == current) {
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
        if (design != PostsCardSize.SMALL) {
            RotationStepButton(
                icon = R.drawable.mention_widget_chevron_right,
                label = context.getString(R.string.mention_posts_widget_next),
                action = actionRunCallback<NextPostAction>(),
            )
        }
    }
}

/**
 * One rotation control.
 *
 * `backgroundColor = null` keeps it an icon on the card rather than a filled button: the card
 * is one large tap target that opens the post, and two filled buttons inside it would compete
 * with that for the eye. The 48dp target is still there whether or not anything is painted
 * under it.
 */
@Composable
private fun RotationStepButton(icon: Int, label: String, action: Action) {
    CircleIconButton(
        imageProvider = ImageProvider(icon),
        contentDescription = label,
        contentColor = GlanceTheme.colors.secondary,
        backgroundColor = null,
        onClick = action,
        modifier = GlanceModifier.size(PostsCardDimensions.CONTROL_SIZE),
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
