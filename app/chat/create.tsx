import React, { useState } from 'react';
import {
    View,
    TextInput,
    TouchableOpacity,
    Text,
    StyleSheet,
    Switch,
    Alert,
    FlatList,
} from 'react-native';
import { useRouter } from 'expo-router';
import { conversationApi } from '@/utils/chatApi';
import { fetchUsersByUsername } from '@/utils/api';
import { colors } from '@/styles/colors';
import { SafeAreaView } from 'react-native-safe-area-context';

interface Participant {
    id: string;
    username: string;
}

export default function CreateConversation() {
    const [name, setName] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isGroup, setIsGroup] = useState(false);
    const [searchResults, setSearchResults] = useState<Participant[]>([]);
    const [selectedParticipants, setSelectedParticipants] = useState<Participant[]>([]);
    const router = useRouter();

    const handleSearch = async (query: string) => {
        try {
            const results = await fetchUsersByUsername(query);
            setSearchResults(results);
        } catch (error) {
            console.error('Error fetching users:', error);
        }
    };

    const handleSelectParticipant = (participant: Participant) => {
        setSelectedParticipants((prev) => [...prev, participant]);
        setSearchQuery('');
        setSearchResults([]);
    };

    const handleCreate = async () => {
        try {
            if (selectedParticipants.length === 0) {
                Alert.alert('Error', 'Please select at least one participant');
                return;
            }

            const participants = selectedParticipants.map((user) => user.id);

            const response = await conversationApi.createConversation({
                participants,
                type: isGroup ? 'group' : 'direct',
                name: isGroup ? name : undefined,
            });

            router.push({
                pathname: '/chat',
                params: { conversation: JSON.stringify(response.data) }
            });
        } catch (error) {
            Alert.alert('Error', 'Failed to create conversation');
            console.error('Error creating conversation:', error);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.switchContainer}>
                <Text style={styles.label}>Group Chat</Text>
                <Switch
                    value={isGroup}
                    onValueChange={setIsGroup}
                />
            </View>

            {isGroup && (
                <TextInput
                    style={styles.input}
                    value={name}
                    onChangeText={setName}
                    placeholder="Group Name"
                    placeholderTextColor="#666"
                />
            )}

            <TextInput
                style={styles.input}
                value={searchQuery}
                onChangeText={(text) => {
                    setSearchQuery(text);
                    handleSearch(text);
                }}
                placeholder="Search users by username"
                placeholderTextColor="#666"
            />

            <FlatList
                data={searchResults}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                    <TouchableOpacity onPress={() => handleSelectParticipant(item)}>
                        <Text style={styles.searchResult}>{item.username}</Text>
                    </TouchableOpacity>
                )}
            />

            <View style={styles.selectedParticipantsContainer}>
                {selectedParticipants.map((participant) => (
                    <Text key={participant.id} style={styles.selectedParticipant}>
                        {participant.username}
                    </Text>
                ))}
            </View>

            <TouchableOpacity style={styles.button} onPress={handleCreate}>
                <Text style={styles.buttonText}>Create Conversation</Text>
            </TouchableOpacity>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
    switchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
        justifyContent: 'space-between',
    },
    label: {
        fontSize: 16,
        color: '#333',
    },
    input: {
        backgroundColor: '#f0f0f0',
        padding: 12,
        borderRadius: 35,
        marginBottom: 16,
        fontSize: 16,
    },
    button: {
        backgroundColor: colors.primaryColor,
        padding: 16,
        borderRadius: 35,
        alignItems: 'center',
    },
    buttonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
    searchResult: {
        padding: 12,
        fontSize: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#ccc',
    },
    selectedParticipantsContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 16,
    },
    selectedParticipant: {
        backgroundColor: '#007AFF',
        color: '#fff',
        padding: 8,
        borderRadius: 16,
        marginRight: 8,
        marginBottom: 8,
    },
});
