import React, { useRef } from 'react';
import { View, Pressable, Text } from 'react-native';
import InstagramStories, { InstagramStoriesPublicMethods } from '@birdwingo/react-native-instagram-stories';

export function Stories() {

    // to use public methods:
    const ref = useRef<InstagramStoriesPublicMethods>(null);

    const stories = [{
        id: 'user1',
        name: 'Nate',
        avatarSource: { uri: 'http://192.168.1.196:3000/api/files/6790749544634262da8394f2' },
        stories: [
            { id: 'story1', source: { uri: 'https://upload.wikimedia.org/wikipedia/commons/3/32/Googleplex_HQ_%28cropped%29.jpg' } },
            // ...
        ]
    }, {
        id: 'user2',
        name: 'Mention',
        avatarSource: { uri: 'http://localhost:8081/assets/?unstable_path=.%2Fassets%2Fimages/default-avatar.jpg' },
        stories: [
            { id: 'story1', source: { uri: 'https://upload.wikimedia.org/wikipedia/commons/3/32/Googleplex_HQ_%28cropped%29.jpg' } },
            // ...
        ]
    }
    ];

    // usage of public method
    const setStories = () => ref.current?.setStories(stories);

    return (
        <View style={{ padding: 10 }}>
            <InstagramStories
                ref={ref}
                stories={stories}
                showName={true}
            />
        </View>
    );
};