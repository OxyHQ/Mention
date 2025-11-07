# Quick Reference: Using Refactored Compose Components

## Import Statements

```typescript
// Hooks
import { useLocationManager } from "@/hooks/useLocationManager";
import { useMediaManager } from "@/hooks/useMediaManager";
import { usePollManager } from "@/hooks/usePollManager";
import { useSourcesManager } from "@/hooks/useSourcesManager";

// Components
import { PollCreator } from "@/components/Compose/PollCreator";
import { PollAttachmentCard } from "@/components/Compose/PollAttachmentCard";
import { MediaPreview } from "@/components/Compose/MediaPreview";
import { ArticleEditor } from "@/components/Compose/ArticleEditor";
import { LocationDisplay } from "@/components/Compose/LocationDisplay";
import { VideoPreview } from "@/components/Compose/VideoPreview";

// Utils
import { buildAttachmentsPayload } from "@/utils/attachmentsUtils";
import { formatScheduledLabel, addMinutes } from "@/utils/dateUtils";
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
} from "@/utils/composeUtils";
```

## Hook Usage

### Location Management
```typescript
const { 
  location,              // Current location data
  setLocation,           // Set location manually
  isGettingLocation,     // Loading state
  requestLocation,       // Request user's location
  removeLocation         // Clear location
} = useLocationManager();

// Use in UI
<TouchableOpacity onPress={requestLocation}>
  <LocationIcon />
</TouchableOpacity>

<LocationDisplay
  location={location}
  onRemove={removeLocation}
  isGettingLocation={isGettingLocation}
/>
```

### Media Management
```typescript
const {
  mediaIds,              // Array of ComposerMediaItem
  setMediaIds,           // Set media array
  addMedia,              // Add single media file
  addMultipleMedia,      // Add multiple files
  removeMedia,           // Remove by ID
  moveMedia,             // Reorder media
  clearMedia             // Clear all media
} = useMediaManager();

// Use in file picker callback
onSelect: (file) => addMedia(file),
onConfirmSelection: (files) => addMultipleMedia(files),

// Use in UI
<MediaPreview
  mediaItems={mediaIds}
  getMediaUrl={(id) => oxyServices.getFileDownloadUrl(id)}
  onRemove={removeMedia}
  onMove={moveMedia}
/>
```

### Poll Management
```typescript
const {
  showPollCreator,       // Boolean - show creator
  setShowPollCreator,    // Manual control
  pollTitle,             // Poll question
  setPollTitle,          // Set question
  pollOptions,           // Array of option strings
  setPollOptions,        // Set options array
  pollTitleInputRef,     // TextInput ref
  focusPollCreator,      // Open and focus poll
  addPollOption,         // Add new option
  updatePollOption,      // Update option by index
  removePollOption,      // Remove option by index
  removePoll,            // Close and clear
  clearPoll              // Clear without closing
} = usePollManager();

// Use in UI
<TouchableOpacity onPress={focusPollCreator}>
  <PollIcon />
</TouchableOpacity>

{showPollCreator && (
  <PollCreator
    pollTitle={pollTitle}
    pollOptions={pollOptions}
    onTitleChange={setPollTitle}
    onOptionChange={updatePollOption}
    onAddOption={addPollOption}
    onRemoveOption={removePollOption}
    onRemove={removePoll}
  />
)}
```

### Sources Management
```typescript
const {
  sources,               // Array of source objects
  setSources,            // Set sources array
  addSource,             // Add new empty source
  updateSourceField,     // Update title or url
  removeSource,          // Remove by ID
  clearSources,          // Clear all
  getSanitizedSources,   // Get clean array for API
  hasInvalidSources      // Check validation
} = useSourcesManager();

// Use in SourcesSheet
<SourcesSheet
  sources={sources}
  onAdd={addSource}
  onUpdate={updateSourceField}
  onRemove={removeSource}
  onClose={() => {}}
  validateUrl={(url) => !hasInvalidSources()}
/>

// Before submitting
const formattedSources = getSanitizedSources();
```

## Component Usage

### PollCreator
```typescript
<PollCreator
  pollTitle={pollTitle}
  pollOptions={pollOptions}
  onTitleChange={setPollTitle}
  onOptionChange={updatePollOption}
  onAddOption={addPollOption}
  onRemoveOption={removePollOption}
  onRemove={removePoll}
  style={{ marginLeft: 68 }}
  autoFocus={true}
/>
```

