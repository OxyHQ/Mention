/**
 * DEV ONLY: `@oxy.so/services/ui/client` as the proof screen sees it (see
 * `../fixture.ts`). `useAuth` is the fixture's. `OxyAuthPrompt` is a stand-in
 * that draws its two props: the real prompt's sign-in button needs a live
 * `<OxyProvider>` (a session, the network), and it is the services package's
 * code, the same under the TypeScript screen and the `.bloom` port; what the
 * screen owns is the label and description it passes.
 */
import { Text, VStack, toElement } from '@oxy.so/bloom-language';

export { useProofAuth as useAuth } from '../fixture';

export function OxyAuthPrompt({ label, description }: { label: string; description?: string }) {
  return toElement(
    VStack(Text(label).font('headline'), description ? Text(description).foreground('muted') : null)
      .spacing('sm')
      .padding('lg')
      .testID('proof-auth-prompt'),
  );
}
