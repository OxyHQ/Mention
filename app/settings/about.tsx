import React, { useRef } from 'react';
import { View, Pressable, Text } from 'react-native';
import InstagramStories, { InstagramStoriesPublicMethods } from '@birdwingo/react-native-instagram-stories';

const YourComponent = () => {

    // to use public methods:
    const ref = useRef<InstagramStoriesPublicMethods>(null);

    const stories = [{
        id: 'user1',
        name: 'User 1',
        avatarSource: { uri: 'https://upload.wikimedia.org/wikipedia/commons/3/32/Googleplex_HQ_%28cropped%29.jpg' },
        stories: [
            { id: 'story1', source: { uri: 'https://upload.wikimedia.org/wikipedia/commons/3/32/Googleplex_HQ_%28cropped%29.jpg' } },
            // ...
        ]
    }, // ...
    ];

    // usage of public method
    const setStories = () => ref.current?.setStories(stories);

    return (
        <View>
            <InstagramStories
                ref={ref}
                stories={stories}
            // ...
            />
            <Pressable onPress={setStories}>
                <Text>Set Stories</Text>
            </Pressable>
        </View>
    );
};

export default YourComponent;