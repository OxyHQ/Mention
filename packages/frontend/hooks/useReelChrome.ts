import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Platform, type LayoutChangeEvent } from 'react-native';
import { useSharedValue, useAnimatedStyle, withSequence, withTiming } from 'react-native-reanimated';
import { useEventListener } from 'expo';
import { VideoView, isPictureInPictureSupported, type VideoPlayer } from 'expo-video';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { toast } from '@oxyhq/bloom/toast';
import { createLogger } from '@oxyhq/core/logger';
import type { MediaPixelSize } from '@/utils/mediaTypes';
import { useVideoPlayback } from '@/context/VideoPlaybackContext';
import { usePipAspectRatio } from '@/hooks/usePipAspectRatio';

/**
 * EVERYTHING A REEL SURFACE DOES AROUND ITS PLAYER.
 *
 * The reels surface is one component doing two separable jobs: owning a
 * `VideoPlayer`, and driving the ~20 pieces of chrome that sit on top of it —
 * the poster, the double-tap heart, the mute and Picture-in-Picture buttons,
 * the scrubber, the buffering spinner, the playback gate, the wake lock and the
 * transport registration. Only the first job cares WHERE the player came from.
 *
 * Splitting them lets the second job be handed a player it did not create,
 * which is what a shared player registry needs: `useVideoPlayer` binds a
 * player's lifetime to its component, so a video that has to outlive the
 * surface must be built elsewhere and passed in. A hook cannot be called
 * conditionally, so the cut is made here rather than by branching inside the
 * component — the chrome takes `player` as an argument and never asks how it
 * was made.
 *
 * This hook is a pure extraction: every decision below was already being made
 * in `ActiveVideoSurface`, in this order, with these dependencies.
 */

// Same tag the reels screen logs under: this code did not move surfaces, only
// files, and its two debug lines should stay findable where they always were.
const logger = createLogger('VideosScreen');

/**
 * Whether this platform can put a video in the OS Picture-in-Picture window.
 *
 * NOT simply `isPictureInPictureSupported()`: that export goes through
 * expo-video's `NativeVideoModule`, and the module's WEB shim
 * (`NativeVideoModule.web.ts`) defines only `VideoThumbnail`. Calling it in a
 * browser therefore throws `isPictureInPictureSupported is not a function` and
 * takes the whole screen down. `tsc` cannot see it — the types come from the
 * NATIVE module declaration, so the web shim's missing method typechecks fine.
 *
 * On web, feature-detect the DOM API directly (what expo-video's own web
 * `VideoView` does); on native the module call is the real capability check.
 */
function supportsPictureInPicture(): boolean {
    if (Platform.OS === 'web') {
        return typeof document !== 'undefined' && typeof document.exitPictureInPicture === 'function';
    }
    return isPictureInPictureSupported();
}

// Max delay (ms) between two surface taps to register a double-tap-like instead
// of the single-tap pause toggle.
const DOUBLE_TAP_WINDOW_MS = 280;

// Namespace for this screen's playback ids in the app-wide video authority. A
// feed `VideoPlayer` can be mounted for the SAME post at the same time (the reel
// is pushed over the feed screen), so the reel surface must not share its id.
const PLAYBACK_ID_PREFIX = 'videos';

export interface PlayableSource {
    url: string;
    fallbackUrl?: string;
}

// How a surface publishes its player's seek to the screen, which owns the OS
// transport controls but not the players. Returns its own release.
export type RegisterTransportSeek = (seek: (seconds: number) => void) => () => void;

/**
 * Hold an OS wake lock for exactly as long as `active` is true.
 *
 * A reel is the one surface in the app a viewer watches without touching anything,
 * so the idle timer would dim and lock the device mid-video. The lock therefore
 * follows PLAYBACK, not the screen's lifetime: a paused reel — someone reading the
 * replies panel — has to let the device sleep on its normal schedule, which is why
 * this takes the same `shouldPlay` predicate that drives the player rather than
 * `expo-keep-awake`'s own `useKeepAwake()` (which holds the lock for as long as the
 * component is mounted, and so would keep a paused reel awake indefinitely).
 *
 * `tag` scopes the lock to ONE surface. The reel keeps preloaded neighbours mounted,
 * and an untagged release is global — a neighbour tearing down would otherwise drop
 * the watched slide's lock.
 *
 * Activation is async and this effect can tear down before it resolves, so a late
 * resolve releases immediately instead of leaking a lock with no owner.
 */
