import React, { useState, useEffect, useContext } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { colors } from '@/styles/colors';
import { useTranslation } from 'react-i18next';
import { authEvents } from '@/modules/oxyhqservices/utils/authEvents';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { useSession } from '@/modules/oxyhqservices/hooks/useSession';
import { getSecureData, getData } from '@/modules/oxyhqservices/utils/storage';
import { STORAGE_KEYS } from '@/modules/oxyhqservices/constants';
import api from '@/utils/api';

export default function DebugAuthScreen() {
  const { t } = useTranslation();
  const [authState, setAuthState] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const sessionContext = useContext(SessionContext);
  const { loginUser, logoutUser } = useSession();
  
  // Enhanced authentication check using oxyhqservices
  const checkAuth = async () => {
    setIsLoading(true);
    try {
      // Get user from session context
      const userId = sessionContext?.getCurrentUserId();
      
      // Get tokens from various sources
      const [
        sessionData,
        directAccessToken,
        oxyAccessToken,
        oxyRefreshToken
      ] = await Promise.all([
        getData('session') as Promise<any>,
        getData('accessToken') as Promise<string | null>,
        getSecureData<string>(STORAGE_KEYS.ACCESS_TOKEN),
        getSecureData<string>(STORAGE_KEYS.REFRESH_TOKEN)
      ]);
      
      // Check OxyHQ validation
      let isValid = false;
      let validationError = null;
      
      if (sessionContext?.isAuthenticated) {
        try {
          isValid = await sessionContext.refreshTokenIfNeeded();
        } catch (error: any) {
          validationError = error.message;
        }
      }

      // Safely handle session data with proper type checking
      const sessionAccessToken = sessionData?.accessToken as string | undefined;
      const sessionRefreshToken = sessionData?.refreshToken as string | undefined;
      
      const state = {
        isAuthenticated: !!sessionContext?.isAuthenticated,
        tokenDetails: {
          hasAccessToken: !!(sessionAccessToken || directAccessToken || oxyAccessToken),
          hasRefreshToken: !!(sessionRefreshToken || oxyRefreshToken),
          hasUserData: !!userId,
          accessTokenPreview: typeof oxyAccessToken === 'string' && oxyAccessToken ? 
            `${oxyAccessToken.substring(0, 10)}...${oxyAccessToken.substring(oxyAccessToken.length - 10)}` : 
            (typeof sessionAccessToken === 'string' && sessionAccessToken ? 
              `${sessionAccessToken.substring(0, 10)}...${sessionAccessToken.substring(sessionAccessToken.length - 10)}` : 
              null)
        },
        validationResult: isValid,
        error: validationError,
        sessions: sessionContext?.sessions || [],
        tokenSources: {
          oxyAccessToken: !!oxyAccessToken,
          sessionToken: !!sessionAccessToken,
          directToken: !!directAccessToken
        }
      };
      
      setAuthState(state);
    } catch (error) {
      Alert.alert('Error', 'Failed to check authentication state');
      console.error('Auth check error:', error);
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleLogin = () => {
    // Use OxyHQ auth system
    authEvents.requireAuth('signin');
  };
  
  const handleLogout = async () => {
    try {
      setIsLoading(true);
      if (logoutUser) {
        await logoutUser();
        Alert.alert('Success', 'Logged out successfully');
      } else {
        Alert.alert('Error', 'Logout function not available');
      }
    } catch (error: any) {
      Alert.alert('Error', error?.message || 'Failed to log out');
    } finally {
      setIsLoading(false);
      checkAuth();
    }
  };
  
  const testCreatePost = async () => {
    try {
      setIsLoading(true);
      
      // First check authentication
      if (!sessionContext?.isAuthenticated) {
        Alert.alert('Error', 'Not authenticated. Please log in first.');
        setIsLoading(false);
        return;
      }
      
      const response = await api.post('/posts', {
        text: 'Test post from debug screen',
        media: [],
      });
      
      Alert.alert('Success', 'Post created successfully');
      console.log('Post response:', response.data);
    } catch (error: any) {
      Alert.alert('Error', error.message || 'Failed to create post');
      console.error('Post error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
    
    // Re-check auth when session changes
    const checkInterval = setInterval(checkAuth, 5000);
    
    return () => clearInterval(checkInterval);
  }, [sessionContext?.isAuthenticated]);
  
  return (
    <ScrollView style={styles.container}>
      <Text style={styles.title}>Authentication Debug</Text>
      
      <View style={styles.buttonContainer}>
        <TouchableOpacity 
          style={styles.button}
          onPress={checkAuth}
          disabled={isLoading}
        >
          <Text style={styles.buttonText}>
            {isLoading ? t('Checking...') : t('Check Auth Status')}
          </Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.button, styles.loginButton]}
          onPress={handleLogin}
        >
          <Text style={styles.buttonText}>{t('Login')}</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.button, styles.logoutButton]}
          onPress={handleLogout}
          disabled={!sessionContext?.isAuthenticated || isLoading}
        >
          <Text style={styles.buttonText}>{t('Logout')}</Text>
        </TouchableOpacity>
        
        <TouchableOpacity 
          style={[styles.button, styles.testButton]}
          onPress={testCreatePost}
          disabled={isLoading}
        >
          <Text style={styles.buttonText}>{t('Test Create Post')}</Text>
        </TouchableOpacity>
      </View>
      
      {authState && (
        <View style={styles.statusContainer}>
          <Text style={styles.sectionTitle}>{t('Authentication Status')}</Text>
          <Text style={styles.statusText}>
            {t('Authenticated')}: {authState.isAuthenticated ? t('Yes') + ' ✅' : t('No') + ' ❌'}
          </Text>
          <Text style={styles.statusText}>
            {t('Session Valid')}: {authState.validationResult ? t('Valid') + ' ✅' : t('Invalid') + ' ❌'}
          </Text>
          {authState.error && (
            <Text style={styles.errorText}>{t('Error')}: {authState.error}</Text>
          )}
          
          <Text style={styles.sectionTitle}>{t('Token Details')}</Text>
          <Text style={styles.statusText}>
            {t('Access Token')}: {authState.tokenDetails.hasAccessToken ? t('Present') + ' ✅' : t('Missing') + ' ❌'}
          </Text>
          <Text style={styles.statusText}>
            {t('Refresh Token')}: {authState.tokenDetails.hasRefreshToken ? t('Present') + ' ✅' : t('Missing') + ' ❌'}
          </Text>
          <Text style={styles.statusText}>
            {t('User Data')}: {authState.tokenDetails.hasUserData ? t('Present') + ' ✅' : t('Missing') + ' ❌'}
          </Text>
          
          {/* Add token sources debugging */}
          <Text style={styles.subSectionTitle}>{t('Token Sources')}</Text>
          <Text style={styles.statusText}>
            {t('OxyHQ Secure Storage')}: {authState.tokenSources.oxyAccessToken ? '✅' : '❌'}
          </Text>
          <Text style={styles.statusText}>
            {t('Session Storage')}: {authState.tokenSources.sessionToken ? '✅' : '❌'}
          </Text>
          <Text style={styles.statusText}>
            {t('Direct Storage')}: {authState.tokenSources.directToken ? '✅' : '❌'}
          </Text>
          
          {authState.tokenDetails.accessTokenPreview && (
            <Text style={styles.tokenPreview}>
              {t('Token Preview')}: {authState.tokenDetails.accessTokenPreview}
            </Text>
          )}
          
          <Text style={styles.sectionTitle}>{t('Sessions')}</Text>
          {authState.sessions && authState.sessions.length > 0 ? (
            authState.sessions.map((session: any, index: number) => (
              <Text key={index} style={styles.sessionText}>
                {index + 1}. {session.id} {session.id === sessionContext?.getCurrentUserId() ? '(current)' : ''}
              </Text>
            ))
          ) : (
            <Text style={styles.statusText}>{t('No active sessions')}</Text>
          )}
        </View>
      )}
      
      <Text style={styles.helpText}>
        {t('If you\'re experiencing authentication issues, try the following:')}
        {'\n\n'}
        1. {t('Check if you\'re properly authenticated (tokens present and valid)')}
        {'\n'}
        2. {t('If not, use the Login button to authenticate')}
        {'\n'}
        3. {t('If problems persist, use Logout and login again')}
        {'\n'}
        4. {t('Try creating a test post to verify that authentication works')}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    padding: 20,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 20,
    color: colors.primaryColor,
    textAlign: 'center',
  },
  buttonContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  button: {
    backgroundColor: colors.primaryColor,
    padding: 12,
    borderRadius: 8,
    marginVertical: 8,
    width: '48%',
    alignItems: 'center',
  },
  loginButton: {
    backgroundColor: '#4CAF50', // Green
  },
  logoutButton: {
    backgroundColor: '#F44336', // Red
  },
  testButton: {
    backgroundColor: '#2196F3', // Blue
  },
  buttonText: {
    color: 'white',
    fontWeight: 'bold',
  },
  statusContainer: {
    backgroundColor: '#f5f5f5',
    padding: 15,
    borderRadius: 8,
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 10,
    marginBottom: 8,
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  statusText: {
    fontSize: 16,
    marginVertical: 4,
  },
  sessionText: {
    fontSize: 14,
    marginVertical: 2,
    fontFamily: 'monospace',
  },
  tokenPreview: {
    fontSize: 12,
    color: colors.COLOR_BLACK_LIGHT_2,
    marginTop: 8,
    fontFamily: 'monospace',
  },
  errorText: {
    color: '#F44336',
    marginVertical: 8,
  },
  helpText: {
    backgroundColor: '#E3F2FD',
    padding: 15,
    borderRadius: 8,
    lineHeight: 20,
  },
  subSectionTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 8,
    marginBottom: 4,
    color: colors.COLOR_BLACK_LIGHT_2,
  },
});