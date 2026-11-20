import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OPERATIONS = Object.freeze({
  verify: { command: "verify", sideEffect: false },
  diagnose: { command: "diagnose", sideEffect: false },
  publish: { command: "publish", sideEffect: true, defaultSelector: "due" },
  update: { command: "update", sideEffect: true, defaultSelector: "changed" },
  delete: { command: "delete", sideEffect: true, requiresIds: true },
  download: { command: "download", sideEffect: true, defaultSelector: "new" },
  extend: { command: "extend", sideEffect: true, defaultSelector: "all" },
});

const LOCAL_AD_ID_SCOPE_OPERATIONS = new Set(["publish", "update", "delete", "extend"]);
const ALLOWED_ENV_KEYS = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_MESSAGES",
  "LOGNAME",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);

const SECRET_ENV_RE = /(api|auth|cookie|credential|key|login|pass|secret|session|sms|token|user)/i;
const SENSITIVE_LINE_RE = new RegExp(
  [
    "\\b(",
    "password|passwd|username|login|cookie|session|token|secret|credential",
    "|2fa|sms|user[_-]?data[_-]?dir|profile_name|browser profile",
    ")\\b",
  ].join(""),
  "i",
);
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const USER_ACTION_RE = new RegExp(
  [
    "\\b(",
    "press (enter|a key)|when done|manual inspection|please solve",
    "|eof when reading a line|eoferror",
    "|captcha (present|detected|recognized|erkannt|vorhanden)",
    "|captcha erkannt|bitte lösen|eingabetaste drücken",
    ")\\b",
  ].join(""),
  "i",
);
const USER_ACTION_HINT = [
  "The miniclaw runtime stopped or paused for an account check.",
  "Run it directly in a terminal/browser, finish that step, then retry this tool.",
].join(" ");
const STATUS_TIMEOUT_MS = 15000;
// Live runs start a browser, log in, upload images and wait for Kleinanzeigen;
// killing them midway can leave a submitted ad without its saved ID.
const DEFAULT_LIVE_TIMEOUT_MS = 600000;
const MAX_LIVE_TIMEOUT_MS = 1800000;
const STATUS_OUTPUT_CHARS = 3000;
const AD_FILE_NAMES = ["ad.yaml", "ad.yml", "ad.json"];
const DRAFT_AD_FILE_NAMES = ["ad.yaml", "ad.yml"];
const SUPPORTED_IMAGE_EXTENSIONS = new Set([".gif", ".jpg", ".jpeg", ".png"]);
const IMAGE_FILE_EXTENSIONS = new Set([...SUPPORTED_IMAGE_EXTENSIONS, ".webp", ".avif", ".heic"]);
const AD_TITLE_MIN_LENGTH = 10;
const AD_TITLE_MAX_LENGTH = 65;
const AD_DESCRIPTION_MAX_LENGTH = 4000;
const PRICE_TYPES = ["FIXED", "NEGOTIABLE", "GIVE_AWAY", "NOT_APPLICABLE"];
const AD_TYPES = ["OFFER", "WANTED"];
const SHIPPING_TYPES = ["PICKUP", "SHIPPING", "NOT_APPLICABLE"];
const SHIPPING_OPTIONS = [
  "DHL_2",
  "Hermes_Päckchen",
  "Hermes_S",
  "DHL_5",
  "Hermes_M",
  "DHL_10",
  "DHL_20",
  "DHL_31,5",
  "Hermes_L",
];
const CONDITION_VALUES = ["new", "like_new", "ok", "alright", "defect"];
const MINICLAW_DEFAULT_BROWSER_ORDER = [
  "chromium",
  "chromium-browser",
  "google-chrome",
  "microsoft-edge",
];
const EMBEDDED_MINICLAW_CLI = fileURLToPath(
  new URL("../miniclaw/dist/cli.js", import.meta.url),
);
const BROWSER_CHOICES = Object.freeze({
  chromium: {
    label: "Chromium",
    commands: ["chromium", "chromium-browser"],
    profileDir: [".config", "chromium"],
    supportedByMiniclaw: true,
  },
  brave: {
    label: "Brave",
    commands: ["brave", "brave-browser"],
    profileDir: [".config", "BraveSoftware", "Brave-Browser"],
    supportedByMiniclaw: false,
    supportNote: "not documented or auto-detected by miniclaw",
  },
  "google-chrome": {
    label: "Google Chrome",
    commands: ["google-chrome", "google-chrome-stable"],
    profileDir: [".config", "google-chrome"],
    supportedByMiniclaw: true,
  },
  "microsoft-edge": {
    label: "Microsoft Edge",
    commands: ["microsoft-edge", "microsoft-edge-stable"],
    profileDir: [".config", "microsoft-edge"],
    supportedByMiniclaw: true,
  },
});
const SUPPORTED_BROWSER_IDS = Object.freeze(
  Object.entries(BROWSER_CHOICES)
    .filter(([, choice]) => choice.supportedByMiniclaw)
    .map(([id]) => id),
);
const BROWSER_COMMAND_ALIASES = Object.freeze(
  Object.fromEntries(
    Object.entries(BROWSER_CHOICES).flatMap(([id, choice]) =>
      choice.commands.map((command) => [command, id]),
    ),
  ),
);

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWorkspaceMode(value) {
  const mode = normalizeOptionalString(value) ?? "portable";
  if (!["portable", "xdg"].includes(mode)) {
    throw new Error("workspaceMode must be portable or xdg");
  }
  return mode;
}

function normalizePositiveInteger(value, fallback, min, max) {
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.min(Math.max(value, min), max);
}

function embeddedMiniclawRuntime() {
  return {
    argsPrefix: [EMBEDDED_MINICLAW_CLI],
    command: process.execPath,
    label: "miniclaw",
  };
}

function normalizeAdIds(value) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("adIds must be an array");
  }
  const ids = value.map((entry) => String(entry).trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("adIds must not be empty");
  }
  for (const id of ids) {
    if (!/^\d+$/.test(id)) {
      throw new Error("adIds may contain only numeric ad IDs");
    }
  }
  return ids;
}

function normalizeSelector(value, allowed, fallback) {
  const selector = normalizeOptionalString(value) ?? fallback;
  if (selector && !allowed.includes(selector)) {
    throw new Error(`selector must be one of: ${allowed.join(", ")}`);
  }
  return selector;
}

function normalizeSelectorList(value, allowed) {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("selectors must be an array");
  }
  const selectors = value.map((entry) => String(entry).trim()).filter(Boolean);
  if (selectors.length === 0) {
    throw new Error("selectors must not be empty");
  }
  for (const selector of selectors) {
    if (!allowed.includes(selector)) {
      throw new Error(`selectors must contain only: ${allowed.join(", ")}`);
    }
  }
  return [...new Set(selectors)];
}

function normalizeStringArray(value, name, { maxItems = 20 } = {}) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  const values = value.map((entry) => String(entry).trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  if (values.length > maxItems) {
    throw new Error(`${name} must contain at most ${maxItems} entries`);
  }
  return [...new Set(values)];
}

function requireConfirmed(operation, params) {
  if (OPERATIONS[operation]?.sideEffect && params.confirm !== true) {
    throw new Error("confirm must be true for this account-changing operation");
  }
}

export function buildKleinanzeigenArgs(operation, params = {}, config = {}) {
  const spec = OPERATIONS[operation];
  if (!spec) {
    throw new Error(`unsupported operation: ${operation}`);
  }

  requireConfirmed(operation, params);

  const args = [];
  const configPath = normalizeOptionalString(config.configPath);
  const workspaceMode = normalizeWorkspaceMode(config.workspaceMode);
  const lang = normalizeOptionalString(config.lang);

  if (!configPath) {
    throw new Error("plugin config must set configPath or workingDirectory");
  }
  args.push(`--config=${configPath}`);
  args.push("--logfile=");
  args.push(`--workspace-mode=${workspaceMode}`);
  for (const adFileOverride of normalizeStringArray(config.adFileOverrides, "adFileOverrides", {
    maxItems: 50,
  })) {
    args.push(`--ad-file=${adFileOverride}`);
  }
  if (lang) {
    if (!["en", "de"].includes(lang)) {
      throw new Error("lang must be en or de");
    }
    args.push(`--lang=${lang}`);
  }
  if (spec.sideEffect) {
    args.push("--allow-live-browser");
  }

  args.push(spec.command);

  if (["verify", "diagnose"].includes(operation)) {
    return args;
  }

  const adIds = normalizeAdIds(params.adIds);
  if (adIds && (params.selector !== undefined || params.selectors !== undefined)) {
    throw new Error("adIds cannot be combined with selectors");
  }
  if (spec.requiresIds && !adIds) {
    throw new Error("adIds are required for delete");
  }

  const selectorByOperation = {
    publish: ["due", "new", "changed", "all"],
    update: ["changed", "all"],
    download: ["new", "all"],
    extend: ["all"],
  };
  const allowedSelectors = selectorByOperation[operation];

  if (params.selector !== undefined && params.selectors !== undefined) {
    throw new Error("selector and selectors cannot be combined");
  }

  const ads =
    adIds?.join(",") ??
    (allowedSelectors
      ? (operation === "publish" && params.selectors !== undefined
          ? normalizeSelectorList(params.selectors, allowedSelectors)?.join(",")
          : normalizeSelector(params.selector, allowedSelectors, spec.defaultSelector))
      : undefined);

  if (ads) {
    args.push(`--ads=${ads}`);
  }

  if (operation === "publish" && params.keepOld === true) {
    args.push("--keep-old");
  }
  if (operation === "publish" && params.fillOnly === true) {
    args.push("--fill-only");
  }

  return args;
}

export function buildChildEnv(sourceEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!ALLOWED_ENV_KEYS.has(key) || SECRET_ENV_RE.test(key) || value === undefined) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export function buildRedactions(config = {}) {
  const values = [];
  const add = (value) => {
    if (typeof value === "string" && value.trim()) {
      values.push(value.trim());
    }
  };

  add(config.workingDirectory);
  add(config.configPath);
  if (config.runtime) {
    add(config.runtime.command);
    for (const arg of config.runtime.argsPrefix ?? []) {
      add(arg);
    }
  }
  for (const adFileOverride of Array.isArray(config.adFileOverrides)
    ? config.adFileOverrides
    : []) {
    add(adFileOverride);
  }
  for (const root of Array.isArray(config.adRoots) ? config.adRoots : []) {
    add(root);
  }
  if (typeof config.configPath === "string" && config.configPath.trim()) {
    const parent = path.dirname(config.configPath.trim());
    if (parent !== "." && parent !== path.parse(parent).root) {
      add(parent);
    }
  }

  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

export function sanitizeText(text, redactions = [], maxChars = 6000) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const sanitizedLines = normalized.split("\n").map((line) => {
    if (SENSITIVE_LINE_RE.test(line)) {
      return "[redacted sensitive line]";
    }

    let next = line.replace(EMAIL_RE, "[redacted-email]");
    for (const raw of redactions) {
      const value = String(raw).trim();
      if (value) {
        next = next.split(value).join("[redacted-path]");
      }
    }
    return next;
  });

  const sanitized = sanitizedLines.join("\n").trim();
  if (maxChars <= 0) {
    return "";
  }
  if (sanitized.length <= maxChars) {
    return sanitized;
  }
  return `${sanitized.slice(0, maxChars)}\n[truncated]`;
}

export function redactArgs(args = []) {
  return args.map((arg) => {
    if (arg.startsWith("--config=")) {
      return "--config=[redacted]";
    }
    if (arg === "--logfile=") {
      return arg;
    }
    if (arg.startsWith("--logfile=")) {
      return "--logfile=[redacted]";
    }
    if (arg.startsWith("--ad-file=")) {
      return "--ad-file=[redacted]";
    }
    return arg;
  });
}

export function detectUserActionRequest(text) {
  return {
    needsUserAction: USER_ACTION_RE.test(String(text ?? "")),
    userActionHint: USER_ACTION_HINT,
  };
}

function localSuccessProcessFields() {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    needsUserAction: false,
    stdout: "",
    stderr: "",
  };
}

export function resolveCliConfig(config = {}) {
  const configuredConfigPath = normalizeOptionalString(config.configPath);
  const configuredCwd = normalizeOptionalString(config.workingDirectory);
  const configPath =
    configuredConfigPath ?? (configuredCwd ? path.join(configuredCwd, "config.yaml") : undefined);
  if (!configPath) {
    throw new Error("plugin config must set configPath or workingDirectory");
  }
  const cwd = configuredCwd ?? path.dirname(configPath);

  return {
    cwd,
    configPath,
    runtime: embeddedMiniclawRuntime(),
    workspaceMode: normalizeWorkspaceMode(config.workspaceMode),
    lang: normalizeOptionalString(config.lang),
    timeoutMs: normalizePositiveInteger(config.timeoutMs, 120000, 1000, 600000),
    liveTimeoutMs: normalizePositiveInteger(
      config.liveTimeoutMs,
      Math.max(normalizePositiveInteger(config.timeoutMs, 120000, 1000, 600000), DEFAULT_LIVE_TIMEOUT_MS),
      1000,
      MAX_LIVE_TIMEOUT_MS,
    ),
    maxOutputChars: normalizePositiveInteger(config.maxOutputChars, 6000, 0, 20000),
    commandRunner: typeof config.commandRunner === "function" ? config.commandRunner : undefined,
  };
}

function resolveConfiguredConfigPath(config = {}) {
  const configuredConfigPath = normalizeOptionalString(config.configPath);
  const configuredCwd = normalizeOptionalString(config.workingDirectory);
  return configuredConfigPath ?? (configuredCwd ? path.join(configuredCwd, "config.yaml") : undefined);
}

async function assertConfiguredFiles(config) {
  try {
    const stat = await fs.stat(config.configPath);
    if (!stat.isFile()) {
      throw new Error("configured miniclaw config is not a file");
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("configured miniclaw config was not found");
    }
    throw error;
  }
}

async function realPath(value) {
  return fs.realpath(path.resolve(value));
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertInsideAdRoots(filePath, config = {}) {
  const configuredRoots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  const fallbackRoots = [
    normalizeOptionalString(config.workingDirectory),
    normalizeOptionalString(config.configPath)
      ? path.dirname(normalizeOptionalString(config.configPath))
      : undefined,
  ].filter(Boolean);
  const roots = configuredRoots.length ? configuredRoots : fallbackRoots;
  if (!roots.length) {
    throw new Error("plugin config must set adRoots to use adConfigPaths or adDirectories");
  }

  const resolvedFile = await realPath(filePath);
  const resolvedRoots = await Promise.all(roots.map((root) => realPath(root)));
  if (!resolvedRoots.some((root) => pathIsInside(resolvedFile, root))) {
    throw new Error("ad config path is outside configured adRoots");
  }
  return resolvedFile;
}

async function configuredAdRoots(config = {}) {
  const roots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  if (!roots.length) {
    throw new Error("plugin config must set adRoots for ad authoring tools");
  }

  const resolved = [];
  for (const root of roots) {
    const realRoot = await realPath(root);
    const stat = await fs.stat(realRoot);
    if (!stat.isDirectory()) {
      throw new Error("configured adRoot is not a directory");
    }
    resolved.push(realRoot);
  }
  return resolved;
}

async function nearestExistingParent(candidate) {
  let current = path.resolve(candidate);
  for (;;) {
    try {
      const stat = await fs.stat(current);
      if (stat.isDirectory()) {
        return current;
      }
      return path.dirname(current);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error("no existing parent directory found");
      }
      current = parent;
    }
  }
}

async function resolveWritableAdDirectory(directory, config = {}) {
  const roots = await configuredAdRoots(config);
  const rawDirectory = normalizeOptionalString(directory);
  if (!rawDirectory) {
    throw new Error("directory is required");
  }

  const candidate = path.isAbsolute(rawDirectory)
    ? path.resolve(rawDirectory)
    : path.resolve(roots[0], rawDirectory);
  const parent = await nearestExistingParent(candidate);
  const resolvedParent = await realPath(parent);
  const matchingRoot = roots.find((root) => pathIsInside(resolvedParent, root));
  if (!matchingRoot || !pathIsInside(candidate, matchingRoot)) {
    throw new Error("directory is outside configured adRoots");
  }

  return { directory: candidate, root: matchingRoot };
}

