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
    <SafeAreaView className="flex-1 rounded-[35px]">
      <StatusBar barStyle="light-content" />
      <ThemedView className="flex-1">

        {/* Main Content */}
        <View className="flex-1 justify-center items-center px-5">
          <Text className="text-[32px] font-semibold text-center mb-2 text-foreground font-primary">Hello, {user?.username || "Nate"}.</Text>
          <Text className="text-2xl font-normal text-center mb-10 text-muted-foreground font-primary">How can I help you today?</Text>

          {/* Action Buttons */}
          <View className="w-full max-w-[500px]">
            <View className="flex-row justify-between mb-4">
              <TouchableOpacity style={styles.actionButton} className="flex-1 flex-row items-center rounded-[30px] p-4 mx-2 bg-secondary relative">
                <Ionicons name="image-outline" size={22} color={theme.colors.text} />
                <Text className="text-[15px] font-medium ml-2 flex-1 text-foreground font-primary">Editar imagen</Text>
                <View className="ml-1">
                  <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} className="flex-1 flex-row items-center rounded-[30px] p-4 mx-2 bg-secondary">
                <Ionicons name="newspaper-outline" size={22} color={theme.colors.text} />
                <Text className="text-[15px] font-medium ml-2 flex-1 text-foreground font-primary">Noticias más recientes</Text>
              </TouchableOpacity>
            </View>
            <View className="flex-row justify-between mb-4">
              <TouchableOpacity style={styles.actionButton} className="flex-1 flex-row items-center rounded-[30px] p-4 mx-2 bg-secondary relative">
                <Ionicons name="person-outline" size={22} color={theme.colors.text} />
                <Text className="text-[15px] font-medium ml-2 flex-1 text-foreground font-primary">Personalidades</Text>
                <View className="ml-1">
                  <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} className="flex-1 flex-row items-center rounded-[30px] p-4 mx-2 bg-secondary relative">
                <Ionicons name="briefcase-outline" size={22} color={theme.colors.text} />
                <Text className="text-[15px] font-medium ml-2 flex-1 text-foreground font-primary">Áreas de trabajo</Text>
                <View className="ml-1">
                  <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
                </View>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Input Area at Bottom */}
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          className="w-full p-4 absolute bottom-0 left-0 right-0"
        >
          <View className="flex-row items-center rounded-[30px] px-3 py-2 bg-secondary">
            <TouchableOpacity className="mx-2">
              <Ionicons name="attach-outline" size={22} color={theme.colors.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity className="mx-2">
              <Ionicons name="refresh-outline" size={22} color={theme.colors.textTertiary} />
            </TouchableOpacity>
            <TouchableOpacity className="mx-2">
              <Ionicons name="bulb-outline" size={22} color={theme.colors.textTertiary} />
            </TouchableOpacity>

            <TextInput
              style={{ height: inputHeight }}
              className="flex-1 text-base px-3 min-h-[40px] mr-2 text-foreground font-primary"
              placeholder="¿Qué quieres saber?"
              placeholderTextColor={theme.colors.textTertiary}
              multiline
              value={inputText}
              onChangeText={handleTextChange}
              onContentSizeChange={handleContentSizeChange}
            />

            <View className="flex-row items-center">
              <TouchableOpacity className="flex-row items-center rounded-[20px] py-1.5 px-3 mr-2 bg-secondary">
                <Text className="text-sm mr-1 text-foreground font-primary">Kaana o1</Text>
                <Ionicons name="chevron-down" size={16} color={theme.colors.text} />
              </TouchableOpacity>
              <TouchableOpacity className="w-10 h-10 rounded-full justify-center items-center bg-primary">
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
  actionButton: {
    ...shadowStyle({ elevation: 3, web: '0px 2px 4px rgba(0,0,0,0.2)' }),
  },
});

export default KaanaClientPage;
