import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert
} from 'react-native';
import { useOxy } from '@oxyhq/services';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../styles/colors';
import Avatar from '@/components/Avatar';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { usePostsStore } from '../stores/postsStore';

const ComposeScreen = () => {
  const [postContent, setPostContent] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const { user } = useOxy();
  const { createPost } = usePostsStore();
  const { t } = useTranslation();

  const handlePost = async () => {
    if (!postContent.trim() || isPosting || !user) return;

    setIsPosting(true);
    try {
      console.log('Attempting to create post...');

      // Create the post request for the API
      const postRequest = {
        content: {
          text: postContent.trim(),
        },
        mentions: [],
        hashtags: []
      };

      // Send to backend API
      await createPost(postRequest);

      // Show success toast
      toast.success(t('Post published successfully'));

      // Navigate back after posting
      router.back();
    } catch (error: any) {
      console.error('Error creating post:', error);
      toast.error(t('Failed to publish post'));
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
          <Text style={styles.cancelText}>{t('Cancel')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={handlePost}
          disabled={!isPostButtonEnabled}
          style={[
            styles.postButton,
            !isPostButtonEnabled && styles.postButtonDisabled
          ]}
        >
          {isPosting ? (
            <ActivityIndicator size="small" color="white" />
          ) : (
            <Text style={styles.postButtonText}>{t('Post')}</Text>
          )}
        </TouchableOpacity>
      </View>

      {/* Compose Area */}
      <KeyboardAvoidingView
        style={styles.composeArea}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.userInfo}>
          <Avatar
            source={user?.avatar}
            size={40}
            verified={user?.verified}
          />
          <View style={styles.userDetails}>
            <Text style={styles.userName}>{user?.name?.full || user?.username}</Text>
            <Text style={styles.userHandle}>@{user?.username}</Text>
          </View>
        </View>

        <TextInput
          style={styles.textInput}
          placeholder={t("What's happening?")}
          placeholderTextColor={colors.COLOR_BLACK_LIGHT_5}
          value={postContent}
          onChangeText={setPostContent}
          multiline
          autoFocus
          textAlignVertical="top"
        />

        <View style={styles.footer}>
          <Text style={styles.characterCount}>
            {postContent.length}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.COLOR_BLACK_LIGHT_9,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  cancelButton: {
    padding: 8,
  },
  cancelText: {
    fontSize: 16,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
  postButton: {
    backgroundColor: colors.primaryColor,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 60,
    alignItems: 'center',
  },
  postButtonDisabled: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_5,
  },
  postButtonText: {
    color: colors.COLOR_BLACK_LIGHT_9,
    fontSize: 16,
    fontWeight: '600',
  },
  composeArea: {
    flex: 1,
    padding: 16,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  userDetails: {
    marginLeft: 12,
  },
  userName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.COLOR_BLACK_LIGHT_1,
  },
  userHandle: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
    marginTop: 2,
  },
  textInput: {
    flex: 1,
    fontSize: 18,
    lineHeight: 24,
    color: colors.COLOR_BLACK_LIGHT_1,
    minHeight: 120,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 16,
  },
  characterCount: {
    fontSize: 14,
    color: colors.COLOR_BLACK_LIGHT_4,
  },
});

export default ComposeScreen;
