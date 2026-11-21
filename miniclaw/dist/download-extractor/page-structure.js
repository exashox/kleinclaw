/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */
import fs from "node:fs/promises";
import path from "node:path";
export const PAGE_STRUCTURE_PREFIX = "Page structure for ad";
/** When set, the structure is saved there as page-structure-<adId>.json. */
export const PAGE_STRUCTURE_DIR_ENV = "MINICLAW_PAGE_STRUCTURE_DIR";
const PAGE_STRUCTURE_LIMIT = 3000;
const PAGE_STRUCTURE_FILE_LIMIT = 20000;
/**
 * Collects where images, the shipping line, the date, and state labels sit on
 * the ad page: element paths (tag, id, up to three classes) plus at most 60
 * characters of the element's own text. The description is skipped. Used to
 * find selectors when Kleinanzeigen changes the layout.
 */
export const PAGE_STRUCTURE_SCRIPT = String.raw `(() => {
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
    Array.from(el.classList).slice(0, 3).map((c) => "." + c).join("");
  const elementPath = (el) => {
    const parts = [];
    for (let cur = el; cur && cur !== document.body && parts.length < 6; cur = cur.parentElement) {
      parts.unshift(name(cur));
    }
    return parts.join(" > ");
  };
  const ownText = (el) => Array.from(el.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const skip = (el) => el.closest("#viewad-description, script, style, noscript");
  const all = Array.from(document.body.querySelectorAll("*")).filter((el) => !skip(el));
  const textHits = (re) => all
    .filter((el) => re.test(ownText(el)))
    .slice(0, 6)
    .map((el) => ({ path: elementPath(el), text: ownText(el).slice(0, 60) }));
  const groups = new Map();
  for (const img of document.querySelectorAll("img")) {
    const src = img.currentSrc || img.src || img.dataset.src || img.dataset.imgsrc || "";
    if (!/img\.kleinanzeigen\.de\/api\/v1\/prod-ads\/images\//.test(src)) {
      continue;
    }
    const key = elementPath(img.parentElement || img);
    const group = groups.get(key) || { count: 0, ids: new Set(), rule: "" };
    group.count += 1;
    group.ids.add(src.split("?")[0].split("/").pop());
    group.rule = group.rule || (src.split("?")[1] || "");
    groups.set(key, group);
  }
  return JSON.stringify({
    url: location.pathname,
    images: Array.from(groups.entries()).slice(0, 8).map(([path, group]) => ({
      path, count: group.count, distinct: group.ids.size, rule: group.rule,
    })),
    shipping: textHits(/Versand|Abholung/i),
    date: textHits(/\bvor (einer|einem|\d+)\b|\b\d{2}\.\d{2}\.\d{4}\b|\b(heute|gestern)\b/i),
    state: textHits(/^(Gelöscht|Reserviert|Verkauft|Deaktiviert|Pausiert|Abgelaufen)\b/i),
  });
})()`;
/**
 * Saves the page structure to `directory` (default: the
 * MINICLAW_PAGE_STRUCTURE_DIR environment variable), otherwise prints it on
 * stderr; never fails the download.
 */
export async function reportPageStructure(controller, adId, missing, { log = (line) => console.error(line), directory = process.env[PAGE_STRUCTURE_DIR_ENV], } = {}) {
    try {
        const raw = await controller.webExecute(PAGE_STRUCTURE_SCRIPT);
        let structure = raw;
        if (typeof raw === "string") {
            try {
                structure = JSON.parse(raw);
            }
            catch {
                structure = raw;
            }
        }
        const text = JSON.stringify({ missing, structure });
        if (directory) {
            await fs.mkdir(directory, { recursive: true });
            await fs.writeFile(path.join(directory, `page-structure-${adId}.json`), text.slice(0, PAGE_STRUCTURE_FILE_LIMIT), { encoding: "utf8", mode: 0o600 });
            log(`${PAGE_STRUCTURE_PREFIX} ${adId} saved (missing: ${missing.join(", ")})`);
            return;
        }
        log(`${PAGE_STRUCTURE_PREFIX} ${adId}: ${text.slice(0, PAGE_STRUCTURE_LIMIT)}`);
    }
    catch {
        // Diagnostics only.
    }
}
