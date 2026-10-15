import type React from 'react';
import { useEffect, useRef } from 'react';
import { AliaChatSheet, type AliaChatSheetRef } from '@alia.onl/sdk';
import { VoiceSession } from '@alia.onl/sdk/voice';

interface AskAliaSheetProps {
  /** Bumped on every press of Ask Alia; each change presents the sheet. */
  presentSignal: number;
  clientContext: string;
  welcomeSuggestions: { id: string; text: string }[];
}

/**
 * The Alia chat sheet, in its own module so `AskAliaProvider` can load the SDK
 * lazily instead of shipping it in the entry bundle. It mounts on the first
 * press, so the first `present()` runs as soon as the sheet is ready.
 */
const AskAliaSheet: React.FC<AskAliaSheetProps> = ({
  presentSignal,
  clientContext,
  welcomeSuggestions,
}) => {
  const ref = useRef<AliaChatSheetRef>(null);

  useEffect(() => {
    if (presentSignal > 0) ref.current?.present();
  }, [presentSignal]);

  return (
    <AliaChatSheet
      ref={ref}
      voiceSession={VoiceSession}
      clientContext={clientContext}
      welcomeSuggestions={welcomeSuggestions}
    />
  );
};

export default AskAliaSheet;
