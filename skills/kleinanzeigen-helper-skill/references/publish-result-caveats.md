## Publish Result Caveats

- Check the structured `outcome` first. Success evidence can include `DONE:`
  counts, published or updated IDs, selected ad config changes observed after
  miniclaw exits, or another explicit success signal returned by KleinClaw.
- If the structured result is empty, times out, reports a noisy process exit, or
  stops after browser interaction, do not assume failure automatically.
- If the result is unclear, tell the user what happened and suggest checking the
  listing on Kleinanzeigen or rerunning a scoped list, verify, or download when
  appropriate.
- `succeeded_with_process_timeout` means the ad is online and its ID is saved;
  report it as success.
- `timed_out` with `uncertain: true` after publish: the ad may be online
  without its new ID saved locally. Never publish it again in that state. Ask
  the user to look at "Meine Anzeigen", or run `kleinanzeigen_download` with
  `selector: "new"` to find online ads missing locally, then record the ID with
  `kleinanzeigen_set_ad_fields` `publishedAdId`.
- Always pass `timeoutMs: 600000` to tools whose description asks for it
  (publish, update, delete, download, extend, verify, sync, sync_check, market
  search, messages, browser check). Without it some agent harnesses stop the
  call after 90 seconds and report a timeout although the browser run goes on
  in the background and may still publish the ad.
- After such a harness timeout, never repeat the action right away. Wait a few
  minutes, then check the local ad (`kleinanzeigen_read_ad`: did `id` or
  `updated_on` change?) before doing anything else.
- Publish one ad per call. Several ads in one call add up and make a timeout
  more likely.
- Treat `Approval timed out` as an OpenClaw/tool approval timing issue, not as a
  Kleinanzeigen runtime failure. Retry only after the user confirms again.
