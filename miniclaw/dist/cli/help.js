const CONFIG_SCHEMA_URL = "miniclaw://schemas/config.schema.json";
export const VERSION = "2026+miniclaw";
export const DEFAULT_CONFIG = `# yaml-language-server: $schema=${CONFIG_SCHEMA_URL}
ad_files:
  - "./**/ad_*.{json,yml,yaml}"

ad_defaults:
  active: true
  type: OFFER
  description_prefix: ""
  description_suffix: ""
  price_type: NEGOTIABLE
  shipping_type: SHIPPING
  sell_directly: false
  images: []
  contact:
    name: ""
    street: ""
    zipcode: ""
    location: ""
    phone: ""
  republication_interval: 7

categories: {}

browser:
  arguments: []
  binary_location: ""
  extensions: []
  use_private_window: true
  user_data_dir: ""
  profile_name: ""

login:
  username: "changeme"
  password: "changeme"

update_check:
  enabled: true
  channel: latest
  interval: 7d
`;
export function usage() {
    return `Usage: miniclaw COMMAND [OPTIONS]

Commands:
  publish  - (re-)publishes ads
  verify   - verifies the configuration files
  delete   - deletes ads
  update   - updates published ads
  extend   - extends ads within the 8-day window before expiry
  download - downloads one or multiple ads
  update-check - checks for available updates
  update-content-hash - recalculates each ad's content_hash
  create-config - creates a new default configuration file
  diagnose - diagnoses browser connection issues
  market-search - reads comparable listings and their price spread (read-only)
  messages - reads conversations of the message box (read-only)
  send-message - sends one reply in a conversation about one of the account's ads
  --
  help     - displays this help
  version  - displays the application version

Options:
  --ads=all|due|new|changed|<id(s)>
  --force
  --keep-old
  --fill-only
  --allow-live-browser
  --query=<TEXT> [--category-id=<ID>] [--min-price=<EUR>] [--max-price=<EUR>] [--pages=1-3]
  --conversation=<ID> [--limit=<N>] [--include-buyer]
  --conversation=<ID> --text=<TEXT> --after=<MESSAGE ID> --ad-id=<ID> [--min-price=<EUR>] [--mark-read]
  --download-dir=<PATH> (download only: overrides download.dir)
  --config=<PATH>
  --workspace-mode=portable|xdg
  --logfile=<PATH>
  --lang=en|de
  -v, --verbose
`;
}