async function resolveAdConfigInDirectory(directory) {
  for (const filename of AD_FILE_NAMES) {
    const candidate = path.join(directory, filename);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  throw new Error("ad directory has no ad.yaml, ad.yml, or ad.json");
}

function stripYamlScalar(value) {
  const raw = String(value ?? "").trim();
  const withoutComment = raw.startsWith("#") ? "" : raw.replace(/\s+#.*$/, "").trim();
  if (
    (withoutComment.startsWith('"') && withoutComment.endsWith('"')) ||
    (withoutComment.startsWith("'") && withoutComment.endsWith("'"))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
}

function quoteYamlScalar(value) {
  return JSON.stringify(String(value ?? ""));
}

function snakeCaseKey(key) {
  return String(key).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function normalizeObject(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function normalizeAdDraftString(value, name, { required = false, maxLength } = {}) {
  if (value === undefined) {
    if (required) {
      throw new Error(`${name} is required`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const next = value.trim();
  if (required && !next) {
    throw new Error(`${name} must not be empty`);
  }
  if (maxLength !== undefined && next.length > maxLength) {
    throw new Error(`${name} length exceeds ${maxLength} characters`);
  }
  return next;
}

function normalizeEnum(value, name, allowed) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function normalizeNumber(value, name, { integer = false, min } = {}) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a number`);
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (min !== undefined && value < min) {
    throw new Error(`${name} must be at least ${min}`);
  }
  return value;
}

function normalizeStringMap(value, name) {
  const object = normalizeObject(value, name);
  if (object === undefined) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key, entry]) => String(key).trim() && entry !== undefined && entry !== null)
      .map(([key, entry]) => [String(key).trim(), String(entry).trim()]),
  );
}

function rejectUnsafeRelativePattern(value, name) {
  const pattern = normalizeAdDraftString(value, name, { required: true });
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new Error(`${name} must be relative to the ad directory`);
  }
  return pattern;
}

function yamlScalar(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (typeof value === "boolean" || typeof value === "number") {
    return `${value}`;
  }
  if (value === null) {
    return "";
  }
  const text = String(value ?? "");
  if (text.includes("\n")) {
    const lines = text.split("\n");
    return `|\n${lines.map((line) => `${pad}  ${line}`).join("\n")}`;
  }
  return quoteYamlScalar(text);
}

function yamlLinesForEntry(key, value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) {
      return [`${pad}${key}: []`];
    }
    return [
      `${pad}${key}:`,
      ...value.map((entry) => `${pad}  - ${yamlScalar(entry, indent + 2)}`),
    ];
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (!entries.length) {
      return [`${pad}${key}: {}`];
    }
    return [
      `${pad}${key}:`,
      ...entries.flatMap(([childKey, entry]) =>
        yamlLinesForEntry(snakeCaseKey(childKey), entry, indent + 2),
      ),
    ];
  }
  return [`${pad}${key}: ${yamlScalar(value, indent)}`];
}

function renderAdYaml(ad) {
  const schemaRef = "miniclaw://schemas/ad.schema.json";
  const order = [
    "active",
    "type",
    "title",
    "description",
    "descriptionPrefix",
    "descriptionSuffix",
    "category",
    "specialAttributes",
    "price",
    "priceType",
    "autoPriceReduction",
    "shippingType",
    "shippingCosts",
    "shippingOptions",
    "sellDirectly",
    "images",
    "contact",
    "republicationInterval",
  ];
  const lines = [
    `# yaml-language-server: $schema=${schemaRef}`,
  ];

  for (const key of order) {
    if (ad[key] !== undefined) {
      lines.push(...yamlLinesForEntry(snakeCaseKey(key), ad[key]));
    }
  }
  return `${lines.join("\n")}\n`;
}

function sanitizeAdYaml(text, { includeContact = false } = {}) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const sanitized = [];
  let inContact = false;

  for (const line of lines) {
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      inContact = /^contact\s*:/.test(line);
      sanitized.push(line);
      continue;
    }
    if (!includeContact && inContact && /^\s+[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      sanitized.push(line.replace(/:\s*.*$/, ": [redacted-contact]"));
      continue;
    }
    sanitized.push(line);
  }
  return sanitized.join("\n").trim();
}

function setYamlTopLevelActive(text, active) {
  return setYamlTopLevelScalar(text, "active", active ? "true" : "false");
}

/** Replaces or inserts one top-level `key: value` line; `value` is already YAML. */
function setYamlTopLevelScalar(text, key, value) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const nextLine = `${key}: ${value}`;
  const keyIndex = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (keyIndex !== -1) {
    const next = [...lines];
    next[keyIndex] = nextLine;
    return next.join("\n");
  }

  let insertAt = 0;
  while (
    insertAt < lines.length &&
    (lines[insertAt].trim() === "" || lines[insertAt].trimStart().startsWith("#"))
  ) {
    insertAt += 1;
  }

  const next = [...lines];
  next.splice(insertAt, 0, nextLine);
  return next.join("\n");
}

function findTopLevelYamlSection(lines, key) {
  const start = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (start === -1) {
    return null;
  }

  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(line)) {
      break;
    }
    end += 1;
  }
  return { start, end };
}

function parseBrowserConfigText(text) {
  const config = {
    arguments: [],
    binary_location: "",
    use_private_window: true,
    user_data_dir: "",
    profile_name: "",
  };
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const section = findTopLevelYamlSection(lines, "browser");
  if (!section) {
    return { ...config, configured: false };
  }

  let currentKey = "";
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    const direct = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (direct) {
      currentKey = direct[1];
      const value = stripYamlScalar(direct[2]);
      if (currentKey === "binary_location") {
        config.binary_location = value;
      } else if (currentKey === "use_private_window") {
        config.use_private_window = value === "true";
      } else if (currentKey === "user_data_dir") {
        config.user_data_dir = value;
      } else if (currentKey === "profile_name") {
        config.profile_name = value;
      } else if (currentKey === "arguments" && value === "[]") {
        config.arguments = [];
      }
      continue;
    }

    const listEntry = currentKey === "arguments" ? /^\s+-\s*(.+?)\s*$/.exec(line) : null;
    if (listEntry) {
      const value = stripYamlScalar(listEntry[1]);
      if (value) {
        config.arguments.push(value);
      }
    }
  }

  return { ...config, configured: true };
}

function normalizeBrowserName(value) {
  const browser = normalizeOptionalString(value);
  if (browser === undefined) {
    return undefined;
  }
  if (browser !== "auto" && !SUPPORTED_BROWSER_IDS.includes(browser)) {
    throw new Error(
      `browser must be one of: auto, ${SUPPORTED_BROWSER_IDS.join(", ")}`,
    );
  }
  return browser;
}

function normalizeBoolean(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

function normalizeProfileMode(value) {
  const mode = normalizeOptionalString(value);
  if (mode === undefined) {
    return undefined;
  }
  if (!["workspace", "system-default", "custom"].includes(mode)) {
    throw new Error("profileMode must be workspace, system-default, or custom");
  }
  return mode;
}

function normalizeOptionalPathSetting(value, name) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value.trim();
}

function assertSafeBrowserConfigureParams(params = {}) {
  const forbidden = [
    "binaryLocation",
    "allowUnsupportedBrowser",
    "userDataDir",
  ].filter((key) => params[key] !== undefined);
  if (forbidden.length > 0) {
    throw new Error(
      `${forbidden.join(", ")} cannot be changed through browser_configure; ` +
        "edit the local miniclaw config outside OpenClaw",
    );
  }
  if (params.profileMode === "custom") {
    throw new Error(
      "profileMode custom cannot be persisted through browser_configure; " +
        "edit the local miniclaw config outside OpenClaw",
    );
  }
  if (params.profileName !== undefined && params.profileMode !== "system-default") {
    throw new Error("profileName requires profileMode system-default");
  }
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function browserSearchPaths(sourceEnv = process.env) {
  return uniqueValues([
    ...(sourceEnv.PATH ? sourceEnv.PATH.split(path.delimiter) : []),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/opt/brave-bin",
  ]);
}

async function fileIsExecutable(filePath) {
  try {
    await fs.access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(command, sourceEnv = process.env) {
  if (!command) {
    return null;
  }
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    const resolved = path.resolve(command);
    return (await fileIsExecutable(resolved)) ? resolved : null;
  }

  for (const directory of browserSearchPaths(sourceEnv)) {
    const candidate = path.join(directory, command);
    if (await fileIsExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolveBrowserChoice(browser, sourceEnv = process.env) {
  const choice = BROWSER_CHOICES[browser];
  if (!choice) {
    return null;
  }
  for (const command of choice.commands) {
    const executable = await findExecutable(command, sourceEnv);
    if (executable) {
      return executable;
    }
  }
  return null;
}

function inferBrowserIdFromExecutable(executable) {
  const lower = path.basename(String(executable ?? "")).toLowerCase().replace(/\.exe$/, "");
  if (Object.hasOwn(BROWSER_COMMAND_ALIASES, lower)) {
    return BROWSER_COMMAND_ALIASES[lower];
  }
  const full = String(executable ?? "").toLowerCase();
  if (full.includes("brave")) {
    return "brave";
  }
  if (full.includes("chromium")) {
    return "chromium";
  }
  if (full.includes("chrome")) {
    return "google-chrome";
  }
  if (full.includes("edge") || full.includes("msedge")) {
    return "microsoft-edge";
  }
  return null;
}

async function browserVersion(executable, commandRunner) {
  if (!executable) {
    return "";
  }
  const result = await runProcess(executable, ["--version"], {
    timeoutMs: 4000,
    maxBufferChars: 500,
    env: buildChildEnv(),
    commandRunner,
  });
  return firstNonEmptyLine([result.stdout, result.stderr].filter(Boolean).join("\n"));
}

async function detectInstalledBrowsers({ sourceEnv = process.env, commandRunner } = {}) {
  const detected = [];
  for (const [id, choice] of Object.entries(BROWSER_CHOICES)) {
    const executable = await resolveBrowserChoice(id, sourceEnv);
    detected.push({
      id,
      label: choice.label,
      commands: choice.commands,
      installed: Boolean(executable),
      executable,
      version: executable ? await browserVersion(executable, commandRunner) : "",
      supportedByMiniclaw: choice.supportedByMiniclaw,
      supportNote: choice.supportNote ?? "",
      miniclawAutoDefault: choice.commands.some((command) =>
        MINICLAW_DEFAULT_BROWSER_ORDER.includes(command),
      ),
    });
  }
  return detected;
}

function effectiveMiniclawAutoBrowser(detectedBrowsers) {
  for (const command of MINICLAW_DEFAULT_BROWSER_ORDER) {
    const browser = detectedBrowsers.find((entry) => entry.commands.includes(command));
    if (browser?.installed) {
      return browser;
    }
  }
  return null;
}

function displayWorkspaceBrowserPath(filePath, baseDir) {
  if (!filePath) {
    return "";
  }
  const resolved = path.resolve(baseDir, filePath);
  const relative = path.relative(baseDir, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return relative || ".";
  }
  return `[redacted-path]/${path.basename(resolved)}`;
}

function displayBrowserProfilePath(filePath, baseDir, { allowWorkspaceProfile = false } = {}) {
  if (!filePath) {
    return "";
  }
  if (allowWorkspaceProfile) {
    const workspaceProfile = path.join(baseDir, ".temp", "browser-profile");
    if (path.resolve(baseDir, filePath) === workspaceProfile) {
      return displayWorkspaceBrowserPath(filePath, baseDir);
    }
  }
  return "[configured-profile-dir]";
}

function redactBrowserArgument(argument, baseDir) {
  if (String(argument).startsWith("--remote-debugging-token=")) {
    return "--remote-debugging-token=[redacted]";
  }
  const match = /^--user-data-dir=(.*)$/.exec(argument);
  if (!match) {
    return argument;
  }
  return `--user-data-dir=${displayBrowserProfilePath(
    match[1].replace(/^["']|["']$/g, ""),
    baseDir,
  )}`;
}

function displayProfileName(profileName) {
  return profileName ? "[configured-profile]" : "";
}

function profileDirForBrowser(browser) {
  const choice = BROWSER_CHOICES[browser];
  if (!choice) {
    return "";
  }
  return path.join(os.homedir(), ...choice.profileDir);
}

function browserArgumentValue(args, flag) {
  const prefix = `${flag}=`;
  const match = (args ?? []).find((entry) => String(entry).startsWith(prefix));
  return match ? String(match).slice(prefix.length).trim() : "";
}

function buildBrowserStatusPayload({ cliConfig, browserConfig, detectedBrowsers }) {
  const autoBrowser = effectiveMiniclawAutoBrowser(detectedBrowsers);
  const configuredBinaryLocation = browserConfig.binary_location;
  const configuredBrowser = configuredBinaryLocation
    ? inferBrowserIdFromExecutable(configuredBinaryLocation)
    : "auto";
  const effectiveBrowser = configuredBinaryLocation
    ? detectedBrowsers.find((entry) => entry.id === configuredBrowser) ?? {
        id: configuredBrowser,
        executable: configuredBinaryLocation,
      }
    : autoBrowser;
  const expectedWorkspaceProfileDir =
    !browserConfig.user_data_dir && cliConfig.workspaceMode === "portable"
      ? path.join(cliConfig.cwd, ".temp", "browser-profile")
      : "";
  const remotePort = browserArgumentValue(browserConfig.arguments, "--remote-debugging-port");
  const connection = remotePort
    ? {
        mode: "connect",
        remoteHost:
          browserArgumentValue(browserConfig.arguments, "--remote-debugging-host") || "127.0.0.1",
        remotePort: Number(remotePort),
        accessTokenConfigured: Boolean(
          browserArgumentValue(browserConfig.arguments, "--remote-debugging-token"),
        ),
        note: "miniclaw attaches to an already running browser; local binary, " +
          "private-window, and profile settings below are not used.",
      }
    : { mode: "launch" };

  return {
    ok: true,
    operation: "browser_status",
    configFile: {
      configured: true,
      exists: true,
      isFile: true,
    },
    connection,
    browser: {
      supportedChoices: ["auto", ...SUPPORTED_BROWSER_IDS],
      configured: {
        browser: configuredBrowser,
        binaryLocation: configuredBinaryLocation,
        usePrivateWindow: browserConfig.use_private_window,
        userDataDir: displayBrowserProfilePath(browserConfig.user_data_dir, cliConfig.cwd),
        userDataDirConfigured: Boolean(browserConfig.user_data_dir),
        profileName: displayProfileName(browserConfig.profile_name),
        profileNameConfigured: Boolean(browserConfig.profile_name),
        arguments: browserConfig.arguments.map((entry) =>
          redactBrowserArgument(entry, cliConfig.cwd),
        ),
      },
      effective: {
        browser: effectiveBrowser?.id ?? null,
        binaryLocation: configuredBinaryLocation || autoBrowser?.executable || "",
        usePrivateWindow: browserConfig.use_private_window,
        userDataDir: displayBrowserProfilePath(
          browserConfig.user_data_dir || expectedWorkspaceProfileDir,
          cliConfig.cwd,
          { allowWorkspaceProfile: !browserConfig.user_data_dir },
        ),
        userDataDirConfigured: Boolean(browserConfig.user_data_dir),
        profileName: displayProfileName(browserConfig.profile_name) || "Default",
        profileNameConfigured: Boolean(browserConfig.profile_name),
      },
      notes: configuredBinaryLocation
        ? []
        : [
            "auto detection follows miniclaw order",
            "Brave is detected as a custom Chromium-family browser, not an official miniclaw choice",
          ],
    },
    detectedBrowsers,
    ...localSuccessProcessFields(),
  };
}

function scalarBrowserLine(indent, key, value) {
  const rendered = typeof value === "boolean" ? String(value) : quoteYamlScalar(value);
  return `${indent}${key}: ${rendered}`;
}

function replaceBrowserYaml(content, updates) {
  const normalized = String(content ?? "").replace(/\r\n/g, "\n");
  const hadTrailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (hadTrailingNewline) {
    lines.pop();
  }

  let section = findTopLevelYamlSection(lines, "browser");
  if (!section) {
    lines.push(
      "",
      "browser:",
      "  arguments: []",
      "  binary_location: \"\"",
      "  extensions: []",
      "  use_private_window: true",
      "  user_data_dir: \"\"",
      "  profile_name: \"\"",
    );
    section = findTopLevelYamlSection(lines, "browser");
  }

  const existingChild = lines
    .slice(section.start + 1, section.end)
    .map((line) => /^(\s+)[A-Za-z_][A-Za-z0-9_-]*\s*:/.exec(line)?.[1])
    .find(Boolean);
  const indent = existingChild ?? "  ";

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      continue;
    }

    let replaced = false;
    for (let index = section.start + 1; index < section.end; index += 1) {
      if (new RegExp(`^\\s+${key}\\s*:`).test(lines[index])) {
        lines[index] = scalarBrowserLine(indent, key, value);
        replaced = true;
        break;
      }
    }

    if (!replaced) {
      lines.splice(section.end, 0, scalarBrowserLine(indent, key, value));
      section.end += 1;
    }
  }

  return `${lines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

async function writeFileAtomic(filePath, content, mode) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const tmp = path.join(directory, `.${basename}.kleinclaw-${process.pid}-${Date.now()}.tmp`);
  try {
    await fs.writeFile(tmp, content, { encoding: "utf8", mode });
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

async function resolveBrowserUpdates(params = {}, cliConfig, currentBrowserConfig) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before changing browser config");
  }

  const browser = normalizeBrowserName(params.browser);
  const binaryLocation = normalizeOptionalPathSetting(params.binaryLocation, "binaryLocation");
  const userDataDir = normalizeOptionalPathSetting(params.userDataDir, "userDataDir");
  const profileName = normalizeOptionalPathSetting(params.profileName, "profileName");
  const profileMode = normalizeProfileMode(params.profileMode);
  const allowUnsupportedBrowser =
    normalizeBoolean(params.allowUnsupportedBrowser, "allowUnsupportedBrowser") ?? false;
  const updates = {};

  if (browser && binaryLocation) {
    throw new Error("browser cannot be combined with binaryLocation");
  }

  if (browser === "auto") {
    updates.binary_location = "";
  } else if (browser) {
    const executable = await resolveBrowserChoice(browser);
    if (!executable) {
      throw new Error(`${BROWSER_CHOICES[browser].label} executable was not found on PATH`);
    }
    updates.binary_location = executable;
  } else if (binaryLocation !== undefined) {
    if (!binaryLocation) {
      throw new Error("binaryLocation must not be empty");
    }
    const executable = path.resolve(cliConfig.cwd, binaryLocation);
    if (!(await fileIsExecutable(executable))) {
      throw new Error("binaryLocation does not point to an executable file");
    }
    const inferredBrowser = inferBrowserIdFromExecutable(executable);
    const browserChoice = inferredBrowser ? BROWSER_CHOICES[inferredBrowser] : null;
    if (!browserChoice?.supportedByMiniclaw && !allowUnsupportedBrowser) {
      throw new Error(
        "binaryLocation is not a supported miniclaw browser; " +
          "set allowUnsupportedBrowser true to try it as a custom Chromium-family executable",
      );
    }
    updates.binary_location = executable;
  }

  if (params.usePrivateWindow !== undefined) {
    updates.use_private_window = normalizeBoolean(params.usePrivateWindow, "usePrivateWindow");
  }

  if (profileMode === "workspace") {
    updates.user_data_dir = "";
    updates.profile_name = "";
  } else if (profileMode === "system-default") {
    const effectiveBinary = updates.binary_location ?? currentBrowserConfig.binary_location;
    const effectiveBrowser =
      browser && browser !== "auto"
        ? browser
        : inferBrowserIdFromExecutable(effectiveBinary) ?? inferBrowserIdFromExecutable(
            effectiveMiniclawAutoBrowser(
              await detectInstalledBrowsers({ commandRunner: cliConfig.commandRunner }),
            )?.executable,
          );
    const profileDir = profileDirForBrowser(effectiveBrowser);
    if (!profileDir) {
      throw new Error("profileMode system-default needs a known browser choice");
    }
    updates.user_data_dir = profileDir;
    updates.profile_name = profileName ?? "";
  } else if (profileMode === "custom") {
    if (userDataDir === undefined || !userDataDir) {
      throw new Error("profileMode custom requires userDataDir");
    }
    updates.user_data_dir = path.resolve(cliConfig.cwd, userDataDir);
    if (profileName !== undefined) {
      updates.profile_name = profileName;
    }
  } else {
    if (userDataDir !== undefined) {
      updates.user_data_dir = userDataDir ? path.resolve(cliConfig.cwd, userDataDir) : "";
    }
    if (profileName !== undefined) {
      updates.profile_name = profileName;
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new Error("provide at least one browser setting to change");
  }

  return updates;
}

function parseAdSummary(text) {
  const summary = {
    active: null,
    internalId: null,
    id: null,
    title: "",
    price: null,
    priceType: null,
    category: "",
    createdOn: null,
    updatedOn: null,
    republicationInterval: null,
    sold: false,
    soldOn: null,
    imageGlobs: [],
    imagesFingerprint: null,
    lastSyncedOn: null,
  };
  let inImages = false;

  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trimEnd();
    const topLevel = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (topLevel) {
      inImages = topLevel[1] === "images";
      const value = stripYamlScalar(topLevel[2]);
      if (topLevel[1] === "active") {
        summary.active = value === "true" ? true : value === "false" ? false : null;
      } else if (topLevel[1] === "id") {
        summary.id = value || null;
      } else if (topLevel[1] === INTERNAL_ID_KEY) {
        summary.internalId = parseInternalIdValue(value);
      } else if (topLevel[1] === IMAGES_FINGERPRINT_KEY) {
        summary.imagesFingerprint = value || null;
      } else if (topLevel[1] === "last_synced_on") {
        summary.lastSyncedOn = value || null;
      } else if (topLevel[1] === "title") {
        summary.title = value;
      } else if (topLevel[1] === "price") {
        summary.price = value || null;
      } else if (topLevel[1] === "price_type") {
        summary.priceType = value || null;
      } else if (topLevel[1] === "category") {
        summary.category = value;
      } else if (topLevel[1] === "created_on") {
        summary.createdOn = value || null;
      } else if (topLevel[1] === "updated_on") {
        summary.updatedOn = value || null;
      } else if (topLevel[1] === "republication_interval") {
        summary.republicationInterval = value ? Number(value) : null;
      } else if (topLevel[1] === "sold") {
        summary.sold = value === "true";
      } else if (topLevel[1] === "sold_on") {
        summary.soldOn = value || null;
      }
      continue;
    }

    const imageEntry = inImages ? /^\s*-\s*(.+?)\s*$/.exec(line) : null;
    if (imageEntry) {
      const imageGlob = stripYamlScalar(imageEntry[1]);
      if (imageGlob && !imageGlob.startsWith("#")) {
        summary.imageGlobs.push(imageGlob);
      }
    }
  }

  return summary;
}

function parseAdOperationState(text, filePath = "") {
  if (path.extname(filePath).toLowerCase() === ".json") {
    try {
      const parsed = JSON.parse(text);
      return {
        internalId: parseInternalIdValue(parsed.internal_id),
        id: parsed.id ? String(parsed.id) : null,
        title: typeof parsed.title === "string" ? parsed.title : "",
        updatedOn: typeof parsed.updated_on === "string" ? parsed.updated_on : "",
        createdOn: typeof parsed.created_on === "string" ? parsed.created_on : "",
        contentHash: typeof parsed.content_hash === "string" ? parsed.content_hash : "",
        repostCount: Number.isInteger(parsed.repost_count) ? parsed.repost_count : null,
      };
    } catch {
      return {
        internalId: null,
        id: null,
        title: "",
        updatedOn: "",
        createdOn: "",
        contentHash: "",
        repostCount: null,
      };
    }
  }

  const state = {
    internalId: null,
    id: null,
    title: "",
    updatedOn: "",
    createdOn: "",
    contentHash: "",
    repostCount: null,
  };

  for (const rawLine of String(text ?? "").split("\n")) {
    const topLevel = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine.trimEnd());
    if (!topLevel) {
      continue;
    }
    const key = topLevel[1];
    const value = stripYamlScalar(topLevel[2]);
    if (key === "id") {
      state.id = value || null;
    } else if (key === INTERNAL_ID_KEY) {
      state.internalId = parseInternalIdValue(value);
    } else if (key === "title") {
      state.title = value;
    } else if (key === "updated_on") {
      state.updatedOn = value;
    } else if (key === "created_on") {
      state.createdOn = value;
    } else if (key === "content_hash") {
      state.contentHash = value;
    } else if (key === "repost_count") {
      state.repostCount = /^\d+$/.test(value) ? Number(value) : null;
    }
  }

  return state;
}

async function readAdOperationSnapshots(adConfigPaths = [], config = {}) {
  const roots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  const resolvedRoots = roots.length
    ? await Promise.all(
        roots.map(async (entry) => realPath(entry).catch(() => null)),
      )
    : [];
  const snapshots = [];

  for (const adConfigPath of adConfigPaths) {
    try {
      const text = await fs.readFile(adConfigPath, "utf8");
      const displayRoot =
        resolvedRoots.find((root) => root && pathIsInside(adConfigPath, root)) ??
        path.dirname(adConfigPath);
      snapshots.push({
        path: adConfigPath,
        displayPath: displayPathForAd(adConfigPath, displayRoot),
        exists: true,
        ...parseAdOperationState(text, adConfigPath),
      });
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      snapshots.push({
        path: adConfigPath,
        displayPath: path.basename(adConfigPath),
        exists: false,
        internalId: null,
        id: null,
        title: "",
        updatedOn: "",
        createdOn: "",
        contentHash: "",
        repostCount: null,
      });
    }
  }

  return snapshots;
}

function operationDonePatterns(operation) {
  if (operation === "publish") {
    return [
      {
        re: /DONE:\s+\(Re-\)published\s+(\d+)\s+ads?(?:\s+\((\d+)\s+failed after retries\))?/i,
        verb: "published",
      },
      { re: /DONE:\s+No new\/outdated ads found\./i, verb: "no_op" },
    ];
  }
  if (operation === "update") {
    return [
      {
        re: /DONE:\s+updated\s+(\d+)\s+ads?(?:\s+\((\d+)\s+failed after retries\))?/i,
        verb: "updated",
      },
      { re: /DONE:\s+No changed ads found\./i, verb: "no_op" },
    ];
  }
  if (operation === "delete") {
    return [
      {
        re: /DONE:\s+Deleted\s+(\d+)\s+of\s+(\d+)/i,
        verb: "deleted",
        totalGroup: true,
      },
      { re: /DONE:\s+No ads to delete found\./i, verb: "no_op" },
    ];
  }
  if (operation === "extend") {
    return [
      { re: /DONE:\s+Extended\s+(\d+)\s+ads?/i, verb: "extended" },
      { re: /DONE:\s+No ads (?:found to extend|extended)\./i, verb: "no_op" },
    ];
  }
  return [];
}

function parseOperationDone(operation, text) {
  for (const pattern of operationDonePatterns(operation)) {
    const match = pattern.re.exec(text);
    if (!match) {
      continue;
    }
    if (pattern.verb === "no_op") {
      return { verb: "no_op", count: 0, failed: 0, total: 0 };
    }
    if (pattern.totalGroup) {
      const count = Number(match[1] ?? 0);
      const total = Number(match[2] ?? count);
      return {
        verb: pattern.verb,
        count,
        failed: Math.max(total - count, 0),
        total,
      };
    }
    const count = Number(match[1] ?? 0);
    const failed = Number(match[2] ?? 0);
    return {
      verb: pattern.verb,
      count,
      failed,
      total: match[2] !== undefined ? count + failed : count,
    };
  }
  return null;
}

function summarizeAdSnapshotChanges(before = [], after = []) {
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const next of after) {
    const previous = beforeByPath.get(next.path);
    if (!previous || !next.exists) {
      continue;
    }
    const changedFields = [];
    if (next.id && next.id !== previous.id) {
      changedFields.push("id");
    }
    if (next.updatedOn && next.updatedOn !== previous.updatedOn) {
      changedFields.push("updated_on");
    }
    if (next.contentHash && next.contentHash !== previous.contentHash) {
      changedFields.push("content_hash");
    }
    if (next.repostCount !== null && next.repostCount !== previous.repostCount) {
      changedFields.push("repost_count");
    }
    if (changedFields.length) {
      changes.push({
        adPath: next.displayPath,
        ...(next.internalId !== null ? { internalId: next.internalId } : {}),
        title: next.title || previous.title,
        id: next.id,
        ...(changedFields.includes("id") && previous.id ? { previousId: previous.id } : {}),
        changedFields,
      });
    }
  }
  return changes;
}

function extractSuccessIds(text) {
  return [...String(text ?? "").matchAll(/SUCCESS:\s+ad (?:published|updated) with ID\s+(\d+)/gi)]
    .map((match) => match[1])
    .filter(Boolean);
}

function buildOperationOutcome({ operation, result, rawText, beforeSnapshots, afterSnapshots }) {
  if (operation === "verify") {
    return {
      success: Boolean(result.ok),
      status: result.ok ? "succeeded" : "failed",
      summary: result.ok ? "verify completed successfully" : "verify failed",
      evidence: result.ok ? ["process exited successfully"] : [],
    };
  }

  const done = parseOperationDone(operation, rawText);
  const successIds = extractSuccessIds(rawText);
  const changedAdConfigs = summarizeAdSnapshotChanges(beforeSnapshots, afterSnapshots);
  const failedCount = done?.failed ?? 0;
  const successEvidence = [];

  if (successIds.length) {
    successEvidence.push(`success ids: ${successIds.join(", ")}`);
  }
  if (done) {
    successEvidence.push(`done marker: ${done.verb}`);
  }
  if (changedAdConfigs.length) {
    successEvidence.push("selected ad config changed after operation");
  }
  if (result.ok) {
    successEvidence.push("process exited successfully");
  }

  if (done?.verb === "no_op") {
    return {
      success: true,
      status: "no_op",
      summary: "miniclaw completed successfully with no matching ads to change",
      evidence: successEvidence,
      counts: { changed: 0, failed: 0, total: 0 },
      adIds: successIds,
      changedAdConfigs,
    };
  }

  const hasSuccessEvidence =
    result.ok || successIds.length > 0 || changedAdConfigs.length > 0 || (done?.count ?? 0) > 0;
  if (hasSuccessEvidence && failedCount === 0) {
    return {
      success: true,
      status: result.timedOut ? "succeeded_with_process_timeout" : "succeeded",
      summary: done
        ? `miniclaw ${done.verb} ${done.count} ad${done.count === 1 ? "" : "s"}`
        : "miniclaw operation produced success evidence",
      evidence: successEvidence,
      counts: done ? { changed: done.count, failed: 0, total: done.total } : undefined,
      adIds: successIds,
      changedAdConfigs,
    };
  }

  if (hasSuccessEvidence && failedCount > 0) {
    return {
      success: false,
      status: "partial_failure",
      summary: `miniclaw changed ${done.count} ad${done.count === 1 ? "" : "s"} but ${failedCount} failed`,
      evidence: successEvidence,
      counts: { changed: done.count, failed: failedCount, total: done.total },
      adIds: successIds,
      changedAdConfigs,
    };
  }

  const uncertainPublication = result.timedOut && ["publish", "update"].includes(operation);
  return {
    success: false,
    status: result.timedOut ? "timed_out" : "failed",
    summary: result.timedOut
      ? "miniclaw process timed out without success evidence"
      : "miniclaw process failed",
    evidence: successEvidence,
    adIds: successIds,
    changedAdConfigs,
    ...(uncertainPublication
      ? {
          uncertain: true,
          nextActions: [
            "do not run publish again for these ads yet: the ad may be online without its ID saved locally",
            "ask the user to check 'Meine Anzeigen' on kleinanzeigen.de, or run kleinanzeigen_download with selector new to find ads missing locally",
            "if the ad is online, record it with kleinanzeigen_set_ad_fields publishedAdId",
            "raise the plugin setting liveTimeoutMs if live runs keep timing out",
          ],
        }
      : {}),
  };
}

function displayPathForAd(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : path.basename(filePath);
}

async function findAdFiles(root, { maxDepth = 4, maxFiles = 200 } = {}) {
  const found = [];
  async function visit(directory, depth) {
    if (found.length >= maxFiles || depth > maxDepth) {
      return;
    }

    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const filename of AD_FILE_NAMES) {
      if (entries.some((entry) => entry.isFile() && entry.name === filename)) {
        found.push(path.join(directory, filename));
        break;
      }
    }
    if (depth === maxDepth) {
      return;
    }

    for (const entry of entries) {
      if (found.length >= maxFiles) {
        return;
      }
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        await visit(path.join(directory, entry.name), depth + 1);
      }
    }
  }

  await visit(root, 0);
  return found;
}

async function readConfiguredAdFiles(configPath) {
  const resolvedConfigPath = normalizeOptionalString(configPath);
  if (!resolvedConfigPath) {
    return [];
  }

  const configDir = path.dirname(resolvedConfigPath);
  const text = await fs.readFile(resolvedConfigPath, "utf8");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => /^ad_files\s*:/.test(line));
  if (start === -1) {
    return [];
  }

  const adFiles = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) && !line.startsWith("#")) {
      break;
    }
    const match = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const value = stripYamlScalar(match[1]);
    if (!value || /[*?[{]/.test(value)) {
      continue;
    }
    adFiles.push(path.isAbsolute(value) ? value : path.resolve(configDir, value));
  }

  return [...new Set(adFiles)];
}

async function collectAdIdScopeCandidatePaths(config = {}) {
  const candidates = new Set();
  for (const adConfigPath of await readConfiguredAdFiles(config.configPath)) {
    try {
      const stat = await fs.stat(adConfigPath);
      if (stat.isFile()) {
        candidates.add(await realPath(adConfigPath));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const roots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  for (const root of roots) {
    const resolvedRoot = await realPath(root);
    const stat = await fs.stat(resolvedRoot);
    if (!stat.isDirectory()) {
      continue;
    }
    for (const adConfigPath of await findAdFiles(resolvedRoot, { maxFiles: 400 })) {
      candidates.add(await realPath(adConfigPath));
    }
  }

  return [...candidates].sort();
}

async function resolveAdIdScopedAdConfigPaths(operation, params = {}, config = {}) {
  if (!LOCAL_AD_ID_SCOPE_OPERATIONS.has(operation)) {
    return [];
  }

  const adIds = normalizeAdIds(params.adIds);
  if (!adIds) {
    return [];
  }

  const requestedIds = [...new Set(adIds)];
  const matchesById = new Map(requestedIds.map((id) => [id, []]));
  for (const adConfigPath of await collectAdIdScopeCandidatePaths(config)) {
    let text;
    try {
      text = await fs.readFile(adConfigPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    const id = parseAdOperationState(text, adConfigPath).id;
    if (matchesById.has(id)) {
      matchesById.get(id).push(adConfigPath);
    }
  }

  if (requestedIds.some((id) => matchesById.get(id).length === 0)) {
    return [];
  }
  return [...new Set(requestedIds.flatMap((id) => matchesById.get(id)))];
}

async function findTitleLengthCandidates(config = {}, { limit = 65, maxResults = 10 } = {}) {
  const roots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  const scopedAdFiles = Array.isArray(config.adFileOverrides)
    ? config.adFileOverrides.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  const configuredAdFiles = scopedAdFiles.length
    ? scopedAdFiles
    : await readConfiguredAdFiles(config.configPath);
  const configuredExisting = [];
  for (const adConfigPath of configuredAdFiles) {
    try {
      const stat = await fs.stat(adConfigPath);
      if (stat.isFile()) {
        configuredExisting.push(await realPath(adConfigPath));
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  if (configuredExisting.length) {
    const resolvedRoots = await Promise.all(roots.map((entry) => realPath(entry)));
    const fallbackRoot = path.dirname(await realPath(config.configPath));
    const candidates = [];
    for (const adConfigPath of configuredExisting) {
      const text = await fs.readFile(adConfigPath, "utf8");
      const summary = parseAdSummary(text);
      if (summary.title.length <= limit) {
        continue;
      }
      const displayRoot =
        resolvedRoots.find((root) => pathIsInside(adConfigPath, root)) ?? fallbackRoot;
      candidates.push({
        adPath: displayPathForAd(adConfigPath, displayRoot),
        title: summary.title,
        titleLength: summary.title.length,
        limit,
      });
      if (candidates.length >= maxResults) {
        return candidates;
      }
    }
    return candidates;
  }

  if (!roots.length) {
    return [];
  }

  const candidates = [];
  for (const root of await Promise.all(roots.map((entry) => realPath(entry)))) {
    for (const adConfigPath of await findAdFiles(root, { maxFiles: 400 })) {
      const text = await fs.readFile(adConfigPath, "utf8");
      const summary = parseAdSummary(text);
      if (summary.title.length > limit) {
        candidates.push({
          adPath: displayPathForAd(adConfigPath, root),
          title: summary.title,
          titleLength: summary.title.length,
          limit,
        });
        if (candidates.length >= maxResults) {
          return candidates;
        }
      }
    }
  }
  return candidates;
}

export async function listKleinanzeigenAds(config = {}, params = {}) {
  const roots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  if (!roots.length) {
    throw new Error("plugin config must set adRoots to list ads");
  }
  const query = normalizeOptionalString(params.query)?.toLowerCase();
  const internalIdQuery = query?.startsWith("#") ? parseInternalIdValue(query.slice(1)) : null;
  const maxResults = normalizePositiveInteger(params.maxResults, 50, 1, 200);
  const resolvedRoots = await Promise.all(roots.map((root) => realPath(root)));
  const ads = [];
  const listResult = async () => ({
    ok: true,
    operation: "list_ads",
    count: ads.length,
    ads,
    ...internalIdOverview(await collectLocalAds(config)),
  });

  for (const root of resolvedRoots) {
    for (const adConfigPath of await findAdFiles(root, { maxFiles: maxResults * 4 })) {
      const directory = path.dirname(adConfigPath);
      const relDir = path.relative(root, directory);
      const text = await fs.readFile(adConfigPath, "utf8");
      const summary = parseAdSummary(text);
      const haystack = [
        relDir,
        path.basename(directory),
        summary.internalId === null ? "" : `#${summary.internalId}`,
        summary.id,
        summary.title,
        summary.category,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (internalIdQuery !== null ? summary.internalId !== internalIdQuery : query && !haystack.includes(query)) {
        continue;
      }
      const negotiation = await readNegotiation(directory);
      ads.push({
        adDirectory: displayPathForAd(directory, root),
        adPath: displayPathForAd(adConfigPath, root),
        relativeDirectory: relDir,
        ...summary,
        ...(negotiation ? { negotiation } : {}),
      });
      if (ads.length >= maxResults) {
        return listResult();
      }
    }
  }

  return listResult();
}

function categorySearchKey(value) {
  return String(value ?? "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Searches the built-in category table so an agent can pick the full display
 * path ("A > B > C") for an ad. Every query word must appear in the path.
 */
export async function searchKleinanzeigenCategories(params = {}) {
  const { BUILTIN_CATEGORIES } = await import(
    new URL("../miniclaw/dist/resources/categories.js", import.meta.url).href
  );
  const terms = categorySearchKey(params.query).split(" ").filter(Boolean);
  const limit = Math.min(Math.max(Number(params.limit) || 25, 1), 100);
  const matches = Object.entries(BUILTIN_CATEGORIES)
    .filter(([name]) => name.includes(">"))
    .filter(([name, id]) => {
      const haystack = `${categorySearchKey(name)} ${categorySearchKey(id)}`;
      return terms.every((term) => haystack.includes(term));
    })
    .map(([name, id]) => ({ path: name, id }));
  return {
    ok: true,
    operation: "categories",
    query: params.query ?? "",
    total: matches.length,
    categories: matches.slice(0, limit),
    note: "Write the chosen path into the ad's category, e.g. " +
      "\"Auto, Rad & Boot > Boote & Bootszubehör > Bootszubehör\". " +
      "The live dialog may label entries slightly differently; publish matches tolerantly " +
      "and reports the offered entries if a level does not match.",
  };
}

export function getKleinanzeigenAdSchema() {
  return {
    ok: true,
    operation: "ad_schema",
    schema: {
      format: "yaml",
      fileNames: DRAFT_AD_FILE_NAMES,
      requiredForDraft: ["title", "description", "category"],
      requiredAfterDefaults: [
        "active",
        "type",
        "title",
        "description",
        "category",
        "price_type",
        "shipping_type",
        "sell_directly",
        "contact.name",
        "contact.zipcode",
        "republication_interval",
      ],
      limits: {
        title: { minLength: AD_TITLE_MIN_LENGTH, maxLength: AD_TITLE_MAX_LENGTH },
        description: { maxLength: AD_DESCRIPTION_MAX_LENGTH },
      },
      enums: {
        type: AD_TYPES,
        price_type: PRICE_TYPES,
        shipping_type: SHIPPING_TYPES,
        shipping_options: SHIPPING_OPTIONS,
        condition_values: CONDITION_VALUES,
      },
      fields: {
        internal_id: "stable local ad number, assigned by KleinClaw; never edit or reuse it",
        id: "Kleinanzeigen ID, written by publish; changes on every republication",
        active: "false is safest for drafts; true allows scoped publish/update",
        type: "OFFER or WANTED",
        title: "10 to 65 characters",
        description: "plain or multiline text, max 4000 characters",
        category: "full display path (search with kleinanzeigen_categories), built-in category name, custom config mapping name, or category ID",
        price: "whole euros preferred; required when price_type is FIXED",
        price_type: "FIXED, NEGOTIABLE, GIVE_AWAY, or NOT_APPLICABLE",
        images: "explicit file names in display order (first = cover); a glob such as " +
          "*.jpg is sorted alphabetically. Set the order with kleinanzeigen_set_ad_images",
        images_fingerprint: "written by KleinClaw to detect swapped image files; do not edit",
        special_attributes: "category-specific string key/value pairs",
        shipping_type: "PICKUP, SHIPPING, or NOT_APPLICABLE",
        shipping_costs: "numeric custom shipping cost",
        shipping_options: "predefined package names from the enum list",
        sell_directly: "works only with SHIPPING plus shipping costs/options",
        contact: "usually inherited from config ad_defaults; avoid putting secrets in chat",
      },
      template: {
        active: false,
        type: "OFFER",
        title: "short descriptive item title",
        description: "condition, contents, pickup or shipping notes",
        category: "category name or id",
        price: 10,
        price_type: "NEGOTIABLE",
        shipping_type: "PICKUP",
        sell_directly: false,
        images: ["01-overview.jpg", "02-detail.jpg"],
      },
      workflow: [
        "use kleinanzeigen_images_list for candidate image filenames",
        "draft_ad assigns the internal_id; tell it to the user",
        "use kleinanzeigen_draft_ad with active false to create a safe draft",
        "use scoped kleinanzeigen_verify on the draft directory",
        "use kleinanzeigen_set_ad_active with active true only when ready",
        "publish scoped to that directory only after a final scoped verify",
      ],
    },
    ...localSuccessProcessFields(),
  };
}

async function resolveSingleAdConfig(params = {}, config = {}) {
  const adConfigPaths = normalizeStringArray(params.adConfigPaths, "adConfigPaths", {
    maxItems: 1,
  });
  const adDirectories = normalizeStringArray(params.adDirectories, "adDirectories", {
    maxItems: 1,
  });
  const internalIds = normalizeInternalIds(params.internalIds, { maxItems: 1 });
  if (adConfigPaths.length + adDirectories.length + internalIds.length !== 1) {
    throw new Error("provide exactly one internalIds, adConfigPaths or adDirectories entry");
  }
  if (internalIds.length) {
    return (await resolveInternalIdScope(internalIds, config))[0];
  }
  if (adConfigPaths.length) {
    return resolveAdConfigPathEntry(adConfigPaths[0], config, {
      kind: "file",
    });
  }
  return resolveAdConfigPathEntry(adDirectories[0], config, {
    kind: "directory",
  });
}

export async function readKleinanzeigenAd(params = {}, config = {}) {
  const adConfigPath = await resolveSingleAdConfig(params, config);
  const roots = await configuredAdRoots(config);
  const root = roots.find((entry) => pathIsInside(adConfigPath, entry)) ?? path.dirname(adConfigPath);
  const text = await fs.readFile(adConfigPath, "utf8");
  const includeContact = normalizeBoolean(params.includeContact, "includeContact") ?? false;

  return {
    ok: true,
    operation: "read_ad",
    adPath: displayPathForAd(adConfigPath, root),
    summary: parseAdSummary(text),
    yaml: sanitizeAdYaml(text, { includeContact }),
    contactRedacted: !includeContact,
    ...localSuccessProcessFields(),
  };
}

export async function setKleinanzeigenAdActive(params = {}, config = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before changing ad active state");
  }
  const active = normalizeBoolean(params.active, "active");
  if (active === undefined) {
    throw new Error("active is required");
  }

  const adConfigPath = await resolveSingleAdConfig(params, config);
  const extension = path.extname(adConfigPath).toLowerCase();
  if (![".yaml", ".yml"].includes(extension)) {
    throw new Error("set_ad_active currently supports only YAML ad configs");
  }

  const roots = await configuredAdRoots(config);
  const root = roots.find((entry) => pathIsInside(adConfigPath, entry)) ?? path.dirname(adConfigPath);
  const beforeText = await fs.readFile(adConfigPath, "utf8");
  const before = parseAdSummary(beforeText);
  const afterText = setYamlTopLevelActive(beforeText, active);
  const changed = afterText !== beforeText;
  if (changed) {
    await fs.writeFile(adConfigPath, afterText, "utf8");
  }

  return {
    ok: true,
    operation: "set_ad_active",
    changed,
    adPath: displayPathForAd(adConfigPath, root),
    previousActive: before.active,
    active,
    summary: parseAdSummary(afterText),
    nextActions: active
      ? [
          "run scoped kleinanzeigen_verify on this ad",
          "publish scoped to this ad only after verify succeeds",
        ]
      : ["the ad is no longer eligible for publish/update"],
    ...localSuccessProcessFields(),
  };
}

const AD_PRICE_TYPES = ["FIXED", "NEGOTIABLE", "GIVE_AWAY"];

/**
 * Changes selected top-level fields of one YAML ad: price, price_type, the
 * sold marker, and the record of a publication done by hand. Marking an ad
 * sold also deactivates it, so publish and the "due" republication skip it.
 */
// Negotiation settings live next to the ad, not in it: changing them must not
// change the ad's content hash, and miniclaw never loads dotfiles as ads.
const NEGOTIATION_FILE = ".negotiation.json";
const NEGOTIATION_NOTES_MAX = 500;

async function readNegotiation(adDirectory) {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(path.join(adDirectory, NEGOTIATION_FILE), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw new Error(`${NEGOTIATION_FILE} in an ad folder is not valid JSON`);
  }
  const minPrice = Number.isInteger(raw?.minPrice) && raw.minPrice >= 0 ? raw.minPrice : null;
  const notes = typeof raw?.notes === "string" ? raw.notes.slice(0, NEGOTIATION_NOTES_MAX) : "";
  return minPrice === null && !notes ? null : { minPrice, notes };
}

function negotiationUpdate(params) {
  const update = {};
  if (params.minPrice !== undefined && params.clearMinPrice === true) {
    throw new Error("minPrice and clearMinPrice cannot be combined");
  }
  if (params.minPrice !== undefined) {
    if (!Number.isInteger(params.minPrice) || params.minPrice < 0) {
      throw new Error("minPrice must be a whole number of euros");
    }
    update.minPrice = params.minPrice;
  }
  if (params.clearMinPrice === true) {
    update.minPrice = null;
  }
  if (params.negotiationNotes !== undefined) {
    if (typeof params.negotiationNotes !== "string" ||
      params.negotiationNotes.length > NEGOTIATION_NOTES_MAX) {
      throw new Error(`negotiationNotes must be text up to ${NEGOTIATION_NOTES_MAX} characters`);
    }
    update.notes = params.negotiationNotes.trim();
  }
  return Object.keys(update).length ? update : null;
}

async function writeNegotiation(adDirectory, update) {
  const current = await readNegotiation(adDirectory) ?? { minPrice: null, notes: "" };
  const next = { ...current, ...update };
  const filePath = path.join(adDirectory, NEGOTIATION_FILE);
  if (next.minPrice === null && !next.notes) {
    await fs.rm(filePath, { force: true });
    return null;
  }
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function setKleinanzeigenAdFields(params = {}, config = {}, { now = new Date() } = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before changing ad fields");
  }
  const negotiation = negotiationUpdate(params);
  const updates = [];
  let publishedAdId = null;
  if (params.publishedAdId !== undefined) {
    publishedAdId = String(params.publishedAdId).trim();
    if (!/^\d{6,15}$/.test(publishedAdId)) {
      throw new Error("publishedAdId must be the numeric Kleinanzeigen ad ID");
    }
  }
  if (params.price !== undefined) {
    const price = Number(params.price);
    if (!Number.isInteger(price) || price < 0 || price > 10_000_000) {
      throw new Error("price must be a whole number of euros");
    }
    updates.push(["price", String(price)]);
  }
  if (params.priceType !== undefined) {
    if (!AD_PRICE_TYPES.includes(params.priceType)) {
      throw new Error(`priceType must be one of ${AD_PRICE_TYPES.join(", ")}`);
    }
    updates.push(["price_type", params.priceType]);
  }
  const entryUpdates = [];
  if (params.title !== undefined) {
    const title = normalizeAdDraftString(params.title, "title", {
      required: true,
      maxLength: AD_TITLE_MAX_LENGTH,
    });
    if (title.length < AD_TITLE_MIN_LENGTH) {
      throw new Error(`title length must be at least ${AD_TITLE_MIN_LENGTH} characters`);
    }
    entryUpdates.push(["title", title]);
  }
  if (params.description !== undefined) {
    entryUpdates.push(["description", normalizeAdDraftString(params.description, "description", {
      required: true,
      maxLength: AD_DESCRIPTION_MAX_LENGTH,
    })]);
  }
  const sold = normalizeBoolean(params.sold, "sold");
  if (sold !== undefined) {
    updates.push(["sold", sold ? "true" : "false"]);
    if (sold) {
      updates.push(["sold_on", quoteYamlScalar(now.toISOString().slice(0, 10))]);
      updates.push(["active", "false"]);
    }
  }
  if (!updates.length && !entryUpdates.length && publishedAdId === null && negotiation === null) {
    throw new Error(
      "set at least one of title, description, price, priceType, sold, publishedAdId, " +
        "minPrice, negotiationNotes",
    );
  }

  const adConfigPath = await resolveSingleAdConfig(params, config);
  const extension = path.extname(adConfigPath).toLowerCase();
  if (![".yaml", ".yml"].includes(extension)) {
    throw new Error("set_ad_fields currently supports only YAML ad configs");
  }

  const roots = await configuredAdRoots(config);
  const root = roots.find((entry) => pathIsInside(adConfigPath, entry)) ?? path.dirname(adConfigPath);
  const beforeText = await fs.readFile(adConfigPath, "utf8");
  if (publishedAdId !== null) {
    // Same fields miniclaw writes after its own publish, so "due" starts counting now.
    const publishedOn = quoteYamlScalar(now.toISOString().replace(/\.\d{3}Z$/, "+00:00"));
    updates.push(["id", publishedAdId], ["updated_on", publishedOn]);
    if (!parseAdSummary(beforeText).createdOn) {
      updates.push(["created_on", publishedOn]);
    }
  }
  const afterText = entryUpdates.reduce(
    (text, [key, value]) => replaceTopLevelYamlEntry(text, key, yamlLinesForEntry(key, value)),
    updates.reduce(
      (text, [key, value]) => setYamlTopLevelScalar(text, key, value),
      beforeText,
    ),
  );
  const afterSummary = parseAdSummary(afterText);
  const askingPrice = Number(afterSummary.price);
  if (negotiation?.minPrice != null && Number.isFinite(askingPrice) && afterSummary.price !== null &&
    negotiation.minPrice > askingPrice) {
    throw new Error("minPrice must not be higher than the ad's price");
  }
  const changed = afterText !== beforeText;
  if (changed) {
    await fs.writeFile(adConfigPath, afterText, "utf8");
  }
  const negotiationResult = negotiation === null
    ? await readNegotiation(path.dirname(adConfigPath))
    : await writeNegotiation(path.dirname(adConfigPath), negotiation);

  return {
    ok: true,
    operation: "set_ad_fields",
    changed: changed || negotiation !== null,
    adPath: displayPathForAd(adConfigPath, root),
    previous: parseAdSummary(beforeText),
    summary: afterSummary,
    negotiation: negotiationResult,
    nextActions: negotiation !== null && !updates.length && !entryUpdates.length &&
      publishedAdId === null
      ? ["negotiation settings are local only; nothing to publish"]
      : sold
      ? ["the ad is sold and no longer eligible for publish/update"]
      : publishedAdId !== null && !updates.some(([key]) => key.startsWith("price"))
        ? ["the ad is recorded as online; the due republication counts from now"]
        : ["run scoped kleinanzeigen_verify, then update or republish this ad to apply the change"],
    ...localSuccessProcessFields(),
  };
}

function imageDimensionsFromBuffer(buffer, extension) {
  if (extension === ".png" && buffer.length >= 24) {
    const signature = buffer.subarray(0, 8).toString("hex");
    if (signature === "89504e470d0a1a0a") {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
  }
  if (extension === ".gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if ([".jpg", ".jpeg"].includes(extension) && buffer.length >= 4) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) {
        break;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
  }
  return { width: null, height: null };
}

async function inspectImageFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, 65536));
    await handle.read(buffer, 0, buffer.length, 0);
    return {
      extension,
      supportedByMiniclaw: SUPPORTED_IMAGE_EXTENSIONS.has(extension),
      bytes: stat.size,
      ...imageDimensionsFromBuffer(buffer, extension),
    };
  } finally {
    await handle.close();
  }
}

