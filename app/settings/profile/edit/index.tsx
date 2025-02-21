import React, { useState, useEffect } from 'react';
import { View, TextInput, TouchableOpacity, SafeAreaView, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Header } from '@/components/Header';
import { useAuth } from '@/modules/oxyhqservices/hooks';
import { profileService } from '@/modules/oxyhqservices';
import type { Profile } from '@/interfaces/Profile';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar'; // Changed to default import

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
    const [profile, setProfile] = useState<Profile | null>(null);
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
                setProfile(profileData as unknown as Profile);
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
        if (!validateForm() || !currentUser) return;
        
        setIsSaving(true);
        try {
            const updatedProfile = await profileService.updateProfile({
                userID: currentUser.id,
                ...formData
            });
            setProfile(updatedProfile as unknown as Profile);
            toast.success(t('Profile updated successfully'));
        } catch (error) {
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
                    <Text>{t('Loading...')}</Text>
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
                        style={[styles.saveButton, isSaving && styles.saveButtonDisabled]} 
                        onPress={handleUpdateProfile}
                        disabled={isSaving}
                    >
                        {isSaving ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <Text style={styles.saveButtonText}>{t('Save')}</Text>
                        )}
                    </TouchableOpacity>
                    )]
                }}
            />
            <View style={styles.avatarContainer}>
                <TouchableOpacity 
                    onPress={() => setAvatarModalVisible(true)}
                    disabled={isSaving}
                >
                    <Avatar id={formData.avatar} size={100} />
                </TouchableOpacity>
                <TouchableOpacity 
                    onPress={() => setAvatarModalVisible(true)}
                    disabled={isSaving}
                >
                    <Text style={styles.changePhotoText}>{t('Change profile photo')}</Text>
                </TouchableOpacity>
            </View>
            <View style={styles.form}>
            <View style={styles.inputGroup}>
            <Text style={styles.label}>{t('First Name')}</Text>
                <TextInput
                    style={styles.input}
                    placeholder={t('First Name')}
                    value={formData.name.first}
                    onChangeText={(text) => setFormData(prev => ({
                        ...prev,
                        name: { ...prev.name, first: text }
                    }))}
                />
                </View>
                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Last Name')}</Text>
                <TextInput
                    style={styles.input}
                    placeholder={t('Last Name')}
                    value={formData.name.last}
                    onChangeText={(text) => setFormData(prev => ({
                        ...prev,
                        name: { ...prev.name, last: text }
                    }))}
                />
                </View>
                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Bio')}</Text>
                <TextInput
                    style={styles.input}
                    placeholder={t('Description')}
                    value={formData.description}
                    onChangeText={(text) => setFormData(prev => ({
                        ...prev,
                        description: text
                    }))}
                    multiline
                />
                </View>
                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Location')}</Text>
                <TextInput
                    style={styles.input}
                    placeholder={t('Location')}
                    value={formData.location}
                    onChangeText={(text) => setFormData(prev => ({
                        ...prev,
                        location: text
                    }))}
                />
                </View>
                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Website')}</Text>
                <TextInput
                    style={styles.input}
                    placeholder={t('Website')}
                    value={formData.website}
                    onChangeText={(text) => setFormData(prev => ({
                        ...prev,
                        website: text
                    }))}
                />
                </View>
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarContainer: {
        alignItems: 'center',
        padding: 20,
    },
    changePhotoText: {
        color: colors.primaryColor,
        marginTop: 10,
        fontSize: 16,
    },
    form: {
        padding: 16,
    },
    inputGroup: {
        marginBottom: 16,
    },
    label: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 8,
        color: colors.COLOR_BLACK,
    },
    input: {
        backgroundColor: '#fff',
        borderRadius: 35,
        padding: 12,
        fontSize: 16,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
    },
    textArea: {
        height: 100,
        textAlignVertical: 'top',
    },
    saveButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 35,
    },
    saveButtonText: {
        color: '#fff',
        fontWeight: '600',
        fontSize: 16,
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    saveButtonDisabled: {
        opacity: 0.6,
    },
    errorText: {
        color: colors.primaryColor,
        textAlign: 'center',
        marginTop: 16,
        padding: 16,
    }
});