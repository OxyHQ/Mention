import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView, ActivityIndicator, Image } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { colors as baseColors } from '@/styles/colors';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useOxy } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';

const COLOR_CHOICES = ['#005c67', '#1D9BF0', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#0EA5E9'];

export default function AppearanceSettingsScreen() {
  // Use selectors to only subscribe to the parts we need
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loading = useAppearanceStore((state) => state.loading);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const { showBottomSheet, oxyServices } = useOxy();
  const theme = useTheme();

  const [themeMode, setThemeMode] = useState<'light' | 'dark' | 'system'>('system');
  const [primaryColor, setPrimaryColor] = useState<string>('');
  const [headerImageId, setHeaderImageId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      setThemeMode(mySettings.appearance?.themeMode || 'system');
      setPrimaryColor(mySettings.appearance?.primaryColor || '');
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings]);

  const previewPrimaryColor = useMemo(() => primaryColor || baseColors.primaryColor, [primaryColor]);

  const onSave = async () => {
    setSaving(true);
    await updateMySettings({
      appearance: { themeMode, primaryColor: primaryColor || undefined },
      profileHeaderImage: headerImageId || undefined,
    } as any);
    setSaving(false);
  };

  // Immediately save theme mode changes for instant feedback
  const onThemeModeChange = async (mode: 'light' | 'dark' | 'system') => {
    setThemeMode(mode);
    // Save immediately so theme changes right away
    // Only update appearance settings, not other fields
    await updateMySettings({
      appearance: { themeMode: mode, primaryColor: primaryColor || undefined },
    } as any);
  };

  const openHeaderPicker = () => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: any) => {
          if (!file?.contentType?.startsWith?.('image/')) return;
          setHeaderImageId(file.id);
        },
      }
    });
  };

  return (
    <ThemedView style={styles.container}>
      <Header 
        options={{ 
          title: 'Appearance', 
          leftComponents: [
            <HeaderIconButton
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }} 
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Theme mode */}
        <Text style={[styles.label, { color: theme.colors.text }]}>Theme</Text>
        <View style={styles.segmentRow}>
          {(['system', 'light', 'dark'] as const).map(mode => (
            <TouchableOpacity key={mode} style={[styles.segmentBtn, { borderColor: theme.colors.border, backgroundColor: theme.colors.background }, themeMode === mode && [styles.segmentBtnActive, { borderColor: previewPrimaryColor }]]} onPress={() => onThemeModeChange(mode)}>
              <Text style={[styles.segmentText, { color: theme.colors.textSecondary }, themeMode === mode && { color: previewPrimaryColor }]}>
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Primary color */}
        <Text style={[styles.label, { color: theme.colors.text }]}>Primary Color</Text>
        <View style={styles.colorsRow}>
          {COLOR_CHOICES.map(c => (
            <TouchableOpacity key={c} style={[styles.colorSwatch, { backgroundColor: c, borderColor: theme.colors.border }, primaryColor === c && { borderColor: theme.colors.text }]} onPress={() => setPrimaryColor(c)} />
          ))}
        </View>
        <View style={styles.inputRow}>
          <TextInput
            placeholder="#005c67"
            placeholderTextColor={theme.colors.textTertiary}
            value={primaryColor}
            onChangeText={setPrimaryColor}
            style={[styles.textInput, { borderColor: theme.colors.border, color: theme.colors.text, backgroundColor: theme.colors.background }]}
            autoCapitalize="none"
          />
          {primaryColor ? (
            <TouchableOpacity style={[styles.clearBtn, { backgroundColor: theme.colors.textTertiary }]} onPress={() => setPrimaryColor('')}>
              <Ionicons name="close" size={18} color={theme.colors.card} />
            </TouchableOpacity>
          ) : null}
        </View>

        {/* Header image selector */}
        <Text style={[styles.label, { color: theme.colors.text }]}>Profile Header Image</Text>
        {headerImageId ? (
          <View style={[styles.headerPreviewWrap, { borderColor: theme.colors.border }]}>
            <Image source={{ uri: oxyServices.getFileDownloadUrl(headerImageId, 'full') }} style={[styles.headerPreview, { backgroundColor: theme.colors.backgroundSecondary }]} />
            <TouchableOpacity style={[styles.clearBtn, { backgroundColor: theme.colors.textTertiary }]} onPress={() => setHeaderImageId('')}>
              <Ionicons name="close" size={18} color={theme.colors.card} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={[styles.mediaPickerBtn, { borderColor: theme.colors.border, backgroundColor: theme.colors.background }]} onPress={openHeaderPicker}>
            <Ionicons name="image-outline" size={18} color={theme.colors.textTertiary} />
            <Text style={[styles.mediaPickerText, { color: theme.colors.textSecondary }]}>Choose header image</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={[styles.saveBtn, { backgroundColor: previewPrimaryColor }]} onPress={onSave} disabled={saving || loading}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>Save</Text>}
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
  label: { fontSize: 16, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  segmentRow: { flexDirection: 'row', gap: 8 },
  segmentBtn: { flex: 1, paddingVertical: 10, borderWidth: 1, borderRadius: 10, alignItems: 'center' },
  segmentBtnActive: {},
  segmentText: { fontWeight: '600' },
  colorsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorSwatch: { width: 32, height: 32, borderRadius: 16, borderWidth: 2 },
  colorSwatchSelected: {},
  inputRow: { flexDirection: 'row', alignItems: 'center' },
  textInput: { flex: 1, borderWidth: 1, borderRadius: 10, padding: 12 },
  clearBtn: { marginLeft: 8, width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  saveBtn: { marginTop: 24, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  saveText: { color: '#fff', fontWeight: '700' },
  mediaPickerBtn: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 12, borderRadius: 10 },
  mediaPickerText: { fontWeight: '600' },
  headerPreviewWrap: { position: 'relative', borderWidth: 1, borderRadius: 10, overflow: 'hidden' },
  headerPreview: { width: '100%', height: 140 },
});