export async function listKleinanzeigenImages(params = {}, config = {}) {
  const maxResults = normalizePositiveInteger(params.maxResults, 100, 1, 500);
  const maxDepth = normalizePositiveInteger(params.maxDepth, 2, 0, 6);
  const { directory, root } = await resolveWritableAdDirectory(params.directory, config);
  const directoryStat = await fs.stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new Error("directory is not a directory");
  }
  const resolvedDirectory = await realPath(directory);
  if (!pathIsInside(resolvedDirectory, root)) {
    throw new Error("directory is outside configured adRoots");
  }

  const images = [];
  async function visit(current, depth) {
    if (images.length >= maxResults || depth > maxDepth) {
      return;
    }
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (images.length >= maxResults) {
        return;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory() && depth < maxDepth) {
        await visit(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const extension = path.extname(entry.name).toLowerCase();
      if (!IMAGE_FILE_EXTENSIONS.has(extension)) {
        continue;
      }
      const info = await inspectImageFile(fullPath);
      images.push({
        file: path.relative(resolvedDirectory, fullPath),
        adRootPath: displayPathForAd(fullPath, root),
        glob: path.relative(resolvedDirectory, fullPath),
        ...info,
      });
    }
  }

  await visit(resolvedDirectory, 0);
  return {
    ok: true,
    operation: "images_list",
    directory: displayPathForAd(resolvedDirectory, root),
    count: images.length,
    images,
    ...localSuccessProcessFields(),
  };
}

