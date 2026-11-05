import { WelcomeScreen } from '@/components/welcome/WelcomeScreen';

/** `/welcome` — the first-run flow. Reached on purpose, never by a redirect. */
export default function WelcomeRoute() {
  return <WelcomeScreen />;
}
