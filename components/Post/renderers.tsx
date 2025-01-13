import React, { useState } from "react";
import { View, Text, TouchableOpacity, Image as RNImage, StyleSheet, Modal } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Post from ".";
import { usePostsStore } from "@/store/stores/postStore";

export const renderImages = (images: string[]) => {
    const [selectedImage, setSelectedImage] = useState<string | null>(null);

    if (images.length === 0) return null;
    const imageCount = images.length;

    return (
        <>
            <View style={styles.imageGrid}>
                {images.map((image, index) => (
                    <TouchableOpacity key={index} onPress={(event) => { event.preventDefault(); event.stopPropagation(); setSelectedImage(image); }}>
                        <RNImage
                            source={{ uri: image }}
                            style={[
                                styles.image,
                                imageCount === 1 && styles.singleImage,
                                imageCount === 2 && styles.twoImages,
                                imageCount === 3 && styles.threeImages,
                                imageCount === 4 && styles.fourImages,
                                imageCount > 4 && styles.moreThanFourImages,
                            ]}
                            onError={(error) => console.error("Error loading image:", error)}
                        />
                    </TouchableOpacity>
                ))}
            </View>
            {selectedImage && (
                <Modal visible={true} transparent={true} onRequestClose={() => setSelectedImage(null)}>
                    <View style={styles.modalContainer}>
                        <TouchableOpacity style={styles.modalCloseButton} onPress={(event) => { event.preventDefault(); event.stopPropagation(); setSelectedImage(null); }}>
                            <Ionicons name="close" size={30} color="#FFFFFF" />
                        </TouchableOpacity>
                        <RNImage source={{ uri: selectedImage }} style={styles.modalImage} />
                    </View>
                </Modal>
            )}
        </>
    );
};

export const renderPoll = (poll: any, selectedOption: number | null, handlePollOptionPress: (index: number) => void) => {
    if (!poll) return null;
    const totalVotes = poll.options.reduce((sum: number, option: any) => sum + option.votes, 0);
    return (
        <View style={styles.pollContainer}>
            <Text style={styles.pollQuestion}>{poll.question}</Text>
            {poll.options.map((option: any, index: number) => {
                const percentage = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;
                return (
                    <TouchableOpacity
                        key={index}
                        style={[
                            styles.pollOption,
                            selectedOption === index && styles.selectedPollOption,
                        ]}
                        onPress={(event) => { event.preventDefault(); event.stopPropagation(); handlePollOptionPress(index); }}
                    >
                        <Text style={styles.pollOptionText}>{option.text}</Text>
                        <Text style={styles.pollOptionStats}>{`${option.votes} votes (${percentage.toFixed(1)}%)`}</Text>
                    </TouchableOpacity>
                );
            })}
        </View>
    );
};

export const renderLocation = (location: string | undefined) => {
    if (!location) return null;
    return (
        <View style={styles.locationContainer}>
            <Ionicons name="location-outline" size={16} color="#1DA1F2" />
            <Text style={styles.locationText}>{location}</Text>
        </View>
    );
};

export const renderQuotedPost = (id: string | undefined) => {
    if (!id) return null;
    return (
        <Post
            id="1"
            avatar="https://example.com/avatar.jpg"
            name="John Doe"
            username="@johndoe"
            content="Just setting up my Twitter clone! 🚀 #coding #reactnative"
            time="2023-10-01T12:00:00Z"
            likes={5}
            reposts={2}
            replies={5}
            showActions={false}
            quotedPost={true}
        />
    );
};

const styles = StyleSheet.create({
    imageGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        marginTop: 8,
        justifyContent: "space-between",
    },
    image: {
        borderRadius: 8,
        margin: 2,
    },
    singleImage: {
        width: "100%",
        height: 200,
        borderRadius: 15,
    },
    twoImages: {
        width: "48%",
        height: 200,
        borderRadius: 15,
    },
    threeImages: {
        width: "32%",
        height: 150,
        borderRadius: 15,
    },
    fourImages: {
        width: "48%",
        height: 150,
        borderRadius: 15,
    },
    moreThanFourImages: {
        width: "32%",
        height: 100,
        borderRadius: 15,
    },
    pollContainer: {
        marginTop: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: "#e1e8ed",
        borderRadius: 8,
        backgroundColor: "#f5f8fa",
    },
    pollQuestion: {
        fontWeight: "bold",
        marginBottom: 12,
        fontSize: 16,
    },
    pollOption: {
        padding: 10,
        borderWidth: 1,
        borderColor: "#e1e8ed",
        borderRadius: 8,
        marginTop: 8,
        backgroundColor: "#fff",
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
    },
    pollOptionText: {
        flex: 1,
        fontSize: 14,
    },
    pollOptionStats: {
        fontSize: 12,
        color: "#657786",
    },
    selectedPollOption: {
        backgroundColor: "#e1f5fe",
        borderColor: "#1DA1F2",
    },
    locationContainer: {
        flexDirection: "row",
        alignItems: "center",
        marginTop: 8,
    },
    locationText: {
        marginLeft: 4,
        color: "#1DA1F2",
    },
    modalContainer: {
        flex: 1,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        justifyContent: "center",
        alignItems: "center",
    },
    modalCloseButton: {
        position: "absolute",
        top: 40,
        right: 20,
    },
    modalImage: {
        width: "90%",
        height: "70%",
        borderRadius: 10,
    },
});