function normalizeDraftAd(params = {}) {
  const title = normalizeAdDraftString(params.title, "title", {
    required: true,
    maxLength: AD_TITLE_MAX_LENGTH,
  });
  if (title.length < AD_TITLE_MIN_LENGTH) {
    throw new Error(`title length must be at least ${AD_TITLE_MIN_LENGTH} characters`);
  }
  const description = normalizeAdDraftString(params.description, "description", {
    required: true,
    maxLength: AD_DESCRIPTION_MAX_LENGTH,
  });
  const category = normalizeAdDraftString(params.category, "category", { required: true });
  const priceType = normalizeEnum(params.priceType, "priceType", PRICE_TYPES);
  const price = normalizeNumber(params.price, "price", { integer: true, min: 0 });
  if (priceType === "FIXED" && price === undefined) {
    throw new Error("price is required when priceType is FIXED");
  }
  if (priceType === "GIVE_AWAY" && price !== undefined) {
    throw new Error("price must not be specified when priceType is GIVE_AWAY");
  }

  const images = params.images === undefined
    ? undefined
    : normalizeStringArray(params.images, "images", { maxItems: 24 })
        .map((entry, index) => rejectUnsafeRelativePattern(entry, `images[${index}]`));
  const shippingOptions = params.shippingOptions === undefined
    ? undefined
    : normalizeStringArray(params.shippingOptions, "shippingOptions", { maxItems: 8 });
  if (shippingOptions?.some((entry) => !SHIPPING_OPTIONS.includes(entry))) {
    throw new Error(`shippingOptions must contain only: ${SHIPPING_OPTIONS.join(", ")}`);
  }

  const ad = {
    active: normalizeBoolean(params.active, "active") ?? false,
    type: normalizeEnum(params.type, "type", AD_TYPES) ?? "OFFER",
    title,
    description,
    descriptionPrefix: normalizeAdDraftString(params.descriptionPrefix, "descriptionPrefix"),
    descriptionSuffix: normalizeAdDraftString(params.descriptionSuffix, "descriptionSuffix"),
    category,
    specialAttributes: normalizeStringMap(params.specialAttributes, "specialAttributes"),
    price,
    priceType: priceType ?? "NEGOTIABLE",
    shippingType: normalizeEnum(params.shippingType, "shippingType", SHIPPING_TYPES) ?? "PICKUP",
    shippingCosts: normalizeNumber(params.shippingCosts, "shippingCosts", { min: 0 }),
    shippingOptions,
    sellDirectly: normalizeBoolean(params.sellDirectly, "sellDirectly") ?? false,
    images,
    contact: normalizeStringMap(params.contact, "contact"),
    republicationInterval: normalizeNumber(
      params.republicationInterval,
      "republicationInterval",
      { integer: true, min: 1 },
    ),
  };

  return Object.fromEntries(
    Object.entries(ad).filter(([, value]) => value !== undefined),
  );
}

export async function draftKleinanzeigenAd(params = {}, config = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before writing an ad draft");
  }
  const fileName = normalizeOptionalString(params.fileName) ?? "ad.yaml";
  if (!DRAFT_AD_FILE_NAMES.includes(fileName)) {
    throw new Error(`fileName must be one of: ${DRAFT_AD_FILE_NAMES.join(", ")}`);
  }
  const overwrite = normalizeBoolean(params.overwrite, "overwrite") ?? false;
  const { directory, root } = await resolveWritableAdDirectory(params.directory, config);
  const ad = normalizeDraftAd(params);
  await fs.mkdir(directory, { recursive: true });
  const adConfigPath = path.join(directory, fileName);
  let existingText = null;
  try {
    existingText = await fs.readFile(adConfigPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  if (existingText !== null && !overwrite) {
    throw new Error("ad draft already exists; set overwrite true to replace it");
  }

  // Overwriting must not lose the internal ID or the Kleinanzeigen ID and
  // publication state; otherwise the next publish would create a duplicate.
  const preserved = topLevelRawScalars(existingText ?? "", PRESERVED_DRAFT_KEYS);
  if (!preserved.has(INTERNAL_ID_KEY)) {
    preserved.set(INTERNAL_ID_KEY, String(nextFreeInternalId(await collectLocalAds(config))));
  }
  let yaml = renderAdYaml(ad);
  for (const key of [...PRESERVED_DRAFT_KEYS].reverse()) {
    if (preserved.has(key)) {
      yaml = setYamlTopLevelScalar(yaml, key, preserved.get(key));
    }
  }
  await fs.writeFile(adConfigPath, yaml, { encoding: "utf8", mode: 0o600 });
  const draftSummary = parseAdSummary(yaml);

  return {
    ok: true,
    operation: "draft_ad",
    changed: true,
    adDirectory: displayPathForAd(directory, root),
    adPath: displayPathForAd(adConfigPath, root),
    active: ad.active,
    internalId: draftSummary.internalId,
    preservedKeys: [...preserved.keys()].filter((key) => existingText !== null || key !== INTERNAL_ID_KEY),
    summary: draftSummary,
    nextActions: [
      `tell the user the internal ID ${draftSummary.internalId} of this ad`,
      "review the draft yaml",
      "run scoped kleinanzeigen_verify on this directory",
      "set active true only when ready to publish",
    ],
    ...localSuccessProcessFields(),
  };
}

export async function extractKleinanzeigenDiagnostics(text, config = {}) {
  const diagnostics = [];
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let target = "";

  for (const line of lines) {
    const validationHeader = /\[ERROR\]\s+\d+\s+validation error for \[(.+?)\]:/.exec(line);
    if (validationHeader) {
      target = validationHeader[1];
      continue;
    }

    const validationLine = /^-\s*([A-Za-z0-9_.-]+):\s*(.+)$/.exec(line.trim());
    if (!validationLine || !target) {
      continue;
    }

    const field = validationLine[1];
    const message = validationLine[2].trim();
    const diagnostic = {
      severity: "error",
      kind: target.includes("AdPartial") ? "ad_validation" : "config_validation",
      field,
      message,
      suggestedAction: target.includes("AdPartial")
        ? "fix the invalid ad or run a scoped operation for a different ad"
        : "fix the miniclaw config and rerun verify",
    };

    if (/title length exceeds 65 characters/i.test(message)) {
      const candidates = await findTitleLengthCandidates(config, { limit: 65 });
      if (candidates.length) {
        diagnostic.candidates = candidates;
        if (candidates.length === 1) {
          diagnostic.adPath = candidates[0].adPath;
          diagnostic.title = candidates[0].title;
          diagnostic.titleLength = candidates[0].titleLength;
          diagnostic.limit = candidates[0].limit;
        }
      }
    }

    diagnostics.push(diagnostic);
  }

  return diagnostics;
}

function buildNextActions(diagnostics = [], scoped) {
  if (!diagnostics.length) {
    return [];
  }
  if (diagnostics.some((entry) => entry.kind === "config_validation")) {
    return ["fix the miniclaw config and rerun kleinanzeigen_verify"];
  }
  if (scoped) {
    return ["fix the selected ad config and rerun scoped kleinanzeigen_verify"];
  }
  return [
    "use kleinanzeigen_list_ads to find the target ad",
    "use kleinanzeigen_verify with adDirectories or adConfigPaths for one ad",
    "fix invalid ads before unscoped verify or bulk publish",
  ];
}

async function resolveScopedAdConfigPaths(params = {}, config = {}) {
  const adConfigPaths = normalizeStringArray(params.adConfigPaths, "adConfigPaths");
  const adDirectories = normalizeStringArray(params.adDirectories, "adDirectories");
  const internalIds = normalizeInternalIds(params.internalIds);
  if (!adConfigPaths.length && !adDirectories.length && !internalIds.length) {
    return [];
  }

  const resolved = [];
  for (const adConfigPath of adConfigPaths) {
    resolved.push(await resolveAdConfigPathEntry(adConfigPath, config, {
      kind: "file",
    }));
  }
  for (const directory of adDirectories) {
    resolved.push(await resolveAdConfigPathEntry(directory, config, {
      kind: "directory",
    }));
  }
  resolved.push(...await resolveInternalIdScope(internalIds, config));
  return [...new Set(resolved)];
}

async function resolveAdConfigPathEntry(entryPath, config, { kind }) {
  const raw = normalizeOptionalString(entryPath);
  if (!raw) {
    throw new Error(`${adPathScopeName(kind)} entry must not be empty`);
  }
  if (!path.isAbsolute(raw)) {
    return resolveRelativeAdConfigPathEntry(raw, config, { kind });
  }
  return resolveAbsoluteAdConfigPathEntry(raw, config, { kind });
}

function adPathScopeName(kind) {
  return kind === "file" ? "adConfigPaths" : "adDirectories";
}

function adPathNotFoundMessage(kind) {
  return `${adPathScopeName(kind)} entry was not found`;
}

function adPathUnreadableMessage(kind) {
  return `${adPathScopeName(kind)} entry cannot be read`;
}

function adPathWrongTypeMessage(kind) {
  if (kind === "file") {
    return "adConfigPaths entry is not a file";
  }
  return "adDirectories entry is not a directory";
}

function pathReadErrorMessage(error, kind) {
  if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
    return adPathNotFoundMessage(kind);
  }
  return adPathUnreadableMessage(kind);
}

async function statAdPathEntry(candidate, kind) {
  try {
    return await fs.stat(candidate);
  } catch (error) {
    throw new Error(pathReadErrorMessage(error, kind));
  }
}

async function resolveAdConfigPathCandidate(candidate, config, { kind }) {
  const stat = await statAdPathEntry(candidate, kind);
  if (kind === "file") {
    if (!stat.isFile()) {
      throw new Error(adPathWrongTypeMessage(kind));
    }
    return assertInsideAdRoots(candidate, config);
  }

  if (!stat.isDirectory()) {
    throw new Error(adPathWrongTypeMessage(kind));
  }
  return assertInsideAdRoots(await resolveAdConfigInDirectory(candidate), config);
}

async function resolveAbsoluteAdConfigPathEntry(entryPath, config, { kind }) {
  return resolveAdConfigPathCandidate(path.resolve(entryPath), config, { kind });
}

async function resolveRelativeAdConfigPathEntry(entryPath, config, { kind }) {
  const roots = await configuredAdRoots(config);
  const matches = [];
  const softErrors = [];
  let escapedAllRoots = true;

  for (const root of roots) {
    const candidate = path.resolve(root, entryPath);
    if (!pathIsInside(candidate, root)) {
      continue;
    }
    escapedAllRoots = false;

    try {
      matches.push(await resolveAdConfigPathCandidate(candidate, config, { kind }));
    } catch (error) {
      if (error?.message === adPathNotFoundMessage(kind)) {
        continue;
      }
      softErrors.push(error);
    }
  }

  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length === 1) {
    return uniqueMatches[0];
  }
  if (uniqueMatches.length > 1) {
    throw new Error("relative ad handle matches multiple adRoots");
  }
  if (escapedAllRoots) {
    throw new Error("relative ad handle is outside configured adRoots");
  }
  if (softErrors.length) {
    throw softErrors[0];
  }
  throw new Error(adPathNotFoundMessage(kind));
}

function parseAdPreflightSummary(text, filePath) {
  if (path.extname(filePath).toLowerCase() === ".json") {
    try {
      const parsed = JSON.parse(text);
      return {
        active: typeof parsed.active === "boolean" ? parsed.active : null,
        title: typeof parsed.title === "string" ? parsed.title : "",
      };
    } catch {
      return { active: null, title: "" };
    }
  }
  return parseAdSummary(text);
}

async function inactiveScopedPublishAds(adConfigPaths, config = {}) {
  if (!adConfigPaths.length) {
    return [];
  }

  const roots = normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 });
  const resolvedRoots = await Promise.all(roots.map((root) => realPath(root)));
  const inactive = [];
  for (const adConfigPath of adConfigPaths) {
    const text = await fs.readFile(adConfigPath, "utf8");
    const summary = parseAdPreflightSummary(text, adConfigPath);
    if (summary.active === true) {
      continue;
    }
    const root =
      resolvedRoots.find((entry) => pathIsInside(adConfigPath, entry)) ?? path.dirname(adConfigPath);
    inactive.push({
      adPath: displayPathForAd(adConfigPath, root),
      title: summary.title,
      active: summary.active,
    });
  }
  return inactive;
}

