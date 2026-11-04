/*
 * SPDX-FileCopyrightText: © Jens Bergmann and contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 * SPDX-ArtifactOfProjectHomePage: https://github.com/Second-Hand-Friends/kleinanzeigen-bot/
 */
import assert from "node:assert";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { CAPTCHA_IFRAME_SELECTOR, checkAndWaitForCaptcha } from "./publish-form.js";
import { hasErrorName } from "./value-guards.js";
import { By, TimeoutError, } from "./web-primitives.js";
export const LOGIN_DETECTION_SELECTORS = [
    [By.CLASS_NAME, "mr-medium"],
    [By.ID, "user-email"],
];
export const LOGGED_OUT_CTA_SELECTORS = [
    [By.CSS_SELECTOR, 'a[href*="einloggen"]'],
    [By.CSS_SELECTOR, 'a[href*="/m-einloggen"]'],
];
export var LoginDetectionReason;
(function (LoginDetectionReason) {
    LoginDetectionReason["USER_INFO_MATCH"] = "USER_INFO_MATCH";
    LoginDetectionReason["CTA_MATCH"] = "CTA_MATCH";
    LoginDetectionReason["SELECTOR_TIMEOUT"] = "SELECTOR_TIMEOUT";
})(LoginDetectionReason || (LoginDetectionReason = {}));
export class LoginDetectionResult {
    isLoggedIn;
    reason;
    constructor(isLoggedIn, reason) {
        if (isLoggedIn && reason !== LoginDetectionReason.USER_INFO_MATCH) {
            throw new Error("isLoggedIn=true requires reason=USER_INFO_MATCH");
        }
        if (!isLoggedIn && reason === LoginDetectionReason.USER_INFO_MATCH) {
            throw new Error("isLoggedIn=false requires reason=CTA_MATCH or SELECTOR_TIMEOUT");
        }
        this.isLoggedIn = isLoggedIn;
        this.reason = reason;
    }
}
function isTimeoutLike(error) {
    return error instanceof TimeoutError ||
        hasErrorName(error, "TimeoutError");
}
function loginOptionsWithDefaults(options) {
    return {
        captchaDetectionTimeout: options.captchaDetectionTimeout ?? 2,
        captureDiagnostics: options.captureDiagnostics,
        emailVerificationTimeout: options.emailVerificationTimeout ?? 5,
        loginDetectionTimeout: options.loginDetectionTimeout ?? 12,
        onManualCaptcha: options.onManualCaptcha,
        onSmsCode: options.onSmsCode,
        onVerificationPrompt: options.onVerificationPrompt,
        pageLoadTimeout: options.pageLoadTimeout ?? 15,
        pollIntervalMs: options.pollIntervalMs ?? 250,
        quickDomTimeout: options.quickDomTimeout ?? 2,
        rootUrl: options.rootUrl ?? "https://www.kleinanzeigen.de",
        smsCodeInputTimeout: options.smsCodeInputTimeout ?? 20,
        smsVerificationTimeout: options.smsVerificationTimeout ?? 5,
    };
}
function requireLoginCredentials(credentials) {
    if (!credentials.username.trim() || !credentials.password) {
        throw new Error("login.username and login.password must be configured before browser login");
    }
}
export function currentPageUrl(controller) {
    const url = controller.page?.url;
    if (!url) {
        return "unknown";
    }
    try {
        const parsed = new URL(url);
        const netloc = parsed.port
            ? `${parsed.hostname}:${parsed.port}`
            : parsed.hostname;
        return `${parsed.protocol}//${netloc}${parsed.pathname}` || "unknown";
    }
    catch {
        return "unknown";
    }
}
export function isValidPostAuth0Destination(url) {
    if (!url || url === "unknown" || url === "about:blank") {
        return false;
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host !== "kleinanzeigen.de" && !host.endsWith(".kleinanzeigen.de")) {
        return false;
    }
    if (host === "login.kleinanzeigen.de") {
        return false;
    }
    if (path.startsWith("/u/login")) {
        return false;
    }
    return !path.includes("error");
}
async function captureLoginDiagnostics(options, context) {
    if (!options.captureDiagnostics) {
        return;
    }
    try {
        await options.captureDiagnostics(context);
    }
    catch {
        // Diagnostics must not hide the original login boundary failure.
    }
}
async function waitForCondition(controller, condition, { pollIntervalMs, timeout, timeoutErrorMessage, }) {
    const deadline = Date.now() + timeout * 1000;
    while (true) {
        if (await condition()) {
            return;
        }
        if (Date.now() >= deadline) {
            throw new TimeoutError(timeoutErrorMessage);
        }
        await controller.webSleep(pollIntervalMs, pollIntervalMs);
    }
}
async function textFirstAvailable(controller, selectors, timeout, key) {
    if (controller.webTextFirstAvailableOnce) {
        const [text, index] = await controller.webTextFirstAvailableOnce(selectors, {
            key,
            timeout,
        });
        return { index, text };
    }
    if (controller.webTextFirstAvailable) {
        const [text, index] = await controller.webTextFirstAvailable(selectors, {
            timeout,
        });
        return { index, text };
    }
    let lastError = null;
    for (let index = 0; index < selectors.length; index += 1) {
        const selector = selectors[index];
        if (!selector) {
            continue;
        }
        const [type, value] = selector;
        try {
            return {
                index,
                text: await controller.webText(type, value, { timeout }),
            };
        }
        catch (error) {
            if (!isTimeoutLike(error)) {
                throw error;
            }
            lastError = error;
        }
    }
    throw new TimeoutError(`No login selector matched within ${timeout} seconds: ${String(lastError)}`);
}
async function hasLoggedInMarker(controller, credentials, options) {
    const username = credentials.username.trim().toLowerCase();
    if (!username) {
        return false;
    }
    const { loginDetectionTimeout = 12, quickDomTimeout = 2, } = options;
    try {
        const quickMatch = await textFirstAvailable(controller, LOGIN_DETECTION_SELECTORS, quickDomTimeout, "quickDom");
        if (quickMatch.text.toLowerCase().includes(username)) {
            return true;
        }
    }
    catch (error) {
        if (!isTimeoutLike(error)) {
            throw error;
        }
    }
    try {
        const match = await textFirstAvailable(controller, LOGIN_DETECTION_SELECTORS, loginDetectionTimeout, "loginDetection");
        return match.text.toLowerCase().includes(username);
    }
    catch (error) {
        if (isTimeoutLike(error)) {
            return false;
        }
        throw error;
    }
}
async function hasLoggedOutCta(controller, options) {
    const { quickDomTimeout = 2 } = options;
    try {
        const match = await textFirstAvailable(controller, LOGGED_OUT_CTA_SELECTORS, quickDomTimeout, "quickDom");
        return match.text.trim().length > 0;
    }
    catch (error) {
        if (isTimeoutLike(error)) {
            return false;
        }
        throw error;
    }
}
export async function getLoginState(controller, credentials, { captureSelectorDiagnostics = true, ...options } = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    if (await hasLoggedInMarker(controller, credentials, resolvedOptions)) {
        return new LoginDetectionResult(true, LoginDetectionReason.USER_INFO_MATCH);
    }
    if (await hasLoggedOutCta(controller, resolvedOptions)) {
        return new LoginDetectionResult(false, LoginDetectionReason.CTA_MATCH);
    }
    if (captureSelectorDiagnostics) {
        await captureLoginDiagnostics(resolvedOptions, {
            basePrefix: "login_detection_selector_timeout",
            reason: LoginDetectionReason.SELECTOR_TIMEOUT,
        });
    }
    return new LoginDetectionResult(false, LoginDetectionReason.SELECTOR_TIMEOUT);
}
export async function isLoggedIn(controller, credentials, options = {}) {
    return hasLoggedInMarker(controller, credentials, loginOptionsWithDefaults(options));
}
async function promptForManualAction(message) {
    if (!input.isTTY || !output.isTTY) {
        throw new Error(`${message} Manual browser action requires an interactive run.`);
    }
    console.error("############################################");
    console.error(message);
    console.error("############################################");
    const readline = createInterface({ input, output });
    try {
        await readline.question("Press ENTER when done...");
    }
    finally {
        readline.close();
    }
}
async function defaultManualCaptchaPrompt() {
    await promptForManualAction("# Captcha present! Please solve the captcha.");
}
async function defaultVerificationPrompt(context) {
    await promptForManualAction(`# Device verification message detected (${context.kind}). ` +
        "Please follow the instruction displayed in the browser.");
}
export const CODE_CHALLENGE_BUTTON_TEXT = "Code senden";
/** Button texts of the "send SMS code" page; Auth0 localizes by browser language. */
export const CODE_CHALLENGE_BUTTON_TEXTS = [
    CODE_CHALLENGE_BUTTON_TEXT,
    "Send code",
    "Send Code",
];
/** Candidate selectors for the SMS code field, most specific first. */
export const SMS_CODE_INPUT_SELECTORS = [
    "input[autocomplete='one-time-code']",
    "input[name='code']",
    "input[inputmode='numeric']",
    "input[type='tel']",
    "input[type='text']",
];
/**
 * Submit buttons for the SMS code, most specific first. Auth0 renders
 * "resend code" as a second submit button, so prefer the primary action.
 */
