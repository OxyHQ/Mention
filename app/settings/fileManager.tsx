import React, { useState } from 'react';
import { View, Button, Image, StyleSheet } from 'react-native';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';

const SomeComponent = () => {
    const [isModalVisible, setModalVisible] = useState(false);
    const [images, setImages] = useState<string[]>([]);

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
        const fileUris = selectedFiles.map(file => `https://api.mention.earth/api/files/${file._id}`);
        console.log('Selected files:', fileUris);
        setImages([...images, ...fileUris]);
    };

    return (
        <View>
            <Button title="Open File Selector" onPress={openModal} />
            {isModalVisible && (
                <FileSelectorModal
                    visible={isModalVisible}
                    onClose={closeModal}
                    onSelect={onSelect}
                    userId="user123"
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

export default SomeComponent;