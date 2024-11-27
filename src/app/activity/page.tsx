import { Activity } from "@/features/activity";
import { ActivityHeader } from "@/features/header";

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
  description: "",
};
