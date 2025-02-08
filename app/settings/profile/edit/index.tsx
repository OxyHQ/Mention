import React, { useState, useContext, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, SafeAreaView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { useDispatch, useSelector } from 'react-redux';
import { updateProfileData } from '@/store/reducers/profileReducer';
import { toast } from '@/lib/sonner';
import Avatar from '@/components/Avatar';
import FileSelectorModal from '@/modules/oxyhqservices/components/FileSelectorModal';
import { RootState, AppDispatch } from '@/store/store';

export default function EditProfileScreen() {
    const { t } = useTranslation();
    const sessionContext = useContext(SessionContext);
    const currentUser = sessionContext?.getCurrentUser();
    const dispatch = useDispatch<AppDispatch>();
    const { loading, error } = useSelector((state: RootState) => state.profile);

    const [isAvatarModalVisible, setAvatarModalVisible] = useState(false);
    const [formData, setFormData] = useState({
        name: {
            first: '',
            last: ''
        },
        description: '',
        location: '',
        website: '',
        avatar: ''
    });

    useEffect(() => {
        if (currentUser) {
            setFormData({
                name: {
                    first: currentUser.name?.first || '',
                    last: currentUser.name?.last || ''
                },
                description: currentUser.description || '',
                location: currentUser.location || '',
                website: currentUser.website || '',
                avatar: currentUser.avatar || ''
            });
        }
    }, [currentUser]);

    const handleUpdateProfile = async () => {
        if (!currentUser?.id) return;
        
        try {
            const result = await dispatch(updateProfileData({ 
                id: currentUser.id, 
                data: formData 
            })).unwrap();
            
            if (result) {
                toast.success(t('Profile updated successfully'));
            }
        } catch (error) {
            toast.error(t('Failed to update profile'));
            console.error('Error updating profile:', error);
        }
    };

    const handleAvatarSelect = (files: Array<{ _id: string; contentType: string; uri: string }>) => {
        if (files.length > 0) {
            const fileUri = `${process.env.OXY_CLOUD_URL}/files/${files[0]._id}`;
            setFormData(prev => ({ ...prev, avatar: fileUri }));
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

    return (
        <SafeAreaView style={styles.container}>
            <Header options={{
                title: t('Edit Profile'),
                showBackButton: true,
                rightComponents: [
                    <TouchableOpacity 
                        style={[styles.saveButton, loading && styles.saveButtonDisabled]} 
                        onPress={handleUpdateProfile}
                        disabled={loading}
                    >
                        {loading ? (
                            <ActivityIndicator color="#fff" size="small" />
                        ) : (
                            <Text style={styles.saveButtonText}>{t('Save')}</Text>
                        )}
                    </TouchableOpacity>
                ]
            }} />
            
            <View style={styles.avatarContainer}>
                <TouchableOpacity onPress={() => setAvatarModalVisible(true)}>
                    <Avatar id={formData.avatar} size={100} />
                </TouchableOpacity>
                <Text style={styles.changePhotoText}>{t('Change profile photo')}</Text>
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
                    />
                </View>

                <View style={styles.inputGroup}>
                    <Text style={styles.label}>{t('Location')}</Text>
                    <TextInput
                        style={styles.input}
                        value={formData.location}
                        onChangeText={(text) => setFormData(prev => ({ ...prev, location: text }))}
                        placeholder={t('Add your location')}
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
                userId={currentUser.id}
                options={{
                    fileTypeFilter: ["image/"],
                    maxFiles: 1,
                }}
            />
        </SafeAreaView>
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