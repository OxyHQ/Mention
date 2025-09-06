import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import NotFoundScreen from '@/components/NotFoundScreen';
import ProfileScreen from '@/components/ProfileScreen';

const UsernamePage = () => {
    const { username } = useLocalSearchParams<{ username: string }>();

    if (typeof username === 'string' && username.startsWith('@')) {
        return <ProfileScreen />;
    }

    return <NotFoundScreen />;
};

export default UsernamePage;