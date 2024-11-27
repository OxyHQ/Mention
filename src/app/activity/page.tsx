import { Activity } from "@/features/activity";
import { ActivityHeader, Header } from "@/features/header";

const ActivityPage = () => {
  return (
    <div>
      <ActivityHeader />
      <Activity />
    </div>
  );
};

export default ActivityPage;

export const metadata = {
  title: "Activity",
  description: "The latest stories on Mention - as told by Posts.",
};