export const SMS_CODE_SUBMIT_SELECTORS = [
    "button[type='submit'][name='action'][value='default']",
    "button[type='submit'][value='default']",
];
const SMS_CODE_SUBMIT_FALLBACK = "button[type='submit']";
export const REMEMBER_DEVICE_SELECTOR = "input[type='checkbox'][name='rememberBrowser']";
const SMS_CODE_RE = /^\d{4,8}$/;
function isInteractiveTerminal() {
    return Boolean(input.isTTY && output.isTTY);
}
async function promptForSmsCode() {
    if (!isInteractiveTerminal()) {
        throw new Error("SMS code entry requires an interactive run.");
    }
    const readline = createInterface({ input, output });
    try {
        return await readline.question("SMS code from Kleinanzeigen: ");
    }
    finally {
        readline.close();
    }
}
async function findSmsCodeInput(controller, timeoutSeconds, pollIntervalMs) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
        for (const selector of SMS_CODE_INPUT_SELECTORS) {
            if (await controller.webProbe(By.CSS_SELECTOR, selector, { timeout: 0.5 })) {
                return selector;
            }
        }
        if (Date.now() >= deadline) {
            return null;
        }
        await controller.webSleep(pollIntervalMs, pollIntervalMs);
    }
}
async function findCodeChallengeButton(controller, timeoutSeconds) {
    for (const [index, text] of CODE_CHALLENGE_BUTTON_TEXTS.entries()) {
        // The page has settled after the first probe; later probes stay short.
        const timeout = index === 0 ? timeoutSeconds : 0.5;
        if (await controller.webProbe(By.TEXT, text, { timeout })) {
            return text;
        }
    }
    return null;
}
async function findSmsCodeSubmit(controller) {
    for (const selector of SMS_CODE_SUBMIT_SELECTORS) {
        if (await controller.webProbe(By.CSS_SELECTOR, selector, { timeout: 0.5 })) {
            return selector;
        }
    }
    return SMS_CODE_SUBMIT_FALLBACK;
}
/**
 * Ticks Auth0's "remember this device" box when the page offers it, so the
 * persistent browser profile is not asked for a code on every run.
 */
