import { StyleSheet, View, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

export const BottomBar = () => {
    const router = useRouter();

    return (
        <View style={styles.bottomBar}>
            <Pressable onPress={() => router.push('/')}>
                <Ionicons name="home" size={24} />
            </Pressable>
            <Pressable onPress={() => router.push('/search')}>
                <Ionicons name="search" size={24} />
            </Pressable>
            <Pressable onPress={() => router.push('/notifications')}>
                <Ionicons name="notifications" size={24} />
            </Pressable>
            <Pressable onPress={() => router.push('/messages')}>
                <Ionicons name="mail" size={24} />
            </Pressable>
        </View>
    );
};

const styles = StyleSheet.create({
    bottomBar: {
        height: 50,
        backgroundColor: '#ffffff',
        flexDirection: 'row',
        justifyContent: 'space-around',
        alignItems: 'center',
        borderTopWidth: 1,
        borderTopColor: '#eeeeee',
    },
});