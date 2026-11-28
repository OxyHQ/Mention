import { useRef, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { MAX_POST_TEXT_LENGTH, PostVisibility } from '@mention/shared-types';
import { COMMUNITY_POST_TITLE_MAX_LENGTH } from '@mention/shared-types/community';
import { useMediaPicker } from '@/hooks/useMediaPicker';
import { useSupervisionState } from '@/hooks/useSupervisionState';
import { useRouter } from '@/lib/navigation/router';
import { usePostsStore } from '@/stores/postsStore';
import { normalizeApiError } from '@/utils/apiError';
import type { ComposerMediaItem } from '@/utils/composeUtils';

export default function VideoUploadRoute() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, canUsePrivateApi, showBottomSheet, signIn } = useAuth();
  const supervision = useSupervisionState();
  const { openMediaPicker } = useMediaPicker({ showBottomSheet, t });
  const createPost = usePostsStore((state) => state.createPost);
  const [draft, setDraft] = useState({ title: '', description: '' });
  const [asset, setAsset] = useState<ComposerMediaItem>();
  const [publishing, setPublishing] = useState(false);
  const busy = useRef(false);

  const publish = async () => {
    if (!asset || !draft.title.trim() || !canUsePrivateApi || !supervision.ready || busy.current)
      return;
    busy.current = true;
    setPublishing(true);
    try {
      const result = await createPost({
        visibility: supervision.supervised ? PostVisibility.PRIVATE : PostVisibility.PUBLIC,
        content: {
          title: draft.title.trim(),
          text: draft.description.trim(),
          media: [{ id: asset.id, type: 'video' }],
        },
      });
      router.replace({ pathname: '/watch/[id]', params: { id: result.id, mediaIndex: '0' } });
    } catch (error) {
      toast(normalizeApiError(error).message || t('common.error'), { type: 'error' });
    } finally {
      busy.current = false;
      setPublishing(false);
    }
  };

  return (
    <Screen
      scroll="auto"
      testID="video-upload-screen"
      header={
        <PageHeader
          title={t('videos.upload', { defaultValue: 'Upload video' })}
          onBack={() => (router.canGoBack() ? router.back() : router.replace('/videos'))}
        />
      }
    >
      <View className="gap-4 p-5">
        {user && canUsePrivateApi ? (
          <>
            <Text className="font-semibold text-foreground">
              {t('videos.uploadTitle', { defaultValue: 'Video title' })}
            </Text>
            <TextInput
              accessibilityLabel={t('videos.uploadTitle', { defaultValue: 'Video title' })}
              className="rounded-xl border border-border p-3 text-foreground"
              maxLength={COMMUNITY_POST_TITLE_MAX_LENGTH}
              editable={!publishing}
              value={draft.title}
              onChangeText={(title) => setDraft((current) => ({ ...current, title }))}
            />
            <Text className="font-semibold text-foreground">
              {t('videos.uploadDescription', { defaultValue: 'Description' })}
            </Text>
            <TextInput
              accessibilityLabel={t('videos.uploadDescription', { defaultValue: 'Description' })}
              className="min-h-[104px] rounded-xl border border-border p-3 text-foreground"
              maxLength={MAX_POST_TEXT_LENGTH}
              editable={!publishing}
              multiline
              textAlignVertical="top"
              value={draft.description}
              onChangeText={(description) => setDraft((current) => ({ ...current, description }))}
            />
            <Button
              appearance="outline"
              disabled={publishing}
              onPress={() => openMediaPicker((files) => setAsset(files[0]), { videoOnly: true })}
            >
              {asset
                ? t('videos.replaceFile', { defaultValue: 'Change video file' })
                : t('videos.chooseFile', { defaultValue: 'Choose video file' })}
            </Button>
            <Button
              tone="action"
              loading={publishing}
              disabled={!asset || !draft.title.trim() || !supervision.ready}
              onPress={() => void publish()}
            >
              {t('videos.publish', { defaultValue: 'Publish video' })}
            </Button>
          </>
        ) : (
          <Button onPress={() => void signIn().catch(() => {})}>
            {t('auth.banner.signIn')}
          </Button>
        )}
      </View>
    </Screen>
  );
}
