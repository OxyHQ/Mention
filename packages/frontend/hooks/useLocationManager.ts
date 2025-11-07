import { useState } from "react";
import * as Location from "expo-location";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

export interface LocationData {
  latitude: number;
  longitude: number;
  address?: string;
}

export const useLocationManager = () => {
  const { t } = useTranslation();
  const [location, setLocation] = useState<LocationData | null>(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);

  const requestLocation = async () => {
    setIsGettingLocation(true);
    try {
      // Request permissions
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        toast.error(t("Location permission denied"));
        return;
      }

      // Get current position
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      // Reverse geocode to get address
      const reverseGeocode = await Location.reverseGeocodeAsync({
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
      });

      const address = reverseGeocode[0];
      const locationData: LocationData = {
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
        address: address
          ? `${address.city || address.subregion || ""}, ${address.region || ""}`
          : `${currentLocation.coords.latitude.toFixed(4)}, ${currentLocation.coords.longitude.toFixed(4)}`,
      };

      setLocation(locationData);
      toast.success(t("Location added"));
    } catch (error) {
      console.error("Error getting location:", error);
      toast.error(t("Failed to get location"));
    } finally {
      setIsGettingLocation(false);
    }
  };

  const removeLocation = () => {
    setLocation(null);
    toast.success(t("Location removed"));
  };

  return {
    location,
    setLocation,
    isGettingLocation,
    requestLocation,
    removeLocation,
  };
};
