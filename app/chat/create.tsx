import React, { useState } from 'react';
import {
    View,
    TextInput,
    TouchableOpacity,
    Text,
    StyleSheet,
    Switch,
    Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { conversationApi } from '@/utils/chatApi';

export default function CreateConversation() {
    const [name, setName] = useState('');
    const [participantId, setParticipantId] = useState('');
    const [isGroup, setIsGroup] = useState(false);
    const router = useRouter();

    const handleCreate = async () => {
        try {
            if (!participantId) {
                Alert.alert('Error', 'Please enter participant ID');
                return;
            }

            const participants = participantId.split(',').map(id => id.trim());

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
        <View style={styles.container}>
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
                value={participantId}
                onChangeText={setParticipantId}
                placeholder={isGroup ? "Participant IDs (comma-separated)" : "Participant ID"}
                placeholderTextColor="#666"
            />

            <TouchableOpacity style={styles.button} onPress={handleCreate}>
                <Text style={styles.buttonText}>Create Conversation</Text>
            </TouchableOpacity>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
        backgroundColor: '#fff',
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
        borderRadius: 8,
        marginBottom: 16,
        fontSize: 16,
    },
    button: {
        backgroundColor: '#007AFF',
        padding: 16,
        borderRadius: 8,
        alignItems: 'center',
    },
    buttonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
    },
});