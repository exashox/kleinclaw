## Internal IDs, Image Order, and Sync

### Internal IDs are the fixed point

- Every local ad has a stable `internal_id` (a small number) in its `ad.yaml`.
  The Kleinanzeigen ID (`id`) changes on every republication; the internal ID
  never does. Talk to the user in internal IDs: "#12 Kinderfahrrad (online as
  3123456789)".
- When the user names an ad in any way ("#12", "ID 12", "the bike", a
  Kleinanzeigen ID or link), resolve it with `kleinanzeigen_find_ad` first.
  - One match: confirm it in your answer with internal ID and title.
  - Several matches (`ambiguous: true`) or none: stop and ask. Never guess.
- Scope every further call with `internalIds: [<internalId>]`. Only fall back
  to `adDirectories` for ads without an internal ID.
- After `kleinanzeigen_draft_ad`, tell the user the new internal ID.
- When `kleinanzeigen_list_ads` reports `adsWithoutInternalId > 0`, offer to run
  `kleinanzeigen_assign_internal_ids` and then show the user the list of
  numbers. When it reports `internalIdDuplicates`, show them and ask how to
  renumber; do not edit `internal_id` on your own.
- Never write `internal_id`, `id`, `content_hash`, or `images_fingerprint` by
  hand or through another tool.

### Several ads in one conversation

- Handle one ad at a time. Before each change, restate which ad you are working
  on (internal ID and title) and use only that ad's folder, text, and images.
- When the user sends photos or text for several items, first assign each photo
  and each text to an internal ID, show the assignment, and wait for approval.
- "Bilder zu 12" / "pictures for 12" means: resolve #12 with
  `kleinanzeigen_find_ad`, then attach the photos with
  `kleinanzeigen_set_ad_images` scoped to `internalIds: [12]`.

### Image order

Look at the photos (with the image capability you have) and order them like a
buyer wants to see them:

1. Cover: the whole item, well lit, in front of a calm background. Never a
   detail, label, or defect as the cover.
2. The item from the other main angles (side, back, open/folded).
3. Details that prove condition and value: brand, model plate, special
   features, accessories that are included.
4. Wear and defects, clearly visible. Hiding them costs trust later.
5. Size references, receipts, or packaging last.

Drop near-duplicates and blurry shots, and tell the user which ones you left out.
Kleinanzeigen shows at most 20 images.

Before you order, read `kleinanzeigen_image_preferences` (with `category` when
the item type is clear). Its `guidance` and `rules` come from the user's past
corrections and override the general order above.

Then:

1. Call `kleinanzeigen_set_ad_images` with the files in your order,
   `orderSource: "agent"`, and an `assessments` entry per image (role, quality
   1-5, short note).
2. Show the user the order: one line per image with role and reason.
3. When the user approves or changes it, call `kleinanzeigen_set_ad_images`
   again with the final order and `orderSource: "user"`. Do this also when
   nothing changed: an approval is a learning signal too.
4. When the user states a general wish ("never a detail as cover"), store it
   with `kleinanzeigen_image_preferences` `action: "add_rule"` after asking.

The tool moves photos from an inbox folder under `adRoots` into the ad folder
and lists byte-identical photos only once (`skippedDuplicates`). Mention
skipped duplicates to the user. Only `.jpg`, `.jpeg`, `.png`, and `.gif` are
accepted; ask the user to convert other formats.

### Keeping storage small

- Photos the user sends go into the inbox folder first. Assign them to an
  internal ID soon; `kleinanzeigen_set_ad_images` moves them into the ad folder.
- When photos cannot be assigned to any ad, ask the user. If they are not
  needed, leave them: `kleinanzeigen_storage_cleanup` moves them to the trash
  after `minAgeDays`.
- Run `kleinanzeigen_storage_cleanup` without `apply` about once a week (or
  when the user asks), show the summary (counts, megabytes, duplicates), and
  apply it only after the user agrees. Trash is purged after
  `trashRetentionDays`.
- Report `duplicatesInAd` (the same photo twice in one ad) and offer to fix the
  image list.

### Changing a published ad

1. Resolve the ad (`kleinanzeigen_find_ad`).
2. Change it locally: `kleinanzeigen_set_ad_fields` (title, description,
   price, price type) or `kleinanzeigen_set_ad_images`.
3. Show the user the new content, then run scoped `kleinanzeigen_verify`.
4. After approval, run `kleinanzeigen_update` with `internalIds` and
   `selector: "changed"`. The Kleinanzeigen ID stays the same on update.
5. Report the result per ad: internal ID, title, Kleinanzeigen ID.

Use `kleinanzeigen_publish` (republication) only when the user wants the ad to
appear as new. That creates a new Kleinanzeigen ID; KleinClaw stores it in the
same `ad.yaml`, so the internal ID keeps pointing to the right ad. Report the
old and the new Kleinanzeigen ID (`previousId` in the outcome).

### Sync with kleinanzeigen.de

- `kleinanzeigen_sync` checks up to 20 published ads in one browser run and
  takes over online edits automatically when the local ad is unchanged
  (`pulled`). Report per ad: internal ID, title, status, and what was taken
  over.
- `local_ahead`: local edits not online yet; offer a scoped
  `kleinanzeigen_update`.
- `conflict`: both sides changed. Show the differences and ask per field.
- `not_found_online`: the ad may be deleted, expired, or paused. Ask before
  changing anything.
- `deleted_online` / `sold_online`: the ad page in the logged-in browser marks
  the ad as deleted or sold. Nothing was taken over. Ask the user to check the
  ad under "Meine Anzeigen"; do not delete or republish on your own.
- `onlineImagesUnreadable: true`: the gallery could not be read, so the images
  were not compared. Do not tell the user the ad has no images online.
- `not_checked` (with `partial: true`): the browser run hit its time limit
  before it reached these ads. Report what was checked and offer another sync
  with a smaller `maxAds`; do not call this a failure of those ads.
- When the user wants a daily sync, suggest an OpenClaw cron job that asks you
  to run `kleinanzeigen_sync` and report; do not loop it yourself.

### When the user edited one ad on kleinanzeigen.de

- Run `kleinanzeigen_sync_check` for that ad (needs approval: it opens the live
  browser) and show the `differences` and the image counts.
- Ask per field which version wins:
  - online wins: call `kleinanzeigen_sync_check` again with `apply` (and
    `applyImages: true` for the images).
  - local wins: run a scoped `kleinanzeigen_update`.
- Offer a sync check when the user mentions an edit on the website, or before
  you change an ad that was last updated a while ago. Do not run it for many
  ads in a row; at most a few per session.
