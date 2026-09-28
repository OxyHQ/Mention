import { Slot } from "expo-router";
import { View } from "react-native";
import { BootMilestone } from "@/components/BootMilestone";

export default function AuthLayout() {
  return (
    <View className="flex-1 bg-background">
      <Slot />
      <BootMilestone name="route-mounted" />
    </View>
  );
}
