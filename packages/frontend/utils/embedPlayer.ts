/**
 * External embed player URL parser.
 *
 * Maps a third-party media URL (YouTube, Spotify, GIPHY, …) to the parameters
 * needed to render its inline player. Pure and synchronous — it never touches
 * the network. Mirrors Bluesky's `embed-player.ts`, adapted for Mention:
 *
 *  - YouTube / YouTube Shorts embed through `youtube-nocookie.com` directly
 *    (Mention has no self-hosted iframe wrapper).
 *  - Tenor / KLIPY are dropped — Mention's GIF library is native, not federated.
 *  - Provider keys + the `EmbedPlayerType` union live in `@mention/shared-types`,
 *    the single source of truth shared with the backend settings whitelist.
 */

import { Platform } from 'react-native';
import { Dimensions } from 'react-native';
import type { EmbedPlayerSource, EmbedPlayerType } from '@mention/shared-types';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');

/**
 * The parent origin Twitch's embed requires for clickjacking protection. On web
 * it must be the page host; native WebViews have no DOM origin, so a constant is
 * used (the WebView still loads `player.twitch.tv` fine with any registered
 * parent). Guarded so native bundles never touch `window`.
 */
const TWITCH_PARENT = Platform.OS === 'web' ? window.location.hostname : 'localhost';

export interface EmbedPlayerParams {
  type: EmbedPlayerType;
  playerUri: string;
  isGif?: boolean;
  source: EmbedPlayerSource;
  metaUri?: string;
  hideDetails?: boolean;
  dimensions?: {
    height: number;
    width: number;
  };
}

const giphyRegex = /media(?:[0-4]\.giphy\.com|\.giphy\.com)/i;
const gifFilenameRegex = /^(\S+)\.(webp|gif|mp4)$/i;

