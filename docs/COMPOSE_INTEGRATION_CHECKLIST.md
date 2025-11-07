# Integration Checklist - Compose Screen Refactoring

## ✅ Phase 1: Preparation (Completed)

- [x] Create utility modules
  - [x] `utils/composeUtils.ts`
  - [x] `utils/dateUtils.ts`
  - [x] `utils/attachmentsUtils.ts`

- [x] Create reusable components
  - [x] `components/Compose/PollCreator.tsx`
  - [x] `components/Compose/PollAttachmentCard.tsx`
  - [x] `components/Compose/VideoPreview.tsx`
  - [x] `components/Compose/MediaPreview.tsx`
  - [x] `components/Compose/ArticleEditor.tsx`
  - [x] `components/Compose/LocationDisplay.tsx`

- [x] Create custom hooks
  - [x] `hooks/useLocationManager.ts`
  - [x] `hooks/useMediaManager.ts`
  - [x] `hooks/usePollManager.ts`
  - [x] `hooks/useSourcesManager.ts`

- [x] Create documentation
  - [x] `docs/COMPOSE_REFACTORING.md`
  - [x] `docs/COMPOSE_COMPONENTS_GUIDE.md`
  - [x] `docs/COMPOSE_OPTIMIZATION_COMPLETE.md`
  - [x] `docs/COMPOSE_ARCHITECTURE_DIAGRAM.md`

- [x] Create index exports
  - [x] `components/Compose/index.ts`

## 📋 Phase 2: Integration (To Do)

### Step 1: Update Imports in compose.tsx
```typescript
// Add these imports at the top of compose.tsx

// Hooks
import { useLocationManager } from '@/hooks/useLocationManager';
import { useMediaManager } from '@/hooks/useMediaManager';
import { usePollManager } from '@/hooks/usePollManager';
import { useSourcesManager } from '@/hooks/useSourcesManager';

// Components
import {
  PollCreator,
  PollAttachmentCard,
  MediaPreview,
  VideoPreview,
  ArticleEditor,
  LocationDisplay,
} from '@/components/Compose';

// Utils
import { buildAttachmentsPayload } from '@/utils/attachmentsUtils';
import { formatScheduledLabel, addMinutes } from '@/utils/dateUtils';
import {
  ComposerMediaItem,
  toComposerMediaType,
  MEDIA_CARD_WIDTH,
  MEDIA_CARD_HEIGHT,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  createMediaAttachmentKey,
  isMediaAttachmentKey,
  getMediaIdFromAttachmentKey,
} from '@/utils/composeUtils';
```

### Step 2: Replace State with Hooks
- [ ] Replace media state with `useMediaManager`
  ```typescript
  // Remove:
  const [mediaIds, setMediaIds] = useState<ComposerMediaItem[]>([]);
  
  // Add:
  const media = useMediaManager();
  ```

- [ ] Replace poll state with `usePollManager`
  ```typescript
  // Remove:
  const [pollOptions, setPollOptions] = useState<string[]>([]);
  const [pollTitle, setPollTitle] = useState('');
  const [showPollCreator, setShowPollCreator] = useState(false);
  
  // Add:
  const poll = usePollManager();
  ```

- [ ] Replace location state with `useLocationManager`
  ```typescript
  // Remove:
  const [location, setLocation] = useState(null);
  const [isGettingLocation, setIsGettingLocation] = useState(false);
  
  // Add:
  const location = useLocationManager();
  ```

- [ ] Replace sources state with `useSourcesManager`
  ```typescript
  // Remove:
  const [sources, setSources] = useState([]);
  
  // Add:
  const sources = useSourcesManager();
  ```

### Step 3: Update References Throughout File
- [ ] Update all `mediaIds` to `media.mediaIds`
- [ ] Update all `setMediaIds` to `media.setMediaIds`
- [ ] Update all `pollOptions` to `poll.pollOptions`
- [ ] Update all `setPollOptions` to `poll.setPollOptions`
- [ ] Update all `pollTitle` to `poll.pollTitle`
- [ ] Update all `setPollTitle` to `poll.setPollTitle`
- [ ] Update all `showPollCreator` to `poll.showPollCreator`
- [ ] Update all `location` references appropriately
- [ ] Update all `sources` references appropriately

### Step 4: Replace Helper Functions
- [ ] Remove `addMedia` function, use `media.addMedia`
- [ ] Remove `removeMedia` function, use `media.removeMedia`
- [ ] Remove `moveMedia` function, use `media.moveMedia`
- [ ] Remove `addPollOption` function, use `poll.addPollOption`
- [ ] Remove `updatePollOption` function, use `poll.updatePollOption`
- [ ] Remove `removePollOption` function, use `poll.removePollOption`
- [ ] Remove `focusPollCreator` function, use `poll.focusPollCreator`
- [ ] Remove `removePoll` function, use `poll.removePoll`
- [ ] Remove `requestLocation` function, use `location.requestLocation`
- [ ] Remove `removeLocation` function, use `location.removeLocation`
- [ ] Remove `addSource` function, use `sources.addSource`
- [ ] Remove `updateSourceField` function, use `sources.updateSourceField`
- [ ] Remove `removeSource` function, use `sources.removeSource`

