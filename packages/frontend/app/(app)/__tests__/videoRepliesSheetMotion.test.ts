import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('video replies sheet motion', () => {
  const appRoot = join(__dirname, '..', '..', '..');
  const context = readFileSync(join(appRoot, 'context/BottomSheetContext.tsx'), 'utf8');
  const screen = readFileSync(join(__dirname, '..', '(tabs)', 'videos.tsx'), 'utf8');

  it('drives the video transform from the same UI-thread progress as the sheet', () => {
    expect(context).toContain("bottomSheetPresentation === 'videoReplies' ? bottomSheetProgress");
    expect(context).toContain('animatedProgress=');
    expect(screen).toContain('bottomSheetProgress?.value ?? 0');
    expect(screen).toContain('scale: interpolate(progress, [0, 1], [1, 0.38])');
  });
});