async function selectRememberDevice(controller) {
    if (!controller.webExecute) {
        return;
    }
    try {
        const state = await controller.webExecute(`(function(){var e=document.querySelector(${JSON.stringify(REMEMBER_DEVICE_SELECTOR)});` +
            "return e ? String(e.checked) : 'missing';})()");
        if (state === "false") {
            await controller.webClick(By.CSS_SELECTOR, REMEMBER_DEVICE_SELECTOR);
            console.error("# Selected 'remember this device'.");
        }
    }
    catch {
        // The checkbox is optional; never block the code entry on it.
    }
}
/** Describes the page structure without any field values, for diagnosing selector misses. */
async function describeCodePageStructure(controller) {
    if (!controller.webExecute) {
        return "(page structure unavailable)";
    }
    try {
        const result = await controller.webExecute("JSON.stringify({path: location.pathname, lang: document.documentElement.lang," +
            "headings: Array.from(document.querySelectorAll('h1,h2')).map(function(h){" +
            "return (h.innerText || '').trim().slice(0, 80);})," +
            "messages: Array.from(document.querySelectorAll(" +
            "\"[role='alert'],[id*='error'],[class*='error']\")).map(function(m){" +
            "return (m.innerText || '').trim().slice(0, 120);}).filter(Boolean)," +
            "inputs:Array.from(document.querySelectorAll('input')).map(function(e){" +
            "return {type: e.type, name: e.name, id: e.id, autocomplete: e.autocomplete," +
            "inputmode: e.inputMode, visible: !!(e.offsetWidth || e.offsetHeight)};})," +
            "buttons: Array.from(document.querySelectorAll('button')).map(function(b){" +
            "return {text: (b.innerText || '').trim().slice(0, 40), type: b.type," +
            "name: b.name, value: b.value};})})");
        return String(result);
    }
    catch {
        return "(page structure unavailable)";
    }
}
/**
 * Handles Kleinanzeigen's "Code senden" challenge page: requests the SMS code,
 * waits for the account owner to supply it, enters it and submits.
 * Returns false when the challenge page is not shown. Never logs the code.
 */
