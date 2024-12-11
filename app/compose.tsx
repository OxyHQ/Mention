import React, { useState } from "react";
import {
  View,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Image,
  FlatList,
  Modal,
} from "react-native";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";
import { createNotification } from "@/utils/notifications";
import * as ImagePicker from "expo-image-picker";
import DraggableFlatList from "react-native-draggable-flatlist";
import * as Location from "expo-location";
import EmojiPicker from "emoji-picker-react";

export default function ComposeScreen() {
  const [posts, setPosts] = useState<Post[]>([
    { id: 1, content: "", images: [], location: "" },
  ]);
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [isModalVisible, setIsModalVisible] = useState(false);
  const [isEmojiPickerVisible, setIsEmojiPickerVisible] = useState(false);
  const maxLength = 280;

  const handlePost = async () => {
    const validPosts = posts.filter((post) => post.content.trim().length > 0);
    if (validPosts.length > 0) {
      for (const post of validPosts) {
        try {
          await createNotification(
            "Post Created",
            `Your post: "${post.content}" has been successfully created.`
          );
        } catch (error) {
          console.error("Error creating notification:", error);
        }
      }
      router.back();
    }
  };

  interface Post {
    id: number;
    content: string;
    images: string[];
    location: string;
  }

  const handleContentChange = (id: number, content: string) => {
    setPosts(
      posts.map((post: Post) => (post.id === id ? { ...post, content } : post))
    );
  };

  const addNewPost = () => {
    setPosts([
      ...posts,
      { id: posts.length + 1, content: "", images: [], location: "" },
    ]);
  };

  const pickImages = async (id: number) => {
    let result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 1,
    });

    if (!result.canceled) {
      setPosts(
        posts.map((post: Post) =>
          post.id === id
            ? { ...post, images: result.assets.map((asset) => asset.uri) }
            : post
        )
      );
    }
  };

  const pickLocation = async (id: number) => {
    let { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") {
      alert("Permission to access location was denied");
      return;
    }

    let location = await Location.getCurrentPositionAsync({});
    const locationString = `${location.coords.latitude}, ${location.coords.longitude}`;
    setPosts(
      posts.map((post: Post) =>
        post.id === id ? { ...post, location: locationString } : post
      )
    );
  };

  const handleImageReorder = (id: number, images: string[]) => {
    setPosts(
      posts.map((post: Post) => (post.id === id ? { ...post, images } : post))
    );
  };

  const handleImagePress = (imageUri: string) => {
    setSelectedImage(imageUri);
    setIsModalVisible(true);
  };

  interface EmojiObject {
    emoji: string;
  }

  const handleEmojiClick = (emojiObject: EmojiObject) => {
    const newPosts = posts.map((post: Post) => {
      if (post.id === posts.length) {
        return { ...post, content: post.content + emojiObject.emoji };
      }
      return post;
    });
    setPosts(newPosts);
    setIsEmojiPickerVisible(false);
  };

  const renderPost = ({
    item,
    drag,
    isActive,
  }: {
    item: Post;
    drag: () => void;
    isActive: boolean;
  }) => {
    const characterCount = item.content.length;
    const isOverLimit = characterCount > maxLength;
    return (
      <View
        style={[styles.postContainer, isActive && styles.activePostContainer]}
      >
        <View style={styles.content}>
          <Image
            source={{ uri: "https://via.placeholder.com/40" }}
            style={styles.avatar}
          />
          <TextInput
            style={styles.input}
            placeholder="What's happening?"
            placeholderTextColor="#657786"
            multiline
            maxLength={maxLength}
            value={item.content}
            onChangeText={(text) => handleContentChange(item.id, text)}
            autoFocus
          />
        </View>
        <FlatList
          data={item.images}
          numColumns={3}
          keyExtractor={(imageUri, index) => imageUri + index}
          renderItem={({ item: imageUri }) => (
            <TouchableOpacity onPress={() => handleImagePress(imageUri)}>
              <Image source={{ uri: imageUri }} style={styles.gridImage} />
            </TouchableOpacity>
          )}
          contentContainerStyle={styles.imageGridContainer}
        />
        {item.location ? (
          <ThemedText style={styles.locationText}>
            Location: {item.location}
          </ThemedText>
        ) : null}
        <View style={styles.footer}>
          <View style={styles.toolbar}>
            <TouchableOpacity
              style={styles.mediaButton}
              onPress={() => pickImages(item.id)}
            >
              <Ionicons name="image-outline" size={24} color="#1DA1F2" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.mediaButton}>
              <Ionicons name="camera-outline" size={24} color="#1DA1F2" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.mediaButton}>
              <Ionicons name="videocam-outline" size={24} color="#1DA1F2" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.mediaButton}
              onPress={() => pickLocation(item.id)}
            >
              <Ionicons name="location-outline" size={24} color="#1DA1F2" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.mediaButton}
              onPress={() => setIsEmojiPickerVisible(true)}
            >
              <Ionicons name="happy-outline" size={24} color="#1DA1F2" />
            </TouchableOpacity>
          </View>
          <View style={styles.characterCount}>
            <ThemedText
              style={[
                styles.characterCountText,
                isOverLimit && styles.characterCountOverLimit,
              ]}
            >
              {characterCount}/{maxLength}
            </ThemedText>
          </View>
        </View>
        {posts.length > 1 && (
          <TouchableOpacity style={styles.reorderIcon} onPressIn={drag}>
            <Ionicons name="reorder-three-outline" size={24} color="#657786" />
          </TouchableOpacity>
        )}
        <View style={styles.separator} />
      </View>
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          title: "New Posts",
          headerLeft: () => (
            <TouchableOpacity
              onPress={() => router.back()}
              style={styles.backButton}
            >
              <Ionicons name="arrow-back" size={24} color="#1DA1F2" />
            </TouchableOpacity>
          ),
          headerRight: () => (
            <TouchableOpacity
              onPress={handlePost}
              disabled={
                posts.every((post) => post.content.trim().length === 0) ||
                posts.some((post) => post.content.length > maxLength)
              }
              style={[
                styles.postButton,
                (posts.every((post) => post.content.trim().length === 0) ||
                  posts.some((post) => post.content.length > maxLength)) &&
                styles.postButtonDisabled,
              ]}
            >
              <ThemedText style={styles.postButtonText}>Post</ThemedText>
            </TouchableOpacity>
          ),
        }}
      />
      <ThemedView style={styles.container}>
        <DraggableFlatList
          data={posts}
          keyExtractor={(item) => item.id.toString()}
          renderItem={renderPost}
          onDragEnd={({ data }) => setPosts(data)}
          activationDistance={10} // Add this line to ensure drag is activated
        />
        <TouchableOpacity onPress={addNewPost} style={styles.addButton}>
          <ThemedText style={styles.addButtonText}>Add New Post</ThemedText>
        </TouchableOpacity>
      </ThemedView>
      <Modal visible={isModalVisible} transparent={true}>
        <View style={styles.modalContainer}>
          <TouchableOpacity
            style={styles.modalCloseButton}
            onPress={() => setIsModalVisible(false)}
          >
            <Ionicons name="close" size={30} color="#FFFFFF" />
          </TouchableOpacity>
          {selectedImage && (
            <Image source={{ uri: selectedImage }} style={styles.modalImage} />
          )}
        </View>
      </Modal>
      {isEmojiPickerVisible && (
        <View style={styles.emojiPickerContainer}>
          <EmojiPicker onEmojiClick={handleEmojiClick} />
          <TouchableOpacity
            style={styles.emojiPickerCloseButton}
            onPress={() => setIsEmojiPickerVisible(false)}
          >
            <Ionicons name="close" size={30} color="#657786" />
          </TouchableOpacity>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
    backgroundColor: "#FFFFFF",
  },
  content: {
    flexDirection: "row",
    alignItems: "flex-start",
    borderBottomWidth: 1,
    borderBottomColor: "#E1E8ED",
    paddingBottom: 12,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: 12,
  },
  input: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    minHeight: 100,
    color: "#14171A",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#E1E8ED",
    paddingTop: 12,
    marginTop: 12,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
  },
  mediaButton: {
    padding: 8,
    marginRight: 8,
  },
  characterCount: {
    padding: 8,
  },
  characterCountText: {
    fontSize: 14,
    color: "#657786",
  },
  characterCountOverLimit: {
    color: "#E0245E",
  },
  postButton: {
    backgroundColor: "#1DA1F2",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  postButtonDisabled: {
    opacity: 0.5,
  },
  postButtonText: {
    color: "#FFFFFF",
    fontWeight: "bold",
  },
  backButton: {
    paddingHorizontal: 16,
  },
  postContainer: {
    marginBottom: 16,
    backgroundColor: "#F5F8FA",
    borderRadius: 10,
    padding: 12,
  },
  addButton: {
    backgroundColor: "#1DA1F2",
    padding: 16,
    borderRadius: 20,
    alignItems: "center",
    marginTop: 16,
    marginHorizontal: 16,
  },
  separator: {
    height: 1,
    backgroundColor: "#E1E8ED",
    marginVertical: 12,
  },
  addButtonText: {
    color: "#FFFFFF",
    fontWeight: "bold",
  },
  previewImage: {
    width: 100,
    height: 100,
    marginRight: 5,
    borderRadius: 35,
  },
  locationText: {
    fontSize: 14,
    color: "#657786",
    marginTop: 8,
  },
  activePostContainer: {
    backgroundColor: "#E1E8ED",
  },
  reorderIcon: {
    position: "absolute",
    top: 10,
    right: 10,
  },
  imageListContainer: {
    paddingVertical: 8,
  },
  imageGridContainer: {
    paddingVertical: 8,
  },
  gridImage: {
    width: 100,
    height: 100,
    margin: 5,
    borderRadius: 10,
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
  emojiPickerContainer: {
    position: "absolute",
    bottom: 0,
    width: "100%",
    backgroundColor: "#FFFFFF",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
  },
  emojiPickerCloseButton: {
    position: "absolute",
    top: 10,
    right: 10,
  },
});
