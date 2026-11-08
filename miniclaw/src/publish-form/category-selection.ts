/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */

import { By, TimeoutError, type WebElement } from "../web-primitives.js";
import {
  CATEGORY_CHANGE_CONTROL_XPATH,
  CATEGORY_NEXT_BUTTON_XPATH,
  CATEGORY_PICKER_RADIO_SELECTOR,
} from "./constants.js";
import { BUILTIN_CATEGORIES } from "../resources/categories.js";
import { CategoryResolutionError } from "./errors.js";
import {
  clickElement,
  elementAttribute,
  stringOrNull,
  visibleElementText,
  xpathLiteral,
} from "./element-helpers.js";
import {
  type PublishingFormController,
  type PublishingFormOptions,
  type SetCategoryOptions,
} from "./types.js";

export async function resolveCategorySuggestions(
  controller: Pick<
    PublishingFormController,
    "webClick" | "webFindAll" | "webProbe" | "webSleep"
  >,
  category: string,
  { quickDomTimeout }: PublishingFormOptions = {},
): Promise<boolean> {
  const picker = await controller.webProbe(By.ID, "ad-category-picker", {
    timeout: quickDomTimeout,
  });
  if (picker === null) {
    return false;
  }

  let radioByValue = new Map<string, WebElement>();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let radios: WebElement[] = [];
    try {
      radios = await controller.webFindAll(
        By.CSS_SELECTOR,
        CATEGORY_PICKER_RADIO_SELECTOR,
        { timeout: quickDomTimeout },
      );
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        throw error;
      }
    }

    radioByValue = new Map();
    for (const radio of radios) {
      const value = String(await elementAttribute(radio, "value") ?? "").trim();
      if (value && !radioByValue.has(value)) {
        radioByValue.set(value, radio);
      }
    }

    if (radioByValue.size > 0) {
      break;
    }
    if (attempt === 0) {
      await controller.webSleep(200, 350);
    }
  }

  if (radioByValue.size === 0) {
    throw new TimeoutError(
      "Category suggestion picker element found but no radio suggestions " +
      "rendered after waiting.",
    );
  }

  const segments = category
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reverse();
  for (const segment of segments) {
    const radio = radioByValue.get(segment);
    if (!radio) {
      continue;
    }
    const radioId = stringOrNull(await elementAttribute(radio, "id"));
    try {
      if (radioId) {
        await controller.webClick(
          By.XPATH,
          "//fieldset[@id='ad-category-picker']" +
          `//label[@for=${xpathLiteral(radioId)}]`,
          quickDomTimeout,
        );
      } else {
        await clickElement(radio, "Category suggestion radio cannot be clicked");
      }
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        throw error;
      }
      await clickElement(radio, "Category suggestion radio cannot be clicked");
    }
    return true;
  }

  const offered = [...radioByValue.keys()].sort().join(", ") || "(none)";
  throw new CategoryResolutionError(
    "Category suggestion picker shown, but no segment of configured path " +
    `'${category}' matched the offered suggestions [${offered}]. Update the ` +
    "ad's 'category' to an offered ID or a valid full path.",
  );
}

/**
 * Finds the "Kategorie wählen" modal: an ARIA dialog, or else the nearest
 * ancestor of its heading that also holds the "Übernehmen" button.
 */
const FIND_CATEGORY_DIALOG_JS = `
  const norm = (text) => (text || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => el.getClientRects().length > 0;
  const findDialog = () => {
    const aria = [...document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')]
      .find((el) => visible(el) && norm(el.innerText).includes("Kategorie wählen"));
    if (aria) return aria;
    const heading = [...document.querySelectorAll("h1, h2, h3, h4, header, div, span")]
      .find((el) => visible(el) && norm(el.innerText) === "Kategorie wählen");
    for (let node = heading; node; node = node.parentElement) {
      if ([...node.querySelectorAll("button")].some((b) => norm(b.innerText) === "Übernehmen")) {
        return node;
      }
    }
    return null;
  };
`;

/**
 * Picks the dialog entry that best matches the wanted name. Entries are the
 * innermost visible text elements, so the script does not depend on the
 * dialog's markup. Matching ignores case, umlaut spelling, "&" vs "und" and
 * punctuation, then falls back to word overlap.
 */
const PICK_CATEGORY_ENTRY_JS = `
  const CHROME_TEXTS = new Set([
    "kategorie wahlen", "kategorie waehlen", "alle kategorien", "abbrechen",
    "ubernehmen", "uebernehmen", "zuruck", "zurueck", "schliessen",
  ]);
  const key = (text) => norm(text).toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/&/g, " ").replace(/\\bund\\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
  const score = (a, b) => {
    const x = key(a);
    const y = key(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.replace(/ /g, "") === y.replace(/ /g, "")) return 0.95;
    const xs = new Set(x.split(" "));
    const ys = new Set(y.split(" "));
    const shared = [...xs].filter((token) => ys.has(token)).length;
    const overlap = shared / new Set([...xs, ...ys]).size;
    return Math.max(overlap, x.includes(y) || y.includes(x) ? 0.6 : 0);
  };
  const entries = [];
  const seen = new Set();
  for (const el of dialog.querySelectorAll("*")) {
    // Only elements that carry text themselves, not containers of several entries.
    const ownText = [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent).join(" ");
    const text = norm(el.innerText);
    if (!norm(ownText) || !text || text.length > 80 || !visible(el)) continue;
    if (CHROME_TEXTS.has(key(text)) || seen.has(text)) continue;
    seen.add(text);
    entries.push({ el, text });
  }
  const signature = entries.map((entry) => entry.text).join("|");
  if (signature === previous) {
    return JSON.stringify({ status: "stale" });
  }
  const ranked = entries
    .map((entry) => ({ ...entry, score: score(entry.text, want) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < 0.5) {
    return JSON.stringify({ status: "missing", offered: entries.map((entry) => entry.text).slice(0, 40) });
  }
  best.el.scrollIntoView({ block: "center" });
  best.el.click();
  return JSON.stringify({ status: "ok", picked: best.text, score: best.score, signature });
`;

