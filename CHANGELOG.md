# Changelog

## Unreleased

- internal ad IDs: `internal_id` in `ad.yaml` is the stable reference for an
  ad across republications; `kleinanzeigen_draft_ad` assigns it, the new
  `kleinanzeigen_assign_internal_ids` numbers existing ads, and every
  ad-scoped tool accepts `internalIds` (delete and download map them to the
  current Kleinanzeigen IDs); `internal_id` is excluded from the content hash
- add `kleinanzeigen_find_ad`: resolve an ad by internal ID, Kleinanzeigen ID,
  or title words and flag ambiguous matches
- `kleinanzeigen_list_ads`: `internalId`, `adsWithoutInternalId`,
  `internalIdDuplicates`, `nextFreeInternalId`, and `query: "#12"`
- `kleinanzeigen_draft_ad`: overwriting a draft keeps `internal_id`, `id`,
  `content_hash`, and the other publication fields, so it no longer turns a
  published ad into a duplicate on the next publish
- add `kleinanzeigen_set_ad_images`: set the image order of one ad and copy
  photos from an inbox folder under `adRoots`
- publish and update store an `images_fingerprint`, so swapped image files
  with unchanged names count as `changed`
- `kleinanzeigen_set_ad_fields`: `title` and `description`
- add `kleinanzeigen_sync_check`: download one published ad temporarily,
  compare it with the local ad, and optionally take over the online version;
  miniclaw `download` accepts `--download-dir`
- miniclaw: `publishing.delete_old_ads_by_title` now defaults to `false`, so a
  republication no longer deletes other ads that share the title
- operation outcomes name the internal ID and the previous Kleinanzeigen ID
  after a republication
- helper skill: internal IDs, several ads in one conversation, image order,
  changing published ads, and sync after edits on the website

## 0.5.0 - 2026-11-15

- add `kleinanzeigen_send_message`: replies in conversations about local ads;
  re-reads the conversation right before sending and refuses when the buyer
  wrote something newer, when it is the buyer's turn, when the conversation is
  about another ad, or when the reply names a price below the ad's minimum
  price (asking price when none is set); refuses phone numbers, email
  addresses, links, and account numbers; marks the conversation read
- `kleinanzeigen_set_ad_fields`: `minPrice`, `clearMinPrice`, and
  `negotiationNotes`, stored in `.negotiation.json` next to the ad
- `kleinanzeigen_messages`: `managed` marker for conversations about local ads,
  `newestMessageId`, `awaitingReply`, `latestOffer`, `offerStatus`, `paid`, and
  for local ads `localAd` and `offerAssessment`
- `kleinanzeigen_list_ads` shows stored negotiation settings
- helper skill: buyer conversations and negotiation guide (judging offers,
  countering, several buyers, scams, what needs the user, schedule)

## 0.4.0 - 2026-11-09

- add `kleinanzeigen_market_search`: reads current listings for a query
  (optionally by category, price range, up to three pages) in the browser and
  returns parsed prices with the price spread (min, quartiles, median, max)
- add `kleinanzeigen_messages`: lists conversations about the account's own
  ads and reads single conversations including price offers; read-only, leaves
  buyer-side conversations out unless asked
- add `--remote-debugging-token` for protected DevTools endpoints; miniclaw
  sends it as `?token=`, never prints it, and stops at once on HTTP 401/403
- KleinClaw Browser add-on 0.4.0: the DevTools port 9223 requires the new
  `cdp_token` option (locked while it is empty), and noVNC accepts only Home
  Assistant ingress connections

## 0.3.0 - 2026-11-09

- add the **KleinClaw Browser** Home Assistant add-on (visible Chromium with
  noVNC, persistent profile, DevTools proxy reachable by add-on hostname); the
  repository root is now installable as a Home Assistant add-on repository
- let miniclaw attach to a browser in a sibling container (private IPv4 or
  local hostname) and transfer upload images as bytes to remote browsers