function buildInactivePublishPreflightResult({ operation, inactiveAds, cliConfig, args }) {
  return {
    ok: false,
    operation,
    outcome: {
      success: false,
      status: "preflight_failed",
      summary: "selected ad is not active; activate it before publishing",
      evidence: ["publish preflight checked selected ad active state"],
      changedAdConfigs: [],
    },
    command: {
      executable: cliConfig.runtime.label,
      args: redactArgs(args),
    },
    processOk: false,
    exitCode: null,
    signal: null,
    timedOut: false,
    needsUserAction: false,
    diagnostics: inactiveAds.map((ad) => ({
      severity: "error",
      kind: "ad_preflight",
      field: "active",
      message: "selected ad is not active and would be skipped by publish",
      adPath: ad.adPath,
      title: ad.title,
      active: ad.active,
      suggestedAction:
        "use kleinanzeigen_set_ad_active with active true, then run scoped verify and publish",
    })),
    nextActions: [
      "re-read the selected ad with kleinanzeigen_read_ad",
      "use kleinanzeigen_set_ad_active with active true if the user wants to publish",
      "run scoped kleinanzeigen_verify",
      "retry kleinanzeigen_publish scoped to the same ad",
    ],
    stdout: "",
    stderr: "",
  };
}

async function createTemporaryConfig(cliConfig, content, ext = path.extname(cliConfig.configPath).toLowerCase()) {
  const configDir = path.dirname(cliConfig.configPath);
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const configPath = path.join(configDir, `.kleinclaw-${suffix}${ext === ".json" ? ".json" : ".yaml"}`);
  await fs.writeFile(configPath, content, { encoding: "utf8", mode: 0o600 });

  return {
    config: { ...cliConfig, configPath, cwd: configDir },
    cleanup: () => fs.rm(configPath, { force: true }),
  };
}

function commandSupportFromHelp(text) {
  const lower = String(text ?? "").toLowerCase();
  return Object.fromEntries(
    Object.keys(OPERATIONS).map((operation) => [operation, lower.includes(operation)]),
  );
}

function firstNonEmptyLine(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) ?? "";
}

export function runProcess(command, args, options = {}) {
  const commandRunner = options.commandRunner;
  const timeoutMs = options.timeoutMs ?? 120000;
  const maxBufferChars = Number.isInteger(options.maxBufferChars)
    ? Math.max(options.maxBufferChars, 0)
    : 20000;
  const captureLimit = maxBufferChars + 1;

  const capOutput = (value) => String(value ?? "").slice(0, captureLimit);
  if (typeof commandRunner !== "function") {
    return Promise.resolve({
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      error: new Error("OpenClaw command runner is not available"),
      timedOut: false,
    });
  }

  return commandRunner([command, ...args], {
    cwd: options.cwd,
    env: options.env ?? buildChildEnv(),
    timeoutMs,
  }).then(
    (result) => {
      const timedOut =
        result?.termination === "timeout" || result?.termination === "no-output-timeout";
      const exitCode = Number.isInteger(result?.code) ? result.code : null;
      return {
        ok: exitCode === 0 && !timedOut,
        exitCode,
        signal: result?.signal ?? null,
        stdout: capOutput(result?.stdout),
        stderr: capOutput(result?.stderr),
        timedOut,
      };
    },
    (error) => ({
      ok: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      error,
      timedOut: false,
    }),
  );
}

function runRuntimeProcess(runtime, args, options = {}) {
  return runProcess(runtime.command, [...runtime.argsPrefix, ...args], options);
}

export async function getKleinanzeigenBrowserStatus(config = {}) {
  const cliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(cliConfig);
  const text = await fs.readFile(cliConfig.configPath, "utf8");
  const browserConfig = parseBrowserConfigText(text);
  const detectedBrowsers = await detectInstalledBrowsers({
    commandRunner: cliConfig.commandRunner,
  });

  return buildBrowserStatusPayload({ cliConfig, browserConfig, detectedBrowsers });
}

export async function configureKleinanzeigenBrowser(params = {}, config = {}) {
  const cliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(cliConfig);
  const stat = await fs.stat(cliConfig.configPath);
  const text = await fs.readFile(cliConfig.configPath, "utf8");
  const currentBrowserConfig = parseBrowserConfigText(text);
  assertSafeBrowserConfigureParams(params);
  const detectedBrowsers = await detectInstalledBrowsers({
    commandRunner: cliConfig.commandRunner,
  });
  const previous = buildBrowserStatusPayload({
    cliConfig,
    browserConfig: currentBrowserConfig,
    detectedBrowsers,
  }).browser;
  const updates = await resolveBrowserUpdates(params, cliConfig, currentBrowserConfig);
  const nextText = replaceBrowserYaml(text, updates);
  const changed = nextText !== text;

  if (changed) {
    await writeFileAtomic(cliConfig.configPath, nextText, stat.mode & 0o777);
  }

  const nextBrowserConfig = parseBrowserConfigText(nextText);
  const status = buildBrowserStatusPayload({
    cliConfig,
    browserConfig: nextBrowserConfig,
    detectedBrowsers,
  });

  return {
    ...status,
    operation: "browser_configure",
    changed,
    changedKeys: Object.keys(updates),
    previous,
  };
}

function browserCheckOverridesRequested(params = {}) {
  return [
    "browser",
    "binaryLocation",
    "usePrivateWindow",
    "profileMode",
    "userDataDir",
    "profileName",
  ].some((key) => params[key] !== undefined);
}

function extractBrowserCheckDiagnostics(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const failures = [];
  const warnings = [];
  const successes = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/\(fail\)|failed|not found|not executable|permission/i.test(trimmed)) {
      failures.push(trimmed);
    } else if (/\(warn\)|warning/i.test(trimmed)) {
      warnings.push(trimmed);
    } else if (/\(ok\)|detected|executable/i.test(trimmed)) {
      successes.push(trimmed);
    }
  }

  return {
    failures,
    warnings,
    successes,
  };
}

export async function checkKleinanzeigenBrowser(params = {}, config = {}) {
  const cliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(cliConfig);
  const original = await fs.readFile(cliConfig.configPath, "utf8");
  const currentBrowserConfig = parseBrowserConfigText(original);
  const requestedOverrides = browserCheckOverridesRequested(params);
  const updates = requestedOverrides
    ? await resolveBrowserUpdates(
        { ...params, confirm: true },
        cliConfig,
        currentBrowserConfig,
      )
    : {};
  const checkText = requestedOverrides ? replaceBrowserYaml(original, updates) : original;
  const tempConfig = requestedOverrides
    ? await createTemporaryConfig(cliConfig, checkText)
    : { config: cliConfig, cleanup: async () => {} };
  const checkConfig = tempConfig.config;
  const browserConfig = parseBrowserConfigText(checkText);
  const detectedBrowsers = await detectInstalledBrowsers({
    commandRunner: checkConfig.commandRunner,
  });
  const status = buildBrowserStatusPayload({
    cliConfig: checkConfig,
    browserConfig,
    detectedBrowsers,
  });

  let result;
  try {
    const args = buildKleinanzeigenArgs("diagnose", {}, checkConfig);
    result = await runRuntimeProcess(checkConfig.runtime, args, {
      cwd: checkConfig.cwd,
      timeoutMs: checkConfig.timeoutMs,
      maxBufferChars: checkConfig.maxOutputChars,
      env: buildChildEnv(),
      commandRunner: checkConfig.commandRunner,
    });
    const redactions = buildRedactions({ ...config, ...checkConfig });
    const rawText = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join("\n");
    const diagnostics = extractBrowserCheckDiagnostics(rawText);
    const stdout = sanitizeText(result.stdout, redactions, checkConfig.maxOutputChars);
    const stderr = sanitizeText(
      result.error ? `${result.stderr}\n${result.error.message}` : result.stderr,
      redactions,
      checkConfig.maxOutputChars,
    );
    const failures = diagnostics.failures.map((line) => sanitizeText(line, redactions, 500));
    const warnings = diagnostics.warnings.map((line) => sanitizeText(line, redactions, 500));
    const canUse = Boolean(result.ok && failures.length === 0);

    return {
      ok: canUse,
      operation: "browser_check",
      canUse,
      check: {
        status: canUse ? "passed" : "failed",
        summary: canUse
          ? "browser config passed miniclaw diagnostics"
          : "browser config failed miniclaw diagnostics",
        failures,
        warnings,
      },
      browser: status.browser,
      detectedBrowsers: status.detectedBrowsers,
      command: {
        executable: checkConfig.runtime.label,
        args: redactArgs(args),
      },
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      needsUserAction: false,
      stdout,
      stderr,
    };
  } finally {
    await tempConfig.cleanup();
  }
}

export async function getKleinanzeigenStatus(config = {}) {
  const runtime = embeddedMiniclawRuntime();
  const configPath = resolveConfiguredConfigPath(config);
  const cwd =
    normalizeOptionalString(config.workingDirectory) ?? (configPath ? path.dirname(configPath) : undefined);
  const commandRunner = typeof config.commandRunner === "function" ? config.commandRunner : undefined;
  const redactions = buildRedactions({ ...config, runtime, workingDirectory: cwd, configPath });

  const configFile = {
    configured: Boolean(configPath),
    exists: false,
    isFile: false,
  };
  if (configPath) {
    try {
      const stat = await fs.stat(configPath);
      configFile.exists = true;
      configFile.isFile = stat.isFile();
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  const versionResult = await runRuntimeProcess(runtime, ["version"], {
    cwd,
    timeoutMs: STATUS_TIMEOUT_MS,
    maxBufferChars: STATUS_OUTPUT_CHARS,
    env: buildChildEnv(),
    commandRunner,
  });
  const versionText = sanitizeText(
    [versionResult.stdout, versionResult.stderr, versionResult.error?.message].filter(Boolean).join("\n"),
    redactions,
    1000,
  );

  let helpResult = null;
  let helpText = "";
  if (!versionResult.error) {
    helpResult = await runRuntimeProcess(runtime, ["help"], {
      cwd,
      timeoutMs: STATUS_TIMEOUT_MS,
      maxBufferChars: STATUS_OUTPUT_CHARS,
      env: buildChildEnv(),
      commandRunner,
    });
    helpText = sanitizeText(
      [helpResult.stdout, helpResult.stderr, helpResult.error?.message].filter(Boolean).join("\n"),
      redactions,
      STATUS_OUTPUT_CHARS,
    );
  }

  return {
    ok: Boolean(versionResult.ok && helpResult?.ok && configFile.configured && configFile.isFile),
    operation: "status",
    executable: runtime.label,
    cwd: cwd ? "[redacted-path]" : null,
    configFile,
    workspaceMode: normalizeWorkspaceMode(config.workspaceMode),
    pluginVersion: await readPluginVersion(),
    runtimeVersion: firstNonEmptyLine(versionText),
    // Kept for compatibility: the embedded miniclaw runtime version, not the plugin version.
    version: firstNonEmptyLine(versionText),
    commands: commandSupportFromHelp(helpText),
    exitCode: helpResult?.exitCode ?? versionResult.exitCode,
    signal: helpResult?.signal ?? versionResult.signal,
    timedOut: Boolean(versionResult.timedOut || helpResult?.timedOut),
    needsUserAction: false,
    stdout: "",
    stderr: versionResult.error || helpResult?.error ? firstNonEmptyLine(helpText || versionText) : "",
  };
}

let pluginVersionCache;

/** Version of the installed KleinClaw plugin (package.json, manifest as fallback). */
async function readPluginVersion() {
  if (pluginVersionCache !== undefined) {
    return pluginVersionCache;
  }
  pluginVersionCache = null;
  for (const fileName of ["../package.json", "../openclaw.plugin.json"]) {
    try {
      const parsed = JSON.parse(await fs.readFile(new URL(fileName, import.meta.url), "utf8"));
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        pluginVersionCache = parsed.version.trim();
        break;
      }
    } catch {
      // try the next file
    }
  }
  return pluginVersionCache;
}

const BROWSER_READ_MARKER = "KLEINCLAW_RESULT ";
const BROWSER_READ_OUTPUT_CHARS = 400000;
const CONVERSATION_ID_RE = /^[A-Za-z0-9:_-]{3,100}$/;

function optionalWholeNumber(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** Runs a read-only miniclaw browser command and returns its structured result. */
async function runBrowserRead(operation, command, commandArgs, config) {
  const cliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(cliConfig);
  const args = [
    `--config=${cliConfig.configPath}`,
    "--logfile=",
    `--workspace-mode=${normalizeWorkspaceMode(config.workspaceMode)}`,
    "--allow-live-browser",
    command,
    ...commandArgs,
  ];
  const result = await runRuntimeProcess(cliConfig.runtime, args, {
    cwd: cliConfig.cwd,
    timeoutMs: cliConfig.timeoutMs,
    maxBufferChars: BROWSER_READ_OUTPUT_CHARS,
    env: buildChildEnv(),
    commandRunner: cliConfig.commandRunner,
  });
  const resultLine = String(result.stdout ?? "")
    .split(/\r?\n/)
    .find((line) => line.startsWith(BROWSER_READ_MARKER));
  if (result.ok && resultLine) {
    return {
      ok: true,
      operation,
      ...JSON.parse(resultLine.slice(BROWSER_READ_MARKER.length)),
    };
  }
  const redactions = buildRedactions({ ...config, ...cliConfig });
  const rawText = [result.stderr, result.error?.message].filter(Boolean).join("\n");
  const userAction = detectUserActionRequest(rawText);
  return {
    ok: false,
    operation,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    needsUserAction: userAction.needsUserAction,
    ...(userAction.needsUserAction ? { userActionHint: userAction.userActionHint } : {}),
    stderr: sanitizeText(rawText, redactions, cliConfig.maxOutputChars),
  };
}

export async function searchKleinanzeigenMarket(params = {}, config = {}) {
  const query = typeof params.query === "string" ? params.query.trim() : "";
  if (query.length < 2 || query.length > 100) {
    throw new Error("query must be 2 to 100 characters");
  }
  const categoryId = optionalWholeNumber(params.categoryId, "categoryId", { min: 1 });
  const minPrice = optionalWholeNumber(params.minPrice, "minPrice");
  const maxPrice = optionalWholeNumber(params.maxPrice, "maxPrice");
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) {
    throw new Error("minPrice must not be greater than maxPrice");
  }
  const pages = optionalWholeNumber(params.pages, "pages", { min: 1, max: 3 });
  const args = [`--query=${query}`];
  if (categoryId !== undefined) args.push(`--category-id=${categoryId}`);
  if (minPrice !== undefined) args.push(`--min-price=${minPrice}`);
  if (maxPrice !== undefined) args.push(`--max-price=${maxPrice}`);
  if (pages !== undefined) args.push(`--pages=${pages}`);
  const result = await runBrowserRead("market_search", "market-search", args, config);
  if (result.ok && params.includeCommercial === false && Array.isArray(result.listings)) {
    result.listings = result.listings.filter((listing) => listing.commercial !== true);
  }
  return result;
}

export async function readKleinanzeigenMessages(params = {}, config = {}) {
  const args = [];
  if (params.conversationId !== undefined) {
    if (typeof params.conversationId !== "string" || !CONVERSATION_ID_RE.test(params.conversationId)) {
      throw new Error("conversationId must contain only letters, digits, ':', '_' or '-'");
    }
    args.push(`--conversation=${params.conversationId}`);
  }
  const limit = optionalWholeNumber(params.limit, "limit", { min: 1, max: 100 });
  if (limit !== undefined) args.push(`--limit=${limit}`);
  if (params.includeBuyerConversations === true) args.push("--include-buyer");
  const result = messageboxOutcome(await runBrowserRead("messages", "messages", args, config));
  if (!result.ok) {
    return result;
  }
  const managed = await managedAdsById(config);
  if (!managed) {
    return result;
  }
  if (result.mode === "list" && Array.isArray(result.conversations)) {
    result.conversations = result.conversations.map((conversation) => {
      const ad = conversation.adId ? managed.get(conversation.adId) : undefined;
      return {
        ...conversation,
        managed: Boolean(ad),
        ...(ad ? { adDirectory: ad.adDirectory } : {}),
      };
    });
    result.managedCount = result.conversations.filter((conversation) => conversation.managed).length;
  }
  if (result.mode === "conversation" && result.conversation) {
    const ad = result.conversation.adId ? managed.get(result.conversation.adId) : undefined;
    result.managed = Boolean(ad);
    if (ad) {
      result.localAd = localAdContext(ad);
      if (result.latestOffer?.offeredPrice != null) {
        result.offerAssessment = assessOffer(result.latestOffer.offeredPrice, result.localAd);
      }
    }
  }
  return result;
}

function messageboxOutcome(result) {
  if (result.ok && result.status === "not_logged_in") {
    return {
      ...result,
      ok: false,
      needsUserAction: true,
      userActionHint:
        "The browser session is not logged in to Kleinanzeigen. Ask the user to log in " +
        "in the browser, then try again.",
    };
  }
  if (result.ok && (result.status === "error" || result.status === "refused")) {
    return { ...result, ok: false };
  }
  return result;
}

/** Local ads with a Kleinanzeigen ID, by ID; null when no adRoots are configured. */
async function managedAdsById(config) {
  if (!normalizeStringArray(config.adRoots, "adRoots", { maxItems: 50 }).length) {
    return null;
  }
  const { ads } = await listKleinanzeigenAds(config, { maxResults: 200 });
  return new Map(ads.filter((ad) => ad.id).map((ad) => [String(ad.id), ad]));
}

function localAdContext(ad, now = new Date()) {
  const price = ad.price === null || ad.price === undefined ? null : Number(ad.price);
  const created = ad.createdOn ? Date.parse(String(ad.createdOn).replace(/^'|'$/g, "")) : NaN;
  return {
    adDirectory: ad.adDirectory,
    title: ad.title,
    price: Number.isFinite(price) ? price : null,
    priceType: ad.priceType ?? null,
    sold: Boolean(ad.sold),
    daysOnline: Number.isFinite(created) ? Math.floor((now.getTime() - created) / 86400000) : null,
    minPrice: ad.negotiation?.minPrice ?? null,
    negotiationNotes: ad.negotiation?.notes ?? "",
  };
}

/** Numbers for judging a buyer's price offer; the decision stays with agent and user. */
function assessOffer(offeredPrice, localAd) {
  const asking = localAd.price;
  const floor = localAd.minPrice ?? asking;
  return {
    offeredPrice,
    askingPrice: asking,
    minPrice: localAd.minPrice,
    floorUsed: floor,
    floorSource: localAd.minPrice !== null ? "minPrice" : asking !== null ? "asking price" : null,
    ratioToAsking: asking ? Math.round((offeredPrice / asking) * 100) / 100 : null,
    atOrAboveFloor: floor === null ? null : offeredPrice >= floor,
    gapToFloor: floor === null ? null : Math.round((floor - offeredPrice) * 100) / 100,
  };
}

const MESSAGE_ID_RE = /^[A-Za-z0-9:@._+-]{1,200}$/;

export async function sendKleinanzeigenMessage(params = {}, config = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before sending a message");
  }
  if (typeof params.conversationId !== "string" || !CONVERSATION_ID_RE.test(params.conversationId)) {
    throw new Error("conversationId must contain only letters, digits, ':', '_' or '-'");
  }
  if (typeof params.afterMessageId !== "string" || !MESSAGE_ID_RE.test(params.afterMessageId)) {
    throw new Error("afterMessageId must be newestMessageId from kleinanzeigen_messages");
  }
  const adId = String(params.adId ?? "").trim();
  if (!/^\d{6,15}$/.test(adId)) {
    throw new Error("adId must be the numeric Kleinanzeigen ad ID of the conversation");
  }
  if (typeof params.text !== "string") {
    throw new Error("text must be the reply text");
  }
  const { findMessageProblems } = await import("../miniclaw/dist/messagebox.js");
  const problems = findMessageProblems(params.text);
  if (problems.length) {
    throw new Error(`reply not sent: ${problems.join("; ")}`);
  }
  const managed = await managedAdsById(config);
  if (!managed) {
    throw new Error("plugin config must set adRoots before replies can be sent");
  }
  const ad = managed.get(adId);
  if (!ad) {
    throw new Error(
      `ad ${adId} is not one of the local ads; replies go only to conversations about them`,
    );
  }
  const localAd = localAdContext(ad);
  // Without an explicit minimum price the asking price is the floor: no discount unless agreed.
  const floor = localAd.minPrice ??
    (localAd.price !== null && localAd.priceType !== "GIVE_AWAY" ? Math.floor(localAd.price) : null);
  const args = [
    `--conversation=${params.conversationId}`,
    `--text=${params.text.trim()}`,
    `--after=${params.afterMessageId}`,
    `--ad-id=${adId}`,
  ];
  if (floor !== null) args.push(`--min-price=${floor}`);
  if (params.markRead !== false) args.push("--mark-read");
  const result = messageboxOutcome(
    await runBrowserRead("send_message", "send-message", args, config),
  );
  return {
    ...result,
    minPriceApplied: floor,
    minPriceSource: localAd.minPrice !== null ? "minPrice" : floor !== null ? "asking price" : null,
    ...(result.status === "refused" && result.reason === "conversation_moved_on"
      ? { nextActions: ["read the conversation again, then answer the newest messages"] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Internal ad IDs, image order, image fingerprints, and online sync checks.
//
// Kleinanzeigen assigns a new ad ID on every republication. `internal_id` in
// ad.yaml is the stable local reference that the user and the agent use;
// the Kleinanzeigen ID (`id`) is looked up from it whenever needed.
// ---------------------------------------------------------------------------

const INTERNAL_ID_KEY = "internal_id";
const IMAGES_FINGERPRINT_KEY = "images_fingerprint";
const INTERNAL_ID_RE = /^#?(\d{1,9})$/;
const MAX_INTERNAL_ID_SCOPE = 20;
const MAX_AD_IMAGES = 20;
const GLOB_MAGIC_RE = /[*?[\]{}()!]/;
const PRESERVED_DRAFT_KEYS = [
  INTERNAL_ID_KEY,
  "id",
  "created_on",
  "updated_on",
  "content_hash",
  "repost_count",
  "price_reduction_count",
  "sold",
  "sold_on",
  IMAGES_FINGERPRINT_KEY,
  "online_hash",
  "last_synced_on",
];
const SYNC_CORE_FIELDS = ["title", "description", "category", "price", "price_type"];
const SYNC_OPTIONAL_FIELDS = [
  "type",
  "shipping_type",
  "shipping_costs",
  "shipping_options",
  "sell_directly",
  "special_attributes",
];
const SYNC_FIELDS = [...SYNC_CORE_FIELDS, ...SYNC_OPTIONAL_FIELDS];

function isYamlAdFile(filePath) {
  return [".yaml", ".yml"].includes(path.extname(filePath).toLowerCase());
}

function parseInternalIdValue(value) {
  const match = /^\d{1,9}$/.exec(String(value ?? "").trim());
  if (!match) {
    return null;
  }
  const id = Number(match[0]);
  return id >= 1 ? id : null;
}

function normalizeInternalIds(value, { maxItems = MAX_INTERNAL_ID_SCOPE } = {}) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("internalIds must be an array");
  }
  const ids = value.map((entry) => {
    const match = INTERNAL_ID_RE.exec(String(entry).trim());
    const id = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new Error("internalIds may contain only positive whole numbers");
    }
    return id;
  });
  if (!ids.length) {
    throw new Error("internalIds must not be empty");
  }
  const unique = [...new Set(ids)];
  if (unique.length > maxItems) {
    throw new Error(`internalIds must contain at most ${maxItems} entries`);
  }
  return unique;
}

async function collectLocalAds(config = {}) {
  const roots = await configuredAdRoots(config);
  const ads = [];
  const seen = new Set();
  for (const root of roots) {
    for (const adConfigPath of await findAdFiles(root, { maxFiles: 1000 })) {
      const resolved = await realPath(adConfigPath);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const text = await fs.readFile(resolved, "utf8");
      ads.push({ adConfigPath: resolved, root, text, summary: parseAdSummary(text) });
    }
  }
  return ads;
}

function localAdReference(ad, extra = {}) {
  return {
    ...extra,
    internalId: ad.summary.internalId,
    kleinanzeigenId: ad.summary.id,
    title: ad.summary.title,
    adDirectory: displayPathForAd(path.dirname(ad.adConfigPath), ad.root),
    active: ad.summary.active,
    sold: ad.summary.sold,
    price: ad.summary.price,
    priceType: ad.summary.priceType,
    images: ad.summary.imageGlobs.length,
  };
}

function internalIdIndex(ads) {
  const byId = new Map();
  for (const ad of ads) {
    const id = ad.summary.internalId;
    if (id === null) {
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, []);
    }
    byId.get(id).push(ad);
  }
  return byId;
}

