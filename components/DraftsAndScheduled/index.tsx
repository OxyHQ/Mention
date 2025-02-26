import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, Pressable } from 'react-native';
import { fetchData } from '@/utils/api';
import { Post as IPost } from '@/interfaces/Post';
import Post from '@/components/Post';
import { colors } from '@/styles/colors';

interface Props {
    onEditPost?: (post: IPost) => void;
}

export const DraftsAndScheduled: React.FC<Props> = ({ onEditPost }) => {
    const [drafts, setDrafts] = useState<IPost[]>([]);
    const [scheduledPosts, setScheduledPosts] = useState<IPost[]>([]);
    const [activeTab, setActiveTab] = useState<'drafts' | 'scheduled'>('drafts');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchDrafts = async () => {
        try {
            const response = await fetchData<{ data: IPost[] }>('posts/drafts');
            setDrafts(response.data);
        } catch (err) {
            setError('Failed to load drafts');
            console.error('Error fetching drafts:', err);
        }
    };

    const fetchScheduledPosts = async () => {
        try {
            const response = await fetchData<{ data: IPost[] }>('posts/scheduled');
            setScheduledPosts(response.data);
        } catch (err) {
            setError('Failed to load scheduled posts');
            console.error('Error fetching scheduled posts:', err);
        }
    };

    useEffect(() => {
        const loadData = async () => {
            setLoading(true);
            setError(null);
            await Promise.all([fetchDrafts(), fetchScheduledPosts()]);
            setLoading(false);
        };

        loadData();
    }, []);

    const renderPost = ({ item }: { item: IPost }) => (
        <View style={styles.postContainer}>
            <Post postData={item} />
            {onEditPost && (
                <Pressable
                    style={styles.editButton}
                    onPress={() => onEditPost(item)}>
                    <Text style={styles.editButtonText}>Edit</Text>
                </Pressable>
            )}
            {activeTab === 'scheduled' && item.scheduledFor && (
                <Text style={styles.scheduledText}>
                    Scheduled for: {new Date(item.scheduledFor).toLocaleString()}
                </Text>
            )}
        </View>
    );

    if (loading) {
        return (
            <View style={styles.container}>
                <Text>Loading...</Text>
            </View>
        );
    }

    if (error) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>{error}</Text>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.tabContainer}>
                <Pressable
                    style={[styles.tab, activeTab === 'drafts' && styles.activeTab]}
                    onPress={() => setActiveTab('drafts')}>
                    <Text style={[styles.tabText, activeTab === 'drafts' && styles.activeTabText]}>
                        Drafts ({drafts.length})
                    </Text>
                </Pressable>
                <Pressable
                    style={[styles.tab, activeTab === 'scheduled' && styles.activeTab]}
                    onPress={() => setActiveTab('scheduled')}>
                    <Text style={[styles.tabText, activeTab === 'scheduled' && styles.activeTabText]}>
                        Scheduled ({scheduledPosts.length})
                    </Text>
                </Pressable>
            </View>

            <FlatList
                data={activeTab === 'drafts' ? drafts : scheduledPosts}
                renderItem={renderPost}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContainer}
                ListEmptyComponent={
                    <Text style={styles.emptyText}>
                        No {activeTab === 'drafts' ? 'drafts' : 'scheduled posts'} found
                    </Text>
                }
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    tabContainer: {
        flexDirection: 'row',
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_1,
    },
    tab: {
        flex: 1,
        paddingVertical: 15,
        alignItems: 'center',
    },
    activeTab: {
        borderBottomWidth: 2,
        borderBottomColor: colors.primaryColor,
    },
    tabText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    activeTabText: {
        color: colors.primaryColor,
        fontWeight: 'bold',
    },
    listContainer: {
        padding: 10,
    },
    postContainer: {
        marginBottom: 15,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_1,
        paddingBottom: 15,
    },
    editButton: {
        backgroundColor: colors.primaryColor,
        padding: 8,
        borderRadius: 5,
        alignSelf: 'flex-end',
        marginTop: 10,
    },
    editButtonText: {
        color: '#fff',
        fontWeight: 'bold',
    },
    emptyText: {
        textAlign: 'center',
        marginTop: 20,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    errorText: {
        color: 'red',
        textAlign: 'center',
        marginTop: 20,
    },
    scheduledText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        marginTop: 5,
        fontStyle: 'italic',
    },
}); 