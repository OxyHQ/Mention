/**
 * SessionSwitcher Component
 * 
 * A component that displays a list of available sessions and allows the user to switch between them.
 * It also provides options to sign in with a new account or sign out from the current session.
 */

import React, { useContext, useState, useEffect } from 'react';
import { View, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView, Image, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../../styles/colors';
import { SessionContext } from '../SessionProvider';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from '../AuthBottomSheet';
import { OxyLogo } from '../OxyLogo';
import errorHandler from '../../utils/errorHandler';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { userService } from '../../services/user.service';
import { profileService } from '../../services/profile.service';
import { OxyProfile } from '../../types';
import { bottomSheetState } from '../context/BottomSheetContainer';

interface SessionSwitcherProps {
    onClose?: () => void;
}

// Define the session type
interface SessionWithProfile {
    id: string;
    profile?: OxyProfile;
    lastActive?: Date;
}

export function SessionSwitcher({ onClose }: SessionSwitcherProps) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(false);
    const [switchingSessionId, setSwitchingSessionId] = useState<string | null>(null);
    const [sessions, setSessions] = useState<SessionWithProfile[]>([]);
    const [isLoadingSessions, setIsLoadingSessions] = useState(true);

    const sessionContext = useContext(SessionContext);
    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    const currentUserId = sessionContext?.getCurrentUserId();
    const isAuthenticated = sessionContext?.isAuthenticated || false;

    // Load sessions with profile data
    useEffect(() => {
        loadSessions();
    }, [isAuthenticated]);

    // Function to load sessions
    const loadSessions = async () => {
        if (!isAuthenticated) {
            setSessions([]);
            setIsLoadingSessions(false);
            return;
        }

        setIsLoadingSessions(true);
        try {
            // Get sessions from the user service
            const { data: serviceSessions } = await userService.getSessions();

            // Load profile data for each session
            const sessionsWithProfiles = await Promise.all(
                serviceSessions.map(async (session) => {
                    try {
                        // If the session already has a profile, use it
                        if (session.profile) {
                            return session;
                        }

                        // Otherwise, fetch the profile
                        const profile = await profileService.getProfileById(session.id);
                        return {
                            ...session,
                            profile
                        };
                    } catch (error) {
                        console.error(`Error loading profile for session ${session.id}:`, error);
                        return session;
                    }
                })
            );

            setSessions(sessionsWithProfiles);
        } catch (error) {
            console.error('Error loading sessions with profiles:', error);
            // Fallback to context sessions if available
            if (sessionContext?.sessions && sessionContext.sessions.length > 0) {
                setSessions(sessionContext.sessions);
            }
        } finally {
            setIsLoadingSessions(false);
        }
    };

    // Handle switching to a different session
    const handleSessionSwitch = async (sessionId: string) => {
        if (!sessionContext?.switchSession) {
            toast.error(t('Session switching is not available'));
            return;
        }

        if (sessionId === currentUserId) {
            // Already on this session
            if (onClose) onClose();
            return;
        }

        try {
            setLoading(true);
            setSwitchingSessionId(sessionId);
            await sessionContext.switchSession(sessionId);
            toast.success(t('Switched to account successfully'));
            if (onClose) onClose();
        } catch (error) {
            errorHandler.handleError(error, {
                context: 'SessionSwitcher',
                fallbackMessage: t('Failed to switch account')
            });
        } finally {
            setLoading(false);
            setSwitchingSessionId(null);
        }
    };

    // Handle signing out
    const handleSignOut = async () => {
        if (!sessionContext?.logoutUser) {
            toast.error(t('Logout is not available'));
            return;
        }

        try {
            setLoading(true);
            await sessionContext.logoutUser();
            toast.success(t('Signed out successfully'));
            if (onClose) onClose();
        } catch (error) {
            errorHandler.handleError(error, {
                context: 'SessionSwitcher',
                fallbackMessage: t('Failed to sign out')
            });
        } finally {
            setLoading(false);
        }
    };

    // Handle adding a new account
    const handleAddAccount = () => {
        // First close the current bottom sheet if needed
        if (onClose) onClose();

        // Small delay to ensure the current sheet is closed before opening the new one
        setTimeout(() => {
            try {
                // Use the helper function to open the AuthBottomSheet
                bottomSheetState.openAuthBottomSheet('signin', () => {
                    // Refresh sessions after successful login
                    loadSessions();
                });
            } catch (error) {
                console.error('Error opening auth bottom sheet:', error);
                toast.error(t('Failed to open sign in screen'));
            }
        }, 300); // 300ms delay to ensure smooth transition
    };

    if (!isAuthenticated) {
        return (
            <View style={styles.container}>
                <View style={styles.header}>
                    <OxyLogo size={30} />
                    <Text style={styles.title}>{t('Sign In')}</Text>
                </View>
                <TouchableOpacity
                    style={styles.signInButton}
                    onPress={handleAddAccount}
                    disabled={loading}
                >
                    <Text style={styles.signInButtonText}>{t('Sign in with Oxy')}</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>{t('Your Accounts')}</Text>
                {(loading || isLoadingSessions) && <ActivityIndicator size="small" color={colors.primaryColor} />}
            </View>

            {isLoadingSessions ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primaryColor} />
                    <Text style={styles.loadingText}>{t('Loading accounts...')}</Text>
                </View>
            ) : sessions.length === 0 ? (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>{t('No accounts found')}</Text>
                </View>
            ) : (
                <ScrollView style={styles.sessionList}>
                    {sessions.map((session: SessionWithProfile) => {
                        const isCurrentSession = session.id === currentUserId;
                        const isSwitching = session.id === switchingSessionId;

                        return (
                            <TouchableOpacity
                                key={session.id}
                                style={[
                                    styles.sessionItem,
                                    isCurrentSession && styles.currentSessionItem
                                ]}
                                onPress={() => handleSessionSwitch(session.id)}
                                disabled={loading || isCurrentSession}
                            >
                                <View style={styles.sessionAvatar}>
                                    {session.profile?.avatar ? (
                                        <Image
                                            source={{ uri: session.profile.avatar }}
                                            style={styles.avatarImage}
                                        />
                                    ) : (
                                        <View style={[styles.avatarImage, styles.defaultAvatar]}>
                                            <Text style={styles.avatarInitial}>
                                                {(session.profile?.username?.[0] || '').toUpperCase()}
                                            </Text>
                                        </View>
                                    )}
                                </View>

                                <View style={styles.sessionInfo}>
                                    <Text style={styles.sessionName}>
                                        {session.profile?.name?.first || session.profile?.username}{' '}
                                        {session.profile?.name?.last || ''}
                                    </Text>
                                    <Text style={styles.sessionUsername}>
                                        @{session.profile?.username}
                                    </Text>
                                </View>

                                {isCurrentSession && (
                                    <View style={styles.currentBadge}>
                                        <Ionicons name="checkmark-circle" size={20} color={colors.primaryColor} />
                                    </View>
                                )}

                                {isSwitching && (
                                    <ActivityIndicator size="small" color={colors.primaryColor} />
                                )}
                            </TouchableOpacity>
                        );
                    })}
                </ScrollView>
            )}

            <View style={styles.footer}>
                <TouchableOpacity
                    style={styles.addAccountButton}
                    onPress={handleAddAccount}
                    disabled={loading}
                >
                    <Ionicons name="add-circle-outline" size={20} color={colors.primaryColor} />
                    <Text style={styles.addAccountText}>{t('Add another account')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    style={styles.signOutButton}
                    onPress={handleSignOut}
                    disabled={loading}
                >
                    <Ionicons name="log-out-outline" size={20} color="#FF3B30" />
                    <Text style={styles.signOutText}>{t('Sign out')}</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK,
    },
    sessionList: {
        flex: 1,
        marginBottom: 16,
    },
    sessionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
        backgroundColor: colors.primaryLight,
    },
    currentSessionItem: {
        backgroundColor: `${colors.primaryColor}20`, // 20% opacity
        borderWidth: 1,
        borderColor: colors.primaryColor,
    },
    sessionAvatar: {
        marginRight: 12,
    },
    avatarImage: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    defaultAvatar: {
        backgroundColor: colors.primaryColor,
        justifyContent: 'center',
        alignItems: 'center',
    },
    avatarInitial: {
        color: '#FFFFFF',
        fontSize: 18,
        fontWeight: 'bold',
    },
    sessionInfo: {
        flex: 1,
    },
    sessionName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK,
    },
    sessionUsername: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_5,
    },
    currentBadge: {
        marginLeft: 8,
    },
    footer: {
        marginTop: 16,
    },
    addAccountButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.primaryLight,
        marginBottom: 8,
    },
    addAccountText: {
        marginLeft: 8,
        fontSize: 16,
        color: colors.primaryColor,
    },
    signOutButton: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.primaryLight,
    },
    signOutText: {
        marginLeft: 8,
        fontSize: 16,
        color: '#FF3B30',
    },
    signInButton: {
        backgroundColor: colors.primaryColor,
        padding: 12,
        borderRadius: 8,
        alignItems: 'center',
    },
    signInButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: 'bold',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        marginTop: 12,
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    }
}); 