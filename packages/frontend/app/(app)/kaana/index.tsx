import { Ionicons } from '@expo/vector-icons';
import { useAuth } from "@oxyhq/services";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { SafeAreaView } from 'react-native-safe-area-context';
import { shadowStyle } from '@/utils/platformStyles';
import { FONT_FAMILIES } from '@/styles/typography';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';

const KaanaClientPage = () => {
  const { user } = useAuth();
  const theme = useTheme();
  const [inputText, setInputText] = useState("");
  const [inputHeight, setInputHeight] = useState(40);

  const handleTextChange = (text: string) => {
    setInputText(text);
  };

  const handleContentSizeChange = (event: { nativeEvent: { contentSize: { height: number; }; }; }) => {
    const contentHeight = Math.max(40, event.nativeEvent.contentSize.height);
    if (inputHeight !== contentHeight) {
      setInputHeight(contentHeight);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" />
      <ThemedView style={styles.container}>

        {/* Main Content */}
        <View style={styles.mainContent}>
          <Text style={[styles.title, { color: theme.colors.text }]}>Hello, {user?.username || "Nate"}.</Text>
          <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>How can I help you today?</Text>

          {/* Action Buttons */}
          <View style={styles.buttonGrid}>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={[styles.actionButton, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="image-outline" size={22} color={theme.colors.text} />
                <Text style={[styles.buttonText, { color: theme.colors.text }]}>Editar imagen</Text>
                <View style={styles.dropdownIndicator}>
                  <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionButton, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="newspaper-outline" size={22} color={theme.colors.text} />
                <Text style={[styles.buttonText, { color: theme.colors.text }]}>Noticias más recientes</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={[styles.actionButton, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="person-outline" size={22} color={theme.colors.text} />
                <Text style={[styles.buttonText, { color: theme.colors.text }]}>Personalidades</Text>
                <View style={styles.dropdownIndicator}>
                  <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionButton, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Ionicons name="briefcase-outline" size={22} color={theme.colors.text} />
                <Text style={[styles.buttonText, { color: theme.colors.text }]}>Áreas de trabajo</Text>
                <View style={styles.dropdownIndicator}>
                  <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Input Area at Bottom */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.inputContainer}
        >
          <View style={[styles.inputBar, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <TouchableOpacity style={styles.inputIcon}>
              <Ionicons name="attach-outline" size={22} color={theme.colors.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.inputIcon}>
              <Ionicons name="refresh-outline" size={22} color={theme.colors.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity style={styles.inputIcon}>
              <Ionicons name="bulb-outline" size={22} color={theme.colors.textTertiary} />
            </TouchableOpacity>

            <TextInput
              style={[styles.input, { height: inputHeight, color: theme.colors.text }]}
              placeholder="¿Qué quieres saber?"
              placeholderTextColor={theme.colors.textTertiary}
              multiline
              value={inputText}
              onChangeText={handleTextChange}
              onContentSizeChange={handleContentSizeChange}
            />

            <View style={styles.inputRightButtons}>
              <TouchableOpacity style={[styles.modelSelector, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <Text style={[styles.modelText, { color: theme.colors.text }]}>Kaana o1</Text>
                <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
              </TouchableOpacity>
              <TouchableOpacity style={[styles.sendButton, { backgroundColor: theme.colors.primary }]}>
                <Ionicons name="arrow-up" size={22} color={theme.colors.card} />
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </ThemedView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    borderRadius: 35,
  },
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8 },
  logoContainer: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  logo: { width: 24, height: 24 },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  iconButton: { marginLeft: 20 },
  avatarContainer: { marginLeft: 20, width: 36, height: 36, borderRadius: 18, overflow: 'hidden' },
  avatar: { width: 36, height: 36 },
  mainContent: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 },
  title: { fontSize: 32, fontWeight: '600', textAlign: 'center', marginBottom: 8, fontFamily: FONT_FAMILIES.primary },
  subtitle: { fontSize: 24, fontWeight: '400', textAlign: 'center', marginBottom: 40, fontFamily: FONT_FAMILIES.primary },
  buttonGrid: { width: '100%', maxWidth: 500 },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  actionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', borderRadius: 30, padding: 16, marginHorizontal: 8, ...shadowStyle({ elevation: 3, web: '0px 2px 4px rgba(0,0,0,0.2)' }), position: 'relative' },
  buttonText: { fontSize: 15, fontWeight: '500', marginLeft: 8, flex: 1, fontFamily: FONT_FAMILIES.primary },
  dropdownIndicator: { marginLeft: 4 },
  inputContainer: { width: '100%', padding: 16, backgroundColor: 'transparent', position: 'absolute', bottom: 0, left: 0, right: 0 },
  inputBar: { flexDirection: 'row', alignItems: 'center', borderRadius: 30, paddingHorizontal: 12, paddingVertical: 8 },
  inputIcon: { marginHorizontal: 8 },
  input: { flex: 1, fontSize: 16, paddingHorizontal: 12, minHeight: 40, marginRight: 8, fontFamily: FONT_FAMILIES.primary },
  inputRightButtons: { flexDirection: 'row', alignItems: 'center' },
  modelSelector: { flexDirection: 'row', alignItems: 'center', borderRadius: 20, paddingVertical: 6, paddingHorizontal: 12, marginRight: 8 },
  modelText: { fontSize: 14, marginRight: 4, fontFamily: FONT_FAMILIES.primary },
  sendButton: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
});

export default KaanaClientPage;