function useKeepAwakeWhile(active: boolean, tag: string): void {
    useEffect(() => {
        if (!active) return;

        let released = false;
        const release = () => {
            deactivateKeepAwake(tag).catch((error: unknown) => {
                logger.debug('Keep-awake release rejected', { tag, error });
            });
        };

        activateKeepAwakeAsync(tag)
            .then(() => {
                if (released) release();
            })
            .catch((error: unknown) => {
                // Browsers without the Screen Wake Lock API reject outright, and
                // Chromium refuses one on a hidden document. Playback is unaffected;
                // the device just keeps its ordinary idle behaviour.
                logger.debug('Keep-awake unavailable', { tag, error });
            });

        return () => {
            released = true;
            release();
        };
    }, [active, tag]);
}

export interface ReelChromeParams {
    /** The player this chrome drives. Who built it, and who releases it, is not this hook's business. */
    player: VideoPlayer;
    /**
     * Whether becoming active rewinds the video to the start.
     *
     * True for a slide that begins its own playback. False for one handed a
     * video already playing — rewinding there would undo the continuity the
     * hand-off exists to preserve, at the exact moment the viewer is looking.
     */
    restartOnActivate: boolean;
    // Identity of the post this surface plays — the stable playback id handed to
    // the app-wide video authority.
    postId: string;
    videoUrl: string;
    // The raw (non-HLS) original URL, always playable. Used as a one-shot
    // retry source if `videoUrl` (the preferred/HLS source) errors.
    fallbackVideoUrl?: string;
    posterUrl?: string;
    /** Persisted duration from the post DTO; used until the player reports duration. */
    initialDurationSec?: number;
    /**
     * Persisted intrinsic size from the post DTO; gives the OS Picture-in-Picture
     * window its shape until the player reports a video track.
     */
    intrinsicSize?: MediaPixelSize;
    isActive: boolean;
    // See VideoItemProps.screenFocused — only play when active AND focused.
    screenFocused: boolean;
    // Viewport height: one slide tall, so it also yields this surface's centre-Y
    // for the visibility report to the playback authority.
    windowHeight: number;
    muted: boolean;
    onMutedChange: (muted: boolean) => void;
    onError: () => void;
    t: (key: string) => string;
    // Double-tap-to-like state + a like-ONLY handler (never unlikes).
    isLiked: boolean;
    onLikePost: () => void;
    // True while THIS surface owns the OS Picture-in-Picture window. The screen
    // owns that fact (it is the reel's session), so the surface never tracks it
    // locally — see the session block below.
    ownsSession: boolean;
    // Whether ANY surface owns the window. While one does, the pager's active slide
    // stops deciding which surface is watched — see `isWatched` below.
    sessionActive: boolean;
    // Where the session has moved to, while this surface owns it. Swapped onto
    // the SAME player rather than mounting the next slide's, which is what keeps
    // the OS window from freezing on a still frame.
    sessionSource?: PlayableSource;
    onSessionStart: (postId: string) => void;
    onSessionEnd: (postId: string) => void;
    onRegisterTransportSeek: RegisterTransportSeek;
}

