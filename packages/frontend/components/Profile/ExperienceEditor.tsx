import { experienceService } from '@/services/experienceService';
import { useState } from 'react';
import { ClarityError } from '@clarity.surf/sdk';
import { ScrollView } from 'react-native';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { TextField, TextFieldInput, TextFieldLabel } from '@oxy.so/bloom/text-field';
import { useTranslation } from 'react-i18next';
import {
  EXPERIENCE_EMPLOYMENT_TYPES,
  validateExperienceInput,
  type Experience,
  type ExperienceInput,
} from '@clarity.surf/sdk/experience';
import type { Organization, SafetyOrganizationIdentity } from '@oxy.so/contracts';
import { ExperienceEmployerField, alertText } from './ExperienceEmployerField';
import { confirmDialog } from '@/utils/alerts';

import {
  Button as LButton,
  Dialog as LDialog,
  Embed,
  HStack,
  RawText,
  Text as LText,
  Toggle,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function ExperienceEditor({
  entry,
  ownerId,
  employer,
  onClose,
  onSaved,
}: {
  entry?: Experience;
  ownerId: string;
  employer?: Organization | SafetyOrganizationIdentity;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  // Presented from the first render; a save or delete closes it with the session it
  // finished in, and `onSaved` runs once the dialog has left, if that session still holds.
  const [isPresented, setPresented] = useState(true);
  const [savedInEpoch, setSavedInEpoch] = useState<number | null>(null);
  const { user, canUsePrivateApi, oxyServices } = useAuth();
  const [ownerSessionEpoch] = useState(() => oxyServices.http.getSessionEpoch());
  const canEdit = user?.id === ownerId && canUsePrivateApi;
  const [draft, setDraft] = useState<ExperienceInput>(() => ({
    title: entry?.title ?? '',
    employerOxyAccountId: entry?.employerOxyAccountId ?? '',
    employmentType: entry?.employmentType ?? null,
    location: entry?.location ?? null,
    startDate: entry?.startDate ?? '',
    endDate: entry?.endDate ?? null,
    description: entry?.description ?? null,
  }));
  const [errors, setErrors] = useState<string[]>([]);
  const save = useMutation({
    mutationFn: ({ input, sessionEpoch }: { input: ExperienceInput; sessionEpoch: number }) => {
      if (!canEdit || oxyServices.http.getSessionEpoch() !== sessionEpoch)
        throw new Error('Experience owner session is not ready');
      return entry ? experienceService.update(entry.id, input) : experienceService.create(input);
    },
    onSuccess: (_result, { sessionEpoch }) => {
      if (oxyServices.http.getSessionEpoch() === sessionEpoch) closeSaved(sessionEpoch);
    },
  });
  const remove = useMutation({
    mutationFn: (sessionEpoch: number) => {
      if (!canEdit || !entry || oxyServices.http.getSessionEpoch() !== sessionEpoch)
        throw new Error('Experience owner session is not ready');
      return experienceService.remove(entry.id);
    },
    onSuccess: (_result, sessionEpoch) => {
      if (oxyServices.http.getSessionEpoch() === sessionEpoch) closeSaved(sessionEpoch);
    },
  });
  function closeSaved(sessionEpoch: number) {
    setSavedInEpoch(sessionEpoch);
    setPresented(false);
  }
  function dismissed() {
    if (savedInEpoch !== null && oxyServices.http.getSessionEpoch() === savedInEpoch) onSaved();
    onClose();
  }
  const busy = save.isPending || remove.isPending;
  function field<Key extends keyof ExperienceInput>(key: Key, value: ExperienceInput[Key]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setErrors((previous) => previous.filter((field) => field !== key));
    save.reset();
    remove.reset();
  }
  function submit() {
    if (busy || !canEdit || oxyServices.http.getSessionEpoch() !== ownerSessionEpoch) return;
    const result = validateExperienceInput(draft);
    if (!result.success) {
      setErrors(result.issues.map((issue) => String(issue.path[0])));
      return;
    }
    save.mutate({ input: result.data, sessionEpoch: ownerSessionEpoch });
  }
  async function deleteEntry() {
    if (!canEdit || busy || oxyServices.http.getSessionEpoch() !== ownerSessionEpoch) return;
    const confirmed = await confirmDialog({
      title: t('profile.experience.deleteTitle'),
      message: t('profile.experience.deleteDescription'),
      okText: t('common.delete', { defaultValue: 'Delete' }),
      cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
      destructive: true,
    });
    if (confirmed && oxyServices.http.getSessionEpoch() === ownerSessionEpoch)
      remove.mutate(ownerSessionEpoch);
  }
  function textField(
    key: 'title' | 'location' | 'startDate' | 'endDate' | 'description',
    maxLength: number,
  ) {
    const invalid = errors.includes(key);
    return toElement(
      VStack(
        Embed(<TextFieldLabel>{t(`profile.experience.fields.${key}`)}</TextFieldLabel>),
        Embed(
          <TextField invalid={invalid} disabled={busy}>
            <TextFieldInput
              label={t(`profile.experience.fields.${key}`)}
              value={draft[key] ?? ''}
              onChangeText={(value) =>
                field(
                  key,
                  (key === 'location' || key === 'description') && !value.trim() ? null : value,
                )
              }
              maxLength={maxLength}
              multiline={key === 'description'}
              autoCapitalize={key.endsWith('Date') ? 'none' : 'sentences'}
              placeholder={key.endsWith('Date') ? 'YYYY-MM' : undefined}
            />
          </TextField>,
        ),
        invalid ? alertText(t(`profile.experience.validation.${key}`)) : null,
      ).spacing('xs'),
    );
  }
  const employmentOptions = [
    { value: '', label: t('profile.experience.unspecified') },
    ...EXPERIENCE_EMPLOYMENT_TYPES.map((value) => ({
      value,
      label: t(`profile.experience.employment.${value}`),
    })),
  ];
  const title = t(entry ? 'profile.experience.edit' : 'profile.experience.add');
  return toElement(
    LDialog(
      Embed(
        <ScrollView
          keyboardShouldPersistTaps="handled"
          style={{ maxHeight: 560 }}
          contentContainerStyle={{ paddingBottom: 8 }}
        >
          {toElement(
            VStack(
              RawText(t('profile.experience.publicHint'))
                .foreground('muted')
                .font('14')
                .leading('20px'),
              Embed(textField('title', 200)),
              Embed(
                <ExperienceEmployerField
                  initialEmployer={employer}
                  value={draft.employerOxyAccountId}
                  disabled={busy || !canEdit}
                  invalid={errors.includes('employerOxyAccountId')}
                  onChange={(organization) =>
                    field('employerOxyAccountId', organization?.accountId ?? '')
                  }
                />,
              ),
              VStack(
                Embed(
                  <TextFieldLabel>{t('profile.experience.fields.employmentType')}</TextFieldLabel>,
                ),
                Embed(
                  <Select
                    value={draft.employmentType ?? ''}
                    disabled={busy}
                    onValueChange={(value) =>
                      field(
                        'employmentType',
                        value
                          ? (EXPERIENCE_EMPLOYMENT_TYPES.find((type) => type === value) ?? null)
                          : null,
                      )
                    }
                  >
                    <SelectTrigger label={t('profile.experience.fields.employmentType')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent
                      items={employmentOptions}
                      renderItem={(option) => (
                        <SelectItem value={option.value} label={option.label}>
                          <SelectItemText>{option.label}</SelectItemText>
                        </SelectItem>
                      )}
                    />
                  </Select>,
                ),
              ).spacing('xs'),
              Embed(textField('location', 300)),
              Embed(textField('startDate', 7)),
              HStack(
                RawText(t('profile.experience.current'))
                  .foreground('foreground')
                  .font('16')
                  .leading('normal')
                  .flex('1'),
                Toggle([draft.endDate === null, (current) => field('endDate', current ? null : '')])
                  .label(t('profile.experience.current'))
                  .disabled(busy),
              )
                .align('center')
                .justify('between')
                .spacing('md'),
              Embed(draft.endDate !== null ? textField('endDate', 7) : null),
              RawText(t('profile.experience.dateHint'))
                .foreground('muted')
                .font('14')
                .leading('20px'),
              Embed(textField('description', 5000)),
              save.isError || remove.isError
                ? alertText(
                    t(
                      remove.isError
                        ? 'profile.experience.deleteError'
                        : save.error instanceof ClarityError &&
                            save.error.code === 'experience_limit_reached'
                          ? 'profile.experience.limitReached'
                          : save.error instanceof ClarityError &&
                              save.error.code === 'invalid_employer'
                            ? 'profile.experience.validation.employerOxyAccountId'
                            : 'profile.experience.saveError',
                    ),
                  )
                : null,
            ).spacing('lg'),
          )}
        </ScrollView>,
      ),
      HStack(
        entry
          ? LButton(LText(t('common.delete', { defaultValue: 'Delete' })))
              .style('plain')
              .tint('danger')
              .onPress(() => void deleteEntry())
              .disabled(busy || !canEdit)
              .loading(remove.isPending)
          : null,
        LButton(LText(t('common.cancel', { defaultValue: 'Cancel' })))
          .style('plain')
          .tint('neutral')
          .onPress(() => setPresented(false))
          .disabled(busy),
        LButton(LText(t('common.save', { defaultValue: 'Save' })))
          .onPress(submit)
          .disabled(busy || !canEdit)
          .loading(save.isPending),
      )
        .padding('top', 'lg')
        .wrap()
        .align('center')
        .justify('end')
        .spacing('sm'),
    )
      .title(title)
      .label(title)
      .dismissOnBackdrop(!busy)
      .onDismissed(dismissed)
      .presented([isPresented, setPresented]),
  );
}
