import React, { useState, useContext, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { useDispatch, useSelector } from 'react-redux';
import { updateProfileData, fetchProfile } from '@/store/reducers/profileReducer';
import { toast } from '@/lib/sonner';
import Avatar from '@/components/Avatar';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { RootState, AppDispatch } from '@/store/store';
import { router } from 'expo-router';
import { Profile } from '@/interfaces/Profile';
import { SafeAreaView } from 'react-native-safe-area-context';
import { OXY_CLOUD_URL } from '@/config';

interface FormData {
    name: {
        first: string;
        last: string;
    };
    description: string;
    location: string;
    website: string;
    avatar: string;
}

export default function EditProfileScreen() {
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    const getCurrentUser = sessionContext?.getCurrentUser || (() => null);
    const currentUser = getCurrentUser();
    const dispatch = useDispatch<AppDispatch>();
    const { profile, loading, error } = useSelector((state: RootState) => state.profile);

    const [isAvatarModalVisible, setAvatarModalVisible] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [formData, setFormData] = useState<FormData>({
        name: {
            first: profile?.name?.first || '',
            last: profile?.name?.last || ''
        },
        description: profile?.description || '',
        location: profile?.location || '',
        website: profile?.website || '',
        avatar: profile?.avatar || ''
    });

    useEffect(() => {
        if (currentUser?.username) {
            dispatch(fetchProfile({ username: currentUser.username }));
        }
    }, [currentUser?.username, dispatch]);

    useEffect(() => {
        if (profile) {
            setFormData({
                name: {
                    first: profile.name?.first || '',
                    last: profile.name?.last || ''
                },
                description: profile.description || '',
                location: profile.location || '',
                website: profile.website || '',
                avatar: profile.avatar || ''
            });
        }
    }, [profile]);

    const validateForm = (): boolean => {
        if (formData.website && !formData.website.match(/^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/)) {
            toast.error(t('Please enter a valid website URL'));
            return false;
        }
        return true;
    };

    const handleUpdateProfile = async () => {
        if (!currentUser?.id || !validateForm()) return;
        
        setIsSaving(true);
        try {
            const result = await dispatch(updateProfileData({ 
                id: currentUser.id, 
                data: formData 
            })).unwrap();
            
            if (result) {
                toast.success(t('Profile updated successfully'));
                router.back();
            }
        } catch (error) {
            toast.error(t('Failed to update profile'));
            console.error('Error updating profile:', error);
        } finally {
            setIsSaving(false);
        }
    };

    const handleAvatarSelect = (files: Array<{ _id: string; filename: string; contentType: string }>) => {
        if (files.length > 0) {
            const fileUri = `${OXY_CLOUD_URL}${files[0]._id}`;
            setFormData(prev => ({ ...prev, avatar: files[0]._id}));
        }
        setAvatarModalVisible(false);
    };

    if (!currentUser) {
        return (
            <SafeAreaView style={styles.container}>
                <Header options={{
                    title: t('Edit Profile'),
                    showBackButton: true,
                }} />
                <View style={styles.centered}>
                    <Text>{t('Please log in to edit your profile')}</Text>
                </View>
            </SafeAreaView>
        );
    }

    const isLoading = loading || isSaving;

    return (
        <ScrollView>
        <SafeAreaView style={styles.container}>
            <Header options={{
                title: t('Edit Profile'),
                showBackButton: true,
                rightComponents: [
                    <TouchableOpacity 
                        key="save"
                        style={[styles.saveButton, isLoading && styles.saveButtonDisabled]} 
                        onPress={handleUpdateProfile}
                        disabled={isLoading}
                    >
                        {isLoading ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <Text style={styles.saveButtonText}>{t('Save')}</Text>
                        )}
                    </TouchableOpacity>
                ]
            }} />
            
            <View style={styles.avatarContainer}>
                <TouchableOpacity 
                    onPress={() => setAvatarModalVisible(true)}
                    disabled={isLoading}
                >
                    <Avatar id={formData.avatar} size={100} />
                </TouchableOpacity>
                <TouchableOpacity 
                    onPress={() => setAvatarModalVisible(true)}
                    disabled={isLoading}
                >
                    <Text style={styles.changePhotoText}>{t('Change profile photo')}</Text>
                </TouchableOpacity>
            </View>

            <View style={styles.form}>
                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('First Name')}</Text>
                    <TextInput
                        style={styles.input}
                        value={formData.name.first}
                        onChangeText={(text) => setFormData(prev => ({
                            ...prev,
                            name: { ...prev.name, first: text }
                        }))}
                        placeholder={t('Enter your first name')}
                        editable={!isLoading}
                        maxLength={50}
                    />
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Last Name')}</Text>
                    <TextInput
                        style={styles.input}
                        value={formData.name.last}
                        onChangeText={(text) => setFormData(prev => ({
                            ...prev,
                            name: { ...prev.name, last: text }
                        }))}
                        placeholder={t('Enter your last name')}
                        editable={!isLoading}
                        maxLength={50}
                    />
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Bio')}</Text>
                    <TextInput
                        style={[styles.input, styles.textArea]}
                        value={formData.description}
                        onChangeText={(text) => setFormData(prev => ({ ...prev, description: text }))}
                        placeholder={t('Write a bio about yourself')}
                        multiline
                        numberOfLines={4}
                        editable={!isLoading}
                        maxLength={160}
                    />
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Location')}</Text>
                    <TextInput
                        style={styles.input}
                        value={formData.location}
                        onChangeText={(text) => setFormData(prev => ({ ...prev, location: text }))}
                        placeholder={t('Add your location')}
                        editable={!isLoading}
                        maxLength={100}
                    />
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Website')}</Text>
                    <TextInput
                        style={styles.input}
                        value={formData.website}
                        onChangeText={(text) => setFormData(prev => ({ ...prev, website: text }))}
                        placeholder={t('Add your website')}
                        keyboardType="url"
                        autoCapitalize="none"
                        editable={!isLoading}
                        maxLength={100}
                    />
                </View>
            </View>

            {error && (
                <Text style={styles.errorText}>{error}</Text>
            )}

            <FileSelectorModal
                visible={isAvatarModalVisible}
                onClose={() => setAvatarModalVisible(false)}
                onSelect={handleAvatarSelect}
                options={{
                    fileTypeFilter: ["image/"],
                    maxFiles: 1,
                }}
            />
        </SafeAreaView>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
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