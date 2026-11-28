import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import { fetchDataExport } from '@/services/dataExportService';
import { saveTextFile } from '@/utils/saveTextFile';

const logger = createLogger('DataExport');

/** Downloads the viewer's Mention data to a file of theirs. */
export function DataExportButton() {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);

  const run = async () => {
    const data = await fetchDataExport();
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    if (await saveTextFile(`mention-export-${stamp}.ndjson`, data, 'application/x-ndjson')) {
      toast(t('settings.account.exportSaved'), { type: 'success' });
    }
  };

  const start = () => {
    setExporting(true);
    void run()
      .catch((error: unknown) => {
        logger.warn('Data export failed', { error });
        toast(t('settings.account.exportFailed'), { type: 'error' });
      })
      .then(() => setExporting(false));
  };

  return (
    <Button
      size="sm"
      appearance="subtle"
      tone="neutral"
      loading={exporting}
      disabled={exporting}
      onPress={start}
    >
      {t('settings.account.exportAction')}
    </Button>
  );
}
