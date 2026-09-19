/**
 * DEV-ONLY feed preview: renders the real `PostItem` against hand-built mock
 * posts covering every attachment combination (images, links, podcasts, video,
 * polls, quotes, reposts…) so the post UI can be iterated on without a backend.
 *
 * Not for commit — local UI review only.
 */
import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useCommunityNoteSheets } from '@/components/CommunityNotes/useCommunityNoteSheets';
import { PostVisibility } from '@mention/shared-types/post';
import type {
    ClarityDocument,
    HydratedPost,
    HydratedPostSummary,
    MediaItem,
    PostPodcastContent,
    PostUser,
} from '@mention/shared-types/post';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import PostItem from '@/components/Feed/PostItem';
import { PostErrorBoundary } from '@/components/Feed/PostErrorBoundary';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const user = (id: string, username: string, displayName: string, verified = false): PostUser => ({
    id,
    username,
    name: { displayName, first: displayName.split(' ')[0], last: displayName.split(' ')[1] ?? '' } as PostUser['name'],
    avatar: `https://i.pravatar.cc/200?u=${username}`,
    verified,
    kind: 'personal',
});

const USERS = {
    nate: user('u1', 'nate', 'Nate Isern', true),
    lucia: user('u2', 'lucia', 'Lucía Ferrer'),
    marc: user('u3', 'marc', 'Marc Puig'),
    sofia: user('u4', 'sofia', 'Sofía Martín', true),
    tech: user('u5', 'techdaily', 'Tech Daily', true),
    pablo: user('u6', 'pablo', 'Pablo Ruiz'),
};

const image = (seed: string, w = 1200, h = 800, alt?: string): MediaItem => ({
    id: `img-${seed}-${w}x${h}`,
    type: 'image',
    width: w,
    height: h,
    aspectRatio: w / h,
    orientation: w > h ? 'landscape' : w < h ? 'portrait' : 'square',
    url: `https://picsum.photos/seed/${seed}/${w}/${h}`,
    thumbUrl: `https://picsum.photos/seed/${seed}/${Math.round(w / 2)}/${Math.round(h / 2)}`,
    fullUrl: `https://picsum.photos/seed/${seed}/${w}/${h}`,
    alt,
});

const VIDEO: MediaItem = {
    id: 'video-bunny',
    type: 'video',
    width: 1280,
    height: 720,
    aspectRatio: 16 / 9,
    orientation: 'landscape',
    durationSec: 596,
    url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
    posterUrl: 'https://picsum.photos/seed/bunny/1280/720',
};

const link = (
    url: string,
    title: string,
    description: string,
    publisher: string,
    imageSeed?: string,
): ClarityDocument => ({
    id: `doc-${url}`,
    canonicalUrl: url,
    title,
    description,
    publisher,
    type: 'article',
    status: 'indexed',
    authors: [],
    evidence: {},
    imageUrl: imageSeed ? `https://picsum.photos/seed/${imageSeed}/1200/630` : undefined,
    faviconUrl: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=64`,
});

const LINKS = {
    verge: link(
        'https://www.theverge.com/2026/9/15/decentralized-social-networks',
        'The quiet rise of decentralized social networks',
        'Federation used to be a niche idea. Now millions of people use it without knowing.',
        'The Verge',
        'verge',
    ),
    github: link(
        'https://github.com/OxyHQ/Mention',
        'OxyHQ/Mention: cross-platform social app with ActivityPub federation',
        'Expo, Express, PostgreSQL. iOS, Android and web from one codebase.',
        'GitHub',
        'github',
    ),
    noImage: link(
        'https://example.com/blog/notes-on-feed-ranking',
        'Notes on feed ranking without engagement bait',
        'A short essay on what a chronological-first feed actually needs.',
        'example.com',
    ),
    youtube: link(
        'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
        'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
        'Big Buck Bunny tells the story of a giant rabbit with a heart bigger than himself.',
        'YouTube',
        'ytbunny',
    ),
};

const podcast = (
    id: string,
    title: string,
    author: string,
    seed: string,
    extra: Partial<PostPodcastContent> = {},
): PostPodcastContent => ({
    syraPodcastId: id,
    title,
    author,
    artworkUrl: `https://picsum.photos/seed/${seed}/600/600`,
    showUrl: `https://syra.fm/podcast/${id}`,
    ...extra,
});

