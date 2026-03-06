import { Slot } from "expo-router";
import { View, StyleSheet } from "react-native";
import { useTheme } from '@/hooks/useTheme';

export default function AuthLayout() {
  const theme = useTheme();

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Slot />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
