import React, { useState, useEffect } from 'react';
import { getData } from '@/utils/storage';
import {
    View,
    TextInput,
    TouchableOpacity,
    Text,
    StyleSheet,
    Switch,
    Alert,
    FlatList,
    ActivityIndicator,
    Pressable,
    ScrollView,
} from 'react-native';
import { useRouter, Stack, useLocalSearchParams } from 'expo-router';
import { conversationApi, ChatType } from '@/utils/chatApi';
import { fetchUsersByUsername } from '@/utils/api';
import { colors } from '@/styles/colors';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import Avatar from '@/components/Avatar';
import { BlurView } from 'expo-blur';
import { debounce } from 'lodash';

interface Participant {
    id: string;
    username: string;
}

export default function CreateConversation() {
    const { type = 'private' } = useLocalSearchParams<{ type: ChatType }>();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [isPublic, setIsPublic] = useState(false);
    const [ttl, setTtl] = useState(0); // Time-to-live for secret chats
    const [searchResults, setSearchResults] = useState<Participant[]>([]);
    const [selectedParticipants, setSelectedParticipants] = useState<Participant[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const isChannel = type === 'channel';
    const isGroup = type === 'group';
    const isSecret = type === 'secret';

    const debouncedSearch = debounce(async (query: string) => {
        if (!query.trim()) {
            setSearchResults([]);
            return;
        }
        
        setIsLoading(true);
        try {
            const results = await fetchUsersByUsername(query);
            setSearchResults(results);
        } catch (error) {
            console.error('Error fetching users:', error);
            Alert.alert('Error', 'Failed to search users');
        } finally {
            setIsLoading(false);
        }
    }, 300);

    const handleSearch = (query: string) => {
        setSearchQuery(query);
        debouncedSearch(query);
    };

    const handleSelectParticipant = (participant: Participant) => {
        if (!selectedParticipants.find(p => p.id === participant.id)) {
            // For private and secret chats, limit to one participant
            if ((type === 'private' || type === 'secret') && selectedParticipants.length > 0) {
                setSelectedParticipants([participant]);
            } else {
                setSelectedParticipants((prev) => [...prev, participant]);
            }
        }
        setSearchQuery('');
        setSearchResults([]);
    };

    const handleRemoveParticipant = (participantId: string) => {
        setSelectedParticipants((prev) => prev.filter((p) => p.id !== participantId));
    };

    const getTypeIcon = () => {
        switch (type) {
            case 'private':
                return 'chatbubble-outline';
            case 'secret':
                return 'lock-closed';
            case 'group':
                return 'people';
            case 'channel':
                return 'megaphone';
            default:
                return 'chatbubble-outline';
        }
    };

    const validateForm = () => {
        if (selectedParticipants.length === 0) {
            Alert.alert('Error', 'Please select at least one participant');
            return false;
        }

        if ((isGroup || isChannel) && !name.trim()) {
            Alert.alert('Error', `Please enter a ${isChannel ? 'channel' : 'group'} name`);
            return false;
        }

        if (isSecret && ttl === 0) {
            Alert.alert('Error', 'Please set a message expiration time for secret chat');
            return false;
        }

        return true;
    };

    const handleCreate = async () => {
        try {
            if (!validateForm()) return;

            const currentUserId = await getData('userId');
            if (!currentUserId) {
                Alert.alert('Error', 'Not logged in');
                return;
            }

            const data = {
                participants: selectedParticipants.map((user) => user.id),
                type: type as ChatType,
                name: isGroup || isChannel ? name : undefined,
                description: description || undefined,
                isPublic: isChannel ? isPublic : undefined,
                ttl: isSecret ? ttl : undefined,
                owner: isGroup || isChannel ? currentUserId : undefined,
                admins: isGroup || isChannel ? [currentUserId] : undefined
            };

            await conversationApi.createConversation(data);
            router.push('/chat');
        } catch (error: any) {
            const errorMsg = error.response?.data?.error?.message || error.message || 'Failed to create conversation';
            Alert.alert('Error', errorMsg);
            console.error('Error creating conversation:', error);
        }
    };

    const renderTTLOption = (value: number, label: string) => (
        <Pressable
            style={[styles.ttlOption, ttl === value && styles.ttlOptionSelected]}
            onPress={() => setTtl(value)}
        >
            <Text style={[styles.ttlOptionText, ttl === value && styles.ttlOptionTextSelected]}>
                {label}
            </Text>
        </Pressable>
    );

    return (
        <SafeAreaView style={styles.container}>
            <View style={styles.header}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
                    <Ionicons name="arrow-back" size={24} color={colors.primaryColor} />
                </TouchableOpacity>
                <Text style={styles.title}>
                    <Ionicons name={getTypeIcon()} size={24} color={colors.primaryDark} />
                    {' '}New {type.charAt(0).toUpperCase() + type.slice(1)}
                </Text>
            </View>

            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                {(isGroup || isChannel) && (
                    <>
                        <BlurView intensity={10} style={styles.inputWrapper}>
                            <TextInput
                                style={styles.input}
                                value={name}
                                onChangeText={setName}
                                placeholder={`${isChannel ? 'Channel' : 'Group'} Name`}
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                            />
                        </BlurView>

                        <BlurView intensity={10} style={styles.inputWrapper}>
                            <TextInput
                                style={styles.input}
                                value={description}
                                onChangeText={setDescription}
                                placeholder="Description (optional)"
                                placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                                multiline
                            />
                        </BlurView>

                        {isChannel && (
                            <BlurView intensity={10} style={styles.switchContainer}>
                                <Text style={styles.label}>Public Channel</Text>
                                <Switch
                                    value={isPublic}
                                    onValueChange={setIsPublic}
                                    trackColor={{ false: colors.COLOR_BLACK_LIGHT_6, true: colors.primaryColor }}
                                    thumbColor={colors.primaryLight}
                                />
                            </BlurView>
                        )}
                    </>
                )}

                {isSecret && (
                    <BlurView intensity={10} style={styles.ttlContainer}>
                        <Text style={styles.label}>Message Expiration Time</Text>
                        <View style={styles.ttlOptionsContainer}>
                            {renderTTLOption(24 * 3600, '24h')}
                            {renderTTLOption(7 * 24 * 3600, '7d')}
                            {renderTTLOption(30 * 24 * 3600, '30d')}
                            {renderTTLOption(-1, 'Never')}
                        </View>
                    </BlurView>
                )}

                <BlurView intensity={10} style={styles.searchContainer}>
                    <Ionicons name="search" size={20} color={colors.COLOR_BLACK_LIGHT_4} style={styles.searchIcon} />
                    <TextInput
                        style={styles.searchInput}
                        value={searchQuery}
                        onChangeText={handleSearch}
                        placeholder={`Search ${isChannel ? 'subscribers' : 'users'}`}
                        placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                    />
                    {isLoading && <ActivityIndicator size="small" color={colors.primaryColor} />}
                </BlurView>

                {selectedParticipants.length > 0 && (
                    <FlatList
                        data={selectedParticipants}
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.selectedParticipantsList}
                        keyExtractor={(item) => item.id}
                        renderItem={({ item }) => (
                            <Pressable style={styles.participantChip} onPress={() => handleRemoveParticipant(item.id)}>
                                <Avatar size={24} id={item.id} style={styles.chipAvatar} />
                                <Text style={styles.participantChipText}>@{item.username}</Text>
                                <Ionicons name="close-circle" size={16} color={colors.primaryLight} />
                            </Pressable>
                        )}
                    />
                )}

                {searchResults.length > 0 && (
                    <FlatList
                        data={searchResults}
                        style={styles.searchResults}
                        keyExtractor={(item) => item.id}
                        renderItem={({ item }) => (
                            <TouchableOpacity
                                style={styles.searchResultItem}
                                onPress={() => handleSelectParticipant(item)}
                            >
                                <Avatar size={40} id={item.id} style={styles.resultAvatar} />
                                <Text style={styles.searchResultText}>@{item.username}</Text>
                            </TouchableOpacity>
                        )}
                    />
                )}
            </ScrollView>

            <TouchableOpacity
                style={[
                    styles.createButton,
                    (!selectedParticipants.length || (isGroup && !name.trim())) && styles.buttonDisabled
                ]}
                onPress={handleCreate}
                disabled={!selectedParticipants.length || ((isGroup || isChannel) && !name.trim())}
            >
                <Text style={styles.createButtonText}>
                    Create {type.charAt(0).toUpperCase() + type.slice(1)}
                </Text>
            </TouchableOpacity>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.primaryLight,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    backButton: {
        padding: 8,
        marginRight: 8,
    },
    title: {
        fontSize: 24,
        fontWeight: '600',
        color: colors.primaryDark,
    },
    content: {
        flex: 1,
        padding: 16,
    },
    switchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 16,
        borderRadius: 16,
        marginBottom: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    ttlContainer: {
        padding: 16,
        borderRadius: 16,
        marginBottom: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    ttlOptionsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 12,
    },
    ttlOption: {
        padding: 8,
        paddingHorizontal: 16,
        borderRadius: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
    },
    ttlOptionSelected: {
        backgroundColor: colors.primaryColor,
    },
    ttlOptionText: {
        color: colors.primaryDark,
        fontWeight: '500',
    },
    ttlOptionTextSelected: {
        color: colors.primaryLight,
    },
    label: {
        fontSize: 16,
        fontWeight: '500',
        color: colors.primaryDark,
    },
    inputWrapper: {
        borderRadius: 16,
        marginBottom: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        overflow: 'hidden',
    },
    input: {
        padding: 16,
        fontSize: 16,
        color: colors.primaryDark,
        minHeight: 52,
    },
    searchContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 16,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        marginBottom: 16,
    },
    searchIcon: {
        marginRight: 8,
    },
    searchInput: {
        flex: 1,
        fontSize: 16,
        color: colors.primaryDark,
    },
    selectedParticipantsList: {
        maxHeight: 56,
        marginBottom: 16,
    },
    participantChip: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primaryColor,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 20,
        marginRight: 8,
    },
    chipAvatar: {
        marginRight: 6,
    },
    participantChipText: {
        color: colors.primaryLight,
        marginRight: 6,
        fontSize: 14,
        fontWeight: '500',
    },
    searchResults: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        borderRadius: 16,
    },
    searchResultItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    resultAvatar: {
        marginRight: 12,
    },
    searchResultText: {
        fontSize: 16,
        color: colors.primaryDark,
        fontWeight: '500',
    },
    createButton: {
        backgroundColor: colors.primaryColor,
        margin: 16,
        padding: 16,
        borderRadius: 16,
        alignItems: 'center',
    },
    buttonDisabled: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_4,
    },
    createButtonText: {
        color: colors.primaryLight,
        fontSize: 16,
        fontWeight: '600',
    },
});
