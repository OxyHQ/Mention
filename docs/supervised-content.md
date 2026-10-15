# Supervised content

Oxy owns supervision, consent, contacts, account privacy and allowed application capabilities. Mention supplies current post material and its existing resource ACL to the canonical safety decision. Mention never accepts a client classification, guardian ID or viewer ID as authorization.

## Read and write boundaries

Reviewed post, feed, article, notification and media routes pass `supervisedAction: 'content'` to Oxy authentication. A supplied invalid or unverifiable bearer fails closed; it cannot turn into an anonymous cached read. Existing adult delegated reads carry the verified MCP connection token to Oxy. Unreviewed search, list, community-note, translation, engagement-list and similar surfaces remain unavailable to supervised accounts.

Hydration loads assessments for the complete unique post graph once, then calls bounded content-decision batches. Every read rechecks current authorization, including anonymous cached feeds and ActivityPub/ATProto output. Existing adult accepted collaborators, pending-invite previews and operated channels supply explicit server-proven resource grants. Supervised authors instead use current guardian/contact consent, without treating unilateral follows as approval. Notification previews follow the same hydrated-post decisions.

Supervised compose sends a private audience and uploads private assets. The server independently rejects public publication, collaboration and federation and rechecks stored/scheduled authors before publication. Only the owner-management response may use Oxy's explicit `manage_own` operation; feeds and nested other-author references remain ordinary reads. File previews and post media use Oxy's owner/recipient ACL and scoped URLs; no public thumbnail, poster or HLS fallback is retained for private files. Public URLs already distributed on the Internet cannot be retracted by this change.

The profile header for a supervised viewer uses Oxy's minimal people contract. Free-form biography, links, cover media and other unreviewed profile details are not inferred safe from a profile-visibility decision. Unreviewed product routes and profile tabs (jobs, lists, feeds, starter packs and writers) show an unavailable state. Foreign career history remains unrated and unavailable. Own Experience management uses Clarity's owner operation and Oxy `safety.organizations`: one batch of minimal employer identities plus bounded search of existing identities. Supervised editors can add/edit/delete roles and select existing employers, but never request the public full directory, logos, websites, neutral creation or claims. Adult directory and organization Jobs behavior is preserved. Experience stays behind its single lazy-loading boundary.

## Rating ownership and efficiency

`post_safety_assessments` records trusted classification-worker verdicts bound to the complete bounded material digest. The existing classification worker includes the verdict in its inference request; no inference runs during feed reads. Sensitive/CW material is mature. Media, links, incomplete material, uncertain verdicts and a mismatched revision remain unrated. Articles and polls can be general only when their complete material was assessed. Existing topic labels or `sensitive: false` are not evidence of a general rating.

Edits invalidate the assessment and reads verify the current digest. The existing bounded reclassification queue may reassess older text; this release does not launch a paid bulk backfill. Migration 0072 adds assessment storage and preserves existing posts and product data.

## Live updates and federation

Global socket updates carry only a feed kind and timestamp. Current clients debounce these invalidations and refetch through HTTP authorization; account changes discard in-flight work. Older native binaries keep HTTP/manual refresh but require an update for the new automatic invalidation protocol. Cached 403/404 post copies and nested references are removed. Supervised detail reads do not expose retained data during an authority outage; established adult offline behavior remains supported.

The shared federation delivery hook checks the trusted persisted sender and local post authors before signing or enqueueing, including internal Follow/Accept. Reference-only Delete/Undo cleanup remains possible after enrollment. Unknown Create/Update resources are refused; persisted Note and Question resources remain supported for adults. Definitive denial terminates durable delivery without retry or delivery-success bookkeeping. Authority outages use normal transient retry behavior. The post-creation dispatch result explicitly distinguishes suppression from accepted connector handoff before setting `federationDelivered`; that marker does not claim that every remote server has received the post.

## Validation and rollout

Endpoint/database tests cover private publication, guardian/contact access without follows, current revision ratings, delegated proof, direct media, notifications, cached feeds, public protocol identity, typed delivery suppression and transient failures. Frontend tests cover account changes, revoked nested copies, unknown supervision and adult offline detail behavior. `playwright.kids.config.ts` runs the production web bundle at 390 and 1280 pixels with real shared UI/SDK and deterministic HTTP fixtures: owner library, multipart private upload, scoped preview and private submit, plus own Experience CRUD with minimal employers and refusal to load foreign history. Adult cross-product Experience and organization flows also run on the combined build. These browser fixtures verify actual transport shapes and UI behavior; they are not a live Oxy consent/deployment proof.

Release requires the canonical Oxy Kids API and reviewed Mention content/background-publication capabilities, registry core/contracts/services packages and federation 2.3.0. No staged tarball, local module override or permissive policy fallback belongs in the release lockfile. Enable the application capability only after API and client rollout checks succeed.
