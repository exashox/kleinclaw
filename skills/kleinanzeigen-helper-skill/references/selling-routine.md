## Selling Routine

Use this when the user hands over items to sell over time and expects the agent
to run listings, republication, reports, and buyer messages.

### One item, one folder

- Create one ad folder per item under `adRoots` with a short, unique slug
  (`schreibtischlampe-metall`). Keep that item's images, text, price and
  notes only in that folder. Never reuse text, facts, prices or images from a
  different item, even when items look alike.
- When the user sends several items at once, confirm which images and which
  description belong to which item before drafting anything.

### From photos to a listing

1. Save the user's photos into the item's folder and check them with
   `kleinanzeigen_images_list`.
2. Research the item (model, specs, condition hints from the photos) with the
   tools available to you. Only state facts you can support.
3. Estimate the market value with `kleinanzeigen_market_search`: search the
   way a buyer would (brand and model first, then broader words), narrow with
   `categoryId` when results drift. Asking prices are not sale prices, and the
   spread only counts listings that really compare: read the titles, drop
   accessories, defects and bundles, and say how many comparable offers you
   found. Add new prices from elsewhere if useful. Report the range and the
   price you propose, with the reasoning.
4. Pick the category with `kleinanzeigen_categories` (see Ad Authoring).
5. Draft with `kleinanzeigen_draft_ad` and `active: false`, run scoped
   `kleinanzeigen_verify`, and send the user a summary (title, description,
   price and type, category, images) for approval. Keep drafts inactive: the
   scheduled `due` run publishes every active ad that was never published.
6. Publish only after explicit approval of that draft: set it active, then run
   `kleinanzeigen_publish` scoped to that ad. Use `fillOnly: true` when the user
   wants to check the filled form first.
7. If the user submits a `fillOnly` form by hand, record it right away with
   `kleinanzeigen_set_ad_fields` `publishedAdId` (the number from the listing
   URL or "Meine Anzeigen"). Otherwise the next `due` run publishes it a second
   time.

### Republication

- `republication_interval` (days) in the ad or in `ad_defaults` decides when an
  ad is due again; `kleinanzeigen_publish` with selector `due` republishes only
  those. By default the old listing is deleted after the new one is online
  (`publishing.delete_old_ads: AFTER_PUBLISH`), which avoids duplicate
  listings.
- Run the `due` republication on a schedule (for example daily) instead of
  counting days yourself.
- Never republish sold items: mark them with `kleinanzeigen_set_ad_fields`
  `sold: true` as soon as you learn an item is sold.
- Before a scheduled `due` run, compare `kleinanzeigen_list_ads` with "Meine
  Anzeigen": an active ad without `id` that is already online must be recorded
  with `publishedAdId` first, never published again.

### Keeping track

- `kleinanzeigen_list_ads` returns per item `id` (set once online), `active`,
  `sold`, `soldOn`, `createdOn` (first publication), `updatedOn` (last
  publication), `price`, and `priceType`. Use it as the single source of truth
  for reports.
- To see what is really online, open "Meine Anzeigen" with the browser tool and
  compare IDs with the local folders. Report mismatches instead of fixing them
  silently.

### Weekly report

- New: items first published in the last 7 days (`createdOn`).
- Active: online and not sold, with days since `createdOn`.
- Sold: items with `soldOn` in the last 7 days, with how long they were online.
- Propose a price change for items online for a long time (for example more
  than 4 weeks) or without buyer interest. Apply it with
  `kleinanzeigen_set_ad_fields` only after the user approves; it takes effect
  with the next republication or an `update` run.

### Buyer messages

- Read messages with `kleinanzeigen_messages`: first the list, then each
  conversation with unread messages by its `conversationId`. It lists only
  conversations where the account sells. Only handle conversations whose
  `adId` matches the `id` of a local ad folder (`kleinanzeigen_list_ads`);
  ignore all others, the account may also be used privately.
- Messages with `direction: system` and an `offer` are price offers made via
  "Direkt kaufen"; report the offered price to the user, never accept or
  decline on your own.
- Draft replies from the facts in that item's folder only. Do not promise
  anything the listing does not say (price, shipping, condition, availability).
- KleinClaw does not send replies. Give the user each draft with the buyer's
  name, the ad title and the conversation ID so they can send it. Send replies
  yourself only when the user has explicitly allowed automatic replies.
- If a buyer confirms a purchase or the user says an item is sold, mark it sold.