const PODCASTS = {
    lex: podcast('pod-lex', 'Conversaciones sobre tecnología', 'Syra Originals', 'podlex'),
    design: podcast('pod-design', 'Design Details', 'Brian Lovin & Marshall Bock', 'poddesign', {
        showUrl: 'https://open.spotify.com/show/design-details',
    }),
    episodeApple: podcast('pod-apple', 'Boyfriend Material with Harry Jowsey', 'Harry Jowsey', 'podharry', {
        showUrl: 'https://podcasts.apple.com/podcast/boyfriend-material',
        episode: { title: "Reacting To My Wedding! With My 'Lets Marry Harry' Mentor" },
    }),
    videoEpisode: podcast('pod-video', 'Boyfriend Material with Harry Jowsey', 'Harry Jowsey', 'podharry', {
        showUrl: 'https://podcasts.apple.com/podcast/boyfriend-material',
        episode: {
            title: "Reacting To My Wedding! With My 'Lets Marry Harry' Mentor",
            videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerJoyrides.mp4',
            posterUrl: 'https://picsum.photos/seed/studio-video/1280/720',
            width: 1280,
            height: 720,
        },
    }),
    videoSpotify: podcast('pod-video-2', 'Design Details', 'Brian Lovin & Marshall Bock', 'poddesign', {
        showUrl: 'https://open.spotify.com/show/design-details',
        episode: {
            title: 'Episode 412: Designing for the feed',
            videoUrl: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
            posterUrl: 'https://picsum.photos/seed/dd-video/1280/720',
            width: 1280,
            height: 720,
        },
    }),
};

let seq = 0;
function post(
    author: PostUser,
    text: string,
    opts: {
        minutes?: number;
        media?: MediaItem[];
        documents?: ClarityDocument[];
        podcast?: PostPodcastContent;
        poll?: HydratedPostSummary['attachments']['poll'];
        engagement?: Partial<HydratedPostSummary['engagement']>;
        extra?: Partial<HydratedPost>;
    } = {},
): HydratedPost {
    seq += 1;
    const id = `mock-post-${seq}`;
    return {
        id,
        content: { text, media: opts.media, podcast: opts.podcast, poll: opts.poll },
        attachments: { media: opts.media, podcast: opts.podcast, poll: opts.poll },
        documents: opts.documents,
        user: author,
        authors: [{ ...author, role: 'owner', status: 'accepted' } as HydratedPost['authors'][number]],
        engagement: {
            likes: (seq * 37) % 900,
            downvotes: 0,
            boosts: (seq * 7) % 60,
            replies: (seq * 5) % 40,
            saves: seq % 9,
            views: seq * 1234,
            ...opts.engagement,
        },
        viewerState: {
            isOwner: false,
            isCollaborator: false,
            isLiked: seq % 4 === 0,
            isDownvoted: false,
            isBoosted: seq % 6 === 0,
            isSaved: false,
        },
        permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
        metadata: {
            visibility: PostVisibility.PUBLIC,
            createdAt: minutesAgo(opts.minutes ?? seq * 13),
            updatedAt: minutesAgo(opts.minutes ?? seq * 13),
        },
        ...opts.extra,
    };
}

function repost(actor: PostUser, original: HydratedPostSummary): HydratedPost {
    const shell = post(actor, '');
    return { ...shell, boost: { originalPost: original, actor } };
}

type Section = { label: string; post: HydratedPost };

