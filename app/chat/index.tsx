import React, { useEffect, useState } from 'react';
import {
    View,
    FlatList,
    TouchableOpacity,
    Text,
    StyleSheet,
    Image,
    Pressable,
    ActivityIndicator,
    ScrollView,
} from 'react-native';
import { useRouter, Link } from 'expo-router';
import { conversationApi } from '@/utils/chatApi';
import { colors } from '@/styles/colors';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import { BlurView } from 'expo-blur';
import { Menu } from '@/components/ui/Menu';
import { getChatSocket, initializeChatSocket } from "@/utils/chatSocket";
import ExpandableMenu from '@/components/ui/ExpandableMenu';

interface Conversation {
    _id: string;
    name?: string;
    type: 'private' | 'secret' | 'group' | 'channel';
    participants: { username: string; id: string }[];
    lastMessage?: { 
        content: string;
        createdAt: string;
        media?: { type: string }[];
    };
    unreadCount?: number;
    isEncrypted?: boolean;
    description?: string;
    memberCount?: number;
    isPublic?: boolean;
}

export default function ConversationList() {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [filter, setFilter] = useState<'all' | 'private' | 'secret' | 'group' | 'channel'>('all');
    const router = useRouter();

    useEffect(() => {
        loadConversations();
        setupSocketListeners();

        return () => {
            const socket = getChatSocket();
            if (socket) {
                socket.off('conversationCreated');
                socket.off('message');
                socket.off('messageDeleted');
            }
        };
    }, []);

    const loadConversations = async () => {
        try {
            const response = await conversationApi.getAllConversations();
            setConversations(response.data);
        } catch (error) {
            console.error('Error loading conversations:', error);
        } finally {
            setIsLoading(false);
        }
    };

    const setupSocketListeners = async () => {
        await initializeChatSocket();
        const socket = getChatSocket();
        
        if (socket) {
            // Listen for new conversations
            socket.on('conversationCreated', (newConversation: Conversation) => {
                setConversations(prev => [newConversation, ...prev]);
            });

            // Listen for new messages to update last message
            socket.on('message', (message: any) => {
                setConversations(prev => prev.map(conv => 
                    conv._id === message.conversationId 
                        ? {
                            ...conv,
                            lastMessage: {
                                content: message.message,
                                createdAt: message.createdAt,
                                media: message.media
                            }
                        }
                        : conv
                ));
            });

            // Listen for message deletions
            socket.on('messageDeleted', ({ messageId, conversationId }) => {
                setConversations(prev => prev.map(conv => 
                    conv._id === conversationId && conv.lastMessage?._id === messageId
                        ? {
                            ...conv,
                            lastMessage: undefined
                        }
                        : conv
                ));
            });
        }
    };

    const getChatIcon = (type: string) => {
        switch (type) {
            case 'private':
                return 'person-circle-outline';
            case 'secret':
                return 'lock-closed';
            case 'group':
                return 'people';
            case 'channel':
                return 'megaphone';
            default:
                return 'chatbubbles-outline';
        }
    };

    const formatLastMessageTime = (dateString?: string) => {
        if (!dateString) return '';
        const date = new Date(dateString);
        const now = new Date();
        const diff = now.getTime() - date.getTime();
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));
        
        if (days === 0) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (days === 1) {
            return 'Yesterday';
        } else if (days < 7) {
            return date.toLocaleDateString([], { weekday: 'short' });
        } else {
            return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        }
    };

    const getLastMessagePreview = (conversation: Conversation) => {
        if (!conversation.lastMessage) return '';
        if (conversation.isEncrypted) return '🔒 Encrypted message';
        if (conversation.lastMessage.media?.length) {
            const mediaType = conversation.lastMessage.media[0].type;
            return mediaType === 'image' ? '🖼️ Photo' : '🎥 Video';
        }
        return conversation.lastMessage.content;
    };

    const renderItem = ({ item }: { item: Conversation }) => (
        <TouchableOpacity
            style={styles.conversationItem}
            onPress={() => router.push(`/chat/c/${item._id}`)}
        >
            <View style={styles.avatarContainer}>
                {item.type === 'private' || item.type === 'secret' ? (
                    <Avatar 
                        size={56} 
                        id={item.participants[0]?.id} 
                        style={styles.avatar}
                    />
                ) : (
                    <View style={[styles.groupAvatar, item.type === 'channel' && styles.channelAvatar]}>
                        <Ionicons name={getChatIcon(item.type)} size={28} color={colors.primaryLight} />
                    </View>
                )}
                {item.type === 'secret' && (
                    <View style={styles.secretBadge}>
                        <Ionicons name="lock-closed" size={12} color={colors.primaryLight} />
                    </View>
                )}
            </View>
            
            <View style={styles.conversationInfo}>
                <View style={styles.conversationHeader}>
                    <Text style={styles.conversationName} numberOfLines={1}>
                        {item.name || item.participants.map(p => p?.username).join(', ')}
                    </Text>
                    <Text style={styles.timeText}>
                        {formatLastMessageTime(item.lastMessage?.createdAt)}
                    </Text>
                </View>
                
                <View style={styles.lastMessageContainer}>
                    {item.type !== 'private' && (
                        <Text style={styles.chatType}>
                            {item.type.charAt(0).toUpperCase() + item.type.slice(1)}
                            {item.memberCount ? ` · ${item.memberCount} members` : ''}
                        </Text>
                    )}
                    <Text style={styles.lastMessage} numberOfLines={1}>
                        {getLastMessagePreview(item)}
                    </Text>
                    {item.unreadCount ? (
                        <View style={styles.unreadBadge}>
                            <Text style={styles.unreadCount}>{item.unreadCount}</Text>
                        </View>
                    ) : null}
                </View>
            </View>
        </TouchableOpacity>
    );

    const ListEmptyComponent = () => (
        <View style={styles.emptyContainer}>
            {isLoading ? (
                <ActivityIndicator size="large" color={colors.primaryColor} />
            ) : (
                <>
                    <Ionicons name="chatbubbles-outline" size={48} color={colors.COLOR_BLACK_LIGHT_4} />
                    <Text style={styles.emptyText}>No conversations yet</Text>
                    <Text style={styles.emptySubtext}>Start chatting with your friends!</Text>
                </>
            )}
        </View>
    );

    const FilterChip = ({ type, label }: { type: typeof filter, label: string }) => (
        <Pressable 
            style={[styles.filterChip, filter === type && styles.filterChipActive]}
            onPress={() => setFilter(type)}
        >
            <Ionicons name={getChatIcon(type === 'all' ? 'private' : type)} size={16} color={filter === type ? colors.primaryLight : colors.primaryColor} />
            <Text style={[styles.filterLabel, filter === type && styles.filterLabelActive]}>{label}</Text>
        </Pressable>
    );

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>Messages</Text>
                <Menu
                    trigger={
                        <View style={styles.createButton}>
                            <Ionicons name="add" size={24} color={colors.primaryColor} />
                        </View>
                    }
                    items={[
                        {
                            label: 'New Chat',
                            icon: 'chatbubble-outline',
                            onPress: () => router.push('/chat/create?type=private')
                        },
                        {
                            label: 'Secret Chat',
                            icon: 'lock-closed',
                            onPress: () => router.push('/chat/create?type=secret')
                        },
                        {
                            label: 'Create Group',
                            icon: 'people',
                            onPress: () => router.push('/chat/create?type=group')
                        },
                        {
                            label: 'Create Channel',
                            icon: 'megaphone',
                            onPress: () => router.push('/chat/create?type=channel')
                        }
                    ]}
                />
            </View>

            <ScrollView 
                horizontal 
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterContainer}
            >
                <FilterChip type="all" label="All" />
                <FilterChip type="private" label="Chats" />
                <FilterChip type="secret" label="Secret" />
                <FilterChip type="group" label="Groups" />
                <FilterChip type="channel" label="Channels" />
            </ScrollView>

            <FlatList
                data={conversations.filter(c => filter === 'all' || c.type === filter)}
                renderItem={renderItem}
                keyExtractor={(item) => item._id}
                contentContainerStyle={styles.listContainer}
                ListEmptyComponent={ListEmptyComponent}
                showsVerticalScrollIndicator={false}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    title: {
        fontSize: 28,
        fontWeight: 'bold',
        color: colors.primaryDark,
    },
    createButton: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        justifyContent: 'center',
        alignItems: 'center',
    },
    filterContainer: {
        padding: 12,
        gap: 8,
    },
    filterChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 16,
        gap: 6,
    },
    filterChipActive: {
        backgroundColor: colors.primaryColor,
    },
    filterLabel: {
        fontSize: 14,
        color: colors.primaryColor,
        fontWeight: '500',
    },
    filterLabelActive: {
        color: colors.primaryLight,
    },
    listContainer: {
        flexGrow: 1,
    },
    conversationItem: {
        flexDirection: 'row',
        padding: 16,
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    avatarContainer: {
        position: 'relative',
        marginRight: 12,
    },
    avatar: {
        marginRight: 12,
    },
    groupAvatar: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
    },
    channelAvatar: {
        backgroundColor: colors.chatUnreadBadge,
    },
    secretBadge: {
        position: 'absolute',
        bottom: -4,
        right: -4,
        backgroundColor: colors.primaryColor,
        borderRadius: 12,
        width: 24,
        height: 24,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: colors.primaryLight,
    },
    conversationInfo: {
        flex: 1,
    },
    conversationHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    conversationName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.primaryDark,
        flex: 1,
        marginRight: 8,
    },
    timeText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    chatType: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginBottom: 2,
    },
    lastMessageContainer: {
        flexDirection: 'column',
    },
    lastMessage: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        flex: 1,
        marginRight: 8,
    },
    unreadBadge: {
        position: 'absolute',
        right: 0,
        bottom: 0,
        backgroundColor: colors.primaryColor,
        borderRadius: 12,
        minWidth: 24,
        height: 24,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 8,
    },
    unreadCount: {
        color: colors.primaryLight,
        fontSize: 12,
        fontWeight: '600',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 32,
    },
    emptyText: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 16,
    },
    emptySubtext: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 8,
    },
});