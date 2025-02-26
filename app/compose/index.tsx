import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { CreatePost } from '@/components/CreatePost';
import { Post as IPost } from '@/interfaces/Post';

export default function ComposeScreen() {
    const params = useLocalSearchParams<{ draft?: string }>();
    const [draftPost, setDraftPost] = useState<IPost | null>(null);

    useEffect(() => {
        if (params.draft) {
            try {
                const parsedDraft = JSON.parse(params.draft);
                setDraftPost(parsedDraft);
            } catch (error) {
                console.error('Error parsing draft:', error);
            }
        }
    }, [params.draft]);

    const handleClose = () => {
        router.back();
    };

    const handlePostCreated = () => {
        router.back();
    };

    return (
        <View style={{ flex: 1, backgroundColor: '#fff' }}>
            <Header options={{ title: draftPost ? 'Edit Draft' : 'New Post' }} />
            <CreatePost
                onClose={handleClose}
                onPostCreated={handlePostCreated}
                initialText={draftPost?.text}
                initialMedia={draftPost?.media}
                isDraft={draftPost?.isDraft}
                scheduledFor={draftPost?.scheduledFor}
                postId={draftPost?.id}
            />
        </View>
    );
} 