function buildSections(): Section[] {
    const podcastWithImage = post(USERS.lucia, 'Nuevo episodio grabado en el estudio 🎙️ Hablamos de diseño de interfaces sociales.', {
        media: [image('studio', 1200, 1200)],
        podcast: PODCASTS.design,
    });
    const multiImage = post(USERS.sofia, 'Fin de semana en los Pirineos 🏔️', {
        media: [image('mount1'), image('mount2', 800, 1200), image('mount3'), image('mount4', 1000, 1000)],
    });
    const linkPost = post(USERS.tech, 'Interesante lectura sobre dónde va la federación 👇', {
        documents: [LINKS.verge],
    });

    return [
        { label: 'Solo texto', post: post(USERS.nate, 'Probando el nuevo feed. ¿Qué os parece la densidad de la UI? Creo que podemos quitar algo de padding entre acciones.') },
        { label: 'Solo texto largo con #hashtag y @mención', post: post(USERS.marc, 'Hilo corto sobre por qué el orden cronológico sigue importando en 2026. La mayoría de feeds optimizan por tiempo de sesión, pero la gente vuelve por la confianza. #producto #feeds @nate ¿lo hablamos mañana?') },
        { label: '1 imagen (horizontal)', post: post(USERS.lucia, 'Atardecer desde la oficina', { media: [image('sunset')] }) },
        { label: '1 imagen (vertical)', post: post(USERS.pablo, 'Nueva bici 🚲', { media: [image('bike', 900, 1400)] }) },
        { label: '2 imágenes', post: post(USERS.marc, 'Antes / después del rediseño', { media: [image('before'), image('after')] }) },
        { label: '4 imágenes (mixtas)', post: multiImage },
        { label: 'Vídeo', post: post(USERS.tech, 'Demo del reproductor inline', { media: [VIDEO] }) },
        { label: 'Solo link (con imagen)', post: linkPost },
        { label: 'Solo link (sin imagen)', post: post(USERS.nate, 'Escribí esto hace tiempo y sigue vigente', { documents: [LINKS.noImage] }) },
        { label: 'Link YouTube (embed)', post: post(USERS.pablo, 'Clásico 🐰', { documents: [LINKS.youtube] }) },
        { label: '2 links', post: post(USERS.tech, 'Dos lecturas para el finde', { documents: [LINKS.github, LINKS.verge] }) },
        { label: 'Solo podcast', post: post(USERS.sofia, 'Os recomiendo este podcast', { podcast: PODCASTS.lex }) },
        { label: 'Podcast (Spotify)', post: post(USERS.marc, 'Mi podcast de diseño favorito', { podcast: PODCASTS.design }) },
        { label: 'Podcast episodio (Apple, sin vídeo)', post: post(USERS.nate, 'Reacting To My Wedding! With My ‘Lets Marry Harry’ Mentor @amandakloots!', { podcast: PODCASTS.episodeApple }) },
        { label: 'Podcast con vídeo', post: post(USERS.lucia, 'Watch me relive the final and dramatic moments of the show!', { podcast: PODCASTS.videoEpisode }) },
        { label: 'Podcast con vídeo (Spotify) + imagen', post: post(USERS.tech, 'Nuevo episodio en vídeo', { podcast: PODCASTS.videoSpotify, media: [image('dd-extra')] }) },
        { label: 'Podcast + imagen', post: podcastWithImage },
        { label: 'Link + imágenes', post: post(USERS.marc, 'Publicamos el repo. Capturas de la nueva UI:', { media: [image('ui1'), image('ui2')], documents: [LINKS.github] }) },
        { label: 'Podcast + link', post: post(USERS.lucia, 'El episodio comenta este artículo', { podcast: PODCASTS.lex, documents: [LINKS.verge] }) },
        { label: 'Imágenes + link + podcast', post: post(USERS.nate, 'Todo junto: fotos del evento, el artículo y el podcast que grabamos allí.', { media: [image('event1'), image('event2'), image('event3')], documents: [LINKS.verge], podcast: PODCASTS.design }) },
        {
            label: 'Encuesta + imagen',
            post: post(USERS.sofia, '¿Qué layout preferís?', {
                media: [image('layouts')],
                poll: {
                    question: '¿Qué layout preferís?',
                    options: ['Compacto', 'Espacioso', 'Tarjetas'],
                    endTime: new Date(Date.now() + 86_400_000).toISOString(),
                    votes: { '0': 42, '1': 17, '2': 30 },
                    userVotes: {},
                },
            }),
        },
        { label: 'Repost de post con imágenes', post: repost(USERS.pablo, multiImage) },
        { label: 'Repost de link', post: repost(USERS.nate, linkPost) },
        { label: 'Repost de podcast + imagen', post: repost(USERS.marc, podcastWithImage) },
        { label: 'Quote de post con podcast', post: post(USERS.tech, 'Muy buen episodio, sobre todo el minuto 20', { extra: { quotedPost: podcastWithImage } }) },
        { label: 'Quote con imagen propia + quote de imágenes', post: post(USERS.lucia, 'Yo también estuve 😄', { media: [image('me-too')], extra: { quotedPost: multiImage } }) },
        { label: 'Quote con link + quote de link', post: post(USERS.marc, 'Complemento perfecto a esto:', { documents: [LINKS.noImage], extra: { quotedPost: linkPost } }) },
        {
            label: 'Community note (mostrada)',
            post: post(USERS.marc, '¿Sabíais que los murciélagos son COMPLETAMENTE CIEGOS? Me lo contó un amigo experto. Se orientan solo por sonar 🦇', {
                media: [image('bat', 1200, 800)],
                extra: {
                    communityNote: {
                        id: 'note-bats',
                        text: 'Es un mito muy extendido. Los murciélagos no son ciegos: no ven con la misma agudeza que los humanos, pero tienen una vista razonablemente buena. Combinada con la ecolocalización (un sistema de sonar biológico), el oído y el olfato, les permite orientarse perfectamente en todo tipo de entornos.',
                        sourceUrls: ['https://www.nationalgeographic.com/animals/article/bats-blind-myth', 'https://www.bats.org.uk/about-bats/what-are-bats/bat-senses'],
                        status: 'shown',
                        createdAt: minutesAgo(90),
                    },
                },
            }),
        },
        {
            label: 'Content warning (solo texto)',
            post: post(USERS.lucia, 'El final de la temporada: resulta que el narrador llevaba muerto desde el primer capítulo y todo era un recuerdo.', {
                extra: { metadata: { visibility: PostVisibility.PUBLIC, spoilerText: 'Spoilers de la serie', createdAt: minutesAgo(40), updatedAt: minutesAgo(40) } },
            }),
        },
        {
            label: 'Contenido sensible + CW',
            post: post(USERS.pablo, 'Spoilers del último episodio', {
                media: [image('spoiler')],
                extra: { metadata: { visibility: PostVisibility.PUBLIC, isSensitive: true, spoilerText: 'Spoilers', createdAt: minutesAgo(500), updatedAt: minutesAgo(500) } },
            }),
        },
        {
            label: 'Crosspost + lane',
            post: post(USERS.sofia, 'Publicado también en Instagram y Threads', {
                media: [image('cross', 1080, 1350)],
                extra: {
                    lane: { id: 'lane-1', name: 'Fotografía', displayMode: 'mixed' },
                    crosspost: {
                        variants: [
                            { network: 'instagram.com', label: 'Instagram', postId: 'x1', rendered: false },
                            { network: 'mention.earth', label: 'Mention', postId: 'x2', rendered: true },
                            { network: 'threads.net', label: 'Threads', postId: 'x3', rendered: false },
                        ],
                    },
                },
            }),
        },
    ];
}

