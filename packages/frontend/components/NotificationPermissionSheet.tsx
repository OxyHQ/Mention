import React from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import { useTranslation } from "react-i18next";
import { colors } from "@/styles/colors";
import { ThemedView } from "@/components/ThemedView";
import { NoUpdatesIllustration } from "@/assets/illustrations/NoUpdates";
import { TouchableOpacity } from "react-native-gesture-handler";

interface Props {
  onEnable: () => void;
  onLater: () => void;
}

export const NotificationPermissionSheet: React.FC<Props> = ({ onEnable, onLater }) => {
  const { t } = useTranslation();

  return (
    <ThemedView style={styles.container}>
      <View style={styles.illustrationWrap}>
        <NoUpdatesIllustration width={140} height={140} />
      </View>
      <Text style={styles.title}>{t("permission.notifications.title")}</Text>
      <Text style={styles.subtitle}>
        {t("permission.notifications.subtitle")}
      </Text>
      <View style={styles.actions}>
        <TouchableOpacity onPress={onLater} style={[styles.button, styles.secondary]}> 
          <Text style={[styles.buttonText, styles.secondaryText]}>{t("permission.notifications.later")}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onEnable} style={[styles.button, styles.primary]}> 
          <Text style={[styles.buttonText, styles.primaryText]}>{t("permission.notifications.enable")}</Text>
        </TouchableOpacity>
      </View>
    </ThemedView>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  illustrationWrap: {
    alignItems: "center",
    justifyContent: "center",
    marginTop: 6,
    marginBottom: 10,
  },
  title: {
    fontSize: 18,
    fontWeight: Platform.OS === 'web' ? 'bold' : '600',
    textAlign: 'center',
    color: colors.COLOR_BLACK_LIGHT_1,
    marginBottom: 6,
  },
  subtitle: {
    fontSize: 14,
    textAlign: 'center',
    color: colors.COLOR_BLACK_LIGHT_4,
    marginHorizontal: 8,
  },
  actions: {
    marginTop: 14,
    gap: 10,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primary: {
    backgroundColor: colors.secondaryColor,
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.chatInputBorder,
  },
  buttonText: {
    fontSize: 15,
  },
  primaryText: {
    color: '#fff',
    fontWeight: Platform.OS === 'web' ? 'bold' : '600',
  },
  secondaryText: {
    color: colors.COLOR_BLACK_LIGHT_1,
  },
});

export default NotificationPermissionSheet;
