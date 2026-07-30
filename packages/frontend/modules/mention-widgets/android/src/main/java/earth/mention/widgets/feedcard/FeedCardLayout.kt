package earth.mention.widgets.feedcard

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
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
                    val post = state.rotation.current
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
                            rotation = state.rotation,
                            design = design,
                            cardSize = widgetSize,
                            padding = padding,
                            contentColor = contentColor,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun PostCard(
    spec: FeedCardSpec,
    post: WidgetPost,
    rotation: FeedRotation,
    design: FeedCardSize,
    cardSize: DpSize,
    padding: Dp,
    contentColor: ColorProvider,
) {
    val context = LocalContext.current
    val contentWidthDp = cardSize.width.value - padding.value * 2
    // The user's font-size setting. Left out, a card at a 1.3 scale would hand its TextView
    // a third more text than fits, and would reserve a third too little height for it.
    val fontScale = context.resources.configuration.fontScale
    val text = truncateToBudget(
        text = post.text,
        budget = textBudgetChars(design, contentWidthDp, fontScale),
    )
    // ONE line count, used twice: as the `Text`'s own `maxLines` and as what the picture's
    // height is measured against. Two separate figures here is how a card comes to reserve
    // room for lines it never draws, or to draw lines it never reserved.
    val textLines = textLinesFor(design, text.length, contentWidthDp, fontScale)
    val showsControls = showsRotationControls(design, rotation.posts.size)

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
        BrandRow(spec = spec, contentColor = contentColor)

        if (textLines > 0) {
            Spacer(GlanceModifier.height(FeedCardDimensions.BLOCK_SPACING))
            Text(
                text = text,
                style = FeedCardTextStyles.body(contentColor, design),
                // The lines the card RESERVED, so the text can never take height the picture
                // was measured against. `truncateToBudget` has already cut the string to an
                // estimate of the same width; this is what bounds the estimate running low.
                maxLines = textLines,
                modifier = GlanceModifier.semantics { contentDescription = "" },
            )
        }

        // Takes up the difference between the lines reserved and the lines the launcher
        // actually drew — the estimate errs towards reserving one line too many, and this is
        // where that dp goes rather than into a gap under the byline.
        Spacer(GlanceModifier.defaultWeight())

        MediaSlot(
            spec = spec,
            post = post,
            slotWidth = imageSlotWidth(design, cardSize.width),
            slotHeight = imageSlotHeight(
                size = design,
                widgetHeight = cardSize.height,
                textLines = textLines,
                showsRotationControls = showsControls,
                fontScale = fontScale,
            ),
        )
        Byline(
            spec = spec,
            post = post,
            rotation = rotation,
            design = design,
            contentColor = contentColor,
        )
        if (showsControls) {
            RotationControlRow(spec = spec, rotation = rotation, contentColor = contentColor)
        }
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
 * The card's picture, or NOTHING AT ALL.
 *
 * Emits no view and no gap in three cases, all of them ordinary rather than exceptional:
 * [slotHeight] is null because the card has no room to spare (the small design always, a
 * taller one whose text ran long), the post has no image (a third of the feed), or the image
 * failed to cache. A placeholder frame in any of them would make a perfectly good text post
 * look like a failed load.
 *
 * The bitmap is decoded HERE, in the composition, because the slot's height depends on the
 * placement and on the post's own text, so the picture cannot be scaled ahead of time — the
 * same reason the sparkline rasterises inside its composable. It is a read from the app's
 * cache directory, never a fetch: `PostsRefreshWorker` has already put the file there.
 */
@Composable
private fun MediaSlot(
    spec: FeedCardSpec,
    post: WidgetPost,
    slotWidth: Dp,
    slotHeight: Dp?,
) {
    val context = LocalContext.current

    // ONE `remember`, called unconditionally and holding everything that depends on the
    // size — the same discipline as the sparkline's rasterisation. Decoding on every
    // recomposition would re-scale the same picture each time the store emits, and the store
    // emits on every rotation tick.
    val bitmap = remember(post.imageUrl, slotWidth, slotHeight) {
        val url = post.imageUrl
        val size = if (slotHeight == null) null else thumbnailBitmapSize(slotWidth, slotHeight)
        val file = if (url == null) null else spec.images.fileForComposition(context, url)
        if (size == null || file == null) {
            null
        } else {
            FeedImageRenderer.decodeCropped(
                file = file,
                size = size,
                // The radius in the bitmap's own pixels rather than in dp, so the curve comes
                // out at 20dp on screen after the launcher scales the bitmap into the slot.
                cornerRadiusPx = FeedCardDimensions.IMAGE_CORNER_RADIUS.value *
                    (size.widthPx / slotWidth.value),
            )
        }
    }

    if (bitmap != null && slotHeight != null) {
        Spacer(GlanceModifier.height(FeedCardDimensions.BLOCK_SPACING))
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
    spec: FeedCardSpec,
    post: WidgetPost,
    rotation: FeedRotation,
    design: FeedCardSize,
    contentColor: ColorProvider,
) {
    Spacer(GlanceModifier.height(FeedCardDimensions.BLOCK_SPACING))
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
    ) {
        BylineAvatar(spec = spec, post = post)
        // Takes the slack, so a long display name shrinks rather than pushing the pips off
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
            // The handle is what the smallest design gives up: at 250 × 110dp the byline
            // shares its row with the pips, and a name plus a federated handle
            // (`verge@mastodon.social`) does not fit beside them.
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
        RotationPips(rotation = rotation, design = design, contentColor = contentColor)
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

    val bitmap = remember(url) {
        val size = avatarBitmapSize()
        val file = if (url == null) null else spec.images.fileForComposition(context, url)
        if (size == null || file == null) null else FeedImageRenderer.decodeCircular(file, size)
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
 * Where in the rotation this post is.
 *
 * Kept in the byline because the pips are 6dp and cost nothing there. The CONTROLS are not:
 * see [RotationControlRow] for why they have a row of their own, and why the pips move down
 * to join them when that row exists.
 *
 * Nothing at all for a rotation of one, where a single pip would say nothing and there is
 * nowhere to step to.
 */
@Composable
private fun RotationPips(
    rotation: FeedRotation,
    design: FeedCardSize,
    contentColor: ColorProvider,
) {
    // At every size but the smallest the pips live in the control row instead, beside the
    // chevrons they belong with.
    if (rotation.posts.size <= 1 || design != FeedCardSize.SMALL) return

    Spacer(GlanceModifier.width(FeedCardDimensions.BYLINE_SPACING))
    Pips(rotation = rotation, contentColor = contentColor)
}

/**
 * The rotation's own row: step back, position, step forward.
 *
 * ## Why the pips needed controls at all
 *
 * They used to be indicators only, on the reasoning that a widget cannot be swiped — which is
 * true: `RemoteViews` has no gestures, Glance exposes none, and no app can add one. But dots
 * that cannot be dragged read as a broken carousel rather than as a position readout, because
 * dots mean "swipe me" everywhere else. Taps are the input a widget does have, so the
 * affordance the pips imply now exists (see `PostsRotationControl.kt`).
 *
 * ## Why they are NOT in the byline
 *
 * They were, and the forward control did not survive it — verified on a real launcher, not
 * reasoned about: with the chevrons appended after the byline's weighted name, the row
 * overflowed and Android dropped the last child, leaving a card with `previous` and no `next`.
 * A `RemoteViews` row is a `LinearLayout` measured in the launcher's process, so the space a
 * name will actually claim is not knowable here — which makes any fix that shares one row with
 * flexible text a guess.
 *
 * A row of its own removes the contention rather than tuning it, and the space was already
 * there: a post with no picture leaves the card visibly empty above the byline.
 *
 * ## Why nothing is drawn at [FeedCardSize.SMALL]
 *
 * 48dp is Material's minimum touch target and is not shrunk to fit. At 250 × 110dp the card
 * has a brand row, two lines of text and a byline; another 48dp row would take roughly half
 * of it. Dropping the least-essential control as the surface narrows is this module's existing
 * rule, and that size keeps its pips in the byline and its automatic turn
 * (`PostsAutoAdvanceWorker`), so it is a glance surface that still moves.
 *
 * Whether this row is drawn at all is [showsRotationControls], asked by the caller — the same
 * predicate the picture's height is reserved against, so the 48dp is charged exactly when it
 * is spent.
 */
@Composable
private fun RotationControlRow(
    spec: FeedCardSpec,
    rotation: FeedRotation,
    contentColor: ColorProvider,
) {
    val context = LocalContext.current
    Row(
        modifier = GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.Vertical.CenterVertically,
        horizontalAlignment = Alignment.Horizontal.End,
    ) {
        RotationStepButton(
            icon = R.drawable.mention_widget_chevron_left,
            label = context.getString(R.string.mention_feed_widget_previous),
            action = spec.previousAction,
        )
        Pips(rotation = rotation, contentColor = contentColor)
        RotationStepButton(
            icon = R.drawable.mention_widget_chevron_right,
            label = context.getString(R.string.mention_feed_widget_next),
            action = spec.nextAction,
        )
    }
}

/** The pips themselves — one filled, the rest dim. */
@Composable
private fun Pips(rotation: FeedRotation, contentColor: ColorProvider) {
    val current = normalizeRotationIndex(rotation.index, rotation.posts.size)
    Row(verticalAlignment = Alignment.Vertical.CenterVertically) {
        rotation.posts.indices.forEach { index ->
            if (index != 0) {
                Spacer(GlanceModifier.width(FeedCardDimensions.PIP_SPACING))
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
                modifier = GlanceModifier.size(FeedCardDimensions.PIP_SIZE),
                colorFilter = ColorFilter.tint(contentColor),
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
        modifier = GlanceModifier.size(FeedCardDimensions.CONTROL_SIZE),
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