const SECTIONS = buildSections();

function NotesDevBar() {
    const router = useRouter();
    const sheets = useCommunityNoteSheets();
    const target = SECTIONS.find((section) => section.label === 'Solo texto largo con #hashtag y @mención')?.post;
    return (
        <View className="flex-row flex-wrap gap-2 px-4 pt-3">
            <Pressable className="bg-primary rounded-full px-4 py-2" onPress={() => target && sheets.openWriteFlow(target)}>
                <Text className="text-primary-foreground text-[13px] font-semibold">Escribir community note</Text>
            </Pressable>
            <Pressable className="border-border rounded-full border px-4 py-2" onPress={() => router.push('/dev/community-notes')}>
                <Text className="text-foreground text-[13px] font-semibold">Hub de community notes (mock)</Text>
            </Pressable>
        </View>
    );
}

export default function FeedPreviewScreen() {
    return (
        <ThemedView className="flex-1">
            <Header options={{ title: 'Feed preview (mock)' }} disableSticky />
            <ScrollView className="flex-1">
                <NotesDevBar />
                {SECTIONS.map(({ label, post: item }) => {
                    const original = item.boost?.originalPost;
                    return (
                        <View key={item.id}>
                            <Text className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {label}
                            </Text>
                            <PostErrorBoundary postId={item.id}>
                                <PostItem
                                    post={(original ?? item) as HydratedPost}
                                    repostedBy={original ? item.boost?.actor : undefined}
                                />
                            </PostErrorBoundary>
                        </View>
                    );
                })}
            </ScrollView>
        </ThemedView>
    );
}
