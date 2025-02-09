import React, { useState, useEffect, useRef } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, Image, Platform, ImageStyle, ViewStyle } from "react-native";
import { useLocalSearchParams } from "expo-router";
import axios from "axios";
import FileSelectorModal from "@/modules/oxyhqservices/components/FileSelectorModal";
import { colors } from "@/styles/colors";
import { MediaIcon } from "@/assets/icons/media-icon";
import { EmojiIcon } from "@/assets/icons/emoji-icon";
import { LocationIcon } from "@/assets/icons/location-icon";
import { Chat } from "@/assets/icons/chat-icon";
import { Header } from "@/components/Header";
import Avatar from "@/components/Avatar";
import { Ionicons } from "@expo/vector-icons";
import { Video, ResizeMode } from "expo-av";
import { SafeAreaView } from "react-native-safe-area-context";
import { API_URL, OXY_CLOUD_URL } from "@/config";

interface Message {
    _id: string;
    userId: string;
    createdAt: string;
    message: string;
    isSent: boolean;
    media?: { uri: string; type: "video" | "image"; id: string; }[];
}

interface MessageGroup {
    userId: string;
    messages: Message[];
}

export default function ChatScreen() {
    const { id: conversationID } = useLocalSearchParams<{ id: string }>();
    const [messages, setMessages] = useState<Message[]>([]);
    const [selectedMedia, setSelectedMedia] = useState<{ uri: string; type: "image" | "video"; id: string }[]>([]);
    const [isModalVisible, setModalVisible] = useState(false);
    const [inputText, setInputText] = useState("");
    const inputRef = useRef<TextInput>(null);
    const scrollViewRef = useRef<ScrollView>(null);

    // Fetch messages using the working API logic
    useEffect(() => {
        const fetchMessages = async () => {
            try {
                const response = await axios.get(`${API_URL}/messages/${conversationID}`);
                const fetchedMessages = response.data.map((msg: any) => ({
                    ...msg,
                    id: msg._id,
                    text: msg.content,
                    isSent: msg.sender === "yourUserId", // Replace "yourUserId" with the actual user ID
                    createdat: msg.createdAt,
                }));
                setMessages(fetchedMessages);
            } catch (error) {
                console.error("Error fetching messages:", error);
            }
        };

        fetchMessages();
    }, [conversationID]);

    useEffect(() => {
        inputRef.current?.focus();
    }, [messages]);

    useEffect(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
    }, [messages]);

    // Send message using the working API endpoint
    const handleSendMessage = async () => {
        if (!inputText.trim()) return;
        try {
            const response = await axios.post(`${API_URL}/messages/send`, {
                conversationId: conversationID,
                content: inputText,
                type: "text",
            });
            setMessages([...messages, response.data]);
            setInputText("");
        } catch (error) {
            console.error("Error sending message:", error);
        }
    };

    const handleReadMessages = async () => {
        try {
            const response = await axios.get(`${API_URL}/messages/${conversationID}`);
            const fetchedMessages = response.data.map((msg: any) => ({
                ...msg,
                _id: msg._id,
                createdAt: msg.createdAt,
            }));
            setMessages(fetchedMessages);
        } catch (error) {
            console.error("Error fetching messages:", error);
        }
    };

    const openMediaSelect = () => setModalVisible(true);
    const closeMediaSelect = () => setModalVisible(false);

    const onSelect = (selectedFiles: any[]) => {
        const media = selectedFiles.map((file) => ({
            uri: `${OXY_CLOUD_URL}/files/${file._id}`,
            type: file.contentType.startsWith("image/") ? "image" : "video" as "video" | "image",
            id: file._id,
        }));
        setSelectedMedia((prev) => [...prev, ...media]);
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

    return (
        <SafeAreaView style={{ flex: 1 }}>
            <View style={styles.container}>
                <Header
                    options={{
                        title: "Chat",
                        titlePosition: "left",
                        subtitle: "Online",
                        leftComponents: [<Avatar key="avatar" size={40} id="" />],
                        rightComponents: [
                            <Ionicons key="call" name="call" size={24} color={colors.primaryColor} />,
                            <Ionicons key="videocam" name="videocam" size={24} color={colors.primaryColor} />,
                        ],
                    }}
                />
                <ScrollView ref={scrollViewRef} style={styles.messageContainer}>
                    {groupedMessages.map((group, groupIndex) => {
                        const isSent = group.messages[0].isSent;
                        return (
                            <View
                                key={groupIndex}
                                style={[styles.messageWrapper, isSent ? styles.sentWrapper : styles.receivedWrapper]}
                            >
                                {group.messages.map((message, idx) => {
                                    const isFirst = idx === 0;
                                    const isLast = idx === group.messages.length - 1;
                                    return (
                                        <View
                                            key={message._id}
                                            style={[
                                                styles.bubble,
                                                isSent ? styles.sentBubble : styles.receivedBubble,
                                                !isFirst && !isLast && (isSent ? styles.sentMiddle : styles.receivedMiddle),
                                                isFirst && (isSent ? styles.sentFirst : styles.receivedFirst),
                                                isLast && (isSent ? styles.sentLast : styles.receivedLast),
                                            ]}
                                        >
                                            {message.media &&
                                                message.media.map((mediaItem, mediaIndex) =>
                                                    mediaItem.type === "image" ? (
                                                        <Image key={mediaIndex} source={{ uri: mediaItem.uri }} style={styles.mediaImage} />
                                                    ) : (
                                                        <Video
                                                            key={mediaIndex}
                                                            source={{ uri: mediaItem.uri }}
                                                            style={styles.mediaImage}
                                                            useNativeControls
                                                            resizeMode={ResizeMode.CONTAIN}
                                                            shouldPlay
                                                            isLooping
                                                            isMuted
                                                        />
                                                    )
                                                )}
                                            {message.message && (
                                                <Text style={styles.textContent}>{message.message}</Text>
                                            )}
                                            <Text style={styles.timestamp}>
                                                {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                            </Text>
                                        </View>
                                    );
                                })}
                            </View>
                        );
                    })}
                </ScrollView>
                <View style={styles.inputContainer}>
                    <FileSelectorModal
                        visible={isModalVisible}
                        onClose={closeMediaSelect}
                        onSelect={onSelect}
                        options={{ fileTypeFilter: ["image/", "video/"], maxFiles: 5 }}
                    />
                    <View style={styles.input}>
                        <View style={styles.mediaPreviewContainer}>
                            {selectedMedia.map((asset, index) =>
                                asset.type === "image" ? (
                                    <Image key={index} source={{ uri: asset.uri }} style={styles.mediaPreview} />
                                ) : (
                                    <Video
                                        key={index}
                                        source={{ uri: asset.uri }}
                                        style={styles.mediaPreview}
                                        useNativeControls
                                        resizeMode={ResizeMode.CONTAIN}
                                        shouldPlay
                                        isLooping
                                        isMuted
                                    />
                                )
                            )}
                        </View>
                        <View style={styles.inputGroup}>
                            <Pressable onPress={openMediaSelect} style={styles.svgWrapper}>
                                <MediaIcon size={20} />
                            </Pressable>
                            <Pressable
                                style={styles.svgWrapper}
                                onPress={() => {
                                    if (Platform.OS === "ios" || Platform.OS === "android") {
                                        inputRef.current?.focus();
                                    }
                                }}
                            >
                                <EmojiIcon size={20} />
                            </Pressable>
                            <Pressable style={styles.svgWrapper}>
                                <LocationIcon size={20} />
                            </Pressable>
                            <TextInput
                                ref={inputRef}
                                style={styles.inputText}
                                placeholder="Type a message..."
                                value={inputText}
                                onChangeText={setInputText}
                                onSubmitEditing={handleSendMessage}
                                blurOnSubmit={false}
                            />
                            <Pressable onPress={handleSendMessage} style={styles.svgWrapper}>
                                <Chat size={20} />
                            </Pressable>
                        </View>
                    </View>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1 },
    messageContainer: { flex: 1, padding: 16 },
    messageWrapper: { flexDirection: "column", marginBottom: 8, flex: 1 },
    sentWrapper: { alignItems: "flex-end" },
    receivedWrapper: { alignItems: "flex-start" },
    bubble: { maxWidth: "80%", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 5, marginBottom: 2 },
    sentBubble: { backgroundColor: colors.primaryColor, borderTopLeftRadius: 20, borderBottomLeftRadius: 20 },
    receivedBubble: { backgroundColor: "#e5e5ea", borderTopRightRadius: 20, borderBottomRightRadius: 20 },
    textContent: { fontSize: 14, color: "#000" },
    timestamp: { fontSize: 12, color: "#666", marginTop: 2 },
    sentFirst: { borderTopRightRadius: 20 },
    receivedFirst: { borderTopLeftRadius: 20 },
    sentLast: { borderBottomRightRadius: 20 },
    receivedLast: { borderBottomLeftRadius: 20 },
    sentMiddle: {},
    receivedMiddle: {},
    sentText: { color: "white" },
    receivedText: { color: "black" },
    createdatText: { fontSize: 10, color: "#999", marginTop: 4 },
    mediaImage: { width: 200, height: 200, borderRadius: 8, marginBottom: 4 } as ImageStyle,
    inputContainer: {
        borderTopWidth: 1,
        borderColor: "#e5e5e5",
        padding: 10,
        flexDirection: "row",
        backgroundColor: colors.primaryLight,
        alignItems: "center",
        borderBottomLeftRadius: 35,
        borderBottomRightRadius: 35,
        ...Platform.select({
            web: { position: "sticky", bottom: 0, zIndex: 101 },
        }),
    } as ViewStyle,
    input: { flex: 1, flexDirection: "column" },
    inputGroup: {
        flex: 1,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 20,
        paddingHorizontal: 5,
        backgroundColor: colors.primaryLight,
        flexDirection: "row",
        alignItems: "center",
    },
    inputText: { flex: 1, height: 40, paddingHorizontal: 5 },
    svgWrapper: { borderRadius: 100, justifyContent: "center", alignItems: "center", width: 30, height: 30 },
    mediaPreviewContainer: { flexDirection: "row", flexWrap: "wrap", marginVertical: 10, paddingHorizontal: 10 },
    mediaPreview: {
        width: 100,
        height: 100,
        borderRadius: 35,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        marginRight: 5,
        marginBottom: 5,
    } as ImageStyle,
});
