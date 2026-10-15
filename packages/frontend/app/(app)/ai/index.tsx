import { AliaChatScreen } from '@alia.onl/sdk';
import { VoiceSession } from '@alia.onl/sdk/voice';
import { Button } from '@oxy.so/bloom/button';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { useTranslation } from 'react-i18next';

import { useSafeBack } from '@/hooks/useSafeBack';

/**
 * The Alia chat, full screen. The shell draws no bottom bar here
 * (`components/shell/bottomBarRoutes.ts`), so the chat's own Back is how a
 * reader leaves on a device with no system back gesture. The greeting (by
 * name) and the 3D avatar are the SDK's own.
 */
export default function AiScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  return (
    <AliaChatScreen
      voiceSession={VoiceSession}
      headerLeft={
        <Button
          appearance="plain"
          tone="neutral"
          size="md"
          icon={RiArrowLeftLine}
          accessibilityLabel={t('common.back', { defaultValue: 'Back' })}
          onPress={() => safeBack()}
        />
      }
      welcomeSubtitle={t('How can I help you today?')}
      welcomeSuggestions={[
        { id: 'latest-news', text: t('What are the latest news?') },
        { id: 'edit-image', text: t('Help me edit an image') },
      ]}
    />
  );
}
