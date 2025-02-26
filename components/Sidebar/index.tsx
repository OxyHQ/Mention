import React from 'react';
import { View, Pressable, Text } from 'react-native';
import { Link } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { styles } from './styles';
import { PostButton } from '@/components/PostButton';

export function Sidebar() {
    return (
        <View style={styles.container}>
            <Link href="/" asChild>
                <Pressable style={styles.item}>
                    <Ionicons name="home-outline" size={24} color="#000" />
                    <Text style={styles.itemText}>Home</Text>
                </Pressable>
            </Link>
            <Link href="/search" asChild>
                <Pressable style={styles.item}>
                    <Ionicons name="search-outline" size={24} color="#000" />
                    <Text style={styles.itemText}>Search</Text>
                </Pressable>
            </Link>
            <Link href="/notifications" asChild>
                <Pressable style={styles.item}>
                    <Ionicons name="notifications-outline" size={24} color="#000" />
                    <Text style={styles.itemText}>Notifications</Text>
                </Pressable>
            </Link>
            <Link href="/drafts" asChild>
                <Pressable style={styles.item}>
                    <Ionicons name="document-outline" size={24} color="#000" />
                    <Text style={styles.itemText}>Drafts & Scheduled</Text>
                </Pressable>
            </Link>
            <Link href="/profile" asChild>
                <Pressable style={styles.item}>
                    <Ionicons name="person-outline" size={24} color="#000" />
                    <Text style={styles.itemText}>Profile</Text>
                </Pressable>
            </Link>
            <PostButton />
        </View>
    );
} 