- support the new "Kategorie wählen" dialog by walking the category path level
  by level; add `kleinanzeigen_categories` to search categories by name
- add `fillOnly` to `kleinanzeigen_publish` to fill the form without submitting
- add `kleinanzeigen_set_ad_fields` for price, price type, sold state and
  recording the ID of an ad published by hand
- show connect mode in `kleinanzeigen_browser_status` and skip local binary
  checks in `kleinanzeigen_browser_check` when attaching to an external browser
- add a selling routine reference to the helper skill

## 0.2.4

- stop with a clear "do not retry for 24 hours" message when Kleinanzeigen
  shows "IP-Bereich vorübergehend gesperrt" after the password step

## 0.2.3

- handle the Kleinanzeigen "Code senden" SMS challenge after the password step:
  request the code, let the account owner type it in an interactive terminal,
  enter and submit it; without a terminal no code is requested
- recognize the English "Send code" page as well
- stop with a clear message when a captcha appears after the password step
- prefer Auth0's primary submit button over "resend code" and tick "remember
  this device" when offered
- print the code page structure (no field values) when the code field is not
  found, and the login page structure (headings, error messages, language) when
  the post-password step stays inconclusive
- persist an explicit **Always allow** choice in the existing `approvalMode`
- keep approval descriptions within the supported OpenClaw request limit

## 0.2.2

- make the readme easier to follow for first-time KleinClaw users
- explain where OpenClaw plugin config and tool policy snippets belong
- document common config fields and allowed values near their examples
- publish a matching GitHub and Clawhub release after the 0.2.1 Clawhub-only
  release drift

## 0.2.1

- make live listing and browser automation impact explicit in published metadata
  and helper guidance
- require plugin approval routing by removing the no-approval mode
- restrict persistent browser configuration to supported browser/profile choices
- keep publish-error diagnostics sparse and avoid storing ad payloads or page
  captures

## 0.2.0

### Changed

- replace the external `kleinanzeigen-bot` command dependency with the embedded
  TypeScript `miniclaw` runtime
- keep the browser automation model inside the package with CDP-style Chromium
  control, local browser profile handling, and the existing KleinClaw approval
  gates
- make embedded miniclaw defaults use miniclaw app names and local schema hints
- switch package metadata to AGPL-3.0-or-later for the embedded derived code

### Removed

- remove the old `cliPath`/external executable configuration surface from the
  OpenClaw plugin config
- remove unused embedded miniclaw resource files from the published package
- avoid Python, Playwright, and upstream bot package dependencies in the
  ClawHub package

### Verified

- package checks assert that the npm lockfile, packed runtime files, generated
  default config, and plugin config schema no longer expose the stale external
  runtime surface
- VM release testing proved the packaged branch can run, publish, and delete
  through embedded miniclaw from an isolated Omarchy guest

## 0.1.6

- add a concise troubleshooting section for sandboxed routed agents
- align package and OpenClaw plugin metadata for the next ClawHub release

## 0.1.5

- document sandbox tool-policy exposure for routed agents
- align package and OpenClaw plugin metadata for the next ClawHub release

## 0.1.4

- render readme images on package pages
- keep unused image assets out of the package

## 0.1.3

- ship the helper skill inside the plugin package
- verify packaged files before publishing

## 0.1.2

- delegate local command execution to the OpenClaw runtime command helper

## 0.1.1

- require OpenClaw 2026.5.3 beta or newer for ClawHub npm-pack installs

## 0.1.0

Initial KleinClaw package.

- registers typed OpenClaw tools for a local Kleinanzeigen helper workflow
- keeps credentials and full config contents outside the plugin
- scopes ad reads, drafts, and operations to configured ad roots
- defaults drafts to inactive and blocks scoped publish for inactive ads
- adds approval prompts, confirm flags, output caps, and redaction
- includes browser status/config/check helpers for browser settings
