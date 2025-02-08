import React, { useState } from 'react';
import { View, Button, Image, StyleSheet, Text } from 'react-native';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { useSelector } from "react-redux";

const FileManager = () => {
    const [isModalVisible, setModalVisible] = useState(false);
    const [images, setImages] = useState<string[]>([]);
    const currentUser = useSelector((state: any) => state.session?.user);

    const openModal = () => {
        setModalVisible(true);
    };

    const closeModal = () => {
        setModalVisible(false);
    };

    interface File {
        _id: string;
        contentType: string;
        uri: string;
    }

    const onSelect = (selectedFiles: File[]) => {
        const fileUris = selectedFiles.map(file => `/api/files/${file._id}`);
        console.log('Selected files:', fileUris);
        setImages([...images, ...fileUris]);
    };

    if (!currentUser?._id) {
        return <View><Text>Please log in to manage files</Text></View>;
    }

    return (
        <View>
            <Button title="Open File Selector" onPress={openModal} />
            {isModalVisible && (
                <FileSelectorModal
                    visible={isModalVisible}
                    onClose={closeModal}
                    onSelect={onSelect}
                    options={{
                        fileTypeFilter: ["image/", "video/"],
                        maxFiles: 5,
                    }}
                />
            )}
            <View style={styles.imageGrid}>
                {images.map((img, index) => (
                    <Image key={index} source={{ uri: img }} style={styles.image} />
                ))}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    imageGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginTop: 20,
    },
    image: {
        width: 100,
        height: 100,
        margin: 5,
    },
});

export default FileManager;