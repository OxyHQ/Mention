import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Image,
  ActivityIndicator,
  Platform,
  ScrollView,
  KeyboardAvoidingView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { toast } from 'sonner';
import { useAuth } from '@oxyhq/services';
import * as ImagePicker from 'expo-image-picker';

import { useTheme } from '@/hooks/useTheme';
import { spacesService } from '@/services/spacesService';

interface StreamConfigModalProps {
  visible: boolean;
  onClose: () => void;
  spaceId: string;
  onStreamStarted: () => void;
}

type StreamMode = 'url' | 'rtmp';

export function StreamConfigModal({ visible, onClose, spaceId, onStreamStarted }: StreamConfigModalProps) {
  const theme = useTheme();
  const { oxyServices } = useAuth();

  const [mode, setMode] = useState<StreamMode>('url');
  const [loading, setLoading] = useState(false);

  // URL mode
  const [streamUrl, setStreamUrl] = useState('');

  // RTMP mode
  const [rtmpUrl, setRtmpUrl] = useState<string | null>(null);
  const [streamKey, setStreamKey] = useState<string | null>(null);
  const [generatingKey, setGeneratingKey] = useState(false);

  // Shared metadata
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [imageFileId, setImageFileId] = useState<string | null>(null);
  const [imagePreviewUri, setImagePreviewUri] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const resetState = () => {
    setStreamUrl('');
    setRtmpUrl(null);
    setStreamKey(null);
    setTitle('');
    setDescription('');
    setImageFileId(null);
    setImagePreviewUri(null);
    setMode('url');
  };

  const handleClose = () => {
    onClose();
  };

  const handlePickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        allowsEditing: true,
        aspect: [16, 9],
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setImagePreviewUri(asset.uri);
      setUploadingImage(true);

      try {
        let file: any;

        if (Platform.OS === 'web') {
          // On web, expo-image-picker returns a blob: URI. Fetch it and create a File object.
          const response = await fetch(asset.uri);
          const blob = await response.blob();
          file = new File([blob], 'stream-cover.jpg', { type: asset.mimeType || 'image/jpeg' });
        } else {
          // On native, use the { uri, type, name } pattern
          file = {
            uri: asset.uri,
            type: asset.mimeType || 'image/jpeg',
            name: 'stream-cover.jpg',
          };
        }

        const uploadResponse = await oxyServices.uploadFile(file, {
          folder: 'user_content',
          isPublic: true,
        });

        const fileId = uploadResponse?.file?.key || uploadResponse?.id || uploadResponse?.fileId || uploadResponse?.file?.id || uploadResponse?.data?.id;

        if (fileId) {
          setImageFileId(fileId);
        } else {
          console.error('Upload response missing file ID:', JSON.stringify(uploadResponse, null, 2));
          toast.error('Failed to upload image');
          setImagePreviewUri(null);
        }
      } catch (err) {
        console.error('Image upload error:', err);
        toast.error('Failed to upload image');
        setImagePreviewUri(null);
      } finally {
        setUploadingImage(false);
      }
    } catch (err) {
      console.error('Image picker error:', err);
      toast.error('Could not open image picker');
    }
  };

  const handleStartUrlStream = async () => {
    if (!streamUrl.trim() || loading) return;
    setLoading(true);
    try {
      const result = await spacesService.startStream(spaceId, {
        url: streamUrl.trim(),
        title: title.trim() || undefined,
        image: imageFileId || undefined,
        description: description.trim() || undefined,
      });
      if (result) {
        toast.success('Stream started');
        resetState();
        onStreamStarted();
        onClose();
      } else {
        toast.error('Failed to start stream');
      }
    } catch {
      toast.error('Failed to start stream');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerateKey = async () => {
    if (generatingKey) return;
    setGeneratingKey(true);
    try {
      const result = await spacesService.generateStreamKey(spaceId, {
        title: title.trim() || undefined,
        image: imageFileId || undefined,
        description: description.trim() || undefined,
      });
      if (result?.rtmpUrl && result?.streamKey) {
        setRtmpUrl(result.rtmpUrl);
        setStreamKey(result.streamKey);
        toast.success('Stream key generated');
        onStreamStarted();
      } else {
        console.error('Generate stream key response:', JSON.stringify(result, null, 2));
        toast.error('Failed to generate stream key — check server logs');
      }
    } catch (err: any) {
      console.error('Generate stream key error:', err);
      const msg = err?.response?.data?.message || err?.message || 'Unknown error';
      toast.error(`Stream key error: ${msg}`);
    } finally {
      setGeneratingKey(false);
    }
  };

  const handleUpdateMetadata = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const success = await spacesService.updateStreamMetadata(spaceId, {
        title: title.trim() || undefined,
        image: imageFileId || undefined,
        description: description.trim() || undefined,
      });
      if (success) {
        toast.success('Stream info updated');
        onStreamStarted();
      } else {
        toast.error('Failed to update stream info');
      }
    } catch {
      toast.error('Failed to update stream info');
    } finally {
      setLoading(false);
    }
  };

  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (Platform.OS === 'web') {
        await navigator.clipboard.writeText(text);
      } else {
        const { Clipboard } = require('react-native');
        Clipboard.setString(text);
      }
      toast.success(`${label} copied`);
    } catch {
      toast.error('Failed to copy');
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: theme.colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
          <TouchableOpacity onPress={handleClose} style={styles.closeBtn}>
            <Ionicons name="close" size={24} color={theme.colors.text} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Stream Setup</Text>
          <View style={styles.closeBtn} />
        </View>

        <ScrollView style={styles.scrollContent} keyboardShouldPersistTaps="handled">
        {/* Mode Selector */}
        <View style={styles.modeSelector}>
          <TouchableOpacity
            style={[
              styles.modeTab,
              { borderColor: theme.colors.border },
              mode === 'url' && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
            ]}
            onPress={() => setMode('url')}
          >
            <Ionicons
              name="link"
              size={16}
              color={mode === 'url' ? '#FFFFFF' : theme.colors.text}
            />
            <Text style={[styles.modeTabText, { color: mode === 'url' ? '#FFFFFF' : theme.colors.text }]}>
              Stream URL
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.modeTab,
              { borderColor: theme.colors.border },
              mode === 'rtmp' && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
            ]}
            onPress={() => setMode('rtmp')}
          >
            <Ionicons
              name="key"
              size={16}
              color={mode === 'rtmp' ? '#FFFFFF' : theme.colors.text}
            />
            <Text style={[styles.modeTabText, { color: mode === 'rtmp' ? '#FFFFFF' : theme.colors.text }]}>
              External App
            </Text>
          </TouchableOpacity>
        </View>

        {/* URL Mode Content */}
        {mode === 'url' && (
          <View style={styles.section}>
            <TextInput
              style={[styles.input, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
              placeholder="Stream URL (m3u8, Icecast, etc.)"
              placeholderTextColor={theme.colors.textSecondary}
              value={streamUrl}
              onChangeText={setStreamUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
        )}

        {/* RTMP Mode Content */}
        {mode === 'rtmp' && (
          <View style={styles.section}>
            {!rtmpUrl ? (
              <TouchableOpacity
                style={[styles.generateBtn, { backgroundColor: theme.colors.primary, opacity: generatingKey ? 0.6 : 1 }]}
                onPress={handleGenerateKey}
                disabled={generatingKey}
              >
                {generatingKey ? (
                  <ActivityIndicator size="small" color="#FFFFFF" />
                ) : (
                  <Ionicons name="key" size={18} color="#FFFFFF" />
                )}
                <Text style={styles.generateBtnText}>
                  {generatingKey ? 'Generating...' : 'Generate Stream Key'}
                </Text>
              </TouchableOpacity>
            ) : (
              <View style={styles.credentialsBox}>
                <Text style={[styles.credLabel, { color: theme.colors.textSecondary }]}>RTMP URL</Text>
                <View style={[styles.credRow, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                  <Text style={[styles.credValue, { color: theme.colors.text }]} numberOfLines={1}>
                    {rtmpUrl}
                  </Text>
                  <TouchableOpacity onPress={() => copyToClipboard(rtmpUrl, 'RTMP URL')} style={styles.copyBtn}>
                    <Ionicons name="copy" size={18} color={theme.colors.primary} />
                  </TouchableOpacity>
                </View>

                <Text style={[styles.credLabel, { color: theme.colors.textSecondary, marginTop: 12 }]}>Stream Key</Text>
                <View style={[styles.credRow, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                  <Text style={[styles.credValue, { color: theme.colors.text }]} numberOfLines={1}>
                    {streamKey}
                  </Text>
                  <TouchableOpacity onPress={() => copyToClipboard(streamKey!, 'Stream key')} style={styles.copyBtn}>
                    <Ionicons name="copy" size={18} color={theme.colors.primary} />
                  </TouchableOpacity>
                </View>

                <View style={styles.infoRow}>
                  <Ionicons name="information-circle" size={16} color={theme.colors.textSecondary} />
                  <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
                    Use these in OBS or your streaming app. Audio will play in the space once you start streaming.
                  </Text>
                </View>
              </View>
            )}
          </View>
        )}

        {/* Shared Metadata */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
            Stream Info (optional)
          </Text>

          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
            placeholder="Title"
            placeholderTextColor={theme.colors.textSecondary}
            value={title}
            onChangeText={setTitle}
            maxLength={200}
          />

          <TouchableOpacity
            style={[styles.imagePicker, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
            onPress={handlePickImage}
            disabled={uploadingImage}
          >
            {imagePreviewUri ? (
              <Image source={{ uri: imagePreviewUri }} style={styles.imagePreview} />
            ) : (
              <View style={styles.imagePickerPlaceholder}>
                <Ionicons name="image" size={24} color={theme.colors.textSecondary} />
                <Text style={[styles.imagePickerText, { color: theme.colors.textSecondary }]}>
                  Cover image
                </Text>
              </View>
            )}
            {uploadingImage && (
              <View style={styles.imageOverlay}>
                <ActivityIndicator size="small" color="#FFFFFF" />
              </View>
            )}
          </TouchableOpacity>

          <TextInput
            style={[styles.input, styles.inputMultiline, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, color: theme.colors.text }]}
            placeholder="Description"
            placeholderTextColor={theme.colors.textSecondary}
            value={description}
            onChangeText={setDescription}
            maxLength={500}
            multiline
            numberOfLines={2}
          />
        </View>

        {/* Action buttons */}
        <View style={styles.footer}>
          {mode === 'url' && (
            <TouchableOpacity
              style={[
                styles.startBtn,
                {
                  backgroundColor: streamUrl.trim() ? theme.colors.primary : theme.colors.backgroundSecondary,
                  opacity: loading ? 0.6 : 1,
                },
              ]}
              onPress={handleStartUrlStream}
              disabled={!streamUrl.trim() || loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons
                  name="play"
                  size={18}
                  color={streamUrl.trim() ? '#FFFFFF' : theme.colors.textSecondary}
                />
              )}
              <Text style={{ color: streamUrl.trim() ? '#FFFFFF' : theme.colors.textSecondary, fontWeight: '600', fontSize: 16 }}>
                Start Stream
              </Text>
            </TouchableOpacity>
          )}

          {mode === 'rtmp' && rtmpUrl && (
            <TouchableOpacity
              style={[styles.startBtn, { backgroundColor: theme.colors.primary, opacity: loading ? 0.6 : 1 }]}
              onPress={handleUpdateMetadata}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <Ionicons name="save" size={18} color="#FFFFFF" />
              )}
              <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 16 }}>
                Save Stream Info
              </Text>
            </TouchableOpacity>
          )}
        </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  closeBtn: {
    width: 40,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '600',
  },
  modeSelector: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 8,
  },
  modeTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  modeTabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  section: {
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 10,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  inputMultiline: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  imagePicker: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
    height: 100,
  },
  imagePreview: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  imagePickerPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  imagePickerText: {
    fontSize: 13,
    fontWeight: '500',
  },
  imageOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  generateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 10,
  },
  generateBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  credentialsBox: {
    gap: 4,
  },
  credLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  credRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
  },
  credValue: {
    flex: 1,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  copyBtn: {
    padding: 10,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 10,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 40,
  },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
});
