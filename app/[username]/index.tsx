import React from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { Text } from 'react-native';
import NotFoundScreen from '@/components/NotFoundScreen';
import ProfileScreen from '@/components/ProfileScreen';

const UsernamePage = () => {
    const router = useRouter();
    const { username } = useLocalSearchParams<{ username: string }>();

    const fakeHandles = ['@john', '@jane', '@doe'];

    if (typeof username === 'string' && username.startsWith('@')) {
        if (fakeHandles.includes(username)) {
            return <ProfileScreen />;
        }
    }

    return <NotFoundScreen />;
};

export default UsernamePage;
