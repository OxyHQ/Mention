import { SupervisedFeatureGate } from '@/components/SupervisedFeatureGate';
import { FeedBuilder } from '@/components/feeds/FeedBuilder';

function NewFeedScreen() {
  return <FeedBuilder />;
}

export default function AvailableNewFeedScreen() {
  return (
    <SupervisedFeatureGate>
      <NewFeedScreen />
    </SupervisedFeatureGate>
  );
}
