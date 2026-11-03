import { useState } from 'react';
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import type { CheckoutCard } from '@peable.to/sdk/checkout/ui';
import { useTranslation } from 'react-i18next';

/** Local fixture: metadata only, never card numbers or provider fields. */
export function LocalCheckoutCardEntry({
  card,
  onCard,
  onDone,
}: {
  card: CheckoutCard | null;
  onCard(card: CheckoutCard): void;
  onDone(): void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`plus.checkout.${key}`);
  const [testCard, setTestCard] = useState<CheckoutCard>(
    card ?? { id: 'demo-visa', brand: 'Visa', last4: '4242', saveForLater: false },
  );
  const saveCard = testCard.saveForLater;
  return (
    <>
      <GroupedSection>
        <GroupedSectionItem
          title={label('secureFields')}
          description={label('cardPlaceholder')}
          descriptionLines={0}
          showChevron={false}
        />
        <GroupedSectionItem
          title={label('cardNumber')}
          description={label('testCardOnly')}
          value={`···· ${testCard.last4}`}
          showChevron={false}
        />
      </GroupedSection>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {(['Visa', 'Mastercard'] as const).map((brand) => (
          <Button
            key={brand}
            appearance={testCard.brand === brand ? 'subtle' : 'outline'}
            onPress={() =>
              setTestCard({
                id: `demo-${brand}`,
                brand,
                last4: brand === 'Visa' ? '4242' : '4444',
                saveForLater: saveCard,
              })
            }
          >
            {brand}
          </Button>
        ))}
      </View>
      <Checkbox
        checked={saveCard}
        onCheckedChange={(checked) => setTestCard({ ...testCard, saveForLater: checked })}
        label={label('saveCard')}
        description={label('saveCardHint')}
      />
      <Button
        size="lg"
        onPress={() => {
          onCard({ ...testCard, saveForLater: saveCard });
          onDone();
        }}
      >
        {label('useCard')}
      </Button>
    </>
  );
}