interface CategoryPickResult {
  status: "ok" | "missing" | "stale";
  picked?: string;
  offered?: string[];
  signature?: string;
}

function parsePickResult(raw: unknown): CategoryPickResult | null {
  if (typeof raw !== "string" || !raw.startsWith("{")) {
    return null;
  }
  return JSON.parse(raw) as CategoryPickResult;
}

function categoryDialogScript(body: string): string {
  return `(() => {${FIND_CATEGORY_DIALOG_JS}
    const dialog = findDialog();
    if (!dialog) return "no-dialog";
    ${body}
  })()`;
}

/**
 * Kleinanzeigen lists categories by display name, so configured IDs such as
 * "210/211/bootszubehoer" are mapped back to their most specific name path.
 */
export function categoryNamePath(category: string): string[] {
  if (category.includes(">")) {
    return category.split(">").map((segment) => segment.trim()).filter(Boolean);
  }
  let best: string[] | null = null;
  for (const [name, id] of Object.entries(BUILTIN_CATEGORIES)) {
    if (id !== category) {
      continue;
    }
    const segments = name.split(">").map((segment) => segment.trim());
    if (!best || segments.length > best.length) {
      best = segments;
    }
  }
  if (!best) {
    throw new CategoryResolutionError(
      `Category '${category}' has no known display name for the category dialog. ` +
        "Use the full path, e.g. 'Auto, Rad & Boot > Boote & Bootszubehör > Bootszubehör'.",
    );
  }
  return best;
}

async function waitForCategoryDialog(
  controller: Pick<PublishingFormController, "webExecute" | "webSleep">,
  attempts = 10,
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await controller.webExecute(categoryDialogScript('return "ok";')) === "ok") {
      return true;
    }
    await controller.webSleep(300, 500);
  }
  return false;
}

async function selectCategoryInDialog(
  controller: Pick<PublishingFormController, "webExecute" | "webSleep">,
  segments: string[],
): Promise<void> {
  const picked: string[] = [];
  // Entries of the level clicked last; the next level counts only once they changed.
  let previous = "";
  for (const segment of segments) {
    let result: CategoryPickResult | null = null;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      result = parsePickResult(await controller.webExecute(categoryDialogScript(
        `const want = ${JSON.stringify(segment)};` +
          `const previous = ${JSON.stringify(previous)};${PICK_CATEGORY_ENTRY_JS}`,
      )));
      if (result?.status === "ok") {
        previous = result.signature ?? "";
        break;
      }
      // The next level may still be rendering after the previous click.
      await controller.webSleep(300, 500);
    }
    if (result?.status !== "ok") {
      throw new CategoryResolutionError(
        `Category dialog has no entry matching '${segment}' ` +
          `(wanted ${segments.join(" > ")}, chosen so far ${picked.join(" > ") || "-"}). ` +
          `Offered at this level: ${(result?.offered ?? []).join(" | ") || "(no dialog)"}. ` +
          "Set the ad's category to the matching display path, " +
          "e.g. 'Level 1 > Level 2 > Level 3'.",
      );
    }
    picked.push(result.picked ?? segment);
    await controller.webSleep();
  }
  console.error(`Category dialog: chose ${picked.join(" > ")}`);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await controller.webExecute(categoryDialogScript(`
      const button = [...dialog.querySelectorAll("button")]
        .find((el) => norm(el.innerText) === "Übernehmen");
      if (!button) return "no-button";
      if (button.disabled || button.getAttribute("aria-disabled") === "true") return "disabled";
      button.click();
      return "ok";
    `));
    // The dialog may also close by itself once a leaf category is chosen.
    if (result === "ok" || result === "no-dialog") {
      await controller.webSleep();
      return;
    }
    await controller.webSleep(300, 500);
  }
  throw new CategoryResolutionError(
    `Category '${segments.join(" > ")}' was clicked, but "Übernehmen" stayed disabled.`,
  );
}

export async function setCategory(
  controller: Pick<
    PublishingFormController,
    | "webClick"
    | "webExecute"
    | "webFind"
    | "webFindAll"
    | "webOpen"
    | "webProbe"
    | "webSleep"
  >,
  { adFile, category, rootUrl, quickDomTimeout }: SetCategoryOptions,
): Promise<void> {
  await controller.webClick(By.ID, "ad-description");

  const categoryPathElement = await controller.webProbe(By.ID, "ad-category-path");
  const isCategoryAutoSelected = categoryPathElement !== null &&
    (await visibleElementText(categoryPathElement)) !== "";

  if (!category) {
    if (!isCategoryAutoSelected) {
      throw new Error(
        `No category specified in [${adFile}] and automatic category detection failed`,
      );
    }
    return;
  }

  await controller.webSleep();
  await controller.webClick(By.XPATH, CATEGORY_CHANGE_CONTROL_XPATH);
  if (await waitForCategoryDialog(controller)) {
    await selectCategoryInDialog(controller, categoryNamePath(category));
    return;
  }
  await controller.webFind(By.XPATH, CATEGORY_NEXT_BUTTON_XPATH);
  await controller.webOpen(`${rootUrl}/p-kategorie-aendern.html#?path=${category}`);
  await controller.webClick(By.XPATH, CATEGORY_NEXT_BUTTON_XPATH);
  await resolveCategorySuggestions(controller, category, { quickDomTimeout });
}
