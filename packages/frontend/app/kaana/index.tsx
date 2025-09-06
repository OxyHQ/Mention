import { Ionicons } from '@expo/vector-icons';
import { useOxy } from "@oxyhq/services";
import React, { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import { shadowStyle } from '@/utils/platformStyles';

const KaanaClientPage = () => {
  const { user } = useOxy();
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
      <View style={styles.container}>

        {/* Main Content */}
        <View style={styles.mainContent}>
          <Text style={styles.title}>Hello, {user?.username || "Nate"}.</Text>
          <Text style={styles.subtitle}>How can I help you today?</Text>

          {/* Action Buttons */}
          <View style={styles.buttonGrid}>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.actionButton}>
                <Ionicons name="image-outline" size={22} color="#fff" />
                <Text style={styles.buttonText}>Editar imagen</Text>
                <View style={styles.dropdownIndicator}>
                  <Ionicons name="chevron-down" size={16} color="#fff" />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton}>
                <Ionicons name="newspaper-outline" size={22} color="#fff" />
                <Text style={styles.buttonText}>Noticias más recientes</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.actionButton}>
                <Ionicons name="person-outline" size={22} color="#fff" />
                <Text style={styles.buttonText}>Personalidades</Text>
                <View style={styles.dropdownIndicator}>
                  <Ionicons name="chevron-down" size={16} color="#fff" />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton}>
                <Ionicons name="briefcase-outline" size={22} color="#fff" />
                <Text style={styles.buttonText}>Áreas de trabajo</Text>
                <View style={styles.dropdownIndicator}>
                  <Ionicons name="chevron-down" size={16} color="#fff" />
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
          <View style={styles.inputBar}>
            <TouchableOpacity style={styles.inputIcon}>
              <Ionicons name="attach-outline" size={22} color="#aaa" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.inputIcon}>
              <Ionicons name="refresh-outline" size={22} color="#aaa" />
            </TouchableOpacity>
            <TouchableOpacity style={styles.inputIcon}>
              <Ionicons name="bulb-outline" size={22} color="#aaa" />
            </TouchableOpacity>

            <TextInput
              style={[styles.input, { height: inputHeight }]}
              placeholder="¿Qué quieres saber?"
              placeholderTextColor="#aaa"
              multiline
              value={inputText}
              onChangeText={handleTextChange}
              onContentSizeChange={handleContentSizeChange}
            />

            <View style={styles.inputRightButtons}>
              <TouchableOpacity style={styles.modelSelector}>
                <Text style={styles.modelText}>Kaana o1</Text>
                <Ionicons name="chevron-down" size={16} color="#fff" />
              </TouchableOpacity>
              <TouchableOpacity style={styles.sendButton}>
                <Ionicons name="arrow-up" size={22} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#1a1a1a',
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
  title: { fontSize: 32, fontWeight: '600', color: '#fff', textAlign: 'center', marginBottom: 8 },
  subtitle: { fontSize: 24, fontWeight: '400', color: '#a0a0a0', textAlign: 'center', marginBottom: 40 },
  buttonGrid: { width: '100%', maxWidth: 500 },
  buttonRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  actionButton: { flex: 1, flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(60, 60, 60, 0.5)', borderRadius: 30, padding: 16, marginHorizontal: 8, ...shadowStyle({ elevation: 3, web: '0px 2px 4px rgba(0,0,0,0.2)' }), position: 'relative' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '500', marginLeft: 8, flex: 1 },
  dropdownIndicator: { marginLeft: 4 },
  inputContainer: { width: '100%', padding: 16, backgroundColor: 'transparent', position: 'absolute', bottom: 0, left: 0, right: 0 },
  inputBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(40, 40, 40, 0.7)', borderRadius: 30, paddingHorizontal: 12, paddingVertical: 8 },
  inputIcon: { marginHorizontal: 8 },
  input: { flex: 1, fontSize: 16, color: '#fff', paddingHorizontal: 12, minHeight: 40, marginRight: 8 },
  inputRightButtons: { flexDirection: 'row', alignItems: 'center' },
  modelSelector: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(60, 60, 60, 0.5)', borderRadius: 20, paddingVertical: 6, paddingHorizontal: 12, marginRight: 8 },
  modelText: { color: '#fff', fontSize: 14, marginRight: 4 },
  sendButton: { backgroundColor: 'rgba(60, 60, 60, 0.8)', width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
});

export default KaanaClientPage;