function nextFreeInternalId(ads) {
  return ads.reduce((max, ad) => Math.max(max, ad.summary.internalId ?? 0), 0) + 1;
}

function internalIdOverview(ads) {
  const duplicates = [...internalIdIndex(ads).entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([internalId, entries]) => ({
      internalId,
      ads: entries.map((ad) => localAdReference(ad)),
    }));
  return {
    adsWithoutInternalId: ads.filter((ad) => ad.summary.internalId === null).length,
    internalIdDuplicates: duplicates,
    nextFreeInternalId: nextFreeInternalId(ads),
  };
}

async function resolveInternalIdScope(internalIds, config = {}) {
  if (!internalIds.length) {
    return [];
  }
  const byId = internalIdIndex(await collectLocalAds(config));
  return internalIds.map((id) => {
    const matches = byId.get(id) ?? [];
    if (!matches.length) {
      throw new Error(`internal ID ${id} was not found under adRoots`);
    }
    if (matches.length > 1) {
      throw new Error(
        `internal ID ${id} is used by ${matches.length} ads; ` +
          "resolve the duplicate first (kleinanzeigen_list_ads lists them)",
      );
    }
    return matches[0].adConfigPath;
  });
}

const KLEINANZEIGEN_ID_OPERATIONS = new Set(["delete", "download"]);

/** delete and download address live ads by Kleinanzeigen ID; map internal IDs to those. */
async function withKleinanzeigenIdsFromInternalIds(operation, params, config) {
  if (!KLEINANZEIGEN_ID_OPERATIONS.has(operation) || params.internalIds === undefined) {
    return params;
  }
  if (params.adIds !== undefined) {
    throw new Error("internalIds cannot be combined with adIds");
  }
  const internalIds = normalizeInternalIds(params.internalIds);
  const adConfigPaths = await resolveInternalIdScope(internalIds, config);
  const adIds = [];
  for (const [index, adConfigPath] of adConfigPaths.entries()) {
    const summary = parseAdSummary(await fs.readFile(adConfigPath, "utf8"));
    if (!summary.id) {
      throw new Error(
        `internal ID ${internalIds[index]} has no Kleinanzeigen ID (never published)`,
      );
    }
    adIds.push(String(summary.id));
  }
  const { internalIds: _internalIds, ...rest } = params;
  return { ...rest, adIds };
}

/** Replaces or appends one top-level YAML entry (scalar, block scalar, list or map). */
function replaceTopLevelYamlEntry(text, key, entryLines) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const section = findTopLevelYamlSection(lines, key);
  const next = [...lines];
  if (!section) {
    let insertAt = next.length;
    while (insertAt > 0 && next[insertAt - 1] === "") {
      insertAt -= 1;
    }
    next.splice(insertAt, 0, ...entryLines);
    return next.join("\n");
  }
  // Keep blank lines and column-0 comments that precede the next key.
  let end = section.end;
  while (end > section.start + 1 && /^(#.*)?$/.test(lines[end - 1])) {
    end -= 1;
  }
  next.splice(section.start, end - section.start, ...entryLines);
  return next.join("\n");
}

