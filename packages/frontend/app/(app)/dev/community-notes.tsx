/**
 * DEV-ONLY: the community-notes hub with mock data. Not for commit.
 */
import React from 'react';
import { PostVisibility, type HydratedPostSummary, type PostUser } from '@mention/shared-types';
import { CommunityNotesScreen, type CommunityNoteEntry } from '@/components/CommunityNotes/CommunityNotesScreen';

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const author = (id: string, username: string, displayName: string): PostUser => ({
    id,
    username,
    name: { displayName } as PostUser['name'],
    avatar: `https://i.pravatar.cc/200?u=${username}`,
    kind: 'personal',
});

const post = (id: string, user: PostUser, text: string, imageSeed?: string): HydratedPostSummary => {
    const media = imageSeed
        ? [{
            id: `img-${imageSeed}`,
            type: 'image' as const,
            width: 1200,
            height: 800,
            aspectRatio: 1.5,
            url: `https://picsum.photos/seed/${imageSeed}/1200/800`,
            thumbUrl: `https://picsum.photos/seed/${imageSeed}/600/400`,
        }]
        : undefined;
    return {
        id,
        content: { text, media },
        attachments: { media },
        user,
        authors: [{ ...user, role: 'owner', status: 'accepted' }],
        engagement: { likes: 120, downvotes: 0, boosts: 12, replies: 30 },
        viewerState: { isOwner: false, isCollaborator: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false },
        permissions: { canReply: true, canDelete: false, canPin: false, canViewSources: false },
        metadata: { visibility: PostVisibility.PUBLIC, createdAt: ago(240), updatedAt: ago(240) },
    };
};

const kaew = author('n1', 'kaew_bunmak', 'Kaew Bunmak');
const claudia = author('n2', 'claudia', 'Claudia Flores');
const tech = author('n3', 'techdaily', 'Tech Daily');

const TO_RATE: CommunityNoteEntry[] = [
    {
        post: post('cn-1', kaew, '¡Por fin! Este año se están tomando medidas récord contra los árbitros corruptos. Perdimos muchísimos partidos ajustados.', 'football'),
        note: {
            id: 'n-1',
            text: 'Criticar el arbitraje es casi un deporte nacional, pero no ha habido ningún anuncio de despidos de árbitros por corrupción durante la temporada 2024.',
            sourceUrls: ['https://www.aol.com/football-ref-firings-153803155.html'],
            status: 'needs_ratings',
            createdAt: ago(360),
        },
    },
    {
        post: post('cn-2', claudia, 'Acabo de aprender que los murciélagos son COMPLETAMENTE CIEGOS. Usan una especie de sonar para orientarse.', 'bat'),
        note: {
            id: 'n-2',
            text: 'Es un mito. Los murciélagos no son ciegos: tienen una vista razonablemente buena que combinan con la ecolocalización, el oído y el olfato.',
            sourceUrls: ['https://www.naturefacts.com/animal-senses-bats-5434059.html'],
            status: 'needs_ratings',
            createdAt: ago(120),
        },
    },
];

const RATED: CommunityNoteEntry[] = [
    {
        post: post('cn-3', tech, 'El nuevo teléfono tiene batería para una semana entera con uso intensivo.'),
        note: {
            id: 'n-3',
            text: 'Las pruebas independientes miden entre 1,5 y 2 días con uso intensivo. La semana corresponde al modo de ahorro extremo.',
            sourceUrls: ['https://www.theverge.com/phone-battery-review'],
            status: 'shown',
            createdAt: ago(2000),
            viewerRating: 'helpful',
        },
    },
];

const WRITTEN: CommunityNoteEntry[] = [
    {
        post: post('cn-4', kaew, 'Esta foto es del concierto de ayer en Barcelona 🤯', 'concert'),
        note: {
            id: 'n-4',
            text: 'La foto es de un concierto de 2019 en Madrid; se publicó originalmente en la web del festival.',
            sourceUrls: ['https://example.com/festival-2019-gallery'],
            status: 'needs_ratings',
            createdAt: ago(30),
        },
    },
];

export default function DevCommunityNotes() {
    return <CommunityNotesScreen toRate={TO_RATE} rated={RATED} written={WRITTEN} />;
}
