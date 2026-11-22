import { Slot } from '@/lib/navigation/router';
import { BootMilestone } from '@/components/BootMilestone';
import { Embed, VStack, toElement } from '@oxy.so/bloom-language';

export default function AuthLayout() {
  return toElement(
    VStack(Embed(<Slot />), Embed(<BootMilestone name="route-mounted" />))
      .background('background')
      .flex('1'),
  );
}