export async function handleCodeChallengePage(controller, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    const challengeText = await findCodeChallengeButton(controller, resolvedOptions.quickDomTimeout);
    if (!challengeText) {
        return false;
    }
    const provideCode = resolvedOptions.onSmsCode ?? promptForSmsCode;
    if (!resolvedOptions.onSmsCode && !isInteractiveTerminal()) {
        throw new Error("Kleinanzeigen asks for an SMS verification code. Run this from an " +
            "interactive terminal. No code was requested.");
    }
    await controller.webClick(By.TEXT, challengeText);
    const selector = await findSmsCodeInput(controller, resolvedOptions.smsCodeInputTimeout, resolvedOptions.pollIntervalMs);
    if (!selector) {
        console.error(`SMS code field not found. Page structure: ${await describeCodePageStructure(controller)}`);
        throw new Error("SMS code field not found after requesting the code " +
            `(url=${currentPageUrl(controller)})`);
    }
    console.error("# An SMS code was requested. Enter it in this terminal.");
    const code = String(await provideCode()).trim();
    if (!SMS_CODE_RE.test(code)) {
        throw new Error("The SMS code must be 4 to 8 digits.");
    }
    await controller.webInput(By.CSS_SELECTOR, selector, code);
    await selectRememberDevice(controller);
    await controller.webClick(By.CSS_SELECTOR, await findSmsCodeSubmit(controller));
    await waitForCondition(controller, () => isValidPostAuth0Destination(currentPageUrl(controller)), {
        pollIntervalMs: resolvedOptions.pollIntervalMs,
        timeout: Math.max(resolvedOptions.loginDetectionTimeout, 30),
        timeoutErrorMessage: `SMS code was not accepted (url=${currentPageUrl(controller)})`,
    });
    return true;
}
export async function waitForAuth0LoginContext(controller, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    try {
        await waitForCondition(controller, () => currentPageUrl(controller).includes("login.kleinanzeigen.de") ||
            currentPageUrl(controller).includes("/u/login"), {
            pollIntervalMs: resolvedOptions.pollIntervalMs,
            timeout: resolvedOptions.loginDetectionTimeout,
            timeoutErrorMessage: `Auth0 redirect did not start within ${resolvedOptions.loginDetectionTimeout} seconds`,
        });
    }
    catch (error) {
        if (isTimeoutLike(error)) {
            throw new assert.AssertionError({
                message: `Auth0 redirect not detected (url=${currentPageUrl(controller)})`,
            });
        }
        throw error;
    }
}
export async function waitForAuth0PasswordStep(controller, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    try {
        await waitForCondition(controller, () => currentPageUrl(controller).includes("/u/login/password"), {
            pollIntervalMs: resolvedOptions.pollIntervalMs,
            timeout: resolvedOptions.loginDetectionTimeout,
            timeoutErrorMessage: `Auth0 password page not reached within ${resolvedOptions.loginDetectionTimeout} seconds`,
        });
    }
    catch (error) {
        if (isTimeoutLike(error)) {
            throw new assert.AssertionError({
                message: `Auth0 password step not reached (url=${currentPageUrl(controller)})`,
            });
        }
        throw error;
    }
}
export async function waitForPostAuth0SubmitTransition(controller, credentials, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    try {
        await waitForCondition(controller, () => isValidPostAuth0Destination(currentPageUrl(controller)), {
            pollIntervalMs: resolvedOptions.pollIntervalMs,
            timeout: resolvedOptions.loginDetectionTimeout,
            timeoutErrorMessage: `Auth0 post-submit transition did not complete within ${resolvedOptions.loginDetectionTimeout} seconds`,
        });
        return;
    }
    catch (error) {
        if (!isTimeoutLike(error)) {
            throw error;
        }
    }
    if (await isLoggedIn(controller, credentials, resolvedOptions)) {
        return;
    }
    if (await controller.webProbe(By.CSS_SELECTOR, CAPTCHA_IFRAME_SELECTOR, {
        timeout: resolvedOptions.quickDomTimeout,
    })) {
        console.error(`Login page structure: ${await describeCodePageStructure(controller)}`);
        throw new Error("Kleinanzeigen shows a captcha after the password step; the login was not " +
            `completed (url=${currentPageUrl(controller)})`);
    }
    if (await handleCodeChallengePage(controller, resolvedOptions)) {
        return;
    }
    const fallbackMaxMs = Math.max(700, Math.trunc(resolvedOptions.quickDomTimeout * 1000));
    const fallbackMinMs = Math.max(300, Math.trunc(fallbackMaxMs / 2));
    await controller.webSleep(fallbackMinMs, fallbackMaxMs);
    if (await hasLoggedInMarker(controller, credentials, {
        ...resolvedOptions,
        loginDetectionTimeout: resolvedOptions.quickDomTimeout,
    })) {
        return;
    }
    console.error(`Login page structure: ${await describeCodePageStructure(controller)}`);
    throw new TimeoutError(`Auth0 post-submit verification remained inconclusive (url=${currentPageUrl(controller)})`);
}
export async function fillLoginDataAndSend(controller, credentials, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    await waitForAuth0LoginContext(controller, resolvedOptions);
    await controller.webInput(By.ID, "username", credentials.username);
    await checkAndWaitForCaptcha(controller, {
        captchaDetectionTimeout: resolvedOptions.captchaDetectionTimeout,
        isLoginPage: true,
        onManualCaptcha: async () => {
            await (resolvedOptions.onManualCaptcha ?? defaultManualCaptchaPrompt)();
        },
    });
    if (!currentPageUrl(controller).includes("/u/login/password")) {
        await controller.webClick(By.CSS_SELECTOR, "button[type='submit']");
    }
    await waitForAuth0PasswordStep(controller, resolvedOptions);
    await controller.webInput(By.CSS_SELECTOR, "input[type='password']", credentials.password);
    await checkAndWaitForCaptcha(controller, {
        captchaDetectionTimeout: resolvedOptions.captchaDetectionTimeout,
        isLoginPage: true,
        onManualCaptcha: async () => {
            await (resolvedOptions.onManualCaptcha ?? defaultManualCaptchaPrompt)();
        },
    });
    await controller.webClick(By.CSS_SELECTOR, "button[type='submit']");
    await waitForPostAuth0SubmitTransition(controller, credentials, resolvedOptions);
}
export async function clickGdprBanner(controller, timeout) {
    const element = await controller.webProbe(By.ID, "gdpr-banner-accept", {
        timeout,
    });
    if (element) {
        await element.click?.();
        await controller.webSleep();
    }
}
export async function dismissConsentBanner(controller, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    await clickGdprBanner(controller, resolvedOptions.quickDomTimeout);
}
async function checkVerificationPrompt(controller, { kind, message, onVerificationPrompt, timeout, }) {
    const element = await controller.webProbe(By.TEXT, message, { timeout });
    if (!element) {
        return;
    }
    await (onVerificationPrompt ?? defaultVerificationPrompt)({ kind, message });
}
export async function handleAfterLoginLogic(controller, options = {}) {
    const resolvedOptions = loginOptionsWithDefaults(options);
    await checkVerificationPrompt(controller, {
        kind: "sms",
        message: "Wir haben dir gerade einen 6-stelligen Code für die Telefonnummer",
        onVerificationPrompt: resolvedOptions.onVerificationPrompt,
        timeout: resolvedOptions.smsVerificationTimeout,
    });
    await checkVerificationPrompt(controller, {
        kind: "email",
        message: "Um dein Konto zu schützen haben wir dir eine E-Mail geschickt",
        onVerificationPrompt: resolvedOptions.onVerificationPrompt,
        timeout: resolvedOptions.emailVerificationTimeout,
    });
    await clickGdprBanner(controller, resolvedOptions.quickDomTimeout);
}
export async function login(controller, credentials, options = {}) {
    requireLoginCredentials(credentials);
    const resolvedOptions = loginOptionsWithDefaults(options);
    await controller.webOpen(resolvedOptions.rootUrl);
    await clickGdprBanner(controller, resolvedOptions.quickDomTimeout);
    let detectionResult = await getLoginState(controller, credentials, {
        ...resolvedOptions,
        captureSelectorDiagnostics: false,
    });
    if (detectionResult.isLoggedIn) {
        return detectionResult;
    }
    try {
        await controller.webOpen(`${resolvedOptions.rootUrl}/m-einloggen-sso.html`, {
            timeout: resolvedOptions.pageLoadTimeout,
        });
    }
    catch (error) {
        if (isTimeoutLike(error)) {
            await captureLoginDiagnostics(resolvedOptions, {
                basePrefix: "login_detection_sso_navigation_timeout",
                error,
            });
        }
        throw error;
    }
    try {
        await fillLoginDataAndSend(controller, credentials, resolvedOptions);
        await handleAfterLoginLogic(controller, resolvedOptions);
    }
    catch (error) {
        if (error instanceof assert.AssertionError || isTimeoutLike(error)) {
            await captureLoginDiagnostics(resolvedOptions, {
                basePrefix: "login_detection_auth0_flow_failure",
                error,
            });
        }
        throw error;
    }
    await dismissConsentBanner(controller, resolvedOptions);
    detectionResult = await getLoginState(controller, credentials, {
        ...resolvedOptions,
        captureSelectorDiagnostics: false,
    });
    if (detectionResult.isLoggedIn) {
        return detectionResult;
    }
    await captureLoginDiagnostics(resolvedOptions, {
        basePrefix: `login_detection_${detectionResult.reason.toLowerCase()}`,
        reason: detectionResult.reason,
    });
    throw new assert.AssertionError({
        message: "Login could not be confirmed after Auth0 flow " +
            `(reason=${detectionResult.reason}, url=${currentPageUrl(controller)})`,
    });
}
