import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Image,
  ActivityIndicator,
  Platform,
  ScrollView,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as ImagePicker from 'expo-image-picker';

import { useAgoraConfig } from '../context/AgoraConfigContext';
import { PanelHeader } from './PanelHeader';

interface StreamConfigPanelProps {
  roomId: string;
  roomStatus?: string;
  initialRtmpUrl?: string;
  initialStreamKey?: string;
  onClose: () => void;
  onStreamStarted: () => void;
}

type StreamMode = 'url' | 'rtmp';

export function StreamConfigPanel({ roomId, roomStatus, initialRtmpUrl, initialStreamKey, onClose, onStreamStarted }: StreamConfigPanelProps) {
  const { useTheme, agoraService, toast, onRoomChanged } = useAgoraConfig();
  const theme = useTheme();

  const hasExistingKey = !!(initialStreamKey);
  const [mode, setMode] = useState<StreamMode>(hasExistingKey ? 'rtmp' : 'url');
  const [loading, setLoading] = useState(false);

  const [streamUrl, setStreamUrl] = useState('');

  const [rtmpUrl, setRtmpUrl] = useState<string | null>(initialRtmpUrl || null);
  const [streamKey, setStreamKey] = useState<string | null>(initialStreamKey || null);
  const [generatingKey, setGeneratingKey] = useState(false);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [imageCdnUrl, setImageCdnUrl] = useState<string | null>(null);
  const [imagePreviewUri, setImagePreviewUri] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const resetState = () => {
    setStreamUrl('');
    setRtmpUrl(null);
    setStreamKey(null);
    setTitle('');
    setDescription('');
    setImageCdnUrl(null);
    setImagePreviewUri(null);
    setMode('url');
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
        const formData = new FormData();
        if (Platform.OS === 'web') {
          const response = await fetch(asset.uri);
          const blob = await response.blob();
          formData.append('file', new File([blob], 'stream-cover.jpg', { type: asset.mimeType || 'image/jpeg' }));
        } else {
          formData.append('file', {
            uri: asset.uri,
            name: 'stream-cover.jpg',
            type: asset.mimeType || 'image/jpeg',
          } as any);
        }

        const cdnUrl = await agoraService.uploadRoomImage(roomId, formData);
        if (cdnUrl) {
          setImageCdnUrl(cdnUrl);
        } else {
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

  const ensureRoomLive = async (): Promise<boolean> => {
    if (roomStatus === 'live') return true;
    if (roomStatus === 'scheduled') {
      const started = await agoraService.startRoom(roomId);
      if (!started) {
        toast.error('Failed to start room');
        return false;
      }
      onRoomChanged?.(roomId);
      return true;
    }
    toast.error('Room cannot be started');
    return false;
  };

  const handleStartUrlStream = async () => {
    if (!streamUrl.trim() || loading) return;
    setLoading(true);
    try {
      if (!(await ensureRoomLive())) return;
      const result = await agoraService.startStream(roomId, {
        url: streamUrl.trim(),
        title: title.trim() || undefined,
        image: imageCdnUrl || undefined,
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

  const generatingRef = useRef(false);

  const generateKey = async () => {
    if (generatingRef.current) return;
    generatingRef.current = true;
    setGeneratingKey(true);
    try {
      if (!(await ensureRoomLive())) return;
      const result = await agoraService.generateStreamKey(roomId, {
        title: title.trim() || undefined,
        image: imageCdnUrl || undefined,
        description: description.trim() || undefined,
      });
      if (result?.streamKey) {
        setRtmpUrl(result.rtmpUrl || '');
        setStreamKey(result.streamKey);
      } else {
        console.error('Generate stream key response:', JSON.stringify(result, null, 2));
        toast.error('Failed to generate stream key');
      }
    } catch (err: unknown) {
      console.error('Generate stream key error:', err);
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast.error(`Stream key error: ${msg}`);
    } finally {
      setGeneratingKey(false);
      generatingRef.current = false;
    }
  };

  // Auto-generate RTMP credentials when switching to the External App tab
  useEffect(() => {
    if (mode === 'rtmp' && !streamKey && !generatingRef.current) {
      generateKey();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleUpdateMetadata = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const success = await agoraService.updateStreamMetadata(roomId, {
        title: title.trim() || undefined,
        image: imageCdnUrl || undefined,
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
    <View style={styles.container}>
      <PanelHeader title="Stream Setup" theme={theme} onBack={onClose} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.modeSelector}>
          <TouchableOpacity
            style={[
              styles.modeTab,
              { borderColor: theme.colors.border },
              mode === 'url' && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary },
            ]}
            onPress={() => setMode('url')}
          >
            <MaterialCommunityIcons name="link" size={16} color={mode === 'url' ? '#FFFFFF' : theme.colors.text} />
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
            <MaterialCommunityIcons name="key" size={16} color={mode === 'rtmp' ? '#FFFFFF' : theme.colors.text} />
            <Text style={[styles.modeTabText, { color: mode === 'rtmp' ? '#FFFFFF' : theme.colors.text }]}>
              External App
            </Text>
          </TouchableOpacity>
        </View>

        {mode === 'url' && (
          <View style={styles.section}>
            <TextInput
              style={[styles.input, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border, color: theme.colors.text }]}
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

        {mode === 'rtmp' && (
          <View style={styles.section}>
            {!streamKey ? (
              <View style={styles.loadingBox}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
                  Generating stream key...
                </Text>
              </View>
            ) : (
              <View style={styles.credentialsBox}>
                <Text style={[styles.credLabel, { color: theme.colors.textSecondary }]}>RTMP URL</Text>
                <View style={[styles.credRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
                  <Text style={[styles.credValue, { color: theme.colors.text }]} numberOfLines={1}>
                    {rtmpUrl}
                  </Text>
                  <TouchableOpacity onPress={() => copyToClipboard(rtmpUrl ?? '', 'RTMP URL')} style={styles.copyBtn}>
                    <MaterialCommunityIcons name="content-copy" size={18} color={theme.colors.primary} />
                  </TouchableOpacity>
                </View>

                <Text style={[styles.credLabel, { color: theme.colors.textSecondary, marginTop: 12 }]}>Stream Key</Text>
                <View style={[styles.credRow, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}>
                  <Text style={[styles.credValue, { color: theme.colors.text }]} numberOfLines={1}>
                    {streamKey}
                  </Text>
                  <TouchableOpacity onPress={() => copyToClipboard(streamKey!, 'Stream key')} style={styles.copyBtn}>
                    <MaterialCommunityIcons name="content-copy" size={18} color={theme.colors.primary} />
                  </TouchableOpacity>
                </View>

                <View style={styles.infoRow}>
                  <MaterialCommunityIcons name="information" size={16} color={theme.colors.textSecondary} />
                  <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
                    Use these in OBS or your streaming app. Audio will play in the room once you start streaming.
                  </Text>
                </View>

                <TouchableOpacity
                  style={styles.regenerateBtn}
                  onPress={() => {
                    setStreamKey(null);
                    setRtmpUrl(null);
                    generateKey();
                  }}
                  disabled={generatingKey}
                >
                  <MaterialCommunityIcons name="refresh" size={16} color={theme.colors.textSecondary} />
                  <Text style={[styles.regenerateText, { color: theme.colors.textSecondary }]}>
                    Regenerate key
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
            Stream Info (optional)
          </Text>

          <TextInput
            style={[styles.input, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border, color: theme.colors.text }]}
            placeholder="Title"
            placeholderTextColor={theme.colors.textSecondary}
            value={title}
            onChangeText={setTitle}
            maxLength={200}
          />

          <TouchableOpacity
            style={[styles.imagePicker, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border }]}
            onPress={handlePickImage}
            disabled={uploadingImage}
          >
            {imagePreviewUri ? (
              <Image source={{ uri: imagePreviewUri }} style={styles.imagePreview} />
            ) : (
              <View style={styles.imagePickerPlaceholder}>
                <MaterialCommunityIcons name="image" size={24} color={theme.colors.textSecondary} />
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
            style={[styles.input, styles.inputMultiline, { backgroundColor: `${theme.colors.card}80`, borderColor: theme.colors.border, color: theme.colors.text }]}
            placeholder="Description"
            placeholderTextColor={theme.colors.textSecondary}
            value={description}
            onChangeText={setDescription}
            maxLength={500}
            multiline
            numberOfLines={2}
          />
        </View>

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
                <MaterialCommunityIcons
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

          {mode === 'rtmp' && streamKey && (
            <TouchableOpacity
              style={[styles.startBtn, { backgroundColor: theme.colors.primary, opacity: loading ? 0.6 : 1 }]}
              onPress={handleUpdateMetadata}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#FFFFFF" />
              ) : (
                <MaterialCommunityIcons name="content-save" size={18} color="#FFFFFF" />
              )}
              <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 16 }}>
                Save Stream Info
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
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
  modeTabText: { fontSize: 14, fontWeight: '600' },
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
  inputMultiline: { minHeight: 60, textAlignVertical: 'top' },
  imagePicker: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
    height: 100,
  },
  imagePreview: { width: '100%', height: '100%', resizeMode: 'cover' },
  imagePickerPlaceholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  imagePickerText: { fontSize: 13, fontWeight: '500' },
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
  generateBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  loadingBox: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: 24,
  },
  loadingText: { fontSize: 14 },
  credentialsBox: { gap: 4 },
  regenerateBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 12,
    paddingVertical: 8,
  },
  regenerateText: { fontSize: 13, fontWeight: '500' },
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
  copyBtn: { padding: 10 },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 10,
  },
  infoText: { flex: 1, fontSize: 13, lineHeight: 18 },
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
