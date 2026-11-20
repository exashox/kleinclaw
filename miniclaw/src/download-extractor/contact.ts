/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */

import { extractAdIdFromAdUrl } from "../ad-identity.js";
import { type ContactInput } from "../model/ad-model.js";
import { isRecord } from "../value-guards.js";
import {
  By,
  TimeoutError,
  type WebElement,
  type WebLocator,
} from "../web-primitives.js";
import { elementPresent, type ProbingController } from "./probe.js";

interface ContactController extends ProbingController {
  webFind(
    type: By,
    value: string,
    options?: { parent?: WebLocator | WebElement | null; timeout?: number },
  ): Promise<WebLocator>;
  webText(
    type: By,
    value: string,
    options?: { parent?: WebLocator | WebElement | null; timeout?: number },
  ): Promise<string>;
}

export function extractSellDirectlyFromAdPage(
  pageUrl: string,
  publishedAdsById: ReadonlyMap<number, unknown>,
): boolean | null {
  try {
    const currentAdId = extractAdIdFromAdUrl(pageUrl);
    if (currentAdId === -1) {
      return null;
    }
    const cachedAd = publishedAdsById.get(currentAdId);
    if (!isRecord(cachedAd)) {
      return null;
    }
    const buyNowEligible = cachedAd?.buyNowEligible;
    return typeof buyNowEligible === "boolean" ? buyNowEligible : null;
  } catch {
    return null;
  }
}

async function optionalText(read: () => Promise<string>): Promise<string | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof TimeoutError) {
      return null;
    }
    throw error;
  }
}

/**
 * Reads the seller's contact box. Every field is best effort: the box layout
 * changes now and then, and a missing name must not fail the whole download.
 */
export async function extractContactFromAdPage(
  controller: ContactController,
): Promise<ContactInput> {
  const contact: ContactInput = {};
  const addressText = await elementPresent(controller, By.ID, "viewad-locality")
    ? (await optionalText(() => controller.webText(By.ID, "viewad-locality"))) ?? ""
    : "";
  // Private sellers usually hide the street, so it is often missing.
  if (await elementPresent(controller, By.ID, "street-address")) {
    try {
      const street = await controller.webText(By.ID, "street-address");
      contact.street = street.slice(0, -1);
    } catch (error) {
      if (!(error instanceof TimeoutError)) {
        throw error;
      }
    }
  }

  const [zipcode, ...locationParts] = addressText.split(" ");
  contact.zipcode = zipcode ?? "";
  contact.location = locationParts.join(" ");

  const name = await extractContactName(controller);
  if (name !== null) {
    contact.name = name;
  }

  if (!("street" in contact)) {
    contact.street = null;
  }
  if (!(await elementPresent(controller, By.ID, "viewad-contact-phone"))) {
    contact.phone = null;
    return contact;
  }
  try {
    const phoneElement = await controller.webFind(
      By.ID,
      "viewad-contact-phone",
    );
    const phoneNumber = await controller.webText(
      By.TAG_NAME,
      "a",
      { parent: phoneElement },
    );
    contact.phone = phoneNumber
      .replaceAll("-", " ")
      .split(" ")
      .join("")
      .replace("+49(0)", "0");
  } catch (error) {
    if (!(error instanceof TimeoutError)) {
      throw error;
    }
    contact.phone = null;
  }

  return contact;
}

async function extractContactName(controller: ContactController): Promise<string | null> {
  if (!(await elementPresent(controller, By.ID, "viewad-contact"))) {
    return null;
  }
  let contactPersonElement: WebLocator;
  try {
    contactPersonElement = await controller.webFind(By.ID, "viewad-contact");
  } catch (error) {
    if (error instanceof TimeoutError) {
      return null;
    }
    throw error;
  }
  for (const className of ["iconlist-text", "userprofile-vip", "text-body-regular-strong"]) {
    if (!(await elementPresent(controller, By.CLASS_NAME, className, { parent: contactPersonElement }))) {
      continue;
    }
    let nameElement: WebLocator;
    try {
      nameElement = await controller.webFind(By.CLASS_NAME, className, {
        parent: contactPersonElement,
        timeout: 2,
      });
    } catch (error) {
      if (error instanceof TimeoutError) {
        continue;
      }
      throw error;
    }
    for (const tag of ["a", "span"]) {
      if (!(await elementPresent(controller, By.TAG_NAME, tag, { parent: nameElement }))) {
        continue;
      }
      const text = await optionalText(() =>
        controller.webText(By.TAG_NAME, tag, { parent: nameElement, timeout: 2 }),
      );
      if (text?.trim()) {
        return text.trim();
      }
    }
    const text = await optionalText(() =>
      controller.webText(By.CLASS_NAME, className, { parent: contactPersonElement, timeout: 2 }),
    );
    if (text?.trim()) {
      return text.trim();
    }
  }
  return null;
}
