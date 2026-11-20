/*
 * SPDX-FileCopyrightText: © Sebastian Thomschke and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */

import {
  type By,
  type WebElement,
  type WebLocator,
} from "../web-primitives.js";

export interface ProbingController {
  webProbe?(
    type: By,
    value: string,
    options?: { parent?: WebLocator | WebElement | null; timeout?: number },
  ): Promise<WebLocator | null>;
}

/**
 * Checks once and briefly whether an optional element exists.
 *
 * The ad page is already loaded when optional fields are read (the title is
 * awaited first), so a missing element will not appear later. The regular
 * lookup would wait through every retry (about 24 seconds) for each missing
 * field. Controllers without `webProbe` keep the regular lookup.
 */
export async function elementPresent(
  controller: ProbingController,
  type: By,
  value: string,
  options: { parent?: WebLocator | WebElement | null } = {},
): Promise<boolean> {
  if (typeof controller.webProbe !== "function") {
    return true;
  }
  return (await controller.webProbe(type, value, options)) !== null;
}
