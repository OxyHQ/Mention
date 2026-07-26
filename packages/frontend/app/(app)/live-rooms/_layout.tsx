import { Slot } from 'expo-router';
import { useRequestLiveFeatureRuntime } from '@/components/providers/LiveFeatureProviders';

export default function LiveRoomsLayout() {
  useRequestLiveFeatureRuntime();
  return <Slot />;
}
