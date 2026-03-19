import { useState } from "react";
import * as Location from "expo-location";
import { useTranslation } from "react-i18next";
import { show as toast } from '@oxyhq/bloom/toast';
import { logger } from '@/lib/logger';

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
        toast(t("Location permission denied"), { type: 'error' });
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
      toast(t("Location added"), { type: 'success' });
    } catch (error) {
      logger.error("Error getting location", { error });
      toast(t("Failed to get location"), { type: 'error' });
    } finally {
      setIsGettingLocation(false);
    }
  };

  const removeLocation = () => {
    setLocation(null);
    toast(t("Location removed"), { type: 'success' });
  };

  return {
    location,
    setLocation,
    isGettingLocation,
    requestLocation,
    removeLocation,
  };
};