function topLevelRawScalars(text, keys) {
  const values = new Map();
  for (const line of String(text ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (match && keys.includes(match[1]) && match[2].trim() !== "") {
      values.set(match[1], match[2].trim());
    }
  }
  return values;
}

async function loadMiniclawHashing() {
  const module = await import(
    new URL("../miniclaw/dist/index.js", import.meta.url).href
  );
  return { contentHashForAd: module.contentHashForAd, loadDataFile: module.loadDataFile };
}

async function resolveAdImageFiles(adConfigPath, imageGlobs) {
  // Mirrors miniclaw: patterns keep their order, matches of one pattern are sorted.
  const { glob } = await import("glob");
  const adDir = path.dirname(adConfigPath);
  const files = [];
  for (const pattern of imageGlobs) {
    const matches = await glob(pattern, { cwd: adDir, nodir: true });
    files.push(...[...new Set(matches.map((match) => path.resolve(adDir, match)))].sort());
  }
  return [...new Set(files)];
}

async function computeImagesFingerprint(adConfigPath, imageGlobs) {
  const adDir = path.dirname(adConfigPath);
  const files = await resolveAdImageFiles(adConfigPath, imageGlobs);
  if (!files.length) {
    return { fingerprint: null, count: 0 };
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(adDir, file).split(path.sep).join("/"));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return { fingerprint: hash.digest("hex").slice(0, 32), count: files.length };
}

async function writeContentHash(adConfigPath, hashing) {
  const contentHash = hashing.contentHashForAd(await hashing.loadDataFile(adConfigPath));
  const text = await fs.readFile(adConfigPath, "utf8");
  await fs.writeFile(
    adConfigPath,
    setYamlTopLevelScalar(text, "content_hash", quoteYamlScalar(contentHash)),
    "utf8",
  );
}

/**
 * The miniclaw content hash only covers ad.yaml, so swapped image files with
 * unchanged names would never count as "changed". Storing a fingerprint of the
 * image files in ad.yaml makes such swaps visible to the changed selector.
 */
async function refreshImageFingerprints(adConfigPaths, config = {}) {
  let roots;
  try {
    roots = await configuredAdRoots(config);
  } catch {
    return [];
  }
  const changes = [];
  let hashing = null;
  for (const adConfigPath of adConfigPaths) {
    if (!isYamlAdFile(adConfigPath) || !roots.some((root) => pathIsInside(adConfigPath, root))) {
      continue;
    }
    let text;
    try {
      text = await fs.readFile(adConfigPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const summary = parseAdSummary(text);
    if (!summary.imageGlobs.length) {
      continue;
    }
    let current;
    try {
      current = await computeImagesFingerprint(adConfigPath, summary.imageGlobs);
    } catch {
      continue;
    }
    if (!current.fingerprint || current.fingerprint === summary.imagesFingerprint) {
      continue;
    }

    const contentHash = parseAdOperationState(text, adConfigPath).contentHash;
    let baseline = false;
    if (summary.imagesFingerprint === null && contentHash) {
      hashing ??= await loadMiniclawHashing();
      baseline =
        hashing.contentHashForAd(await hashing.loadDataFile(adConfigPath)) === contentHash;
    }
    await fs.writeFile(
      adConfigPath,
      setYamlTopLevelScalar(text, IMAGES_FINGERPRINT_KEY, quoteYamlScalar(current.fingerprint)),
      "utf8",
    );
    if (baseline) {
      // First fingerprint of an unchanged ad: record it without flagging a change.
      await writeContentHash(adConfigPath, hashing);
      continue;
    }
    const root = roots.find((entry) => pathIsInside(adConfigPath, entry));
    changes.push({
      adPath: displayPathForAd(adConfigPath, root),
      internalId: summary.internalId,
      title: summary.title,
      imageCount: current.count,
    });
  }
  return changes;
}

export async function findKleinanzeigenAd(params = {}, config = {}) {
  const ref = normalizeAdDraftString(params.ref, "ref", { required: true, maxLength: 200 });
  const maxResults = normalizePositiveInteger(params.maxResults, 10, 1, 50);
  const ads = await collectLocalAds(config);
  const matches = [];
  const numeric = /^#?(\d+)$/.exec(ref);
  if (numeric) {
    const value = numeric[1];
    for (const ad of ads) {
      if (ad.summary.internalId !== null && ad.summary.internalId === Number(value)) {
        matches.push(localAdReference(ad, { matchedBy: "internal_id" }));
      }
      if (!ref.startsWith("#") && ad.summary.id && String(ad.summary.id) === value) {
        matches.push(localAdReference(ad, { matchedBy: "kleinanzeigen_id" }));
      }
    }
  }
  if (!matches.length) {
    const terms = categorySearchKey(ref).split(" ").filter(Boolean);
    const exact = categorySearchKey(ref);
    const titleMatches = ads
      .filter((ad) => {
        const haystack = categorySearchKey(
          `${ad.summary.title} ${path.basename(path.dirname(ad.adConfigPath))}`,
        );
        return terms.length && terms.every((term) => haystack.includes(term));
      })
      .sort((left, right) =>
        Number(categorySearchKey(right.summary.title) === exact) -
          Number(categorySearchKey(left.summary.title) === exact) ||
        (left.summary.internalId ?? Number.MAX_SAFE_INTEGER) -
          (right.summary.internalId ?? Number.MAX_SAFE_INTEGER),
      );
    matches.push(...titleMatches.map((ad) => localAdReference(ad, { matchedBy: "title" })));
  }

  const limited = matches.slice(0, maxResults);
  const withoutInternalId = limited.filter((match) => match.internalId === null).length;
  return {
    ok: true,
    operation: "find_ad",
    ref,
    count: matches.length,
    ambiguous: matches.length > 1,
    matches: limited,
    hint: matches.length === 0
      ? "no local ad matches; check kleinanzeigen_list_ads"
      : matches.length > 1
        ? "several ads match; ask the user which internal ID is meant before changing anything"
        : withoutInternalId
          ? "this ad has no internal ID yet; run kleinanzeigen_assign_internal_ids"
          : "use internalIds: [<internalId>] to scope further tool calls",
    ...localSuccessProcessFields(),
  };
}

export async function assignKleinanzeigenInternalIds(params = {}, config = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before assigning internal IDs");
  }
  const ads = await collectLocalAds(config);
  const missing = ads
    .filter((ad) => ad.summary.internalId === null && isYamlAdFile(ad.adConfigPath))
    .sort((left, right) =>
      (left.summary.createdOn ?? "9999").localeCompare(right.summary.createdOn ?? "9999") ||
      left.adConfigPath.localeCompare(right.adConfigPath),
    );
  let nextId = nextFreeInternalId(ads);
  const assigned = [];
  for (const ad of missing) {
    const internalId = nextId;
    nextId += 1;
    const text = setYamlTopLevelScalar(ad.text, INTERNAL_ID_KEY, String(internalId));
    await fs.writeFile(ad.adConfigPath, text, "utf8");
    assigned.push(localAdReference({ ...ad, summary: parseAdSummary(text) }));
  }
  const overview = internalIdOverview(await collectLocalAds(config));

  return {
    ok: true,
    operation: "assign_internal_ids",
    changed: assigned.length > 0,
    assigned,
    skippedNonYaml: ads.filter((ad) => !isYamlAdFile(ad.adConfigPath)).length,
    internalIdDuplicates: overview.internalIdDuplicates,
    nextFreeInternalId: overview.nextFreeInternalId,
    nextActions: overview.internalIdDuplicates.length
      ? ["show the duplicate internal IDs to the user and ask how to renumber them"]
      : ["tell the user the internal ID of each ad; use internalIds for further calls"],
    ...localSuccessProcessFields(),
  };
}

function sanitizeImageFileName(name) {
  const extension = path.extname(name);
  const stem = path.basename(name, extension).replace(/[*?[\]{}()!]/g, "_").trim() || "image";
  return `${stem}${extension.toLowerCase()}`;
}

async function hashFile(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

/** Content hashes of the image files directly inside one ad directory. */
async function adDirectoryImageHashes(adDir) {
  const hashes = new Map();
  for (const entry of await fs.readdir(adDir, { withFileTypes: true })) {
    if (entry.isFile() && IMAGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      hashes.set(entry.name, await hashFile(path.join(adDir, entry.name)));
    }
  }
  return hashes;
}

async function copyImageIntoAdDirectory(source, adDir, preferredName, existingHashes = null) {
  const sourceHash = await hashFile(source);
  const hashes = existingHashes ?? await adDirectoryImageHashes(adDir);
  for (const [name, hash] of hashes) {
    if (hash === sourceHash) {
      return { name, copied: false };
    }
  }
  const name = sanitizeImageFileName(preferredName);
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const candidateName = attempt === 1 ? name : `${stem}-${attempt}${extension}`;
    try {
      await fs.copyFile(source, path.join(adDir, candidateName), fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code === "EEXIST") {
        continue;
      }
      throw error;
    }
    hashes.set(candidateName, sourceHash);
    return { name: candidateName, copied: true };
  }
  throw new Error("could not find a free image file name in the ad directory");
}

async function resolveImageSource(entry, index, adDir, roots) {
  const raw = normalizeAdDraftString(entry, `images[${index}]`, { required: true });
  const candidates = path.isAbsolute(raw)
    ? [path.resolve(raw)]
    : [path.resolve(adDir, raw), ...roots.map((root) => path.resolve(root, raw))];
  for (const candidate of candidates) {
    let resolved;
    try {
      resolved = await realPath(candidate);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
        continue;
      }
      throw error;
    }
    if (!roots.some((root) => pathIsInside(resolved, root))) {
      throw new Error(`images[${index}] must be inside configured adRoots`);
    }
    if (!(await fs.stat(resolved)).isFile()) {
      throw new Error(`images[${index}] is not a file`);
    }
    if (!SUPPORTED_IMAGE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      throw new Error(
        `images[${index}] must be .jpg, .jpeg, .png or .gif; convert other formats first`,
      );
    }
    return resolved;
  }
  throw new Error(`images[${index}] was not found in the ad directory or adRoots`);
}

async function unlistedAdImages(adDir, listed) {
  const entries = await fs.readdir(adDir, { withFileTypes: true });
  return entries
    .filter((entry) =>
      entry.isFile() &&
      IMAGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
      !listed.includes(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
}

async function directoryHoldsAd(directory) {
  for (const fileName of AD_FILE_NAMES) {
    try {
      if ((await fs.stat(path.join(directory, fileName))).isFile()) {
        return true;
      }
    } catch {
      // not this file name
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Image preferences: KleinClaw records the agent's proposed image order and the
// order the user finally accepted, so the agent can learn the user's taste.
// ---------------------------------------------------------------------------

const KLEINCLAW_DIR = ".kleinclaw";
const IMAGE_ROLES = [
  "overview",
  "angle",
  "detail",
  "label",
  "defect",
  "accessory",
  "scale",
  "packaging",
  "other",
];
const IMAGE_ORDER_SOURCES = ["agent", "user"];
const IMAGE_PROPOSAL_FILE = ".kleinclaw-image-proposal.json";
const IMAGE_PREFERENCES_FILE = "image-preferences.json";
const MAX_PREFERENCE_EVENTS = 300;
const MAX_PREFERENCE_RULES = 50;

async function imagePreferencesPath(config) {
  const roots = await configuredAdRoots(config);
  return path.join(roots[0], KLEINCLAW_DIR, IMAGE_PREFERENCES_FILE);
}

async function readImagePreferences(config) {
  const filePath = await imagePreferencesPath(config);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      version: 1,
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { version: 1, rules: [], events: [] };
    }
    throw new Error("image preferences file cannot be read");
  }
}

async function writeImagePreferences(config, preferences) {
  const filePath = await imagePreferencesPath(config);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(preferences, null, 2)}\n`, 0o600);
}

function normalizeImageAssessments(value, requested, images) {
  if (value === undefined) {
    return new Map();
  }
  if (!Array.isArray(value)) {
    throw new Error("assessments must be an array");
  }
  const byFinalName = new Map();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`assessments[${index}] must be an object`);
    }
    const reference = normalizeAdDraftString(entry.image, `assessments[${index}].image`, {
      required: true,
    });
    const position = requested.findIndex((candidate) =>
      candidate === reference || path.basename(candidate) === path.basename(reference),
    );
    const finalName = position !== -1 ? images[position] : images.find((name) => name === reference);
    if (!finalName) {
      throw new Error(`assessments[${index}].image is not one of the listed images`);
    }
    const role = normalizeEnum(entry.role, `assessments[${index}].role`, IMAGE_ROLES) ?? "other";
    const quality = normalizeNumber(entry.quality, `assessments[${index}].quality`, {
      integer: true,
      min: 1,
    });
    if (quality !== undefined && quality > 5) {
      throw new Error(`assessments[${index}].quality must be between 1 and 5`);
    }
    byFinalName.set(finalName, {
      role,
      ...(quality !== undefined ? { quality } : {}),
      ...(typeof entry.note === "string" && entry.note.trim()
        ? { note: entry.note.trim().slice(0, 200) }
        : {}),
    });
  }
  return byFinalName;
}

async function recordImageOrder({ adDir, images, assessments, orderSource, summary, config, now }) {
  const proposalPath = path.join(adDir, IMAGE_PROPOSAL_FILE);
  if (orderSource === "agent") {
    const proposal = {
      createdOn: now.toISOString(),
      images: images.map((file) => ({ file, ...(assessments.get(file) ?? { role: "other" }) })),
    };
    await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
    return { recorded: "proposal" };
  }

  let proposal = null;
  try {
    proposal = JSON.parse(await fs.readFile(proposalPath, "utf8"));
  } catch {
    proposal = null;
  }
  const proposedByFile = new Map(
    (Array.isArray(proposal?.images) ? proposal.images : []).map((entry) => [entry.file, entry]),
  );
  const final = images.map((file) => {
    const fromProposal = proposedByFile.get(file);
    const assessment = assessments.get(file) ?? (fromProposal
      ? { role: fromProposal.role, ...(fromProposal.quality ? { quality: fromProposal.quality } : {}) }
      : { role: "other" });
    return { file, ...assessment };
  });
  const proposedOrder = Array.isArray(proposal?.images)
    ? proposal.images.map((entry) => entry.file)
    : null;
  const corrected = proposedOrder === null
    ? null
    : JSON.stringify(proposedOrder) !== JSON.stringify(images);

  const preferences = await readImagePreferences(config);
  preferences.events.push({
    date: now.toISOString().slice(0, 10),
    internalId: summary.internalId,
    title: summary.title,
    category: summary.category,
    proposal: proposal?.images ?? null,
    final,
    corrected,
  });
  preferences.events = preferences.events.slice(-MAX_PREFERENCE_EVENTS);
  await writeImagePreferences(config, preferences);
  await fs.rm(proposalPath, { force: true });
  return { recorded: "feedback", corrected };
}

export async function setKleinanzeigenAdImages(params = {}, config = {}, { now = new Date() } = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before changing ad images");
  }
  const requested = normalizeStringArray(params.images, "images", { maxItems: MAX_AD_IMAGES });
  if (!requested.length) {
    throw new Error("images is required: the image files in display order");
  }
  const orderSource = normalizeEnum(params.orderSource, "orderSource", IMAGE_ORDER_SOURCES) ?? "agent";
  const keepSource = normalizeBoolean(params.keepSource, "keepSource") ?? false;
  const adConfigPath = await resolveSingleAdConfig(params, config);
  if (!isYamlAdFile(adConfigPath)) {
    throw new Error("set_ad_images currently supports only YAML ad configs");
  }
  const roots = await configuredAdRoots(config);
  const root = roots.find((entry) => pathIsInside(adConfigPath, entry)) ?? path.dirname(adConfigPath);
  const adDir = path.dirname(adConfigPath);

  const sources = [];
  for (const [index, entry] of requested.entries()) {
    sources.push(await resolveImageSource(entry, index, adDir, roots));
  }
  if (new Set(sources).size !== sources.length) {
    throw new Error("images lists the same file twice");
  }

  // Identical photos under different names are listed only once.
  const firstByHash = new Map();
  const skippedDuplicates = [];
  const keptRequests = [];
  const keptSources = [];
  for (const [index, source] of sources.entries()) {
    const hash = await hashFile(source);
    if (firstByHash.has(hash)) {
      skippedDuplicates.push({ image: requested[index], duplicateOf: requested[firstByHash.get(hash)] });
      continue;
    }
    firstByHash.set(hash, index);
    keptRequests.push(requested[index]);
    keptSources.push(source);
  }

  const existingHashes = await adDirectoryImageHashes(adDir);
  const images = [];
  const copied = [];
  const movedSources = [];
  for (const source of keptSources) {
    if (pathIsInside(source, adDir)) {
      const relative = path.relative(adDir, source).split(path.sep).join("/");
      if (GLOB_MAGIC_RE.test(relative)) {
        throw new Error(
          "an image file name contains glob characters (*?[]{}()!); rename it first",
        );
      }
      images.push(relative);
      continue;
    }
    const target = await copyImageIntoAdDirectory(
      source,
      adDir,
      path.basename(source),
      existingHashes,
    );
    images.push(target.name);
    const sourceRoot = roots.find((entry) => pathIsInside(source, entry)) ?? path.dirname(source);
    if (target.copied) {
      copied.push({ from: displayPathForAd(source, sourceRoot), to: target.name });
    }
    // Photos from an inbox are moved, so nothing unassigned stays behind.
    if (!keepSource && !(await directoryHoldsAd(path.dirname(source)))) {
      await fs.rm(source, { force: true });
      movedSources.push(displayPathForAd(source, sourceRoot));
    }
  }

  const assessments = normalizeImageAssessments(params.assessments, keptRequests, images);
  const beforeText = await fs.readFile(adConfigPath, "utf8");
  const before = parseAdSummary(beforeText);
  const afterText = replaceTopLevelYamlEntry(
    beforeText,
    "images",
    yamlLinesForEntry("images", images),
  );
  const changed = afterText !== beforeText;
  if (changed) {
    await fs.writeFile(adConfigPath, afterText, "utf8");
  }
  const learning = await recordImageOrder({
    adDir,
    images,
    assessments,
    orderSource,
    summary: before,
    config,
    now,
  });

  return {
    ok: true,
    operation: "set_ad_images",
    changed: changed || copied.length > 0,
    adPath: displayPathForAd(adConfigPath, root),
    internalId: before.internalId,
    kleinanzeigenId: before.id,
    title: before.title,
    previousImages: before.imageGlobs,
    images,
    copied,
    movedSources,
    skippedDuplicates,
    unlistedImages: await unlistedAdImages(adDir, images),
    learning,
    nextActions: [
      ...(orderSource === "agent"
        ? ["show the user the order with a short reason per image; after approval or " +
            "correction call this tool again with orderSource user and the final order"]
        : []),
      before.id
        ? "run scoped kleinanzeigen_verify, then kleinanzeigen_update scoped to this ad"
        : "run scoped kleinanzeigen_verify on this ad",
    ],
    ...localSuccessProcessFields(),
  };
}

function roundTo(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export async function kleinanzeigenImagePreferences(params = {}, config = {}, { now = new Date() } = {}) {
  const action = normalizeEnum(params.action ?? "read", "action", ["read", "add_rule", "remove_rule"]);
  const preferences = await readImagePreferences(config);
  let changed = false;
  if (action === "add_rule") {
    if (params.confirm !== true) {
      throw new Error("confirm must be true before adding an image rule");
    }
    const text = normalizeAdDraftString(params.rule, "rule", { required: true, maxLength: 300 });
    if (preferences.rules.length >= MAX_PREFERENCE_RULES) {
      throw new Error(`at most ${MAX_PREFERENCE_RULES} image rules; remove one first`);
    }
    const id = preferences.rules.reduce((max, rule) => Math.max(max, Number(rule.id) || 0), 0) + 1;
    preferences.rules.push({ id, text, createdOn: now.toISOString().slice(0, 10) });
    changed = true;
  } else if (action === "remove_rule") {
    if (params.confirm !== true) {
      throw new Error("confirm must be true before removing an image rule");
    }
    const ruleId = normalizeNumber(params.ruleId, "ruleId", { integer: true, min: 1 });
    const next = preferences.rules.filter((rule) => Number(rule.id) !== ruleId);
    if (next.length === preferences.rules.length) {
      throw new Error(`image rule ${ruleId} does not exist`);
    }
    preferences.rules = next;
    changed = true;
  }
  if (changed) {
    await writeImagePreferences(config, preferences);
  }

  const category = normalizeOptionalString(params.category)?.toLowerCase();
  const events = preferences.events.filter((event) =>
    !category || String(event.category ?? "").toLowerCase().includes(category),
  );
  const coverRoles = {};
  const positions = {};
  const moves = {};
  for (const event of events) {
    const final = Array.isArray(event.final) ? event.final : [];
    if (final[0]?.role) {
      coverRoles[final[0].role] = (coverRoles[final[0].role] ?? 0) + 1;
    }
    final.forEach((entry, index) => {
      (positions[entry.role] ??= []).push(index + 1);
    });
    if (event.corrected && Array.isArray(event.proposal)) {
      const proposed = event.proposal.map((entry) => entry.file);
      final.forEach((entry, index) => {
        const before = proposed.indexOf(entry.file);
        if (before !== -1) {
          (moves[entry.role] ??= []).push(before - index);
        }
      });
    }
  }
  const average = (values) => roundTo(values.reduce((sum, value) => sum + value, 0) / values.length);
  const averagePositionByRole = Object.fromEntries(
    Object.entries(positions).map(([role, values]) => [role, average(values)]),
  );
  const userMovesByRole = Object.fromEntries(
    Object.entries(moves).map(([role, values]) => [role, { average: average(values), count: values.length }]),
  );
  const corrections = events.filter((event) => event.corrected === true).length;
  const reviewed = events.filter((event) => event.corrected !== null).length;

  const guidance = preferences.rules.map((rule) => `user rule: ${rule.text}`);
  const coverEntries = Object.entries(coverRoles).sort(([, left], [, right]) => right - left);
  if (events.length >= 3 && coverEntries.length) {
    const [role, count] = coverEntries[0];
    guidance.push(`the cover is usually a "${role}" image (${count} of ${events.length} ads)`);
  }
  for (const [role, { average: delta, count }] of Object.entries(userMovesByRole)) {
    if (count >= 2 && delta >= 1) {
      guidance.push(`the user moves "${role}" images ${delta} positions earlier than proposed`);
    } else if (count >= 2 && delta <= -1) {
      guidance.push(`the user moves "${role}" images ${-delta} positions later than proposed`);
    }
  }

  return {
    ok: true,
    operation: "image_preferences",
    action,
    changed,
    rules: preferences.rules,
    events: events.length,
    reviewed,
    corrections,
    correctionRate: reviewed ? roundTo(corrections / reviewed, 2) : null,
    coverRoles,
    averagePositionByRole,
    userMovesByRole,
    recentCorrections: events
      .filter((event) => event.corrected === true)
      .slice(-5)
      .map((event) => ({
        date: event.date,
        internalId: event.internalId,
        title: event.title,
        proposal: (event.proposal ?? []).map((entry) => `${entry.role}:${entry.file}`),
        final: (event.final ?? []).map((entry) => `${entry.role}:${entry.file}`),
      })),
    guidance,
    ...localSuccessProcessFields(),
  };
}

// ---------------------------------------------------------------------------
// Online sync. `online_hash` remembers the live state seen at the last sync, so
// a later sync can tell which side changed:
//   local unchanged, online changed -> take over the online version
//   local changed, online unchanged -> local is ahead, suggest update
//   both changed                    -> conflict, the user decides
// ---------------------------------------------------------------------------

const ONLINE_HASH_KEY = "online_hash";
const LAST_SYNCED_KEY = "last_synced_on";
const MAX_SYNC_ADS = 20;
const DEFAULT_SYNC_ADS = 5;
// The browser run must stop before the agent harness gives up on the tool
// call, or the ads that were already read are lost with it.
const SYNC_RESULT_MARGIN_MS = 60000;
const MIN_SYNC_PROCESS_TIMEOUT_MS = 30000;

/** Browser time for a read-only sync, kept below the call budget the agent requested. */
function syncProcessTimeoutMs(params, cliConfig) {
  const budget = Number.isInteger(params.timeoutMs) && params.timeoutMs > 0 ? params.timeoutMs : null;
  if (budget === null) {
    return cliConfig.liveTimeoutMs;
  }
  return Math.min(
    cliConfig.liveTimeoutMs,
    Math.max(MIN_SYNC_PROCESS_TIMEOUT_MS, budget - SYNC_RESULT_MARGIN_MS),
  );
}

function normalizeSyncText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
}

function syncComparable(field, value, local, builtinCategories) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (field === "title") {
    return normalizeSyncText(value);
  }
  if (field === "description") {
    let text = String(value).trim();
    const prefix = String(local.description_prefix ?? "").trim();
    const suffix = String(local.description_suffix ?? "").trim();
    if (prefix && text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
    if (suffix && text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
    }
    return normalizeSyncText(text);
  }
  if (field === "category") {
    const text = String(value).trim();
    return builtinCategories[text] ?? text;
  }
  if (["price", "shipping_costs"].includes(field)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  if (Array.isArray(value)) {
    return [...value].map(String).sort();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== null && entry !== "")
        .map(([key, entry]) => [key, String(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

function syncPreview(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

function compareWithOnline(local, online, builtinCategories) {
  const differences = [];
  for (const field of SYNC_FIELDS) {
    if (!SYNC_CORE_FIELDS.includes(field) && local[field] === undefined) {
      continue; // Not set locally: config defaults apply, no meaningful comparison.
    }
    const localValue = syncComparable(field, local[field], local, builtinCategories);
    const onlineValue = syncComparable(field, online[field], local, builtinCategories);
    if (JSON.stringify(localValue) !== JSON.stringify(onlineValue)) {
      differences.push({
        field,
        local: syncPreview(local[field]),
        online: syncPreview(online[field]),
      });
    }
  }
  return differences;
}

function onlineStateHash(online, local, builtinCategories) {
  const state = Object.fromEntries(
    SYNC_FIELDS.map((field) => [field, syncComparable(field, online[field], local, builtinCategories)]),
  );
  state.images = Array.isArray(online.images) ? online.images.length : 0;
  return createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 32);
}

async function findDownloadedAdFiles(directory, depth = 0) {
  if (depth > 3) {
    return [];
  }
  const found = [];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      found.push(path.join(directory, entry.name));
    } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
      found.push(...await findDownloadedAdFiles(path.join(directory, entry.name), depth + 1));
    }
  }
  return found;
}

/** Downloads live ads into a temporary folder next to the miniclaw config. */
async function downloadOnlineAds(adIds, cliConfig, { timeoutMs = cliConfig.liveTimeoutMs } = {}) {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const downloadDir = path.join(path.dirname(cliConfig.configPath), `.kleinclaw-sync-${suffix}`);
  await fs.mkdir(downloadDir, { recursive: true, mode: 0o700 });
  const cleanup = () => fs.rm(downloadDir, { recursive: true, force: true }).catch(() => {});
  try {
    const args = buildKleinanzeigenArgs(
      "download",
      { confirm: true, adIds: adIds.map(String) },
      cliConfig,
    );
    args.push(`--download-dir=${downloadDir}`);
    const result = await runRuntimeProcess(cliConfig.runtime, args, {
      cwd: cliConfig.cwd,
      timeoutMs,
      maxBufferChars: cliConfig.maxOutputChars,
      env: buildChildEnv(),
      commandRunner: cliConfig.commandRunner,
    });
    // After a timeout the folder still holds every ad that was read completely.
    const hashing = await loadMiniclawHashing();
    const onlineById = new Map();
    for (const file of await findDownloadedAdFiles(downloadDir)) {
      const data = (await hashing.loadDataFile(file)) ?? {};
      const id = String(data.id ?? "").trim();
      if (id) {
        onlineById.set(id, { file, data });
      }
    }
    const failedById = new Map();
    const rawText = [result.stdout, result.stderr].filter(Boolean).join("\n");
    for (const match of rawText.matchAll(/Failed to download ad (\d+): (.*)/g)) {
      failedById.set(match[1], match[2].trim());
    }
    return { downloadDir, result, onlineById, failedById, hashing, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function assessAgainstOnline(adConfigPath, onlineEntry, { hashing, builtinCategories }) {
  const local = (await hashing.loadDataFile(adConfigPath)) ?? {};
  const online = onlineEntry.data;
  const summary = parseAdSummary(await fs.readFile(adConfigPath, "utf8"));
  const differences = compareWithOnline(local, online, builtinCategories);
  const localImages = await resolveAdImageFiles(adConfigPath, summary.imageGlobs).catch(() => []);
  const onlineImages = Array.isArray(online.images) ? online.images.map(String) : [];
  const storedContentHash = typeof local.content_hash === "string" ? local.content_hash : "";
  return {
    local,
    online,
    summary,
    differences,
    localImages,
    onlineImages,
    imageCountDiffers: localImages.length !== onlineImages.length,
    localChanged: !storedContentHash || hashing.contentHashForAd(local) !== storedContentHash,
    onlineHash: onlineStateHash(online, local, builtinCategories),
    storedOnlineHash: typeof local[ONLINE_HASH_KEY] === "string" ? local[ONLINE_HASH_KEY] : null,
  };
}

async function applyOnlineVersion(adConfigPath, assessment, onlineEntry, { fields, images }) {
  const adDir = path.dirname(adConfigPath);
  let text = await fs.readFile(adConfigPath, "utf8");
  const applied = [];
  for (const field of fields) {
    if (
      !assessment.differences.some((entry) => entry.field === field) ||
      assessment.online[field] === undefined
    ) {
      continue;
    }
    text = replaceTopLevelYamlEntry(text, field, yamlLinesForEntry(field, assessment.online[field]));
    applied.push(field);
  }
  const importedImages = [];
  if (images && assessment.onlineImages.length) {
    const downloadedDir = path.dirname(onlineEntry.file);
    const existingHashes = await adDirectoryImageHashes(adDir);
    for (const [index, image] of assessment.onlineImages.entries()) {
      const source = path.resolve(downloadedDir, image);
      if (!pathIsInside(source, downloadedDir)) {
        continue;
      }
      const extension = path.extname(source).toLowerCase() || ".jpg";
      const target = await copyImageIntoAdDirectory(
        source,
        adDir,
        `online-${String(index + 1).padStart(2, "0")}${extension}`,
        existingHashes,
      );
      importedImages.push(target.name);
    }
    if (importedImages.length) {
      text = replaceTopLevelYamlEntry(text, "images", yamlLinesForEntry("images", importedImages));
    }
  }
  const changed = applied.length > 0 || importedImages.length > 0;
  if (changed) {
    await fs.writeFile(adConfigPath, text, "utf8");
  }
  const remaining = assessment.differences.filter((entry) => !applied.includes(entry.field));
  const imagesInSync = !assessment.imageCountDiffers || importedImages.length > 0;
  return {
    applied,
    importedImages,
    changed,
    inSyncAfter: remaining.length === 0 && imagesInSync,
  };
}

async function recordSyncState(adConfigPath, { onlineHash, now, refreshHashes, hashing }) {
  if (refreshHashes) {
    // Local now equals the live ad: store hashes so update does not resend it.
    const images = parseAdSummary(await fs.readFile(adConfigPath, "utf8")).imageGlobs;
    const { fingerprint } = await computeImagesFingerprint(adConfigPath, images);
    if (fingerprint) {
      const text = await fs.readFile(adConfigPath, "utf8");
      await fs.writeFile(
        adConfigPath,
        setYamlTopLevelScalar(text, IMAGES_FINGERPRINT_KEY, quoteYamlScalar(fingerprint)),
        "utf8",
      );
    }
    await writeContentHash(adConfigPath, hashing);
  }
  let text = await fs.readFile(adConfigPath, "utf8");
  if (onlineHash) {
    text = setYamlTopLevelScalar(text, ONLINE_HASH_KEY, quoteYamlScalar(onlineHash));
  }
  text = setYamlTopLevelScalar(
    text,
    LAST_SYNCED_KEY,
    quoteYamlScalar(now.toISOString().replace(/\.\d{3}Z$/, "+00:00")),
  );
  await fs.writeFile(adConfigPath, text, "utf8");
}

async function loadBuiltinCategories() {
  const { BUILTIN_CATEGORIES } = await import(
    new URL("../miniclaw/dist/resources/categories.js", import.meta.url).href
  );
  return BUILTIN_CATEGORIES;
}

function downloadFailurePayload(base, download, config, cliConfig) {
  const { result } = download;
  const rawText = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  const userAction = detectUserActionRequest(rawText);
  const redactions = buildRedactions({ ...config, ...cliConfig });
  return {
    ok: false,
    ...base,
    processOk: result.ok,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    needsUserAction: userAction.needsUserAction,
    ...(userAction.needsUserAction ? { userActionHint: userAction.userActionHint } : {}),
    message: result.timedOut
      ? "the browser run hit its time limit before any ad was read; check the login in the " +
        "browser or sync fewer ads (maxAds)"
      : "nothing could be downloaded; the ads may be offline or deleted, or the login failed",
    stdout: sanitizeText(result.stdout, redactions, 2000),
    stderr: sanitizeText(result.stderr, redactions, 2000),
  };
}

export async function syncCheckKleinanzeigenAd(params = {}, config = {}, { now = new Date() } = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before opening the live browser for a sync check");
  }
  const apply = params.apply === undefined
    ? []
    : normalizeStringArray(params.apply, "apply", { maxItems: SYNC_FIELDS.length });
  if (apply.some((field) => !SYNC_FIELDS.includes(field))) {
    throw new Error(`apply must contain only: ${SYNC_FIELDS.join(", ")}`);
  }
  const applyImages = normalizeBoolean(params.applyImages, "applyImages") ?? false;

  const adConfigPath = await resolveSingleAdConfig(params, config);
  if (!isYamlAdFile(adConfigPath)) {
    throw new Error("sync_check currently supports only YAML ad configs");
  }
  const roots = await configuredAdRoots(config);
  const root = roots.find((entry) => pathIsInside(adConfigPath, entry)) ?? path.dirname(adConfigPath);
  const summary = parseAdSummary(await fs.readFile(adConfigPath, "utf8"));
  if (!summary.id) {
    throw new Error("the ad has no Kleinanzeigen ID yet; there is nothing online to compare");
  }

  const cliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(cliConfig);
  const download = await downloadOnlineAds([summary.id], cliConfig, {
    timeoutMs: syncProcessTimeoutMs(params, cliConfig),
  });
  try {
    const base = {
      operation: "sync_check",
      adPath: displayPathForAd(adConfigPath, root),
      internalId: summary.internalId,
      kleinanzeigenId: summary.id,
      title: summary.title,
    };
    const onlineEntry = download.onlineById.get(String(summary.id));
    if (!onlineEntry) {
      return downloadFailurePayload(base, download, config, cliConfig);
    }
    const context = { hashing: download.hashing, builtinCategories: await loadBuiltinCategories() };
    const assessment = await assessAgainstOnline(adConfigPath, onlineEntry, context);
    const outcome = await applyOnlineVersion(adConfigPath, assessment, onlineEntry, {
      fields: apply,
      images: applyImages,
    });
    const inSyncBefore = assessment.differences.length === 0 && !assessment.imageCountDiffers;
    await recordSyncState(adConfigPath, {
      // Remember the live state only when both sides agree; open differences
      // stay visible to the next sync.
      onlineHash: inSyncBefore || outcome.inSyncAfter ? assessment.onlineHash : null,
      now,
      refreshHashes: outcome.changed && outcome.inSyncAfter,
      hashing: download.hashing,
    });

    return {
      ok: true,
      ...base,
      inSync: inSyncBefore,
      localChanged: assessment.localChanged,
      differences: assessment.differences,
      images: {
        local: assessment.localImages.length,
        online: assessment.onlineImages.length,
        countDiffers: assessment.imageCountDiffers,
        note: "online images are re-encoded by Kleinanzeigen, so only the count is compared",
      },
      applied: outcome.applied,
      importedImages: outcome.importedImages,
      changed: outcome.changed,
      nextActions: !outcome.changed
        ? inSyncBefore
          ? ["local ad and online ad match"]
          : [
              "show the differences to the user",
              "to keep the online version: call again with apply (and applyImages)",
              "to keep the local version: run kleinanzeigen_update scoped to this ad",
            ]
        : outcome.inSyncAfter
          ? ["local ad now matches the online ad"]
          : ["remaining local differences will be sent by the next scoped kleinanzeigen_update"],
      ...localSuccessProcessFields(),
    };
  } finally {
    await download.cleanup();
  }
}

export async function syncKleinanzeigenAds(params = {}, config = {}, { now = new Date() } = {}) {
  if (params.confirm !== true) {
    throw new Error("confirm must be true before opening the live browser for a sync");
  }
  const dryRun = normalizeBoolean(params.dryRun, "dryRun") ?? false;
  // Five ads fit well into the 10-minute budget an agent harness grants a tool call.
  const maxAds = normalizePositiveInteger(params.maxAds, DEFAULT_SYNC_ADS, 1, MAX_SYNC_ADS);
  const internalIds = normalizeInternalIds(params.internalIds, { maxItems: MAX_SYNC_ADS });
  const roots = await configuredAdRoots(config);

  let candidates;
  if (internalIds.length) {
    const paths = await resolveInternalIdScope(internalIds, config);
    candidates = (await collectLocalAds(config)).filter((ad) => paths.includes(ad.adConfigPath));
  } else {
    candidates = await collectLocalAds(config);
  }
  const skipped = { notPublished: 0, sold: 0, notYaml: 0 };
  candidates = candidates.filter((ad) => {
    if (!isYamlAdFile(ad.adConfigPath)) {
      skipped.notYaml += 1;
      return false;
    }
    if (!ad.summary.id) {
      skipped.notPublished += 1;
      return false;
    }
    if (ad.summary.sold) {
      skipped.sold += 1;
      return false;
    }
    return true;
  });
  // Oldest sync first, so repeated runs rotate through all ads.
  candidates.sort((left, right) =>
    (left.summary.lastSyncedOn ?? "").localeCompare(right.summary.lastSyncedOn ?? ""),
  );
  const selected = candidates.slice(0, maxAds);
  const base = {
    operation: "sync",
    dryRun,
    remaining: candidates.length - selected.length,
    skipped,
  };
  if (!selected.length) {
    return { ok: true, ...base, checked: 0, results: [], counts: {}, ...localSuccessProcessFields() };
  }

  const cliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(cliConfig);
  const download = await downloadOnlineAds(selected.map((ad) => ad.summary.id), cliConfig, {
    timeoutMs: syncProcessTimeoutMs(params, cliConfig),
  });
  const timedOut = download.result.timedOut === true;
  try {
    if (download.onlineById.size === 0 && download.failedById.size === 0) {
      return downloadFailurePayload(base, download, config, cliConfig);
    }
    const context = { hashing: download.hashing, builtinCategories: await loadBuiltinCategories() };
    const redactions = buildRedactions({ ...config, ...cliConfig });
    const results = [];
    for (const ad of selected) {
      const reference = {
        internalId: ad.summary.internalId,
        kleinanzeigenId: ad.summary.id,
        title: ad.summary.title,
        adDirectory: displayPathForAd(
          path.dirname(ad.adConfigPath),
          roots.find((root) => pathIsInside(ad.adConfigPath, root)) ?? ad.root,
        ),
      };
      const onlineEntry = download.onlineById.get(String(ad.summary.id));
      const failure = download.failedById.get(String(ad.summary.id));
      if (!onlineEntry && failure !== undefined) {
        results.push({
          ...reference,
          status: "download_failed",
          error: sanitizeText(failure, redactions, 300),
        });
        continue;
      }
      if (!onlineEntry) {
        // After a timeout, a missing ad was most likely not reached yet.
        results.push({ ...reference, status: timedOut ? "not_checked" : "not_found_online" });
        continue;
      }
      const assessment = await assessAgainstOnline(ad.adConfigPath, onlineEntry, context);
      const differs = assessment.differences.length > 0 || assessment.imageCountDiffers;
      let status;
      if (!differs) {
        status = "in_sync";
      } else if (!assessment.localChanged) {
        status = "pulled";
      } else if (assessment.storedOnlineHash && assessment.storedOnlineHash === assessment.onlineHash) {
        status = "local_ahead";
      } else {
        status = "conflict";
      }

      const entry = {
        ...reference,
        status,
        ...(differs ? { differences: assessment.differences } : {}),
        ...(assessment.imageCountDiffers
          ? { images: { local: assessment.localImages.length, online: assessment.onlineImages.length } }
          : {}),
      };
      if (dryRun) {
        results.push(status === "pulled" ? { ...entry, status: "would_pull" } : entry);
        continue;
      }
      let refreshHashes = false;
      if (status === "pulled") {
        const outcome = await applyOnlineVersion(ad.adConfigPath, assessment, onlineEntry, {
          fields: assessment.differences.map((difference) => difference.field),
          images: assessment.imageCountDiffers,
        });
        entry.applied = outcome.applied;
        entry.importedImages = outcome.importedImages;
        refreshHashes = outcome.inSyncAfter;
      }
      await recordSyncState(ad.adConfigPath, {
        // A conflict keeps the previous online state, so it stays a conflict until resolved.
        onlineHash: status === "conflict" ? null : assessment.onlineHash,
        now,
        refreshHashes,
        hashing: download.hashing,
      });
      results.push(entry);
    }

    const counts = results.reduce((total, entry) => {
      total[entry.status] = (total[entry.status] ?? 0) + 1;
      return total;
    }, {});
    const nextActions = [];
    if (counts.pulled) {
      nextActions.push("tell the user which online changes were taken over locally");
    }
    if (counts.would_pull) {
      nextActions.push("dry run: run again without dryRun to take over the online changes");
    }
    if (counts.local_ahead) {
      nextActions.push("local_ahead ads have local changes: offer a scoped kleinanzeigen_update");
    }
    if (counts.conflict) {
      nextActions.push(
        "conflict ads changed on both sides: show the differences and ask per field; " +
          "use kleinanzeigen_sync_check with apply for the online side",
      );
    }
    if (counts.download_failed) {
      nextActions.push(
        "download_failed ads could not be read from Kleinanzeigen (page layout or network); " +
          "report the error, they are retried by the next sync",
      );
    }
    if (counts.not_found_online) {
      nextActions.push(
        "not_found_online ads may be deleted, expired or paused; ask the user before changing them",
      );
    }
    if (counts.not_checked) {
      nextActions.push(
        "the browser run hit its time limit; not_checked ads were not read. " +
          "Report the partial result and offer a new sync with a smaller maxAds",
      );
    }
    if (base.remaining > 0) {
      nextActions.push(`${base.remaining} more ads are due; the next sync continues with them`);
    }

    return {
      ok: true,
      ...base,
      checked: results.length - (counts.not_checked ?? 0),
      ...(timedOut ? { timedOut: true, partial: true } : {}),
      counts,
      results,
      nextActions,
      ...localSuccessProcessFields(),
    };
  } finally {
    await download.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Storage hygiene: images that belong to no ad, duplicate images, and
// leftover temporary folders are moved to a dated trash folder
// (<adRoot>/.kleinclaw/trash/YYYY-MM-DD) and purged after the retention time.
// ---------------------------------------------------------------------------

const TEMP_ENTRY_RE = /^(\.kleinclaw-sync-|\.tmp-|\.bak-)/;
const TEMP_CONFIG_RE = /^\.kleinclaw-.+\.(ya?ml|json)$/;
const TEMP_MIN_AGE_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CLEANUP_REPORT_ITEMS = 100;

async function pathSize(target) {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) {
    return stat.size;
  }
  let total = 0;
  for (const entry of await fs.readdir(target)) {
    total += await pathSize(path.join(target, entry));
  }
  return total;
}

async function scanAdRootStorage(root) {
  const images = [];
  const tempEntries = [];
  const directories = [];
  async function visit(directory, depth) {
    if (depth > 6) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.name.startsWith(".")) {
        if (TEMP_ENTRY_RE.test(entry.name)) {
          tempEntries.push(fullPath);
        }
        continue; // never descend into hidden folders such as .kleinclaw or .git
      }
      if (entry.isDirectory()) {
        directories.push(fullPath);
        await visit(fullPath, depth + 1);
      } else if (entry.isFile() && IMAGE_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        images.push(fullPath);
      }
    }
  }
  await visit(root, 0);
  return { images, tempEntries, directories };
}

async function isEmptyDirectory(directory) {
  try {
    return (await fs.readdir(directory)).length === 0;
  } catch {
    return false;
  }
}

export async function cleanupKleinanzeigenStorage(params = {}, config = {}, { now = new Date() } = {}) {
  const apply = normalizeBoolean(params.apply, "apply") ?? false;
  if (apply && params.confirm !== true) {
    throw new Error("confirm must be true before cleaning up storage");
  }
  const minAgeDays = normalizeNumber(params.minAgeDays, "minAgeDays", { integer: true, min: 0 }) ?? 7;
  const trashRetentionDays =
    normalizeNumber(params.trashRetentionDays, "trashRetentionDays", { integer: true, min: 0 }) ?? 14;
  const nowMs = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const roots = await configuredAdRoots(config);
  const ads = await collectLocalAds(config);
  const adDirectories = new Set(ads.map((ad) => path.dirname(ad.adConfigPath)));

  const referencedBy = new Map();
  for (const ad of ads) {
    const files = await resolveAdImageFiles(ad.adConfigPath, ad.summary.imageGlobs).catch(() => []);
    for (const file of files) {
      const resolved = await realPath(file).catch(() => file);
      if (!referencedBy.has(resolved)) {
        referencedBy.set(resolved, []);
      }
      referencedBy.get(resolved).push(ad);
    }
  }

  const candidates = [];
  const duplicatesInAd = [];
  const sharedDuplicates = [];
  const scannedDirectories = [];

  for (const root of roots) {
    const { images, tempEntries, directories } = await scanAdRootStorage(root);
    scannedDirectories.push(...directories.map((directory) => ({ directory, root })));

    for (const entry of tempEntries) {
      const stat = await fs.lstat(entry).catch(() => null);
      if (stat && nowMs - stat.mtimeMs >= TEMP_MIN_AGE_MS) {
        candidates.push({ path: entry, root, reason: "temporary", bytes: await pathSize(entry), remove: true });
      }
    }

    const trashRoot = path.join(root, KLEINCLAW_DIR, "trash");
    for (const day of await fs.readdir(trashRoot).catch(() => [])) {
      const dayStart = Date.parse(`${day}T00:00:00Z`);
      if (TRASH_DAY_RE.test(day) && nowMs - dayStart >= trashRetentionDays * DAY_MS) {
        const target = path.join(trashRoot, day);
        candidates.push({ path: target, root, reason: "expired_trash", bytes: await pathSize(target), remove: true });
      }
    }

    const items = [];
    const byHash = new Map();
    for (const image of images) {
      const resolved = await realPath(image).catch(() => image);
      const stat = await fs.stat(resolved);
      const item = {
        path: resolved,
        root,
        bytes: stat.size,
        ageDays: (nowMs - stat.mtimeMs) / DAY_MS,
        hash: await hashFile(resolved),
        ads: referencedBy.get(resolved) ?? [],
      };
      items.push(item);
      if (!byHash.has(item.hash)) {
        byHash.set(item.hash, []);
      }
      byHash.get(item.hash).push(item);
    }

    for (const group of byHash.values()) {
      if (group.length < 2) {
        continue;
      }
      const referenced = group.filter((item) => item.ads.length);
      const keep = referenced.length
        ? referenced
        : [[...group].sort((left, right) => right.ageDays - left.ageDays)[0]];
      for (const item of group) {
        if (!keep.includes(item)) {
          item.duplicateOf = keep[0].path;
        }
      }
      const byAd = new Map();
      for (const item of referenced) {
        for (const ad of item.ads) {
          if (!byAd.has(ad.adConfigPath)) {
            byAd.set(ad.adConfigPath, { ad, files: [] });
          }
          byAd.get(ad.adConfigPath).files.push(path.basename(item.path));
        }
      }
      for (const { ad, files } of byAd.values()) {
        if (files.length > 1) {
          duplicatesInAd.push({ internalId: ad.summary.internalId, title: ad.summary.title, files });
        }
      }
      if (byAd.size > 1) {
        sharedDuplicates.push({
          ads: [...byAd.values()].map(({ ad }) => ({
            internalId: ad.summary.internalId,
            title: ad.summary.title,
          })),
          files: [...new Set(referenced.map((item) => path.basename(item.path)))],
        });
      }
    }

    for (const item of items) {
      if (item.ads.length) {
        continue;
      }
      if (item.duplicateOf) {
        candidates.push({ ...item, reason: "duplicate" });
      } else if (item.ageDays >= minAgeDays) {
        candidates.push({
          ...item,
          reason: adDirectories.has(path.dirname(item.path)) ? "unlisted_in_ad" : "unassigned",
        });
      }
    }
  }

  // Leftovers of sync checks and scoped runs next to the miniclaw config.
  let configDir = null;
  try {
    configDir = path.dirname(resolveCliConfig(config).configPath);
  } catch {
    configDir = null;
  }
  if (configDir) {
    for (const entry of await fs.readdir(configDir, { withFileTypes: true }).catch(() => [])) {
      if (!TEMP_ENTRY_RE.test(entry.name) && !TEMP_CONFIG_RE.test(entry.name)) {
        continue;
      }
      const target = path.join(configDir, entry.name);
      const stat = await fs.lstat(target).catch(() => null);
      if (
        stat && nowMs - stat.mtimeMs >= TEMP_MIN_AGE_MS &&
        !candidates.some((candidate) => candidate.path === target)
      ) {
        candidates.push({ path: target, root: configDir, reason: "temporary", bytes: await pathSize(target), remove: true });
      }
    }
  }

  const removedDirectories = [];
  if (apply) {
    for (const candidate of candidates) {
      if (candidate.remove) {
        await fs.rm(candidate.path, { recursive: true, force: true });
        continue;
      }
      const relative = path.relative(candidate.root, candidate.path);
      const target = path.join(candidate.root, KLEINCLAW_DIR, "trash", today, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      let destination = target;
      for (let attempt = 2; await fs.stat(destination).then(() => true, () => false); attempt += 1) {
        const extension = path.extname(target);
        destination = `${target.slice(0, -extension.length || undefined)}-${attempt}${extension}`;
      }
      await fs.rename(candidate.path, destination);
    }
    // Deepest folders first, so emptied parents follow.
    const ordered = [...scannedDirectories].sort(
      (left, right) => right.directory.length - left.directory.length,
    );
    for (const { directory, root } of ordered) {
      // Keep ad folders and top-level folders such as an inbox.
      if (adDirectories.has(directory) || path.dirname(directory) === root) {
        continue;
      }
      if (await isEmptyDirectory(directory)) {
        await fs.rmdir(directory).catch(() => {});
        removedDirectories.push(displayPathForAd(directory, root));
      }
    }
  }

  const counts = {};
  let bytes = 0;
  for (const candidate of candidates) {
    counts[candidate.reason] = (counts[candidate.reason] ?? 0) + 1;
    bytes += candidate.bytes ?? 0;
  }
  const display = (target, root) =>
    root === configDir ? path.basename(target) : displayPathForAd(target, root);

  return {
    ok: true,
    operation: "storage_cleanup",
    applied: apply,
    minAgeDays,
    trashRetentionDays,
    counts,
    bytes,
    megabytes: roundTo(bytes / (1024 * 1024), 2),
    items: candidates.slice(0, MAX_CLEANUP_REPORT_ITEMS).map((candidate) => ({
      path: display(candidate.path, candidate.root),
      reason: candidate.reason,
      bytes: candidate.bytes,
      ...(candidate.ageDays !== undefined ? { ageDays: roundTo(candidate.ageDays) } : {}),
      ...(candidate.duplicateOf
        ? { duplicateOf: displayPathForAd(candidate.duplicateOf, candidate.root) }
        : {}),
    })),
    duplicatesInAd,
    sharedDuplicates,
    removedDirectories,
    trash: `${KLEINCLAW_DIR}/trash/<date> under each adRoot; purged after ${trashRetentionDays} days`,
    nextActions: apply
      ? ["report what was moved to the trash and how much space was freed"]
      : candidates.length
        ? ["show the user the list, then run again with apply true and confirm true"]
        : ["nothing to clean up"],
    ...localSuccessProcessFields(),
  };
}

export async function runKleinanzeigenOperation(operation, requestParams = {}, config = {}) {
  const baseCliConfig = resolveCliConfig(config);
  await assertConfiguredFiles(baseCliConfig);
  requireConfirmed(operation, requestParams);
  const params = await withKleinanzeigenIdsFromInternalIds(operation, requestParams, config);
  const requestedScopedAdConfigPaths = await resolveScopedAdConfigPaths(params, config);
  const adIdScopedAdConfigPaths = requestedScopedAdConfigPaths.length
    ? []
    : await resolveAdIdScopedAdConfigPaths(
        operation,
        params,
        { ...config, configPath: baseCliConfig.configPath },
      );
  const scopedAdConfigPaths = requestedScopedAdConfigPaths.length
    ? requestedScopedAdConfigPaths
    : adIdScopedAdConfigPaths;
  if (operation === "publish" && scopedAdConfigPaths.length > 0) {
    const inactiveAds = await inactiveScopedPublishAds(scopedAdConfigPaths, config);
    if (inactiveAds.length) {
      const preflightCliConfig = { ...baseCliConfig, adFileOverrides: scopedAdConfigPaths };
      const args = buildKleinanzeigenArgs(operation, params, preflightCliConfig);
      return buildInactivePublishPreflightResult({
        operation,
        inactiveAds,
        cliConfig: preflightCliConfig,
        args,
      });
    }
  }
  const snapshotPaths =
    scopedAdConfigPaths.length > 0
      ? scopedAdConfigPaths
      : await readConfiguredAdFiles(baseCliConfig.configPath);
  const imageChanges = ["publish", "update"].includes(operation) && params.fillOnly !== true
    ? await refreshImageFingerprints(snapshotPaths, config)
    : [];
  const beforeSnapshots = await readAdOperationSnapshots(snapshotPaths, config);
  const cliConfig = scopedAdConfigPaths.length > 0
    ? { ...baseCliConfig, adFileOverrides: scopedAdConfigPaths }
    : baseCliConfig;
  await assertConfiguredFiles(cliConfig);
  let args;
  let result;
  args = buildKleinanzeigenArgs(operation, params, cliConfig);
  result = await runRuntimeProcess(cliConfig.runtime, args, {
    cwd: cliConfig.cwd,
    timeoutMs: OPERATIONS[operation]?.sideEffect ? cliConfig.liveTimeoutMs : cliConfig.timeoutMs,
    maxBufferChars: cliConfig.maxOutputChars,
    env: buildChildEnv(),
    commandRunner: cliConfig.commandRunner,
  });
  const afterSnapshots = await readAdOperationSnapshots(snapshotPaths, config);
  const redactions = buildRedactions({ ...config, ...cliConfig });
  const rawText = [result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n");
  const userAction = detectUserActionRequest(rawText);

  const stdout = sanitizeText(result.stdout, redactions, cliConfig.maxOutputChars);
  const stderr = sanitizeText(
    result.error ? `${result.stderr}\n${result.error.message}` : result.stderr,
    redactions,
    cliConfig.maxOutputChars,
  );
  const diagnostics = await extractKleinanzeigenDiagnostics(
    rawText,
    scopedAdConfigPaths.length > 0
      ? { ...config, adFileOverrides: scopedAdConfigPaths }
      : config,
  );
  const nextActions = buildNextActions(diagnostics, scopedAdConfigPaths.length > 0);
  const outcome = buildOperationOutcome({
    operation,
    result,
    rawText,
    beforeSnapshots,
    afterSnapshots,
  });

  return {
    ok: outcome.success,
    operation,
    outcome,
    command: {
      executable: cliConfig.runtime.label,
      args: redactArgs(args),
    },
    processOk: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    needsUserAction: userAction.needsUserAction,
    ...(userAction.needsUserAction ? { userActionHint: userAction.userActionHint } : {}),
    ...(diagnostics.length ? { diagnostics, nextActions } : {}),
    ...(imageChanges.length ? { imageChanges } : {}),
    stdout,
    stderr,
  };
}
