import React, { useState, useEffect, useRef } from "react";
import { View, Text, TextInput, ScrollView, Pressable, StyleSheet, Image } from "react-native";
import io from "socket.io-client";
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { colors } from "@/styles/colors";
import { MediaIcon } from "@/assets/icons/media-icon";
import { EmojiIcon } from "@/assets/icons/emoji-icon";
import { LocationIcon } from "@/assets/icons/location-icon";
import { Chat } from "@/assets/icons/chat-icon";
import { Header } from "@/components/Header";
import Avatar from "@/components/Avatar";
import { Ionicons } from "@expo/vector-icons";
import { Video, ResizeMode } from 'expo-av';

type Message = {
    id: string;
    userId: string;
    text: string;
    isSent: boolean;
    timestamp: string;
    media?: string;
};

type MessageGroup = {
    userId: string;
    messages: Message[];
};

export default function ChatScreen() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [selectedMedia, setSelectedMedia] = useState<
        { uri: string; type: "image" | "video"; id: string }[]
    >([]);
    const [isModalVisible, setModalVisible] = useState(false);
    const [inputText, setInputText] = useState("");
    const inputRef = useRef<TextInput>(null);
    const scrollViewRef = useRef<ScrollView>(null);
    const socket = useRef(io("http://localhost:3000")).current;

    const TIME_THRESHOLD = 5 * 60 * 1000;

    // Called when the user selects media files
    const onSelect = (selectedFiles: any[]) => {
        const media = selectedFiles.map(file => ({
            uri: `http://localhost:3000/api/files/${file._id}`,
            type: file.contentType.startsWith("image/") ? "image" as const : "video" as const,
            id: file._id,
        }));
        setSelectedMedia(prev => [...prev, ...media]);
    };

    useEffect(() => {
        socket.on("message", (newMessage: Message) => {
            setMessages(prev => [...prev, newMessage]);
        });
        fetch("http://localhost:3000/messages")
            .then(res => res.json())
            .then(data => setMessages(data));
        return () => {
            socket.off("message");
        };
    }, [socket]);

    // Focus the input whenever messages update (optional)
    useEffect(() => {
        inputRef.current?.focus();
    }, [messages]);

    // Auto scroll to the bottom when messages update
    useEffect(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
    }, [messages]);

    const handleSendMessage = () => {
        if (!inputText.trim()) return;
        const newMessage: Message = {
            id: Date.now().toString(),
            userId: "current-user",
            text: inputText,
            isSent: true,
            // This example uses a formatted time string (hours and minutes)
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        socket.emit("sendMessage", newMessage);
        setInputText("");
    };

    const openMediaSelect = async () => {
        setModalVisible(true);
    };

    const closeMediaSelect = () => {
        setModalVisible(false);
    };

    // Group messages by same user and timestamp.
    // (This simple grouping assumes messages are in order and uses an exact match on the formatted time.)
    const groupMessages = (messages: Message[]): MessageGroup[] => {
        const groups: MessageGroup[] = [];
        messages.forEach((message) => {
            // If no groups exist, create a new one.
            if (groups.length === 0) {
                groups.push({ userId: message.userId, messages: [message] });
            } else {
                const lastGroup = groups[groups.length - 1];
                const lastMessage = lastGroup.messages[lastGroup.messages.length - 1];
                // Check: same user and time gap less than the threshold.
                if (
                    message.userId === lastGroup.userId &&
                    new Date(message.timestamp).getTime() - new Date(lastMessage.timestamp).getTime() < TIME_THRESHOLD
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
        <View style={styles.container}>
            <Header
                options={{
                    title: "Chat",
                    titlePosition: "left",
                    subtitle: "Online",
                    leftComponents: [<Avatar key="avatar" size={40} source={{ uri: "" }} />],
                    rightComponents: [
                        <Ionicons key="call" name="call" size={24} color={colors.primaryColor} />,
                        <Ionicons key="videocam" name="videocam" size={24} color={colors.primaryColor} />,
                    ],
                }}
            />
            <ScrollView ref={scrollViewRef} style={styles.messageContainer}>
                {groupedMessages.map((group, index) => {
                    const isSent = group.messages[0].isSent;
                    return (
                        <View
                            key={index}
                            style={[styles.messageWrapper, isSent ? styles.sentWrapper : styles.receivedWrapper]}
                        >
                            <View style={[styles.bubble, isSent ? styles.sentBubble : styles.receivedBubble]}>
                                {group.messages.map(message => (
                                    <React.Fragment key={message.id}>
                                        {message.media && (
                                            <Image source={{ uri: message.media }} style={styles.mediaImage} />
                                        )}
                                        {message.text && (
                                            <Text style={[styles.messageText, isSent ? styles.sentText : styles.receivedText]}>
                                                {message.text}
                                            </Text>
                                        )}
                                    </React.Fragment>
                                ))}
                                <Text
                                    style={[
                                        styles.timestampText,
                                        { alignSelf: isSent ? "flex-end" : "flex-start" },
                                    ]}
                                >
                                    {group.timestamp}
                                </Text>
                            </View>
                        </View>
                    );
                })}
            </ScrollView>
            <View style={styles.inputContainer}>
                <FileSelectorModal
                    visible={isModalVisible}
                    onClose={closeMediaSelect}
                    onSelect={onSelect}
                    userId="user123"
                    options={{
                        fileTypeFilter: ["image/", "video/"],
                        maxFiles: 5,
                    }}
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
                        <Pressable style={styles.svgWrapper}>
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
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    messageContainer: {
        flex: 1,
        padding: 16,
    },
    messageWrapper: {
        flexDirection: "row",
    },
    sentWrapper: {
        justifyContent: "flex-end",
    },
    receivedWrapper: {
        justifyContent: "flex-start",
    },
    bubble: {
        maxWidth: "80%",
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderRadius: 20,
        flexDirection: "column",
    },
    sentBubble: {
        backgroundColor: colors.primaryColor,
        borderBottomRightRadius: 8,
    },
    receivedBubble: {
        backgroundColor: "#f1f0f0",
        borderBottomLeftRadius: 8,
    },
    messageText: {
        fontSize: 14,
    },
    sentText: {
        color: "white",
    },
    receivedText: {
        color: "black",
    },
    timestampText: {
        fontSize: 10,
        color: "#999",
    },
    mediaImage: {
        width: 200,
        height: 200,
        borderRadius: 8,
        marginBottom: 4,
    },
    inputContainer: {
        borderTopWidth: 1,
        borderColor: "#e5e5e5",
        padding: 10,
        flexDirection: "row",
        backgroundColor: colors.primaryLight,
        alignItems: "center",
        borderBottomLeftRadius: 35,
        borderBottomRightRadius: 35,
    },
    input: {
        flex: 1,
        flexDirection: "column",
    },
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
    inputText: {
        flex: 1,
        height: 40,
        paddingHorizontal: 5,
        borderWidth: 0,
    },
    svgWrapper: {
        borderRadius: 100,
        justifyContent: "center",
        alignItems: "center",
        width: 30,
        height: 30,
    },
    mediaPreviewContainer: {
        flexDirection: "row",
        flexWrap: "wrap",
        marginVertical: 10,
        paddingHorizontal: 10,
        gap: 5,
    },
    mediaPreview: {
        width: 100,
        height: 100,
        borderRadius: 35,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
});
