## Tool Selection

- `kleinanzeigen_status`: check runtime availability, config wiring, workspace
  mode, version, and supported commands without reading the config contents.
- `kleinanzeigen_list_ads`: discover configured local ad folders and return
  titles, IDs, active state, and relative handles for scoped operations.
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
  price offers. Read-only: it marks nothing as read and cannot send replies.
- `kleinanzeigen_read_ad`: read one existing ad config under configured
  `adRoots`, with contact fields redacted by default.
- `kleinanzeigen_images_list`: list image files under one configured ad
  directory and return relative globs usable in an ad draft.
- `kleinanzeigen_set_ad_fields`: change `price` or `priceType` of one ad, or
  mark it `sold` (also sets `active: false` and `sold_on`).
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
- `kleinanzeigen_delete`: delete only explicitly selected live Kleinanzeigen ad
  IDs. Deleted listings may not be reversible from the plugin.
- `kleinanzeigen_download`: download new, all, or explicitly selected live ads
  into the local workspace.
- `kleinanzeigen_extend`: extend all eligible live ads or explicitly selected
  IDs.

Do not mix explicit ad IDs with selectors. For publish combinations, use
`selectors`, for example `["changed", "due"]`.

If a tool is unavailable, tell the user that KleinClaw must be installed and
enabled in OpenClaw before that action can run.