export function useReelChrome({
    player,
    restartOnActivate,
    postId,
    videoUrl,
    fallbackVideoUrl,
    posterUrl,
    initialDurationSec,
    intrinsicSize,
    isActive,
    screenFocused,
    windowHeight,
    muted,
    onMutedChange,
    onError,
    t,
    isLiked,
    onLikePost,
    ownsSession,
    sessionActive,
    sessionSource,
    onSessionStart,
    onSessionEnd,
    onRegisterTransportSeek,
}: ReelChromeParams) {
    // `hasRendered` latches true on the FIRST `readyToPlay` and never flips back,
    // so a mid-playback re-buffer (status → loading) does NOT re-show the poster.
    const [hasRendered, setHasRendered] = useState(false);
    const [hasError, setHasError] = useState(false);
    // Live re-buffer flag: distinct from `hasRendered` so a mid-playback stall
    // shows only a small spinner over the already-rendered frame, never the poster.
    const [isBuffering, setIsBuffering] = useState(false);
    // Poster frame can 404 (no extractable frame) or fail to load → fall back to
    // the neutral icon instead of a blank/broken image. Reset when the source changes.
    const [posterFailed, setPosterFailed] = useState(false);
    // Whether the preferred source has already been given up on for the video
    // currently targeted. The preferred source is the HLS stream when the server
    // resolved one; if it errors (e.g. the ladder hasn't finished transcoding)
    // the raw original is tried EXACTLY ONCE, and a second error is a genuine
    // terminal failure that fires `onError` (the parent's give-up path).
    const [usedFallback, setUsedFallback] = useState(false);
    // Reels tap-to-pause: a viewer-driven pause override on the ACTIVE surface. It
    // is cleared whenever the surface stops being active (see the playback effect)
    // so a newly-activated video always autoplays instead of inheriting a stale
    // paused state.
    const [userPaused, setUserPaused] = useState(false);
    // Scrubber state — current playhead + total duration, driven by player events.
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(initialDurationSec ?? 0);
    const [isScrubbing, setIsScrubbing] = useState(false);

    // Reset the poster-failed flag when the poster source changes. Adjusted during
    // render via a previous-value tracker rather than in an effect, so a new poster
    // never flashes the stale icon fallback for a frame. See React "You Might Not
    // Need an Effect".
    const [prevPosterUrl, setPrevPosterUrl] = useState(posterUrl);
    if (prevPosterUrl !== posterUrl) {
        setPrevPosterUrl(posterUrl);
        setPosterFailed(false);
    }

    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    // The video this surface must have LOADED right now: its own row's, or —
    // while it owns the PiP session — wherever the session's cursor has moved to.
    const targetUrl = sessionSource?.url ?? videoUrl;
    const targetFallbackUrl = sessionSource ? sessionSource.fallbackUrl : fallbackVideoUrl;
    const desiredSource = usedFallback && targetFallbackUrl ? targetFallbackUrl : targetUrl;

    // Pointing the surface at a different video gives it a clean slate: its own
    // one-shot fallback retry, no inherited error, and no inherited pause
    // override (asking for the next video is an intent to watch it). Adjusted
    // during render via a previous-value tracker, like the poster above.
    const [prevTargetUrl, setPrevTargetUrl] = useState(targetUrl);
    if (prevTargetUrl !== targetUrl) {
        setPrevTargetUrl(targetUrl);
        setUsedFallback(false);
        setHasError(false);
        setUserPaused(false);
    }

    // Surface readiness + errors + live buffering. `hasRendered` latches on first
    // `readyToPlay`; AFTER that, a transition to `loading` is a mid-playback
    // re-buffer (small spinner), and `readyToPlay` clears it.
    // `useEventListener` (expo) subscribes once per player and always invokes the
    // LATEST listener, so these handlers read fresh state without re-subscribing.
    useEventListener(player, 'statusChange', ({ status: next }) => {
        if (next === 'readyToPlay') {
            setHasRendered(true);
            setIsBuffering(false);
            if (player.duration > 0) {
                setDuration(player.duration);
            }
        } else if (next === 'loading') {
            // Only a re-buffer (small spinner) once the first frame has
            // rendered; the initial load is covered by the poster instead.
            setIsBuffering(hasRendered);
        } else if (next === 'error') {
            if (!usedFallback && targetFallbackUrl) {
                setUsedFallback(true);
            } else {
                setHasError(true);
                onError();
            }
        }
    });

    // Track the playhead for the scrubber. Skipped while the viewer is dragging so
    // the thumb follows the gesture, not the (lagging) player position.
    useEventListener(player, 'timeUpdate', ({ currentTime: nextTime }) => {
        if (!isScrubbing) {
            setCurrentTime(nextTime);
        }
        if (duration <= 0 && player.duration > 0) {
            setDuration(player.duration);
        }
    });

    // Single place that syncs the live player's mute with the store.
    useEffect(() => {
        if (player.muted !== muted) {
            player.muted = muted;
        }
    }, [player, muted]);

    // Point the (never rebuilt) player at whatever source it should be holding.
    // The ref starts at the source the player was CONSTRUCTED with, so the common
    // case — no session, no fallback — never issues a replace at all.
    const loadedSourceRef = useRef(videoUrl);
    useEffect(() => {
        if (loadedSourceRef.current === desiredSource) return;
        loadedSourceRef.current = desiredSource;
        player.replaceAsync(desiredSource).catch((error: unknown) => {
            // A rejected swap is the call failing, not the asset: a source that
            // loads and then fails arrives as a `statusChange` error instead, and
            // is handled there.
            logger.debug('Video source swap failed', { postId, error });
        });
    }, [player, desiredSource, postId]);

    // When this surface stops being the active index, drop any viewer pause
    // override so re-activating it (scrolling back) autoplays from the top rather
    // than staying paused. A neighbour preloads but never plays, so the override
    // is meaningless off-screen. Adjusted during render via a previous-value tracker
    // instead of an effect. See React "You Might Not Need an Effect".
    const [prevIsActive, setPrevIsActive] = useState(isActive);
    if (prevIsActive !== isActive) {
        setPrevIsActive(isActive);
        if (!isActive) {
            setUserPaused(false);
        }
    }

    // ── Picture-in-Picture session ──────────────────────────────────
    // The reels screen is the app's ONLY PiP surface (tapping a feed video routes
    // here), and expo-video allows exactly one player in PiP at a time — so only
    // the surface being watched gets the capability. The preloaded neighbours
    // buffer but never play, and never enter PiP.
    //
    // Entering PiP opens the screen's session, pinned to this surface: it stays
    // the owner (and the audible player) however far the session's cursor walks,
    // because the alternative — the pager moving and a different player mounting
    // — would leave the OS window showing a frozen frame of a player nothing is
    // driving any more.
    const videoViewRef = useRef<VideoView | null>(null);

    // The surface the viewer is actually watching: the slide the pager is on, or —
    // while the OS window is up — the session's owner, wherever the pager left it.
    // The owner must stay in this set: on web `allowsPictureInPicture` maps to the
    // element's `disablePictureInPicture`, which the browser reads as "leave PiP
    // now", so dropping the capability under a live window would close it.
    //
    // Once a session exists the owner is the ONLY watched surface, which is why the
    // pager's own idea of the active slide is ignored for as long as one is open.
    // Entering PiP shrinks the activity's window to a couple of hundred pixels, and
    // that resize makes the list re-run its viewability pass and hand `isActive` to
    // a NEIGHBOUR — which then declared itself watched, published its own video's
    // shape into the activity-wide PiP params, and reshaped a window showing someone
    // else's video (measured: a 0.7999 window became the neighbour's 0.5618 about a
    // second after it opened). The pager is not an authority on what the OS is
    // showing while the OS is the one showing it.
    const isWatched = ownsSession || (!sessionActive && isActive && screenFocused);

    // Android delivers `onPictureInPictureModeChanged` to the ACTIVITY, so
    // expo-video forwards `onPictureInPictureStart` to EVERY mounted `VideoView` —
    // all five of them, in the same millisecond, not just the one that entered.
    // Without this guard the last preloading neighbour to be called won the session
    // and became the owner of a window showing a video it had nothing to do with.
    // Only a surface that could actually enter PiP may claim to have done so.
    const handlePictureInPictureStart = useCallback(() => {
        if (!isWatched) return;
        onSessionStart(postId);
    }, [isWatched, onSessionStart, postId]);
    const handlePictureInPictureStop = useCallback(() => onSessionEnd(postId), [onSessionEnd, postId]);

    // Give the OS window this video's shape. Only the watched surface publishes —
    // the params are activity-wide, so a preloading neighbour asserting its own
    // shape would describe a video nobody is looking at. Without this the window
    // comes up at expo-video's `Rational(16, 9)` default: landscape, for a reel.
    usePipAspectRatio({
        player,
        active: isWatched,
        persistedSize: intrinsicSize,
        sessionOwner: ownsSession,
        postId,
    });

    // The OS window dies with this player, so a surface torn down while it owns
    // the session (a feed switch rebuilds the whole list) must release the
    // session rather than leave the authority pinned to a player that is gone.
    // `onSessionEnd` ignores a caller that is not the current owner, so the
    // ordinary path — PiP stops, the session closes, this flips false — does not
    // end anything twice.
    //
    // Keyed on OWNERSHIP alone, with the callback read at teardown time rather
    // than depended on. `onSessionEnd` closes over the session, so its identity
    // changes on every cursor move; depending on it here would make the FIRST
    // "next" pressed in the OS window run this cleanup — releasing the session,
    // dropping `allowsPictureInPicture` from the owner, and so closing the very
    // window the press was meant to advance. This is a teardown action: it must
    // fire when the surface stops owning the session, never when a callback it
    // happens to call is rebuilt.
    //
    // The mirror is written from an effect, not during render — a render-phase
    // ref write makes the React Compiler refuse the whole function (see the
    // AGENTS note). The one-commit lag it costs is immaterial here: the only
    // commit that both rebuilds the callback and runs this cleanup is the one
    // where the session has just ended anyway, and re-ending an already-ended
    // session is the no-op the ownership guard is there for.
    const sessionEndRef = useRef(onSessionEnd);
    useEffect(() => {
        sessionEndRef.current = onSessionEnd;
    }, [onSessionEnd]);
    useEffect(() => {
        if (!ownsSession) return;
        return () => sessionEndRef.current(postId);
    }, [ownsSession, postId]);

    // The app-wide playback authority owns the foreground gate (app backgrounded /
    // tab hidden → nothing plays) and the single audible slot. A player the OS is
    // showing in the PiP window is exempt from both — that is exactly what
    // `ownsSession` buys here.
    const { shouldPlay: playbackAllowed, claimActive, reportVisibility } = useVideoPlayback({
        id: `${PLAYBACK_ID_PREFIX}:${postId}`,
        // Native reads visibility from the reel's own viewability source — the
        // `VideoViewabilityProvider` this screen publishes the snapped slide into.
        viewabilityKey: postId,
        ownsSession,
    });

    // Web resolves visibility only from what a player reports, and this screen
    // mounts no `IntersectionObserver` — its pager already knows which slide is on
    // screen. Report exactly what an observer would: the snapped slide of a focused
    // screen is on screen (a slide fills the viewport, so it sits at its centre);
    // the preloaded neighbours and every slide of a blurred screen are not. NOT
    // reporting would leave this surface permanently hidden on web; reporting a
    // blurred screen as visible would let the reel hold the audible slot after the
    // viewer pushes another route on top of it.
    //
    // Reported DURING RENDER via a previous-value tracker — the same pattern as the
    // trackers above. From an effect it would land AFTER the claim below and leave
    // that claim standing on stale visibility, which the authority then drops.
    const onScreen = isActive && screenFocused;
    const surfaceCenterY = windowHeight / 2;
    const [reportedOnScreen, setReportedOnScreen] = useState<boolean | null>(null);
    const [reportedCenterY, setReportedCenterY] = useState<number | null>(null);
    if (reportedOnScreen !== onScreen || reportedCenterY !== surfaceCenterY) {
        setReportedOnScreen(onScreen);
        setReportedCenterY(surfaceCenterY);
        reportVisibility(surfaceCenterY, onScreen);
    }

    // This screen's own paging decides WHICH row is audible, so the active+focused
    // surface claims the authority's audible slot outright rather than competing on
    // position with whatever else is mounted. Publishing to an external store on a
    // state change is the legitimate effect case.
    useEffect(() => {
        if (isActive && screenFocused) {
            claimActive();
        }
    }, [isActive, screenFocused, claimActive]);

    // Drive playback from the watched gate, the app-wide authority, AND the viewer's tap
    // override. The active surface plays from the top when it first activates; a
    // tap-resume continues from the current position (no `currentTime = 0` reset)
    // so toggling play/pause does not jump the video back to the start.
    // Off-screen, blurred, backgrounded (unless in PiP), or viewer-paused → paused.
    //
    // `desiredSource` is a dependency because a swap RESETS the element's play
    // state: the web player's `replace` calls `play()` itself, so without
    // re-asserting the gate here a source change could start a video this surface
    // is not allowed to play.
    const shouldPlay = isWatched && playbackAllowed && !userPaused;
    useEffect(() => {
        if (shouldPlay) {
            player.play();
        } else {
            player.pause();
        }
    }, [player, shouldPlay, desiredSource]);

    // …and once more per LOAD, because the effect above cannot see a reload it
    // did not cause. A swap produces TWO of them on web: `replace` writes the
    // element's `src` attribute imperatively, then expo-video's own `VideoView`
    // re-renders and React writes its rendered `src` — the same URL, but a value
    // React last committed as the old one, so the element loads a second time.
    // That second load aborts the `play()` the first one issued (`AbortError`,
    // no `pause` event, so nothing downstream notices) and leaves the surface
    // frozen on the new video's first frame, with `desiredSource` already
    // settled and no further reason for the effect to run. `sourceChange` is
    // emitted from `loadstart`, so it fires once per load and covers both;
    // `play`/`pause` are idempotent, so the native single-load path is unchanged.
    useEventListener(player, 'sourceChange', () => {
        if (shouldPlay) {
            player.play();
        } else {
            player.pause();
        }
    });

    // Keep the device awake while this surface is the one actually playing. Same
    // predicate as the player above, so the lock cannot outlive playback.
    useKeepAwakeWhile(shouldPlay, `${PLAYBACK_ID_PREFIX}:${postId}`);

    // The OS transport controls (media keys, the lock screen, and the buttons
    // Chromium puts inside the PiP window) are registered by the SCREEN, which
    // owns no player. Publish this player's seek while this surface is the one
    // being watched; the returned release only ever clears its own registration,
    // so a late teardown can never unhook the live player.
    useEffect(() => {
        if (!isWatched) return;
        return onRegisterTransportSeek((seconds: number) => {
            player.seekBy(seconds);
        });
    }, [isWatched, player, onRegisterTransportSeek]);

    // Restart from the top whenever the surface (re)becomes active+focused, so each
    // activation begins at the start. Kept separate from the play/pause gate so a
    // mid-playback tap-resume does not rewind — and skipped entirely for a slide
    // that adopted a playing video, whose whole point is the position it arrived
    // with.
    useEffect(() => {
        if (restartOnActivate && isActive && screenFocused) {
            player.currentTime = 0;
        }
    }, [player, restartOnActivate, isActive, screenFocused]);

    // ── Double-tap-to-like ──────────────────────────────────────────
    // A single tap toggles pause but is DEFERRED by DOUBLE_TAP_WINDOW_MS; a second
    // tap inside the window cancels that pending pause and fires a like-only.
    const lastTapRef = useRef(0);
    const pausePendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const heartScale = useSharedValue(0);
    const heartOpacity = useSharedValue(0);

    useEffect(() => () => {
        if (pausePendingRef.current) {
            clearTimeout(pausePendingRef.current);
            pausePendingRef.current = null;
        }
    }, []);

    const popHeart = useCallback(() => {
        heartOpacity.value = withSequence(
            withTiming(1, { duration: 120 }),
            withTiming(0, { duration: 480 }),
        );
        heartScale.value = withSequence(
            withTiming(1, { duration: 180 }),
            withTiming(1.25, { duration: 420 }),
        );
    }, [heartOpacity, heartScale]);

    const handleSurfacePress = useCallback(() => {
        if (!isActive || !screenFocused) return;
        const now = Date.now();
        if (now - lastTapRef.current < DOUBLE_TAP_WINDOW_MS) {
            // Double tap: cancel the pending pause toggle and like (like-only).
            lastTapRef.current = 0;
            if (pausePendingRef.current) {
                clearTimeout(pausePendingRef.current);
                pausePendingRef.current = null;
            }
            if (!isLiked) {
                onLikePost();
            }
            popHeart();
            return;
        }
        lastTapRef.current = now;
        if (pausePendingRef.current) {
            clearTimeout(pausePendingRef.current);
        }
        pausePendingRef.current = setTimeout(() => {
            pausePendingRef.current = null;
            setUserPaused((prev) => !prev);
        }, DOUBLE_TAP_WINDOW_MS);
    }, [isActive, screenFocused, isLiked, onLikePost, popHeart]);

    const heartStyle = useAnimatedStyle(() => ({
        opacity: heartOpacity.value,
        transform: [{ scale: heartScale.value }],
    }));

    const toggleMute = useCallback(() => {
        const next = !muted;
        onMutedChange(next);
        player.muted = next;
        if (!next && shouldPlay) {
            player.play();
        }
    }, [muted, shouldPlay, onMutedChange, player]);

    // Manual entry into the OS Picture-in-Picture window. This is the ONLY PiP
    // affordance on web: browsers never start PiP automatically, and
    // `nativeControls={false}` means there is no built-in button to fall back on.
    // `startPictureInPicture` rejects when the platform refuses — another player
    // already owns the single PiP window, or the native build predates the
    // `supportsPictureInPicture` config-plugin flag (device support, which
    // `isPictureInPictureSupported()` reports, is a separate question).
    const handleStartPictureInPicture = useCallback(() => {
        videoViewRef.current?.startPictureInPicture().catch(() => {
            toast(t('videos.picture_in_picture_failed'), { type: 'error' });
        });
    }, [t]);

    // ── Scrubber / seek ─────────────────────────────────────────────
    // Measured track width drives the gesture→time mapping. PanResponder works on
    // both web and native and is confined to the thin bar's own hit area, so it
    // never steals tap-to-pause or scroll from the surface.
    const trackWidthRef = useRef(0);
    const onTrackLayout = useCallback((e: LayoutChangeEvent) => {
        trackWidthRef.current = e.nativeEvent.layout.width;
    }, []);

    const seekToLocationX = useCallback((locationX: number) => {
        const width = trackWidthRef.current;
        const total = duration > 0 ? duration : player.duration;
        if (width <= 0 || total <= 0) return;
        const ratio = Math.min(1, Math.max(0, locationX / width));
        const nextTime = ratio * total;
        setCurrentTime(nextTime);
        player.currentTime = nextTime;
    }, [duration, player]);

    const panResponder = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
            setIsScrubbing(true);
            seekToLocationX(e.nativeEvent.locationX);
        },
        onPanResponderMove: (e) => {
            seekToLocationX(e.nativeEvent.locationX);
        },
        onPanResponderRelease: (e) => {
            seekToLocationX(e.nativeEvent.locationX);
            setIsScrubbing(false);
        },
        onPanResponderTerminate: () => {
            setIsScrubbing(false);
        },
    }), [seekToLocationX]);

    const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

    const showPoster = !hasRendered;
    // The pause affordance shows only when the viewer has actively paused the
    // current video — not for the autoplay-gating pauses (off-screen / blurred).
    const showPauseAffordance = isActive && screenFocused && userPaused;
    const showScrubber = isActive && screenFocused;
    const showBufferSpinner = isBuffering && isActive && hasRendered;
    // Hidden while the OS window is already up (the affordance would be a no-op)
    // and wherever the platform reports no PiP support — Firefox on web, Android
    // without `FEATURE_PICTURE_IN_PICTURE`, iOS without `AVPictureInPictureController`.
    const showPipButton = isWatched && !ownsSession && supportsPictureInPicture();

    return {
        videoViewRef,
        isWatched,
        handlePictureInPictureStart,
        handlePictureInPictureStop,
        showPoster,
        posterFailed,
        handlePosterError,
        handleSurfacePress,
        userPaused,
        heartStyle,
        showPauseAffordance,
        showBufferSpinner,
        toggleMute,
        showPipButton,
        handleStartPictureInPicture,
        showScrubber,
        onTrackLayout,
        panResponder,
        isScrubbing,
        progress,
        hasError,
    };
}
