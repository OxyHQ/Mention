import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '@/components/Header';
import { CreatePost } from '@/components/CreatePost';
import { Post as IPost } from '@/interfaces/Post';
import { fetchData } from '@/utils/api';

export default function QuoteScreen() {
    const { id } = useLocalSearchParams<{ id: string }>();
    const [post, setPost] = useState<IPost | undefined>(undefined);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchPost = async () => {
            try {
                setLoading(true);
                setError(null);
                const response = await fetchData<{ data: IPost }>(`feed/post/${id}`);
                setPost(response.data);
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load post');
                console.error('Error fetching post:', err);
            } finally {
                setLoading(false);
            }
        };

        if (id) {
            fetchPost();
        }
    }, [id]);

    const handleClose = () => {
        router.back();
    };

    const handlePostCreated = () => {
        router.back();
    };

    return (
        <View className="flex-1 bg-white">
            <Header options={{ title: 'Quote Post' }} />
            <CreatePost
                repostPostId={id}
                repostPost={post}
                onClose={handleClose}
                onPostCreated={handlePostCreated}
            />
        </View>
    );
} 