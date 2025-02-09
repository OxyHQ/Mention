import React, { useState, useEffect, useRef } from "react";
import { 
    View, Text, TextInput, ScrollView, Pressable, StyleSheet, Image, 
    Platform, ImageStyle, ViewStyle, KeyboardAvoidingView, Dimensions, Alert 
} from "react-native";
import { useLocalSearchParams, Link, useRouter } from "expo-router";
import { conversationApi, messageApi } from "@/utils/chatApi";
import FileSelectorModal from "@/modules/oxyhqservices/components/FileSelectorModal";
import { colors } from "@/styles/colors";
import { Header } from "@/components/Header";
import Avatar from "@/components/Avatar";
import { Ionicons } from "@expo/vector-icons";
import { Video, ResizeMode } from "expo-av";
import { SafeAreaView } from "react-native-safe-area-context";
import { BlurView } from 'expo-blur';
import { Menu } from '@/components/ui/Menu';
import { getData } from '@/utils/storage';
import { joinConversation, leaveConversation, getChatSocket } from "@/utils/chatSocket";

interface Message {
    _id: string;
    userId: string;
    createdAt: string;
    message: string;
    isSent: boolean;
    media?: { uri: string; type: "video" | "image"; id: string; }[];
    isEncrypted?: boolean;
    encryptedContent?: string;
    reactions?: { emoji: string; userId: string }[];
}

interface MessageGroup {
    userId: string;
    messages: Message[];
}

