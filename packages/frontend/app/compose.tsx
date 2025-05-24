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
import { useOxy } from '@oxyhq/services';
import { postData } from '@/utils/api';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { clearCache } from '@/utils/api';
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
  
  const handlePost = async () => {
    if (!postContent.trim() || isPosting) return;
    
    setIsPosting(true);
    try {
      // Call API to create post
      await postData('/posts', { text: postContent.trim() });
      
      // Clear cache to ensure feed is refreshed with the new post
      clearCache('feed/');
      
      // Show success toast
      toast.success(t('Post published successfully'));
      
      // Navigate back after posting
      router.back();
    } catch (error) {
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
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: '#E1E8ED',
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