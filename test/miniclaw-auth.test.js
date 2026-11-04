import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  fillLoginDataAndSend,
  getLoginState,
  handleCodeChallengePage,
  LoginDetectionReason,
} from "../miniclaw/dist/auth.js";
import { Config } from "../miniclaw/dist/model/config-model.js";
import { By } from "../miniclaw/dist/web-primitives.js";

describe("miniclaw auth", () => {
  it("uses the single-attempt selector-group helper for login probes", async () => {
    const helperCalls = [];
    const controller = {
      page: { url: "https://www.kleinanzeigen.de/" },
      async webTextFirstAvailable() {
        throw new Error("legacy helper should not be used");
      },
      async webTextFirstAvailableOnce(selectors, options = {}) {
        helperCalls.push({ options, selectors });
        return ["User user@example.test", 1];
      },
    };

    const result = await getLoginState(
      controller,
      new Config({ login: { username: "user@example.test" } }).login,
      { quickDomTimeout: 0.1 },
    );

    assert.equal(result.isLoggedIn, true);
    assert.equal(result.reason, LoginDetectionReason.USER_INFO_MATCH);
    assert.equal(helperCalls.length, 1);
    assert.equal(helperCalls[0].options.key, "quickDom");
    assert.equal(helperCalls[0].options.timeout, 0.1);
  });

  it("stops at captcha before submitting the username step", async () => {
    const expected = new Error("manual captcha boundary");
    let manualCaptchaCalls = 0;
    let submitClicks = 0;
    const controller = {
      page: { url: "https://login.kleinanzeigen.de/u/login/identifier" },
      async webInput(type, value, text) {
        assert.equal(type, By.ID);
        assert.equal(value, "username");
        assert.equal(text, "user@example.invalid");
      },
      async webClick() {
        submitClicks += 1;
      },
      async webProbe(type) {
        if (type === By.CSS_SELECTOR) {
          return {};
        }
        return null;
      },
      async webSleep() {},
      async webText() {
        return "";
      },
    };

    await assert.rejects(
      () => fillLoginDataAndSend(
        controller,
        { username: "user@example.invalid", password: "secret" },
        {
          captchaDetectionTimeout: 0.1,
          onManualCaptcha: () => {
            manualCaptchaCalls += 1;
            throw expected;
          },
        },
      ),
      expected,
    );

    assert.equal(manualCaptchaCalls, 1);
    assert.equal(submitClicks, 0);
  });

  it("does not submit username again if captcha reaches password step", async () => {
    let manualCaptchaCalls = 0;
    let usernameSubmitClicks = 0;
    let passwordSubmitClicks = 0;
    const controller = {
      page: { url: "https://login.kleinanzeigen.de/u/login/identifier" },
      async webInput(type, value, text) {
        if (value === "username") {
          assert.equal(type, By.ID);
          assert.equal(text, "user@example.invalid");
          return;
        }
        assert.equal(type, By.CSS_SELECTOR);
        assert.equal(value, "input[type='password']");
        assert.equal(text, "secret");
      },
      async webClick() {
        if (this.page.url.includes("/identifier")) {
          usernameSubmitClicks += 1;
          return;
        }
        passwordSubmitClicks += 1;
        this.page.url = "https://www.kleinanzeigen.de/";
      },
      async webProbe(type) {
        if (
          type === By.CSS_SELECTOR &&
            this.page.url.includes("/identifier")
        ) {
          return {};
        }
        return null;
      },
      async webSleep() {},
      async webText() {
        return "";
      },
    };

    await fillLoginDataAndSend(
      controller,
      { username: "user@example.invalid", password: "secret" },
      {
        captchaDetectionTimeout: 0.1,
        onManualCaptcha: () => {
          manualCaptchaCalls += 1;
          controller.page.url = "https://login.kleinanzeigen.de/u/login/password";
        },
      },
    );

    assert.equal(manualCaptchaCalls, 1);
    assert.equal(usernameSubmitClicks, 0);
    assert.equal(passwordSubmitClicks, 1);
  });
});

describe("miniclaw SMS code challenge", () => {
  function makeController({ hasChallenge = true, inputSelector = "input[type='tel']" } = {}) {
    const calls = { clicks: [], inputs: [], probes: [] };
    const controller = {
      page: { url: "https://login.kleinanzeigen.de/u/mfa-sms-challenge" },
      calls,
      async webProbe(type, value) {
        calls.probes.push([type, value]);
        if (type === By.TEXT && value === "Code senden") {
          return hasChallenge ? {} : null;
        }
        if (type === By.CSS_SELECTOR && value === inputSelector && calls.clicks.length) {
          return {};
        }
        return null;
      },
      async webClick(type, value) {
        calls.clicks.push([type, value]);
        if (type === By.CSS_SELECTOR && value === "button[type='submit']") {
          controller.page.url = "https://www.kleinanzeigen.de/";
        }
        return {};
      },
      async webInput(type, value, text) {
        calls.inputs.push([type, value, text]);
        return {};
      },
      async webSleep() {},
      async webExecute() {
        return JSON.stringify({ inputs: [], buttons: [] });
      },
    };
    return controller;
  }

  it("does nothing when the challenge page is not shown", async () => {
    const controller = makeController({ hasChallenge: false });
    const handled = await handleCodeChallengePage(controller, { quickDomTimeout: 0.1 });
    assert.equal(handled, false);
    assert.equal(controller.calls.clicks.length, 0);
  });

  it("requests the code, enters the supplied code and submits", async () => {
    const controller = makeController();
    const handled = await handleCodeChallengePage(controller, {
      quickDomTimeout: 0.1,
      smsCodeInputTimeout: 1,
      onSmsCode: async () => " 123456 ",
    });
    assert.equal(handled, true);
    assert.deepEqual(controller.calls.clicks[0], [By.TEXT, "Code senden"]);
    assert.deepEqual(controller.calls.inputs, [
      [By.CSS_SELECTOR, "input[type='tel']", "123456"],
    ]);
    assert.deepEqual(controller.calls.clicks[1], [By.CSS_SELECTOR, "button[type='submit']"]);
  });

  it("refuses non-numeric codes without typing them", async () => {
    const controller = makeController();
    await assert.rejects(
      () => handleCodeChallengePage(controller, {
        quickDomTimeout: 0.1,
        smsCodeInputTimeout: 1,
        onSmsCode: async () => "abc",
      }),
      /4 to 8 digits/,
    );
    assert.equal(controller.calls.inputs.length, 0);
  });

  it("does not request a code without a terminal or code provider", async () => {
    const controller = makeController();
    await assert.rejects(
      () => handleCodeChallengePage(controller, { quickDomTimeout: 0.1 }),
      /interactive terminal/,
    );
    assert.equal(controller.calls.clicks.length, 0);
  });

  it("reports the page structure when the code field is missing", async () => {
    const controller = makeController({ inputSelector: "input#nothing-matches" });
    await assert.rejects(
      () => handleCodeChallengePage(controller, {
        quickDomTimeout: 0.1,
        smsCodeInputTimeout: 0.2,
        pollIntervalMs: 10,
        onSmsCode: async () => "123456",
      }),
      /SMS code field not found/,
    );
    assert.equal(controller.calls.inputs.length, 0);
  });
});
