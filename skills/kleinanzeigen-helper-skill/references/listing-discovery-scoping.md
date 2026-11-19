## Listing Discovery and Scoping

- When the user asks for a specific listing, resolve it with
  `kleinanzeigen_find_ad` (internal ID, Kleinanzeigen ID, or title words) before
  publishing, updating, deleting, downloading, or extending. Ask when the result
  is ambiguous.
- Scope the next calls with `internalIds`. `adDirectories` or `adConfigPaths`
  remain for ads without an internal ID. Avoid broad selectors like `all`
  unless the user explicitly wants a broad operation.
- For a single listing request such as "publish the sample listing", first list
  with a query, then verify or publish only the matching relative handle.
- `kleinanzeigen_delete` needs explicit `adIds` or `internalIds`; internal IDs
  are mapped to the current Kleinanzeigen IDs.
