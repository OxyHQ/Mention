import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator
} from 'react-native';
import { useAuthFetch, useOxy } from '@oxyhq/services/full';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '@/styles/colors';
import Avatar from '@/components/Avatar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

const ComposeScreen = () => {
  const [postContent, setPostContent] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const { user } = useOxy();
  const { t } = useTranslation();

  const authFetch = useAuthFetch();
  authFetch.setApiUrl('http://localhost:3000');

  const handlePost = async () => {
    if (!postContent.trim() || isPosting) return;

    setIsPosting(true);
    try {
      console.log('Attempting to create post...');

      // Call API to create post - authentication handled by API utils
      const result = await authFetch.post('/posts', { text: postContent.trim() });
      console.log('Post created successfully:', result);

      // Show success toast
      toast.success(t('Post published successfully'));

      // Navigate back after posting
      router.back();
    } catch (error: any) {
      console.error('Error creating post:', error);
      console.error('Error response:', error.response?.data);
      console.error('Error status:', error.response?.status);

      // Show specific error message if available
      const errorMessage = error.response?.data?.message || error.message || 'Failed to publish post';
      toast.error(t(errorMessage));
    } finally {
      setIsPosting(false);
    }
  };

  const handleCancel = () => {
    router.back();
  };

  const isPostButtonEnabled = postContent.trim().length > 0 && !isPosting;

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <StatusBar style="dark" />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
          <Text style={styles.cancelButtonText}>{t('Cancel')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handlePost}
          style={[
            styles.postButton,
            !isPostButtonEnabled && styles.postButtonDisabled
          ]}
          disabled={!isPostButtonEnabled}
        >
          {isPosting ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.postButtonText}>{t('Post')}</Text>
          )}
        </TouchableOpacity>
      </View>

      <KeyboardAvoidingView
        style={styles.composeArea}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
      >
        <View style={styles.userInfoContainer}>
          <Avatar
            size={40}
          />

          <View style={styles.userInfo}>
            <Text style={styles.userName}>{user?.fullName || user?.username}</Text>
            {user?.username && <Text style={styles.userHandle}>@{user.username}</Text>}
          </View>
        </View>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder={t("What's happening?")}
            placeholderTextColor="#657786"
            multiline
            autoFocus
            value={postContent}
            onChangeText={setPostContent}
            maxLength={280}
          />
        </View>

        <View style={styles.charCountContainer}>
          <Text style={[
            styles.charCount,
            postContent.length > 260 && styles.charCountWarning,
            postContent.length >= 280 && styles.charCountLimit
          ]}>
            {280 - postContent.length}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E1E8ED',
    ...Platform.select({
      web: {
        position: 'sticky',
        top: 0,
        zIndex: 1000,
      },
    }),
  },
  cancelButton: {
    padding: 8,
  },
  cancelButtonText: {
    color: '#1DA1F2',
    fontSize: 16,
  },
  postButton: {
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 50,
  },
  postButtonDisabled: {
    backgroundColor: '#9BD1F9',
  },
  postButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  composeArea: {
    flex: 1,
    padding: 16,
  },
  userInfoContainer: {
    flexDirection: 'row',
    marginBottom: 16,
  },
  userInfo: {
    marginLeft: 12,
    justifyContent: 'center',
  },
  userName: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#14171A',
  },
  userHandle: {
    fontSize: 14,
    color: '#657786',
  },
  inputContainer: {
    flex: 1,
  },
  input: {
    fontSize: 18,
    lineHeight: 24,
    color: '#14171A',
    textAlignVertical: 'top',
  },
  charCountContainer: {
    alignItems: 'flex-end',
    paddingVertical: 8,
  },
  charCount: {
    fontSize: 14,
    color: '#657786',
  },
  charCountWarning: {
    color: '#FFAD1F',
  },
  charCountLimit: {
    color: '#E0245E',
  },
});

export default ComposeScreen;