import React, { useState, useEffect } from 'react';
import { View, TextInput, TouchableOpacity, SafeAreaView, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header } from '@/components/Header';
import { useAuth } from '@/modules/oxyhqservices/hooks';
import { profileService } from '@/modules/oxyhqservices';
import type { OxyProfile } from '@/modules/oxyhqservices/types';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';

interface FormData {
    name: {
        first: string;
        last: string;
    };
    description: string;
    location: string;
    website: string;
    avatar?: string;
}

export default function EditProfileScreen() {
    const { t } = useTranslation();
    const { user: currentUser } = useAuth();
    const [isSaving, setIsSaving] = useState(false);
    const [profile, setProfile] = useState<OxyProfile | null>(null);
    const [avatarModalVisible, setAvatarModalVisible] = useState(false);
    const [formData, setFormData] = useState<FormData>({
        avatar: '',
        name: { first: '', last: '' },
        description: '',
        location: '',
        website: '',
    });

    useEffect(() => {
        const loadProfile = async () => {
            if (!currentUser?.id) return;
            try {
                const profileData = await profileService.getProfileById(currentUser.id);
                setProfile(profileData);
                setFormData({
                    name: {
                        first: profileData.name?.first || '',
                        last: profileData.name?.last || ''
                    },
                    description: profileData.description || '',
                    location: profileData.location || '',
                    website: profileData.website || '',
                    avatar: profileData.avatar
                });
            } catch (error) {
                toast.error(t('Failed to load profile'));
            }
        };
        loadProfile();
    }, [currentUser?.id]);

    const validateForm = (): boolean => {
        if (formData.website && !formData.website.match(/^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/)) {
            toast.error(t('Please enter a valid website URL'));
            return false;
        }
        return true;
    };

    const handleUpdateProfile = async () => {
        if (!validateForm() || !currentUser || !profile) return;

        setIsSaving(true);
        try {
            const updatedProfile = await profileService.updateProfile({
                _id: profile._id,
                userID: currentUser.id,
                name: formData.name,
                description: formData.description,
                location: formData.location,
                website: formData.website,
                avatar: formData.avatar
            });
            setProfile(updatedProfile);
            toast.success(t('Profile updated successfully'));
        } catch (error) {
            console.error('Profile update error:', error);
            toast.error(t('Failed to update profile'));
        } finally {
            setIsSaving(false);
        }
    };

    if (!profile) {
        return (
            <SafeAreaView style={styles.container}>
                <Header options={{
                    title: t('Edit Profile'),
                    showBackButton: true
                }} />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primaryColor} />
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container}>
            <Header
                options={{
                    title: t('Edit Profile'),
                    showBackButton: true,
                    rightComponents: [(
                        <TouchableOpacity
                            key="save"
                            onPress={handleUpdateProfile}
                            disabled={isSaving}
                            style={styles.saveButton}
                        >
                            {isSaving ? (
                                <ActivityIndicator size="small" color={colors.primaryColor} />
                            ) : (
                                <Text style={styles.saveButtonText}>{t('Save')}</Text>
                            )}
                        </TouchableOpacity>
                    )]
                }}
            />
            <View style={styles.content}>
                <View style={styles.avatarContainer}>
                    <TouchableOpacity onPress={() => setAvatarModalVisible(true)}>
                        <Avatar id={profile.avatar} size={100} />
                    </TouchableOpacity>
                </View>
                <View style={styles.form}>
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('First Name')}</Text>
                        <TextInput
                            style={styles.input}
                            value={formData.name.first}
                            onChangeText={(text) => setFormData(prev => ({
                                ...prev,
                                name: { ...prev.name, first: text }
                            }))}
                            placeholder={t('Enter your first name')}
                        />
                    </View>
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('Last Name')}</Text>
                        <TextInput
                            style={styles.input}
                            value={formData.name.last}
                            onChangeText={(text) => setFormData(prev => ({
                                ...prev,
                                name: { ...prev.name, last: text }
                            }))}
                            placeholder={t('Enter your last name')}
                        />
                    </View>
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('Bio')}</Text>
                        <TextInput
                            style={[styles.input, styles.textArea]}
                            value={formData.description}
                            onChangeText={(text) => setFormData(prev => ({
                                ...prev,
                                description: text
                            }))}
                            placeholder={t('Tell us about yourself')}
                            multiline
                            numberOfLines={4}
                        />
                    </View>
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('Location')}</Text>
                        <TextInput
                            style={styles.input}
                            value={formData.location}
                            onChangeText={(text) => setFormData(prev => ({
                                ...prev,
                                location: text
                            }))}
                            placeholder={t('Enter your location')}
                        />
                    </View>
                    <View style={styles.formGroup}>
                        <Text style={styles.label}>{t('Website')}</Text>
                        <TextInput
                            style={styles.input}
                            value={formData.website}
                            onChangeText={(text) => setFormData(prev => ({
                                ...prev,
                                website: text
                            }))}
                            placeholder={t('Enter your website')}
                            keyboardType="url"
                            autoCapitalize="none"
                        />
                    </View>
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        padding: 20,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarContainer: {
        alignItems: 'center',
        marginBottom: 20,
    },
    form: {
        gap: 15,
    },
    formGroup: {
        gap: 5,
    },
    label: {
        fontSize: 16,
        fontWeight: '500',
        color: colors.COLOR_BLACK,
    },
    input: {
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_8,
        borderRadius: 8,
        padding: 10,
        fontSize: 16,
    },
    textArea: {
        height: 100,
        textAlignVertical: 'top',
    },
    saveButton: {
        paddingHorizontal: 15,
        paddingVertical: 8,
        borderRadius: 20,
        backgroundColor: colors.primaryColor,
    },
    saveButtonText: {
        color: colors.primaryLight,
        fontWeight: '600',
    },
});