export function parseEmbedPlayerFromUrl(url: string): EmbedPlayerParams | undefined {
  let urlp: URL;
  try {
    urlp = new URL(url);
  } catch {
    return undefined;
  }

  // youtube
  if (urlp.hostname === 'youtu.be') {
    const videoId = urlp.pathname.split('/')[1];
    const t = urlp.searchParams.get('t') ?? '0';
    const seek = encodeURIComponent(t.replace(/s$/, ''));

    if (videoId) {
      return {
        type: 'youtube_video',
        source: 'youtube',
        playerUri: `https://www.youtube-nocookie.com/embed/${videoId}?start=${seek}&autoplay=1`,
      };
    }
  }
  if (
    urlp.hostname === 'www.youtube.com' ||
    urlp.hostname === 'youtube.com' ||
    urlp.hostname === 'm.youtube.com' ||
    urlp.hostname === 'music.youtube.com'
  ) {
    const [, page, shortOrLiveVideoId] = urlp.pathname.split('/');

    const isShorts = page === 'shorts';
    const isLive = page === 'live';
    const videoId = isShorts || isLive ? shortOrLiveVideoId : urlp.searchParams.get('v');
    const t = urlp.searchParams.get('t') ?? '0';
    const seek = encodeURIComponent(t.replace(/s$/, ''));

    if (videoId) {
      return {
        type: isShorts ? 'youtube_short' : 'youtube_video',
        source: isShorts ? 'youtubeShorts' : 'youtube',
        hideDetails: isShorts ? true : undefined,
        playerUri: `https://www.youtube-nocookie.com/embed/${videoId}?start=${seek}&autoplay=1`,
      };
    }
  }

  // twitch
  if (
    urlp.hostname === 'twitch.tv' ||
    urlp.hostname === 'www.twitch.tv' ||
    urlp.hostname === 'm.twitch.tv'
  ) {
    const parent = TWITCH_PARENT;
    const [, channelOrVideo, clipOrId, id] = urlp.pathname.split('/');

    if (channelOrVideo === 'videos') {
      return {
        type: 'twitch_video',
        source: 'twitch',
        playerUri: `https://player.twitch.tv/?volume=0.5&!muted&autoplay&video=${clipOrId}&parent=${parent}`,
      };
    } else if (clipOrId === 'clip') {
      return {
        type: 'twitch_video',
        source: 'twitch',
        playerUri: `https://clips.twitch.tv/embed?volume=0.5&autoplay=true&clip=${id}&parent=${parent}`,
      };
    } else if (channelOrVideo) {
      return {
        type: 'twitch_video',
        source: 'twitch',
        playerUri: `https://player.twitch.tv/?volume=0.5&!muted&autoplay&channel=${channelOrVideo}&parent=${parent}`,
      };
    }
  }

  // spotify
  if (urlp.hostname === 'open.spotify.com') {
    const [, typeOrLocale, idOrType, id] = urlp.pathname.split('/');

    if (idOrType) {
      if (typeOrLocale === 'playlist' || idOrType === 'playlist') {
        return {
          type: 'spotify_playlist',
          source: 'spotify',
          playerUri: `https://open.spotify.com/embed/playlist/${id ?? idOrType}`,
        };
      }
      if (typeOrLocale === 'album' || idOrType === 'album') {
        return {
          type: 'spotify_album',
          source: 'spotify',
          playerUri: `https://open.spotify.com/embed/album/${id ?? idOrType}`,
        };
      }
      if (typeOrLocale === 'track' || idOrType === 'track') {
        return {
          type: 'spotify_song',
          source: 'spotify',
          playerUri: `https://open.spotify.com/embed/track/${id ?? idOrType}`,
        };
      }
      if (typeOrLocale === 'episode' || idOrType === 'episode') {
        return {
          type: 'spotify_song',
          source: 'spotify',
          playerUri: `https://open.spotify.com/embed/episode/${id ?? idOrType}`,
        };
      }
      if (typeOrLocale === 'show' || idOrType === 'show') {
        return {
          type: 'spotify_song',
          source: 'spotify',
          playerUri: `https://open.spotify.com/embed/show/${id ?? idOrType}`,
        };
      }
    }
  }

  // soundcloud
  if (urlp.hostname === 'soundcloud.com' || urlp.hostname === 'www.soundcloud.com') {
    const [, user, trackOrSets, set] = urlp.pathname.split('/');

    if (user && trackOrSets) {
      if (trackOrSets === 'sets' && set) {
        return {
          type: 'soundcloud_set',
          source: 'soundcloud',
          playerUri: `https://w.soundcloud.com/player/?url=${url}&auto_play=true&visual=false&hide_related=true`,
        };
      }

      return {
        type: 'soundcloud_track',
        source: 'soundcloud',
        playerUri: `https://w.soundcloud.com/player/?url=${url}&auto_play=true&visual=false&hide_related=true`,
      };
    }
  }

  // apple music
  if (urlp.hostname === 'music.apple.com') {
    // Path shape: /locale/type/name/id — validate the length before trusting it.
    const pathParams = urlp.pathname.split('/');
    const type = pathParams[2];
    const songId = urlp.searchParams.get('i');

    if (pathParams.length === 5 && (type === 'playlist' || type === 'album' || type === 'song')) {
      // Append the songId when present so a deep-linked track plays directly.
      const embedUri = `https://embed.music.apple.com${urlp.pathname}${songId ? `?i=${songId}` : ''}`;

      if (type === 'playlist') {
        return {
          type: 'apple_music_playlist',
          source: 'appleMusic',
          playerUri: embedUri,
        };
      } else if (type === 'album') {
        if (songId) {
          return {
            type: 'apple_music_song',
            source: 'appleMusic',
            playerUri: embedUri,
          };
        } else {
          return {
            type: 'apple_music_album',
            source: 'appleMusic',
            playerUri: embedUri,
          };
        }
      } else if (type === 'song') {
        return {
          type: 'apple_music_song',
          source: 'appleMusic',
          playerUri: embedUri,
        };
      }
    }
  }

  // vimeo
  if (urlp.hostname === 'vimeo.com' || urlp.hostname === 'www.vimeo.com') {
    const [, videoId] = urlp.pathname.split('/');
    if (videoId) {
      return {
        type: 'vimeo_video',
        source: 'vimeo',
        playerUri: `https://player.vimeo.com/video/${videoId}?autoplay=1`,
      };
    }
  }

  // giphy — canonical share URL: giphy.com/gifs/<name>-<id>
  if (urlp.hostname === 'giphy.com' || urlp.hostname === 'www.giphy.com') {
    const [, gifs, nameAndId] = urlp.pathname.split('/');

    if (gifs === 'gifs' && nameAndId) {
      // The trailing dash-separated segment is the gif id.
      const gifId = nameAndId.split('-').pop();

      if (gifId) {
        return {
          type: 'giphy_gif',
          source: 'giphy',
          isGif: true,
          hideDetails: true,
          metaUri: `https://giphy.com/gifs/${gifId}`,
          playerUri: `https://i.giphy.com/media/${gifId}/200.webp`,
        };
      }
    }
  }

  // giphy media hosts: media.giphy.com and media0-4.giphy.com (may carry a
  // tracking id segment before the file id).
  if (giphyRegex.test(urlp.hostname)) {
    const [, media, trackingOrId, idOrFilename, filename] = urlp.pathname.split('/');

    if (media === 'media') {
      if (idOrFilename && gifFilenameRegex.test(idOrFilename)) {
        return {
          type: 'giphy_gif',
          source: 'giphy',
          isGif: true,
          hideDetails: true,
          metaUri: `https://giphy.com/gifs/${trackingOrId}`,
          playerUri: `https://i.giphy.com/media/${trackingOrId}/200.webp`,
        };
      } else if (filename && gifFilenameRegex.test(filename)) {
        return {
          type: 'giphy_gif',
          source: 'giphy',
          isGif: true,
          hideDetails: true,
          metaUri: `https://giphy.com/gifs/${idOrFilename}`,
          playerUri: `https://i.giphy.com/media/${idOrFilename}/200.webp`,
        };
      }
    }
  }

  // i.giphy.com direct media links (may end in .webp, not just .gif)
  if (urlp.hostname === 'i.giphy.com' || urlp.hostname === 'www.i.giphy.com') {
    const [, mediaOrFilename, filename] = urlp.pathname.split('/');

    if (mediaOrFilename === 'media' && filename) {
      const gifId = filename.split('.')[0];
      return {
        type: 'giphy_gif',
        source: 'giphy',
        isGif: true,
        hideDetails: true,
        metaUri: `https://giphy.com/gifs/${gifId}`,
        playerUri: `https://i.giphy.com/media/${gifId}/200.webp`,
      };
    } else if (mediaOrFilename) {
      const gifId = mediaOrFilename.split('.')[0];
      return {
        type: 'giphy_gif',
        source: 'giphy',
        isGif: true,
        hideDetails: true,
        metaUri: `https://giphy.com/gifs/${gifId}`,
        playerUri: `https://i.giphy.com/media/${gifId}/200.webp`,
      };
    }
  }

  // flickr albums + group pools
  if (urlp.hostname === 'www.flickr.com' || urlp.hostname === 'flickr.com') {
    let i = urlp.pathname.length - 1;
    while (i > 0 && urlp.pathname.charAt(i) === '/') {
      --i;
    }

    const pathComponents = urlp.pathname.slice(1, i + 1).split('/');
    if (pathComponents.length === 4) {
      // discard username — it's not relevant
      const [photos, , albums, id] = pathComponents;
      if (photos === 'photos' && albums === 'albums') {
        return {
          type: 'flickr_album',
          source: 'flickr',
          playerUri: `https://embedr.flickr.com/photosets/${id}`,
        };
      }
    }

    if (pathComponents.length === 3) {
      const [groups, id, pool] = pathComponents;
      if (groups === 'groups' && pool === 'pool') {
        return {
          type: 'flickr_album',
          source: 'flickr',
          playerUri: `https://embedr.flickr.com/groups/${id}`,
        };
      }
    }
    // not an album or a group pool — nothing we can embed
    return undefined;
  }

  // link-shortened flickr path (flic.kr, base58-encoded id)
  if (urlp.hostname === 'flic.kr') {
    const b58alph = '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
    const [, type, idBase58Enc] = urlp.pathname.split('/');
    let id = 0n;
    for (const char of idBase58Enc ?? '') {
      const nextIdx = b58alph.indexOf(char);
      if (nextIdx >= 0) {
        id = id * 58n + BigInt(nextIdx);
      } else {
        // not b58 encoded → not a valid link to embed
        return undefined;
      }
    }

    switch (type) {
      case 'go': {
        const formattedGroupId = `${id}`;
        return {
          type: 'flickr_album',
          source: 'flickr',
          playerUri: `https://embedr.flickr.com/groups/${formattedGroupId.slice(0, -2)}@N${formattedGroupId.slice(-2)}`,
        };
      }
      case 's':
        return {
          type: 'flickr_album',
          source: 'flickr',
          playerUri: `https://embedr.flickr.com/photosets/${id}`,
        };
      default:
        return undefined;
    }
  }

  // bandcamp albums + tracks
  const bandcampRegex = /^[a-z\d][a-z\d-]{2,}[a-z\d]\.bandcamp\.com$/i;
  if (bandcampRegex.test(urlp.hostname)) {
    const pathComponents = urlp.pathname.split('/');
    switch (pathComponents[1]) {
      case 'album':
        return {
          type: 'bandcamp_album',
          source: 'bandcamp',
          playerUri: `https://bandcamp.com/EmbeddedPlayer/url=${encodeURIComponent(urlp.href)}/size=large/bgcol=ffffff/linkcol=0687f5/minimal=true/transparent=true/`,
        };
      case 'track':
        return {
          type: 'bandcamp_track',
          source: 'bandcamp',
          playerUri: `https://bandcamp.com/EmbeddedPlayer/url=${encodeURIComponent(urlp.href)}/size=large/bgcol=ffffff/linkcol=0687f5/minimal=true/transparent=true/`,
        };
      default:
        return undefined;
    }
  }

  return undefined;
}

export function getPlayerAspect({
  type,
  hasThumb,
  width,
}: {
  type: EmbedPlayerType;
  hasThumb: boolean;
  width: number;
}): { aspectRatio?: number; height?: number } {
  if (!hasThumb) return { aspectRatio: 16 / 9 };

  switch (type) {
    case 'youtube_video':
    case 'twitch_video':
    case 'vimeo_video':
      return { aspectRatio: 16 / 9 };
    case 'youtube_short':
      if (SCREEN_HEIGHT < 600) {
        return { aspectRatio: (9 / 16) * 1.75 };
      } else {
        return { aspectRatio: (9 / 16) * 1.5 };
      }
    case 'spotify_album':
    case 'apple_music_album':
    case 'apple_music_playlist':
    case 'spotify_playlist':
    case 'soundcloud_set':
      return { height: 380 };
    case 'spotify_song':
      if (width <= 300) {
        return { height: 155 };
      }
      return { height: 232 };
    case 'soundcloud_track':
      return { height: 165 };
    case 'apple_music_song':
      return { height: 150 };
    case 'bandcamp_album':
    case 'bandcamp_track':
      return { aspectRatio: 1 };
    default:
      return { aspectRatio: 16 / 9 };
  }
}