interface Conversation {
    _id: string;
    type: 'private' | 'secret' | 'group' | 'channel';
    name?: string;
    participants: { username: string; id: string }[];
    isEncrypted?: boolean;
    encryptionKey?: string;
    description?: string;
    owner?: string;
    admins?: string[];
    isPublic?: boolean;
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const BUBBLE_MAX_WIDTH = SCREEN_WIDTH * 0.75;

export default function ChatScreen() {
    const { id: conversationID } = useLocalSearchParams<{ id: string }>();
    const router = useRouter();
    const [conversation, setConversation] = useState<Conversation | null>(null);
    const [messages, setMessages] = useState<Message[]>([]);
    const [selectedMedia, setSelectedMedia] = useState<{ uri: string; type: "image" | "video"; id: string }[]>([]);
    const [isModalVisible, setModalVisible] = useState(false);
    const [inputText, setInputText] = useState("");
    const [isAdmin, setIsAdmin] = useState(false);
    const inputRef = useRef<TextInput>(null);
    const scrollViewRef = useRef<ScrollView>(null);

    useEffect(() => {
        const socket = getChatSocket();
        
        loadConversation();
        loadMessages();
        
        if (socket) {
            joinConversation(conversationID);
            
            // Listen for new messages
            socket.on('message', (newMessage: Message) => {
                setMessages(prev => [...prev, newMessage]);
                scrollViewRef.current?.scrollToEnd({ animated: true });
            });

            // Listen for message updates
            socket.on('messageEdited', ({ messageId, newMessage }) => {
                setMessages(prev => prev.map(msg => 
                    msg._id === messageId ? { ...msg, message: newMessage } : msg
                ));
            });

            // Listen for message deletions
            socket.on('messageDeleted', ({ messageId }) => {
                setMessages(prev => prev.filter(msg => msg._id !== messageId));
            });

            // Listen for reactions
            socket.on('messageReaction', ({ messageId, emoji, userId }) => {
                setMessages(prev => prev.map(msg => 
                    msg._id === messageId 
                        ? { 
                            ...msg, 
                            reactions: [...(msg.reactions || []), { emoji, userId }] 
                          }
                        : msg
                ));
            });

            // Listen for typing indicators
            socket.on('typing', ({ user }) => {
                // Add typing indicator logic here
            });

            socket.on('stopTyping', ({ user }) => {
                // Remove typing indicator logic here
            });
        }

        return () => {
            if (socket) {
                leaveConversation(conversationID);
                socket.off('message');
                socket.off('messageEdited');
                socket.off('messageDeleted');
                socket.off('messageReaction');
                socket.off('typing');
                socket.off('stopTyping');
            }
        };
    }, [conversationID]);

    const loadConversation = async () => {
        try {
            const response = await conversationApi.getConversation(conversationID);
            setConversation(response.data);
            // Check if current user is admin
            const currentUser = await getData('userId');
            setIsAdmin(response.data.admins?.includes(currentUser) || response.data.owner === currentUser);
        } catch (error) {
            console.error("Error loading conversation:", error);
            Alert.alert("Error", "Failed to load conversation");
        }
    };

    const loadMessages = async () => {
        try {
            const response = await messageApi.getMessages(conversationID);
            setMessages(response.data);
        } catch (error) {
            console.error("Error loading messages:", error);
            Alert.alert("Error", "Failed to load messages");
        }
    };

    const handleSendMessage = async () => {
        if (!inputText.trim() && !selectedMedia.length) return;

        try {
            if (conversation?.type === 'secret') {
                await messageApi.sendSecureMessage({
                    conversationId: conversationID,
                    content: inputText,
                    encryptionKey: conversation.encryptionKey!,
                });
            } else {
                await messageApi.sendMessage({
                    conversationId: conversationID,
                    content: inputText,
                    type: selectedMedia.length ? 'media' : 'text',
                });
            }
            setInputText("");
            setSelectedMedia([]);
        } catch (error) {
            console.error("Error sending message:", error);
            Alert.alert("Error", "Failed to send message");
        }
    };

    const handleMoreOptions = () => {
        const options = [];
        
        if (conversation?.type === 'group' || conversation?.type === 'channel') {
            if (isAdmin) {
                options.push(
                    {
                        label: 'Add Members',
                        icon: 'person-add',
                        onPress: () => router.push(`/chat/members/add/${conversationID}`)
                    },
                    {
                        label: 'Manage Members',
                        icon: 'people',
                        onPress: () => router.push(`/chat/members/manage/${conversationID}`)
                    }
                );
            }
            options.push({
                label: 'View Info',
                icon: 'information-circle',
                onPress: () => router.push(`/chat/info/${conversationID}`)
            });
        }

        if (conversation?.type === 'secret') {
            options.push({
                label: 'View Security Info',
                icon: 'shield',
                onPress: () => router.push(`/chat/security/${conversationID}`)
            });
        }

        return options;
    };

    const renderHeader = () => (
        <Header
            options={{
                title: conversation?.name || conversation?.participants[0]?.username || "Chat",
                titlePosition: "left",
                subtitle: conversation?.type === 'channel' ? 
                    `${conversation.isPublic ? 'Public' : 'Private'} Channel` : 
                    conversation?.type === 'group' ? 
                    `${conversation.participants.length} members` : 
                    "Online",
                leftComponents: [
                    <Link href="/chat" key="back" style={styles.headerBackLink}>
                        <Ionicons name="chevron-back" size={24} color={colors.primaryColor} />
                    </Link>,
                    conversation?.type === 'private' || conversation?.type === 'secret' ? (
                        <Avatar key="avatar" size={32} id={conversation.participants[0]?.id} style={styles.headerAvatar} />
                    ) : (
                        <View key="groupIcon" style={[styles.headerGroupIcon, conversation?.type === 'channel' && styles.headerChannelIcon]}>
                            <Ionicons 
                                name={conversation?.type === 'channel' ? 'megaphone' : 'people'} 
                                size={20} 
                                color={colors.primaryLight} 
                            />
                        </View>
                    ),
                ],
                rightComponents: [
                    ...(conversation?.type !== 'channel' ? [
                        <Pressable key="call" style={styles.headerIcon}>
                            <Ionicons name="call" size={20} color={colors.primaryColor} />
                        </Pressable>,
                        <Pressable key="video" style={styles.headerIcon}>
                            <Ionicons name="videocam" size={20} color={colors.primaryColor} />
                        </Pressable>
                    ] : []),
                    <Menu
                        key="more"
                        trigger={
                            <Pressable style={styles.headerIcon}>
                                <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
                            </Pressable>
                        }
                        items={handleMoreOptions()}
                    />
                ],
            }}
            style={styles.header}
        />
    );

    useEffect(() => {
        inputRef.current?.focus();
    }, [messages]);

    useEffect(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
    }, [messages]);