### PollAttachmentCard
```typescript
<PollAttachmentCard
  pollTitle={pollTitle}
  pollOptions={pollOptions}
  onPress={focusPollCreator}
  onRemove={removePoll}
  onMoveLeft={() => moveAttachment(POLL_ATTACHMENT_KEY, 'left')}
  onMoveRight={() => moveAttachment(POLL_ATTACHMENT_KEY, 'right')}
  canMoveLeft={index > 0}
  canMoveRight={index < total - 1}
  showReorderControls={total > 1}
/>
```

### MediaPreview
```typescript
<MediaPreview
  mediaItems={mediaIds}
  getMediaUrl={(id) => oxyServices.getFileDownloadUrl(id)}
  onRemove={removeMedia}
  onMove={moveMedia}
  paddingLeft={68}
/>
```

### ArticleEditor
```typescript
const [isArticleEditorVisible, setIsArticleEditorVisible] = useState(false);
const [articleDraftTitle, setArticleDraftTitle] = useState('');
const [articleDraftBody, setArticleDraftBody] = useState('');

<ArticleEditor
  visible={isArticleEditorVisible}
  title={articleDraftTitle}
  body={articleDraftBody}
  onTitleChange={setArticleDraftTitle}
  onBodyChange={setArticleDraftBody}
  onSave={() => {
    setArticle({ title: articleDraftTitle, body: articleDraftBody });
    setIsArticleEditorVisible(false);
  }}
  onClose={() => setIsArticleEditorVisible(false)}
/>
```

### LocationDisplay
```typescript
<LocationDisplay
  location={location}
  onRemove={removeLocation}
  isGettingLocation={isGettingLocation}
  style={{ marginLeft: 68 }}
/>
```

### VideoPreview
```typescript
<VideoPreview 
  src={oxyServices.getFileDownloadUrl(videoId)} 
  style={{ width: '100%', height: '100%' }}
/>
```

## Utility Functions

### Build Attachments Payload
```typescript
const attachmentsPayload = buildAttachmentsPayload(
  attachmentOrder,  // Array of attachment keys
  mediaIds,         // Array of ComposerMediaItem
  {
    includePoll: showPollCreator,
    includeArticle: Boolean(article),
    includeLocation: Boolean(location),
    includeSources: sources.length > 0,
  }
);
```

### Date Formatting
```typescript
// Add time to date
const futureDate = addMinutes(new Date(), 60); // 1 hour from now

// Format for display
const label = formatScheduledLabel(scheduledDate);
// Output: "Nov 7, 2025, 3:30 PM"
```

### Media Type Conversion
```typescript
const mediaType = toComposerMediaType('video', 'video/mp4');
// Returns: 'video'

const mediaItem: ComposerMediaItem = {
  id: file.id,
  type: toComposerMediaType(undefined, file.contentType)
};
```

### Attachment Keys
```typescript
// Create media attachment key
const key = createMediaAttachmentKey(mediaId);
// Returns: 'media:abc123'

// Check if key is media
if (isMediaAttachmentKey(key)) {
  const id = getMediaIdFromAttachmentKey(key);
  // Use id...
}

// Non-media keys
POLL_ATTACHMENT_KEY      // 'poll'
ARTICLE_ATTACHMENT_KEY   // 'article'
LOCATION_ATTACHMENT_KEY  // 'location'
SOURCES_ATTACHMENT_KEY   // 'sources'
```

## Migration Example

### Before (Old Code)
```typescript
const [pollOptions, setPollOptions] = useState<string[]>([]);
const [pollTitle, setPollTitle] = useState('');
const [showPollCreator, setShowPollCreator] = useState(false);

const addPollOption = () => {
  setPollOptions(prev => [...prev, '']);
};

const updatePollOption = (index: number, value: string) => {
  setPollOptions(prev => prev.map((option, i) => i === index ? value : option));
};

// ... 50+ more lines of poll logic
```

### After (New Code)
```typescript
const poll = usePollManager();

// All logic is in the hook!
<PollCreator {...poll} onRemove={poll.removePoll} />
```

## Benefits

✅ **Less Code** - Main file shrinks significantly  
✅ **Reusable** - Use same components elsewhere  
✅ **Testable** - Test hooks and components separately  
✅ **Maintainable** - Changes isolated to specific files  
✅ **Type Safe** - Proper TypeScript interfaces  
✅ **Optimized** - Better memoization opportunities
