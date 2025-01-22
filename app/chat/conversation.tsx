import * as React from "react";
import { useState } from "react";
import { View, Text, StyleSheet, TextInput, ScrollView, TouchableOpacity } from "react-native";
import { colors } from "@/styles/colors";

type Message = {
    id: number;
    text: string;
    isSent: boolean;
    timestamp: string;
};

const initialMessages: Message[] = [
    { id: 1, text: "Hey, how are you?", isSent: false, timestamp: "10:00 AM" },
    { id: 2, text: "I'm good! How about you?", isSent: true, timestamp: "10:01 AM" },
    { id: 3, text: "Great! What are your plans for today?", isSent: false, timestamp: "10:02 AM" },
    { id: 4, text: "Just working on some coding projects. Want to grab lunch later?", isSent: true, timestamp: "10:03 AM" },
    { id: 5, text: "Sure, that sounds great!", isSent: false, timestamp: "10:04 AM" },
];

function groupMessagesByUserAndTime(messages: Message[], intervalMinutes: number): { id: number; messages: Message[] }[] {
    const grouped: { id: number; messages: Message[] }[] = [];
    let currentGroup: { id: number; messages: Message[] } | null = null;

    messages.forEach((message, index) => {
        const currentTime = new Date(`2023-01-01T${message.timestamp}:00`).getTime();

        if (
            !currentGroup ||
            currentGroup.messages[0].isSent !== message.isSent ||
            Math.abs(
                new Date(`2023-01-01T${currentGroup.messages[currentGroup.messages.length - 1].timestamp}:00`).getTime() -
                currentTime
            ) > intervalMinutes * 60 * 1000
        ) {
            currentGroup = { id: index, messages: [message] };
            grouped.push(currentGroup);
        } else {
            currentGroup.messages.push(message);
        }
    });

    return grouped;
}

export default function ChatScreen() {
    const [messages, setMessages] = useState<Message[]>(initialMessages);
    const [inputText, setInputText] = useState<string>("");

    const handleSendMessage = () => {
        if (inputText.trim() === "") return;

        const newMessage: Message = {
            id: messages.length + 1,
            text: inputText,
            isSent: true,
            timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };

        setMessages([...messages, newMessage]);
        setInputText("");
    };

    const groupedMessages = groupMessagesByUserAndTime(messages, 5);

    return (
        <View style={styles.container}>
            <ScrollView style={styles.messageContainer}>
                {groupedMessages.map((group) => (
                    <View key={group.id} style={styles.groupWrapper}>
                        {group.messages.map((message, index) => (
                            <View
                                key={message.id}
                                style={[
                                    styles.messageWrapper,
                                    message.isSent ? styles.sentWrapper : styles.receivedWrapper,
                                ]}
                            >
                                <View
                                    style={[
                                        styles.bubble,
                                        message.isSent ? styles.sentBubble : styles.receivedBubble,
                                    ]}
                                >
                                    <Text
                                        style={[
                                            styles.messageText,
                                            message.isSent ? styles.sentText : styles.receivedText,
                                        ]}
                                    >
                                        {message.text}
                                    </Text>
                                </View>
                            </View>
                        ))}
                        <Text style={styles.timestamp}>{group.messages[0].timestamp}</Text>
                    </View>
                ))}
            </ScrollView>
            <View style={styles.inputContainer}>
                <TextInput
                    style={styles.input}
                    placeholder="Type a message..."
                    value={inputText}
                    onChangeText={setInputText}
                    onSubmitEditing={handleSendMessage}
                />
                <TouchableOpacity style={styles.sendButton} onPress={handleSendMessage}>
                    <Text style={styles.sendButtonText}>Send</Text>
                </TouchableOpacity>
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
    groupWrapper: {
        marginBottom: 16,
    },
    messageWrapper: {
        marginVertical: 4,
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
        padding: 8,
        borderRadius: 16,
        flexDirection: "column",
    },
    sentBubble: {
        backgroundColor: colors.primaryColor,
        borderBottomRightRadius: 4,
    },
    receivedBubble: {
        backgroundColor: "#f1f0f0",
        borderBottomLeftRadius: 4,
    },
    messageText: {
        fontSize: 14,
        marginBottom: 2,
    },
    sentText: {
        color: "white",
    },
    receivedText: {
        color: "black",
    },
    timestamp: {
        fontSize: 10,
        color: "#8e8e8e",
        textAlign: "center",
        marginTop: 8,
    },
    inputContainer: {
        borderTopWidth: 1,
        borderColor: "#e5e5e5",
        padding: 10,
        flexDirection: "row",
        backgroundColor: "#ffffff",
    },
    input: {
        flex: 1,
        height: 40,
        borderWidth: 1,
        borderColor: "#e5e5e5",
        borderRadius: 20,
        paddingHorizontal: 16,
        backgroundColor: "#f1f0f0",
    },
    sendButton: {
        marginLeft: 10,
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 20,
        justifyContent: "center",
    },
    sendButtonText: {
        color: "white",
        fontSize: 14,
    },
});
