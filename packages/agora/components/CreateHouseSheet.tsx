import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Image,
  Platform,
  ActivityIndicator,
} from 'react-native';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as ImagePicker from 'expo-image-picker';
import { toast } from 'sonner-native';
import { useAuth } from '@oxyhq/services';

import { useTheme } from '@/hooks/useTheme';
import { useCreateHouse } from '@/hooks/useRoomsQuery';

const TOPICS = [
  'Technology',
  'Music',
  'Sports',
  'Gaming',
  'News',
  'Politics',
  'Science',
  'Art',
  'Business',
  'Education',
  'Entertainment',
  'Health',
  'Culture',
  'Crypto',
  'AI',
] as const;

interface CreateHouseSheetProps {
  onClose: () => void;
  onHouseCreated?: () => void;
}

export function CreateHouseSheet({ onClose, onHouseCreated }: CreateHouseSheetProps) {
  const theme = useTheme();
  const createHouse = useCreateHouse();
  const { oxyServices } = useAuth();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [isPublic, setIsPublic] = useState(true);

  const [imagePreviewUri, setImagePreviewUri] = useState<string | null>(null);
  const [imageFileId, setImageFileId] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);

  const isValid = name.trim().length > 0;
  const loading = createHouse.isPending;

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  const handlePickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        allowsEditing: true,
        aspect: [1, 1],
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      setImagePreviewUri(asset.uri);
      setUploadingImage(true);

      try {
        let file: File | Blob;

        if (Platform.OS === 'web') {
          const response = await fetch(asset.uri);
          const blob = await response.blob();
          file = new File([blob], 'house-avatar.jpg', { type: asset.mimeType || 'image/jpeg' });
        } else {
          const response = await fetch(asset.uri);
          file = await response.blob();
        }

        const uploadResponse = await oxyServices!.uploadRawFile(file, 'public');

        const fileId = uploadResponse?.file?.key || uploadResponse?.file?.id || uploadResponse?.id || uploadResponse?.fileId || uploadResponse?.data?.id;

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

  const handleCreate = async () => {
    if (!isValid || loading) return;

    try {
      const house = await createHouse.mutateAsync({
        name: name.trim(),
        description: description.trim() || undefined,
        avatar: imageFileId || undefined,
        tags: selectedTags.length > 0 ? selectedTags : undefined,
        isPublic,
      });

      if (house) {
        toast.success('House created!');
        onClose();
        onHouseCreated?.();
      } else {
        toast.error('Failed to create house');
      }
    } catch (error) {
      console.error('Error creating house:', error);
      toast.error('Failed to create house');
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={onClose} style={styles.headerCloseBtn}>
          <MaterialCommunityIcons name="close" size={20} color={theme.colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: theme.colors.text }]}>
          Create House
        </Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={[styles.scrollContent]}>
        {/* Avatar Picker */}
        <View style={styles.avatarSection}>
          <TouchableOpacity
            style={[styles.avatarPicker, { backgroundColor: theme.colors.backgroundSecondary }]}
            onPress={handlePickImage}
            activeOpacity={0.7}
            disabled={uploadingImage}
          >
            {imagePreviewUri ? (
              <Image source={{ uri: imagePreviewUri }} style={styles.avatarImage} />
            ) : (
              <MaterialCommunityIcons name="camera-plus" size={28} color={theme.colors.textSecondary} />
            )}
            {uploadingImage && (
              <View style={styles.avatarOverlay}>
                <ActivityIndicator size="small" color="#FFFFFF" />
              </View>
            )}
          </TouchableOpacity>
          <Text style={[styles.avatarHint, { color: theme.colors.textTertiary }]}>
            Add photo
          </Text>
        </View>

        {/* Name */}
        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Name *</Text>
          <TextInput
            style={[styles.input, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
            placeholder="Give your house a name"
            placeholderTextColor={theme.colors.textTertiary}
            value={name}
            onChangeText={setName}
            maxLength={50}
          />
          <Text style={[styles.charCount, { color: theme.colors.textTertiary }]}>
            {name.length}/50
          </Text>
        </View>

        {/* Description */}
        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Description</Text>
          <TextInput
            style={[styles.textArea, { backgroundColor: theme.colors.backgroundSecondary, color: theme.colors.text }]}
            placeholder="What is this house about?"
            placeholderTextColor={theme.colors.textTertiary}
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
            maxLength={300}
          />
          <Text style={[styles.charCount, { color: theme.colors.textTertiary }]}>
            {description.length}/300
          </Text>
        </View>

        {/* Tags */}
        <View style={styles.inputSection}>
          <Text style={[styles.label, styles.sectionPadded, { color: theme.colors.text }]}>Tags</Text>
          <View style={styles.chipWrap}>
            {TOPICS.map((tag) => {
              const selected = selectedTags.includes(tag);
              return (
                <TouchableOpacity
                  key={tag}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? theme.colors.primary : theme.colors.backgroundSecondary,
                    },
                  ]}
                  onPress={() => toggleTag(tag)}
                >
                  <Text style={[styles.chipText, { color: selected ? '#FFFFFF' : theme.colors.text }]}>
                    {tag}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* Public Toggle */}
        <View style={[styles.inputSection, styles.sectionPadded]}>
          <Text style={[styles.label, { color: theme.colors.text }]}>Visibility</Text>
          <TouchableOpacity
            style={[
              styles.toggleRow,
              { backgroundColor: theme.colors.backgroundSecondary, borderRadius: 12 },
            ]}
            onPress={() => setIsPublic((prev) => !prev)}
            activeOpacity={0.7}
          >
            <MaterialCommunityIcons
              name={isPublic ? 'earth' : 'lock'}
              size={18}
              color={isPublic ? theme.colors.primary : theme.colors.textSecondary}
            />
            <Text style={[styles.toggleLabel, { color: theme.colors.text }]}>
              {isPublic ? 'Public' : 'Private'}
            </Text>
            <View
              style={[
                styles.toggleTrack,
                { backgroundColor: isPublic ? theme.colors.primary : theme.colors.border },
              ]}
            >
              <View
                style={[
                  styles.toggleThumb,
                  {
                    backgroundColor: '#FFFFFF',
                    alignSelf: isPublic ? 'flex-end' : 'flex-start',
                  },
                ]}
              />
            </View>
          </TouchableOpacity>
        </View>
      </View>

      {/* Footer */}
      <View style={[styles.footer, { borderTopColor: theme.colors.border, backgroundColor: theme.colors.background }]}>
        <TouchableOpacity
          style={[
            styles.primaryButton,
            {
              backgroundColor: isValid ? theme.colors.primary : theme.colors.backgroundSecondary,
              opacity: loading ? 0.6 : 1,
            },
          ]}
          onPress={handleCreate}
          disabled={!isValid || loading}
        >
          <MaterialCommunityIcons
            name="home-group"
            size={20}
            color={isValid ? theme.colors.card : theme.colors.textSecondary}
          />
          <Text
            style={[styles.primaryButtonText, { color: isValid ? theme.colors.card : theme.colors.textSecondary }]}
          >
            {loading ? 'Creating...' : 'Create House'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 0.5,
  },
  headerCloseBtn: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  scrollContent: { paddingVertical: 16, paddingBottom: 12 },
  avatarSection: {
    alignItems: 'center',
    marginBottom: 20,
  },
  avatarPicker: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  avatarOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 40,
  },
  avatarHint: { fontSize: 12, marginTop: 6 },
  sectionPadded: { paddingHorizontal: 16 },
  inputSection: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6 },
  input: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
  },
  textArea: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 72,
    textAlignVertical: 'top',
  },
  charCount: { fontSize: 11, marginTop: 4 },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 16,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  chipText: { fontSize: 13, fontWeight: '500' },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toggleLabel: { fontSize: 14, flex: 1 },
  toggleTrack: {
    width: 40,
    height: 22,
    borderRadius: 11,
    padding: 2,
    justifyContent: 'center',
  },
  toggleThumb: {
    width: 18,
    height: 18,
    borderRadius: 9,
  },
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    borderTopWidth: 0.5,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 22,
    gap: 6,
  },
  primaryButtonText: { fontSize: 15, fontWeight: '600' },
});

export default CreateHouseSheet;
