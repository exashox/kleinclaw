## Tool Selection

- `kleinanzeigen_status`: check runtime availability, config wiring, workspace
  mode, versions, and supported commands without reading the config contents.
  `pluginVersion` is the installed KleinClaw version (report this one);
  `runtimeVersion`/`version` is the embedded miniclaw runtime.
- `kleinanzeigen_list_ads`: discover configured local ad folders and return
  internal IDs, titles, Kleinanzeigen IDs, active state, and relative handles,
  plus ads without internal ID and duplicate internal IDs.
- `kleinanzeigen_find_ad`: resolve what the user calls an ad (`#12`, a
  Kleinanzeigen ID, or title words) to internal ID, Kleinanzeigen ID, title,
  and folder. Use it before every ad-specific action.
- `kleinanzeigen_assign_internal_ids`: give all local ads without
  `internal_id` the next free number (after confirmation).
- `kleinanzeigen_ad_schema`: inspect the safe ad config schema and draft
  workflow exposed by KleinClaw.
- `kleinanzeigen_categories`: search categories by keyword and return full
  display paths with IDs for an ad's `category`.
- `kleinanzeigen_market_search`: search current Kleinanzeigen listings in the
  browser and get comparable offers with parsed prices plus the price spread
  (min, quartiles, median, max). Read-only. Use it for market value instead of
  scraping search pages with the browser tool.
- `kleinanzeigen_messages`: read the message box. Without `conversationId` it
  lists conversations about the account's own ads (ad ID, title, buyer, unread
  count); with `conversationId` it returns that conversation's messages and
  price offers, plus `newestMessageId`, `awaitingReply`, `latestOffer`, and for
  local ads `localAd` and `offerAssessment`. Conversations about local ads are
  marked `managed: true`. Read-only: it marks nothing as read.
- `kleinanzeigen_send_message`: send one reply in a managed conversation after
  confirmation. Needs `afterMessageId` (= `newestMessageId`) and refuses when the
  buyer wrote something newer, when it is the buyer's turn, or when the text
  names a price below the ad's `minPrice` (asking price if none is set).
- `kleinanzeigen_read_ad`: read one existing ad config under configured
  `adRoots`, with contact fields redacted by default.
- `kleinanzeigen_images_list`: list image files under one configured ad
  directory and return relative globs usable in an ad draft.
- `kleinanzeigen_set_ad_fields`: change `title`, `description`, `price`, or
  `priceType` of one ad, or mark it `sold` (also sets `active: false` and
  `sold_on`). Local only; a scoped `kleinanzeigen_update` sends it live. `minPrice` and
  `negotiationNotes` store the user's negotiation limits next to the ad.
- `kleinanzeigen_set_ad_images`: set the images of one ad in display order
  (first = cover); copies photos from an inbox folder under `adRoots`.
- `kleinanzeigen_sync`: compare up to 20 published ads with Kleinanzeigen in
  one browser run; takes over online edits where the local ad is unchanged and
  reports `local_ahead` and `conflict` ads.
- `kleinanzeigen_storage_cleanup`: report, then (after confirmation) move
  unassigned and duplicate images to the trash and remove temporary folders.
- `kleinanzeigen_image_preferences`: what was learned about the user's image
  order; read it before proposing an order; manage the user's image rules.
- `kleinanzeigen_sync_check`: download one published ad temporarily and
  compare it with the local `ad.yaml`; `apply`/`applyImages` take over the
  online version. Opens the live browser, changes nothing online.
- `kleinanzeigen_browser_status`: inspect sanitized effective browser settings
  and detected local browsers.
- `kleinanzeigen_browser_check`: test current or proposed browser settings
  through miniclaw diagnostics without changing the real config.
- `kleinanzeigen_browser_configure`: change miniclaw browser settings only after
  explicit confirmation. Browser settings affect which local browser profile the
  live runtime can open.
- `kleinanzeigen_draft_ad`: create or replace a local ad draft under configured
  `adRoots` only after explicit confirmation.
- `kleinanzeigen_set_ad_active`: set the top-level `active` flag for one YAML
  ad config before scoped verify/publish.
- `kleinanzeigen_verify`: validate the full configured miniclaw workspace or
  selected relative ad handles.
- `kleinanzeigen_publish`: publish or republish due, new, changed, all, combined
  selectors, or explicitly selected ads. This can create or replace live
  Kleinanzeigen listings. With `fillOnly: true` and exactly one ad scoped via
  `adDirectories` or `adConfigPaths`, it fills the whole form including images
  and stops before submitting; the user reviews and submits in the browser.
  Prefer this when the user wants to check an ad before it goes live.
- `kleinanzeigen_update`: update changed, all, or explicitly selected live ads.
- `kleinanzeigen_delete`: delete only explicitly selected live ads (`adIds` or
  `internalIds`). Deleted listings may not be reversible from the plugin.
- `kleinanzeigen_download`: download new, all, or explicitly selected live ads
  into the local workspace.
- `kleinanzeigen_extend`: extend all eligible live ads or explicitly selected
  IDs.

Do not mix explicit ad IDs with selectors. For publish combinations, use
`selectors`, for example `["changed", "due"]`.

If a tool is unavailable, tell the user that KleinClaw must be installed and
enabled in OpenClaw before that action can run.