### Step 5: Replace UI Components
- [ ] Replace inline poll creator JSX with `<PollCreator />` component
- [ ] Replace poll attachment card with `<PollAttachmentCard />`
- [ ] Replace media preview with `<MediaPreview />` component
- [ ] Replace video preview with `<VideoPreview />` component
- [ ] Replace article editor modal with `<ArticleEditor />` component
- [ ] Replace location display with `<LocationDisplay />` component

### Step 6: Update Utility Usages
- [ ] Replace inline `buildAttachmentsPayload` logic with imported function
- [ ] Replace date formatting with `formatScheduledLabel`
- [ ] Replace media type conversion with `toComposerMediaType`
- [ ] Use constants from `composeUtils` instead of inline

### Step 7: Clean Up
- [ ] Remove old utility functions (now in utils files)
- [ ] Remove old type definitions (now in utils files)
- [ ] Remove old constants (now in utils files)
- [ ] Remove commented code
- [ ] Remove unused imports
- [ ] Remove duplicate logic

## 🧪 Phase 3: Testing

### Unit Tests
- [ ] Test `useLocationManager` hook
- [ ] Test `useMediaManager` hook
- [ ] Test `usePollManager` hook
- [ ] Test `useSourcesManager` hook
- [ ] Test `PollCreator` component
- [ ] Test `MediaPreview` component
- [ ] Test `ArticleEditor` component
- [ ] Test `LocationDisplay` component
- [ ] Test utility functions

### Integration Tests
- [ ] Test media upload flow
- [ ] Test poll creation flow
- [ ] Test location request flow
- [ ] Test article editing flow
- [ ] Test sources management flow
- [ ] Test draft save/load
- [ ] Test post submission

### Manual Testing
- [ ] Create a simple post
- [ ] Create a post with media
- [ ] Create a post with poll
- [ ] Create a post with location
- [ ] Create a post with article
- [ ] Create a post with sources
- [ ] Create a thread
- [ ] Use Beast mode
- [ ] Test draft auto-save
- [ ] Test draft loading
- [ ] Test scheduling
- [ ] Test reply permissions
- [ ] Test on iOS
- [ ] Test on Android
- [ ] Test on Web

### Performance Testing
- [ ] Check component render counts
- [ ] Check memory usage
- [ ] Check app bundle size
- [ ] Check initial load time
- [ ] Check interaction responsiveness

## 🐛 Phase 4: Bug Fixes

If issues are found:
- [ ] Document the issue
- [ ] Identify the component/hook/util responsible
- [ ] Fix in isolation
- [ ] Test the fix
- [ ] Verify no regressions

## 📊 Phase 5: Metrics & Validation

### Code Metrics
- [ ] Verify main file is < 1,500 lines
- [ ] Verify no circular dependencies
- [ ] Verify all TypeScript types are correct
- [ ] Verify no unused code

### Performance Metrics
- [ ] Bundle size reduced or same
- [ ] No performance regressions
- [ ] Faster component re-renders
- [ ] Better memory management

### Developer Metrics
- [ ] Easier to find code
- [ ] Faster to make changes
- [ ] Clear separation of concerns
- [ ] Better code organization

## 📝 Phase 6: Documentation

- [ ] Update README if needed
- [ ] Add JSDoc comments to complex functions
- [ ] Document any breaking changes
- [ ] Update migration guide if needed

## 🚀 Phase 7: Deployment

- [ ] Create feature branch
- [ ] Commit changes with clear messages
- [ ] Open pull request
- [ ] Get code review
- [ ] Address review comments
- [ ] Merge to main
- [ ] Deploy to staging
- [ ] Test on staging
- [ ] Deploy to production
- [ ] Monitor for issues

## 📋 Success Criteria

- ✅ All features work as before
- ✅ No performance regressions
- ✅ Code is more maintainable
- ✅ Main file is < 1,500 lines
- ✅ Components are reusable
- ✅ Hooks are testable
- ✅ Utils are pure functions
- ✅ Documentation is complete
- ✅ Team is onboarded

## 🎯 Final Validation

Before marking as complete:
- [ ] All checkboxes above are checked
- [ ] Code review approved
- [ ] QA testing passed
- [ ] Production deployment successful
- [ ] No critical bugs reported
- [ ] Team is satisfied with changes

---

## Notes

- Take your time with each phase
- Test thoroughly after each change
- Keep the old code commented until verification
- Document any issues or learnings
- Celebrate when complete! 🎉