    const openMediaSelect = () => setModalVisible(true);
    const closeMediaSelect = () => setModalVisible(false);

    const handleMediaSelect = (selectedFiles: any[]) => {
        const media = selectedFiles.map((file) => ({
            uri: file.uri,
            type: file.type.startsWith("image/") ? "image" as const : "video" as const,
            id: file.id,
        }));
        setSelectedMedia((prev) => [...prev, ...media]);
    };

    const removeMediaItem = (index: number) => {
        setSelectedMedia(prev => prev.filter((_, i) => i !== index));
    };

    // Group messages by user and time threshold (5 minutes)
    const TIME_THRESHOLD = 5 * 60 * 1000;
    const groupMessages = (messages: Message[]): MessageGroup[] => {
        const groups: MessageGroup[] = [];
        messages.forEach((message) => {
            if (groups.length === 0) {
                groups.push({ userId: message.userId, messages: [message] });
            } else {
                const lastGroup = groups[groups.length - 1];
                const lastMessage = lastGroup.messages[lastGroup.messages.length - 1];
                if (
                    message.userId === lastGroup.userId &&
                    new Date(message.createdAt).getTime() - new Date(lastMessage.createdAt).getTime() < TIME_THRESHOLD
                ) {
                    lastGroup.messages.push(message);
                } else {
                    groups.push({ userId: message.userId, messages: [message] });
                }
            }
        });
        return groups;
    };

    const groupedMessages = groupMessages(messages);

