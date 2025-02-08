import React, { useEffect, useState } from 'react';
import {
    View,
    FlatList,
    TouchableOpacity,
    Text,
    StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { conversationApi } from '@/utils/chatApi';

interface Conversation {
    _id: string;
    name?: string;
    participants: { username: string }[];
    lastMessage?: { content: string };
}

export default function ConversationList() {
    const [conversations, setConversations] = useState<Conversation[]>([]);
    const router = useRouter();

    useEffect(() => {
        loadConversations();
    }, []);

    const loadConversations = async () => {
        try {
            const response = await conversationApi.getAllConversations();
            setConversations(response.data);
        } catch (error) {
            console.error('Error loading conversations:', error);
        }
    };

    const renderItem = ({ item }: { item: Conversation }) => (
        <TouchableOpacity
            style={styles.conversationItem}
            onPress={() => router.push({
                pathname: `/chat/c/${item._id}`,
            })}
        >
            <Text style={styles.conversationName}>
                {item.name || item.participants.map((p: any) => p?.username).join(', ')}
            </Text>
            {item.lastMessage && (
                <Text style={styles.lastMessage} numberOfLines={1}>
                    {item.lastMessage.content}
                </Text>
            )}
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            <TouchableOpacity
                style={styles.createButton}
                onPress={() => router.push('/chat/create')}
            >
                <Text style={styles.createButtonText}>New Conversation</Text>
            </TouchableOpacity>

            <FlatList
                data={conversations}
                renderItem={renderItem}
                keyExtractor={(item) => item._id}
                contentContainerStyle={styles.listContainer}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    createButton: {
        backgroundColor: '#007AFF',
        margin: 16,
        padding: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    createButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    listContainer: {
        padding: 16,
        paddingTop: 0,
    },
    conversationItem: {
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#eee',
    },
    conversationName: {
        fontSize: 16,
        fontWeight: 'bold',
        marginBottom: 4,
    },
    lastMessage: {
        fontSize: 14,
        color: '#666',
    },
});