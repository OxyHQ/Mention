import React, { useState, useEffect } from "react";
import { View, Text, TouchableOpacity, Image as RNImage, StyleSheet, Modal } from "react-native";
import { useSelector, useDispatch } from "react-redux";
import { fetchPosts } from "@/store/reducers/postsReducer";
import { Ionicons } from "@expo/vector-icons";
import Post from ".";
import { colors } from "@/styles/colors";

export const renderMedia = (media: { media_url: string; media_type: string }[]) => {
    const [selectedImage, setSelectedImage] = useState<string | null>(null);

    const images = media
        .filter(item => item.media_type === "image" && item.media_url)
        .map(item => item.media_url);

    if (images.length === 0) return null;

    const handleImagePress = (event: any, image: string) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedImage(image);
    };

    const handleModalClose = () => {
        setSelectedImage(null);
    };

    return (
        <>
            <View style={styles.imageGrid}>
                {images.map((image, index) => (
                    <TouchableOpacity
                        key={index}
                        onPress={(event) => handleImagePress(event, image)}
                        accessibilityLabel={`Image ${index + 1}`}
                    >
                        <RNImage
                            source={{ uri: image }}
                            style={[styles.image]}
                            onError={(error) => console.error("Error loading image:", error)}

                        />
                    </TouchableOpacity>
                ))}
            </View>
            {selectedImage && (
                <Modal
                    visible={true}
                    transparent={true}
                    onRequestClose={handleModalClose}
                >
                    <View style={styles.modalContainer}>
                        <TouchableOpacity
                            style={styles.modalCloseButton}
                            onPress={handleModalClose}
                            accessibilityLabel="Close image modal"
                        >
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
    const dispatch = useDispatch();
    const posts = useSelector((state) => state.posts.posts);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        dispatch(fetchPosts());
    }, [dispatch]);

    useEffect(() => {
        if (posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    const post = posts.find((post) => post.id === id);

    return (
        <Post
            postData={post}
            quotedPost={true}
            style={{ borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6, borderRadius: 16, marginTop: 8 }}
        />
    );
};

const styles = StyleSheet.create({
    imageGrid: {
        flexDirection: "row",
        flexWrap: "wrap",
        justifyContent: "space-between",
    },
    image: {
        flex: 1,
        width: 250,
        height: 250,
        margin: 5,
        borderRadius: 35,
    },
    modalContainer: {
        flex: 1,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        justifyContent: "center",
        alignItems: "center",
    },
    modalImage: {
        width: "90%",
        height: "70%",
        resizeMode: "contain",
    },
    modalCloseButton: {
        position: "absolute",
        top: 40,
        right: 20,
        zIndex: 1,
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