    const formatTime = (dateString: string) => {
        const date = new Date(dateString);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const DateSeparator = ({ date }: { date: string }) => (
        <View style={styles.dateSeparator}>
            <Text style={styles.dateSeparatorText}>
                {new Date(date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            </Text>
        </View>
    );

    const MessageBubble = ({ message, isFirst, isLast, isSent }: { message: Message; isFirst: boolean; isLast: boolean; isSent: boolean }) => (
        <View style={[
            styles.bubbleWrapper,
            isSent ? styles.sentBubbleWrapper : styles.receivedBubbleWrapper,
        ]}>
            {!isSent && isFirst && (
                <Avatar size={24} id={message.userId} style={styles.bubbleAvatar} />
            )}
            <View style={[
                styles.bubble,
                isSent ? styles.sentBubble : styles.receivedBubble,
                !isFirst && !isLast && (isSent ? styles.sentMiddle : styles.receivedMiddle),
                isFirst && (isSent ? styles.sentFirst : styles.receivedFirst),
                isLast && (isSent ? styles.sentLast : styles.receivedLast),
            ]}>
                {message.media?.map((mediaItem, mediaIndex) =>
                    mediaItem.type === "image" ? (
                        <Image 
                            key={mediaIndex} 
                            source={{ uri: mediaItem.uri }} 
                            style={styles.mediaImage} 
                        />
                    ) : (
                        <Video
                            key={mediaIndex}
                            source={{ uri: mediaItem.uri }}
                            style={styles.mediaVideo}
                            useNativeControls
                            resizeMode={ResizeMode.COVER}
                            shouldPlay={false}
                            isMuted={true}
                        />
                    )
                )}
                {message.message && (
                    <Text style={[
                        styles.messageText,
                        isSent ? styles.sentText : styles.receivedText
                    ]}>
                        {message.message}
                    </Text>
                )}
                <Text style={[
                    styles.timestamp,
                    isSent ? styles.sentTimestamp : styles.receivedTimestamp
                ]}>
                    {formatTime(message.createdAt)}
                </Text>
            </View>
        </View>
    );

    return (
        <SafeAreaView style={styles.safeArea}>
            <KeyboardAvoidingView 
                behavior={Platform.OS === "ios" ? "padding" : "height"}
                style={styles.container}
                keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
            >
                {renderHeader()}

                <ScrollView 
                    ref={scrollViewRef}
                    style={styles.messageContainer}
                    contentContainerStyle={styles.messageContent}
                >
                    {groupedMessages.map((group, groupIndex) => (
                        <View key={groupIndex} style={styles.messageGroup}>
                            {group.messages.map((message, idx) => (
                                <MessageBubble
                                    key={message._id}
                                    message={message}
                                    isFirst={idx === 0}
                                    isLast={idx === group.messages.length - 1}
                                    isSent={message.isSent}
                                />
                            ))}
                        </View>
                    ))}
                </ScrollView>

                {/* Don't show input for channels if not admin */}
                {(conversation?.type !== 'channel' || isAdmin) && (
                    <View style={styles.inputContainer}>
                        <FileSelectorModal
                            visible={isModalVisible}
                            onClose={() => setModalVisible(false)}
                            onSelect={handleMediaSelect}
                            options={{ fileTypeFilter: ["image/", "video/"], maxFiles: 5 }}
                        />
                        <View style={styles.inputInner}>
                            <View style={styles.mediaPreviewContainer}>
                                {selectedMedia.map((asset, index) => (
                                    <Pressable 
                                        key={index} 
                                        style={styles.mediaPreviewWrapper}
                                        onPress={() => removeMediaItem(index)}
                                    >
                                        {asset.type === "image" ? (
                                            <Image source={{ uri: asset.uri }} style={styles.mediaPreview} />
                                        ) : (
                                            <Video
                                                source={{ uri: asset.uri }}
                                                style={styles.mediaPreview}
                                                useNativeControls
                                                resizeMode={ResizeMode.CONTAIN}
                                                shouldPlay={false}
                                                isMuted={true}
                                            />
                                        )}
                                        <View style={styles.mediaRemoveButton}>
                                            <Ionicons name="close" size={16} color={colors.primaryLight} />
                                        </View>
                                    </Pressable>
                                ))}
                            </View>
                            <BlurView intensity={10} style={styles.inputGroup}>
                                <Pressable onPress={() => setModalVisible(true)} style={styles.inputButton}>
                                    <Ionicons name="add-circle-outline" size={24} color={colors.primaryColor} />
                                </Pressable>
                                <TextInput
                                    ref={inputRef}
                                    style={styles.inputText}
                                    placeholder={conversation?.type === 'secret' ? "Send encrypted message..." : "Message"}
                                    placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                                    value={inputText}
                                    onChangeText={setInputText}
                                    multiline
                                    onSubmitEditing={handleSendMessage}
                                    blurOnSubmit={false}
                                />
                                {inputText.length > 0 || selectedMedia.length > 0 ? (
                                    <Pressable onPress={handleSendMessage} style={styles.sendButton}>
                                        <Ionicons name="send" size={24} color={colors.primaryColor} />
                                    </Pressable>
                                ) : (
                                    <>
                                        <Pressable style={styles.inputButton}>
                                            <Ionicons name="mic" size={24} color={colors.primaryColor} />
                                        </Pressable>
                                        <Pressable style={styles.inputButton}>
                                            <Ionicons name="camera" size={24} color={colors.primaryColor} />
                                        </Pressable>
                                    </>
                                )}
                            </BlurView>
                        </View>
                    </View>
                )}
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safeArea: {
        flex: 1,
        backgroundColor: colors.primaryLight,
    },
    container: {
        flex: 1,
    },
    header: {
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    headerBackLink: {
        padding: 8,
    },
    headerAvatar: {
        marginLeft: 8,
    },
    headerIcon: {
        padding: 8,
        marginLeft: 8,
    },
    messageContainer: {
        flex: 1,
    },
    messageContent: {
        padding: 16,
    },
    messageGroup: {
        marginBottom: 8,
    },
    bubbleWrapper: {
        flexDirection: 'row',
        marginBottom: 2,
        maxWidth: BUBBLE_MAX_WIDTH,
    },
    sentBubbleWrapper: {
        alignSelf: 'flex-end',
    },
    receivedBubbleWrapper: {
        alignSelf: 'flex-start',
    },
    bubbleAvatar: {
        marginRight: 8,
        alignSelf: 'flex-end',
    },
    bubble: {
        padding: 12,
        borderRadius: 20,
        maxWidth: '100%',
    },
    sentBubble: {
        backgroundColor: colors.primaryColor,
        borderTopLeftRadius: 20,
        borderBottomLeftRadius: 20,
    },
    receivedBubble: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        borderTopRightRadius: 20,
        borderBottomRightRadius: 20,
    },
    messageText: {
        fontSize: 16,
        lineHeight: 20,
    },
    sentText: {
        color: colors.primaryLight,
    },
    receivedText: {
        color: colors.primaryDark,
    },
    timestamp: {
        fontSize: 11,
        marginTop: 4,
        alignSelf: 'flex-end',
    },
    sentTimestamp: {
        color: 'rgba(255, 255, 255, 0.7)',
    },
    receivedTimestamp: {
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    dateSeparator: {
        alignItems: 'center',
        marginVertical: 16,
    },
    dateSeparatorText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
    },
    inputContainer: {
        borderTopWidth: 1,
        borderTopColor: colors.COLOR_BLACK_LIGHT_6,
        padding: 8,
        paddingBottom: Platform.OS === 'ios' ? 24 : 8,
    },
    inputInner: {
        marginHorizontal: 8,
    },
    mediaPreviewContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 8,
    },
    mediaPreview: {
        width: 60,
        height: 60,
        borderRadius: 8,
        marginRight: 8,
        marginBottom: 8,
    } as ImageStyle,
    inputGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 24,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    inputButton: {
        padding: 4,
        marginRight: 8,
    },
    inputText: {
        flex: 1,
        fontSize: 16,
        maxHeight: 100,
        color: colors.primaryDark,
        padding: 8,
    },
    sendButton: {
        padding: 4,
        marginLeft: 8,
    },
    mediaImage: {
        width: '100%',
        height: 200,
        borderRadius: 12,
        marginBottom: 8,
    } as ImageStyle,
    mediaVideo: {
        width: '100%',
        height: 200,
        borderRadius: 12,
        marginBottom: 8,
    } as ImageStyle,
    headerGroupIcon: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
        marginLeft: 8,
    },
    headerChannelIcon: {
        backgroundColor: colors.chatUnreadBadge,
    },
    mediaPreviewWrapper: {
        position: 'relative',
        marginRight: 8,
        marginBottom: 8,
    },
    mediaRemoveButton: {
        position: 'absolute',
        top: -8,
        right: -8,
        backgroundColor: colors.primaryColor,
        borderRadius: 12,
        width: 24,
        height: 24,
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 2,
        borderColor: colors.primaryLight,
    },
    sentMiddle: {
        borderTopRightRadius: 4,
        borderBottomRightRadius: 4,
    },
    receivedMiddle: {
        borderTopLeftRadius: 4,
        borderBottomLeftRadius: 4,
    },
    sentFirst: {
        borderTopRightRadius: 20,
    },
    receivedFirst: {
        borderTopLeftRadius: 20,
    },
    sentLast: {
        borderBottomRightRadius: 20,
    },
    receivedLast: {
        borderBottomLeftRadius: 20,
    },
});
