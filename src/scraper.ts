// Pension connector. Only evidenced source observations are returned; identity,
// as-of dates and completeness must be checked by consumers. Session state is
// ephemeral unless the caller explicitly supplies a store or profile directory.

import { mkdirSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import puppeteerVanilla, { type Browser, type Page } from 'puppeteer';
import type {
  PensionAccount,
  PensionCompanyInfo,
  PensionScrapeOutcome,
  ScrapePensionArgs,
  SessionStore,
} from './types.js';
import { createMemorySessionStore, connectionKey } from './session.js';

// Internal aliases for the public result types.
type NormalizedAccount = PensionAccount;
type ScrapeOutcome = PensionScrapeOutcome;
type CompanyInfo = PensionCompanyInfo;

// A minimal handle the helpers expect; it carries the cookies that were
// loaded into the browser and a save() that flushes them after a sync. Both
// adapt to the user-supplied SessionStore. The library does not require the
// caller to manage this — `scrapePension` builds one internally.
interface SessionHandle {
  cookies?: unknown[];
  save(cookies: unknown[]): Promise<void>;
}

async function restoreSession(browser: Browser, session?: SessionHandle): Promise<boolean> {
  const cookies = session?.cookies;
  if (!cookies || cookies.length === 0) return false;
  try {
    await browser.setCookie(...(cookies as Parameters<Browser['setCookie']>));
    return true;
  } catch {
    return false;
  }
}

async function persistSession(browser: Browser, session?: SessionHandle): Promise<void> {
  if (!session) return;
  try {
    const cookies = await browser.cookies();
    await session.save(cookies as unknown as unknown[]);
  } catch {
    /* best effort */
  }
}

// page.evaluate runs its callback in the browser, where these globals exist.
declare const document: any;
declare const location: any;
declare const Event: any;

interface PensionFund {
  id: string;
  /** Shown in the catalog / Add-connection picker. */
  name: string;
  /** Website host, used to show the provider's favicon as a logo. */
  domain: string;
  /** Member-portal login URL. */
  loginUrl: string;
  /** Credentials the user supplies — rendered as fields in the Add flow. */
  loginFields: string[];
  /** CSS selector for the ID-number input. */
  idSelector?: string;
  /** CSS selector for the phone-number input, when the portal needs one. */
  phoneSelector?: string;
  /** CSS selector for a phone-prefix <select> (050/052/…), when split out. */
  phonePrefixSelector?: string;
  /** CSS selector for the "send the code by SMS" radio, clicked to be sure. */
  smsRadioSelector?: string;
  /** Terms checkbox that gates submit. Never ticked: a fresh login returns NEEDS_CONSENT. */
  termsCheckboxSelector?: string;
  /** Text on the button that submits the form — omitted for interactive funds. */
  submitLabels?: string[];
  /** Page to open after login to reach the product balances, when separate. */
  productsUrl?: string;
  /** Visible button text to click first to reveal the login form (Harel). */
  openLoginLabel?: string;
  /** When set, the portal is behind a CAPTCHA / bot wall. Hon opens a visible
   *  Chromium window for it and the user signs in by hand; the connector then
   *  reads balances from the portal's API and saves the session. */
  interactive?: boolean;
}

const FUNDS: Record<string, PensionFund> = {
  migdal: {
    id: 'migdal',
    name: 'Migdal (מגדל)',
    domain: 'migdal.co.il',
    loginUrl: 'https://my.migdal.co.il/mymigdal/process/login',
    loginFields: ['id'],
    idSelector: '#username',
    smsRadioSelector: '#otpToCell',
    submitLabels: ['המשך', 'כניסה', 'שלח'],
    productsUrl: 'https://my.migdal.co.il/mymigdal/info/myproducts',
  },
  clal: {
    id: 'clal',
    name: 'Clal (כלל)',
    domain: 'clalbit.co.il',
    loginUrl: 'https://www.clalbit.co.il/login/',
    loginFields: ['id', 'phone'],
    idSelector: '[formcontrolname="tz"]',
    phoneSelector: '[formcontrolname="mobile"]',
    // The login form is Angular Material: SMS is the first delivery radio and
    // a terms checkbox gates the "שליחה" submit button. The library never ticks
    // it, so a fresh login returns NEEDS_CONSENT; only a saved session is read.
    smsRadioSelector: '#mat-radio-2-input',
    termsCheckboxSelector: '#mat-checkbox-1-input',
    submitLabels: ['שליחה', 'שלח', 'המשך', 'כניסה'],
    productsUrl: 'https://www.clalbit.co.il/portfolio/',
  },
  harel: {
    id: 'harel',
    name: 'Harel (הראל)',
    domain: 'harel-group.co.il',
    loginUrl: 'https://www.harel-group.co.il/Pages/login-Page/Login.aspx',
    loginFields: ['id', 'phone'],
    idSelector: '#idUser',
    phoneSelector: '#phone',
    openLoginLabel: 'כניסה לאזור האישי',
    submitLabels: ['המשך', 'כניסה', 'שלח'],
    productsUrl:
      'https://www.harel-group.co.il/personal-info/my-harel/Pages/client-view.aspx',
  },
  // Meitav and Menora sit behind CAPTCHA bot-walls (reCAPTCHA Enterprise /
  // Radware + hCaptcha). They run in a visible Chromium window the user signs
  // in to; Hon pre-fills the ID/phone and reads the balances afterwards.
  meitav: {
    id: 'meitav',
    name: 'Meitav (מיטב)',
    domain: 'meitav.co.il',
    loginUrl: 'https://customers.meitav.co.il/v2/login/loginAmit',
    loginFields: ['id', 'phone'],
    idSelector: '#id-identity-input',
    // Meitav's phone is split: a prefix <select> (050/052/…) + a 7-digit number.
    phonePrefixSelector: 'select[name="prefixPhone"]',
    phoneSelector: '[name="phoneNumber"]',
    submitLabels: ['כניסה', 'התחברות', 'המשך', 'שליחה', 'שלח', 'אישור'],
    interactive: true,
  },
  menora: {
    id: 'menora',
    name: 'Menora Mivtachim (מנורה מבטחים)',
    domain: 'menoramivt.co.il',
    loginUrl: 'https://www.menoramivt.co.il/customer-login/',
    loginFields: ['id', 'phone'],
    idSelector: '#id-num',
    phoneSelector: '#email-phone-num',
    submitLabels: ['כניסה', 'התחברות', 'המשך', 'שליחה', 'שלח', 'אישור'],
    interactive: true,
  },
};

/**
 * Whether a fund opens a visible browser window the user signs in to — true
 * for the CAPTCHA-walled funds (Meitav/Menora).
 */
function isInteractive(fund: PensionFund): boolean {
  return Boolean(fund.interactive);
}

/** Catalog entries so the pension funds appear in the Add-connection picker. */
export const PENSION_COMPANIES: CompanyInfo[] = Object.values(FUNDS).map((fund) => ({
  id: fund.id,
  name: fund.name,
  loginFields: fund.loginFields,
  type: 'pension',
  domain: fund.domain,
  interactive: isInteractive(fund),
}));

export function isPensionCompany(companyId: string): boolean {
  return Object.prototype.hasOwnProperty.call(FUNDS, companyId);
}

/** Every fund id the library knows how to scrape, in catalog order. */
export const FUND_IDS = Object.keys(FUNDS) as Array<
  'migdal' | 'clal' | 'harel' | 'meitav' | 'menora'
>;

// Set PENSION_SCRAPERS_HEADFUL=1 (or pass headless: false in args) to scrape
// with a visible browser — useful when a portal's WAF or bot-detection
// rejects a headless session.
const DEFAULT_HEADLESS = process.env.PENSION_SCRAPERS_HEADFUL !== '1';

// How long an interactive fund waits for the user to finish signing in (and
// pass the CAPTCHA + OTP) in the visible browser window before giving up.
const INTERACTIVE_LOGIN_TIMEOUT_MS = 5 * 60_000;
const activeConnections = new Set<string>();

// Funds with no reviewed product/balance reader (see readBalances). A login
// could only end in NEEDS_MAPPING, so no credential or OTP request is made.
const UNMAPPED_FUNDS = new Set(['harel']);

// In a container Chromium runs as root with no user namespace, so its
// sandbox cannot start — set PENSION_SCRAPERS_NO_SANDBOX=1 to drop it. On a
// normal desktop the array stays empty so the sandbox stays on.
const SANDBOX_ARGS: string[] =
  process.env.PENSION_SCRAPERS_NO_SANDBOX === '1'
    ? ['--no-sandbox', '--disable-setuid-sandbox']
    : [];

// The OTP code-entry step exposes dedicated inputs. Migdal renders six boxes
// all named otp, otp2…otp6; a waitForSelector on this catches that step
// reliably — it polls the live DOM and does not depend on page text.
const OTP_FIELD_SELECTOR =
  'input[name="otp"], input[name="otp1"], input[id="otp"], ' +
  'input[autocomplete="one-time-code"]';

// Product keywords used to recognise a pension / gemel / study-fund balance.
const PRODUCT_KEYWORDS = [
  'קרן השתלמות', 'השתלמות', 'קופת גמל', 'גמל להשקעה', 'גמל',
  'קרן פנסיה', 'פנסיה', 'תגמולים', 'פיצויים', 'ביטוח מנהלים',
  'קצבה', 'חיסכון',
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(errorType: string, errorMessage: string): ScrapeOutcome {
  return { success: false, accounts: [], complete: false, identityVerified: false, warnings: [], errorType, errorMessage };
}

/** Logs a pension-connector diagnostic line to the sidecar console (stderr). */
function plog(...parts: unknown[]): void {
  console.error('[pension]', ...parts);
}

/** Launch with ordinary browser settings; no stealth or bot-wall bypass. */
async function launchPensionBrowser(headless: boolean, profileDir?: string): Promise<{ browser: Browser; page: Page }> {
  const browser = await puppeteerVanilla.launch({
    headless, defaultViewport: headless ? undefined : null, userDataDir: profileDir,
    args: [...SANDBOX_ARGS, '--lang=he-IL', ...(headless ? [] : ['--window-size=1280,960'])],
  });
  try {
    const page = await browser.newPage();
    if (headless) await page.setViewport({ width: 1280, height: 900 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'he-IL,he;q=0.9,en;q=0.8' });
    await page.evaluateOnNewDocument('window.__name = window.__name || function (f) { return f; };');
    return { browser, page };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

/** Reads source observations; success does not assert completeness or member identity. */
export async function scrapePension(args: ScrapePensionArgs): Promise<ScrapeOutcome> {
  const { fundId, credentials, onProgress, onOtpNeeded, connectionId,
    session: userStore, profileBaseDir, headless } = args;
  if (!isPensionCompany(fundId)) return fail('CONFIG', 'Unknown pension fund.');
  const fund = FUNDS[fundId]!;
  if (UNMAPPED_FUNDS.has(fundId)) {
    return { ...fail('NEEDS_MAPPING', 'No reviewed product/balance mapping exists for this fund; no login was attempted.'),
      warnings: ['PRODUCT_AND_BALANCE_MAPPING_REQUIRED'] };
  }
  const interactive = Boolean(fund.interactive);
  if (!interactive && (!credentials.id?.trim() || (fund.phoneSelector && !credentials.phone?.trim()))) {
    return fail('CONFIG', 'This connection needs its required identity and phone fields.');
  }
  if (!interactive && !onOtpNeeded) return fail('CONFIG', 'An OTP callback is required.');
  let sessionKey: string;
  try { sessionKey = connectionKey(fundId, connectionId, credentials.id); }
  catch { return fail('CONFIG', 'Provide a connectionId or member ID; never share it between members.'); }

  if (activeConnections.has(sessionKey)) return fail('CONNECTION_BUSY', 'This connection already has an active scrape in this process.');
  activeConnections.add(sessionKey);
  const store: SessionStore = userStore ?? createMemorySessionStore();
  let browser: Browser | undefined;
  try {
    const restoredCookies = await store.load(sessionKey);
    const session: SessionHandle = {
      cookies: restoredCookies ?? undefined,
      save: (cookies) => store.save(sessionKey, cookies),
    };
    const profileDir = profileBaseDir ? join(profileBaseDir, sessionKey) : undefined;
    if (profileDir) {
      // A profile must not silently resurrect an expired/cleared cookie session.
      if (!restoredCookies?.length) rmSync(profileDir, { recursive: true, force: true });
      mkdirSync(profileDir, { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') chmodSync(profileDir, 0o700);
    }
    onProgress?.('Starting the browser.');
    const launched = await launchPensionBrowser(!interactive && (headless ?? DEFAULT_HEADLESS), profileDir);
    browser = launched.browser;
    const page = launched.page;
    await restoreSession(browser, session);

    if (!interactive && fund.productsUrl && restoredCookies?.length) {
      onProgress?.('Resuming the isolated saved session; member identity is not verified by this mapping.');
      await page.goto(fund.productsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (!/login/i.test(page.url())) {
        const read = await readBalances(fundId, page);
        if (hasObservations(read)) {
          await persistSession(browser, session);
          return outcome(read);
        }
      }
    }

    // Only the account holder can review and accept a portal's current terms, and
    // nothing here records that, so a terms-gated fresh login stops before any form.
    if (!interactive && fund.termsCheckboxSelector) {
      return fail('NEEDS_CONSENT', 'A fresh login requires accepting the portal terms, which only the account holder can review and accept. No reviewed consent step exists, so nothing was filled or submitted and no consent was given.');
    }

    onProgress?.('Opening the pension portal.');
    await page.goto(fund.loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (interactive) {
      onProgress?.('Sign in in the browser and check the member identity there. Stop if access is refused.');
      void prefillCredentials(page, fund, credentials).catch(() => {});
      const deadline = Date.now() + INTERACTIVE_LOGIN_TIMEOUT_MS;
      let read = emptyRead('BALANCE_RESPONSE_UNAVAILABLE');
      while (Date.now() < deadline && !page.isClosed()) {
        read = await readBalances(fundId, page);
        if (hasObservations(read)) {
          await persistSession(browser, session);
          return outcome(read);
        }
        if (read.warnings.includes('AMBIGUOUS_DUPLICATE_PRODUCT')) return outcome(read);
        await delay(5000);
      }
      return { ...fail('INTERACTIVE_TIMEOUT', 'No usable products were read. Check sign-in manually before any retry.'),
        warnings: read.warnings };
    }

    onProgress?.('Logging in.');
    if (!(await fillAndSubmitLogin(page, fund, credentials))) {
      return fail('LOGIN_FAILED', 'The login form could not be completed. Check the portal before retrying.');
    }
    const otpAppeared = await page.waitForSelector(OTP_FIELD_SELECTOR, { visible: true, timeout: 90_000 })
      .then(() => true).catch(() => false);
    if (!otpAppeared) return fail('LOGIN_FAILED', 'The portal did not reach the verification-code step. Do not retry automatically.');
    const code = (await onOtpNeeded!()).trim();
    if (!/^\d+$/.test(code)) return fail('OTP_REJECTED', 'A numeric verification code is required. Do not retry automatically.');
    await enterOtpCode(page, code);
    await delay(7000);
    // Reuse the existing login-step selector. Presence alone is not proof of rejection:
    // only a still-visible input means the verification step is unresolved.
    const otpStillVisible = await page.$eval(OTP_FIELD_SELECTOR, (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }).catch(() => false);
    if (otpStillVisible) return fail('OTP_UNCONFIRMED', 'Verification is still displayed. Check the code manually; no automatic retry.');
    if (fund.productsUrl) await page.goto(fund.productsUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await delay(4000);
    const read = await readBalances(fundId, page);
    if (hasObservations(read)) await persistSession(browser, session);
    return outcome(read);
  } catch {
    return fail('SCRAPE_FAILED', 'The portal or local storage operation failed. Check locally before retrying; raw errors are suppressed.');
  } finally {
    if (browser) await browser.close().catch(() => {});
    activeConnections.delete(sessionKey);
  }
}

/**
 * Fills an input by CSS selector. Picks the visible match when a portal
 * duplicates an id, types with real keystrokes, then also sets the value via
 * JS with input/change events so an Angular reactive form registers it even
 * if the element was not cleanly interactable.
 */
async function fillField(page: Page, selector: string, value: string): Promise<boolean> {
  // A page navigating mid-query (e.g. a Radware bounce) makes $$ throw
  // "Execution context destroyed" — treat that as "no field" so the caller
  // simply retries rather than crashing the whole login.
  const handles = await page.$$(selector).catch(() => []);
  if (handles.length === 0) return false;
  let target = handles[0];
  for (const handle of handles) {
    const box = await handle.boundingBox().catch(() => null);
    if (box && box.width > 0 && box.height > 0) {
      target = handle;
      break;
    }
  }
  if (!target) return false;
  try {
    await target.click({ clickCount: 3 });
    await target.type(value, { delay: 45 });
  } catch {
    // not cleanly interactable — the JS fill below still sets the value
  }
  await target
    .evaluate((el: any, val: string) => {
      el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
    }, value)
    .catch(() => {});
  return true;
}

/** Clicks the first enabled element whose text matches one of `labels`. */
async function clickByText(page: Page, labels: string[]): Promise<boolean> {
  try {
    return await page.evaluate((wanted: string[]) => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const off = (n: any): boolean =>
        Boolean(n.disabled) || n.getAttribute('aria-disabled') === 'true';
      for (const label of wanted) {
        const controls: any[] = Array.from(
          document.querySelectorAll(
            'button, input[type=submit], input[type=button], a, [role=button]',
          ),
        );
        let hit: any = controls.find((n: any) => {
          const t = norm(n.innerText || n.value || n.getAttribute('aria-label') || '');
          return !off(n) && (t === label || t.includes(label));
        });
        // Buttons built from plain <div>/<span> (e.g. Migdal's "המשך") carry no
        // button tag or role — take the innermost element whose own text is the
        // label; a click on it bubbles up to the real handler.
        if (!hit) {
          const plain: any[] = Array.from(
            document.querySelectorAll('span, div, a, p, li'),
          ).filter((n: any) => norm(n.innerText || '') === label && !off(n));
          plain.sort(
            (a: any, b: any) =>
              a.querySelectorAll('*').length - b.querySelectorAll('*').length,
          );
          hit = plain[0];
        }
        if (hit) {
          (hit.closest('button, a, [role=button]') || hit).click();
          return true;
        }
      }
      return false;
    }, labels);
  } catch {
    return false;
  }
}

/**
 * Fills a fund's phone field(s) from a raw phone string. Normalises to a local
 * 0XXXXXXXXX form, then either fills a single field or splits across a prefix
 * <select> (050/052/…) plus a 7-digit number field when the portal needs that.
 */
async function fillPhone(page: Page, fund: PensionFund, rawPhone: string): Promise<void> {
  if (!fund.phoneSelector) return;
  let phone = (rawPhone ?? '').replace(/\D/g, '');
  if (phone.startsWith('972')) phone = `0${phone.slice(3)}`;
  if (phone.length === 9 && phone.startsWith('5')) phone = `0${phone}`;
  if (fund.phonePrefixSelector && phone.length >= 4) {
    await page
      .evaluate(
        (sel: string, value: string) => {
          const el: any = document.querySelector(sel);
          if (!el) return;
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        fund.phonePrefixSelector,
        phone.slice(0, 3),
      )
      .catch(() => {});
    await fillField(page, fund.phoneSelector, phone.slice(3)).catch(() => false);
  } else {
    await fillField(page, fund.phoneSelector, phone || (rawPhone ?? '').trim()).catch(
      () => false,
    );
  }
}

/**
 * Fills the login form (ID number, plus phone where the portal needs it),
 * makes sure the code goes by SMS, and submits — which triggers the SMS code.
 */
async function fillAndSubmitLogin(
  page: Page,
  fund: PensionFund,
  credentials: ScrapePensionArgs['credentials'],
): Promise<boolean> {
  plog('fillAndSubmitLogin: entered for', fund.id);
  // Only automated funds reach here; interactive funds carry no selectors.
  if (!fund.idSelector || !fund.submitLabels) {
    plog('fillAndSubmitLogin: no idSelector/submitLabels — bailing');
    return false;
  }
  // Harel hides its login form behind a CTA button. The page also renders a
  // zero-size duplicate of that button, so target the *visible* one (real
  // bounding box) and click its centre with a real mouse click — page.click's
  // hit-test and a synthetic .click() both fail here; a mouse click works.
  if (fund.openLoginLabel) {
    try {
      await page.waitForSelector('button, [role=button]', { timeout: 40_000 });
      await delay(2000);
      const point = await page.evaluate((label: string) => {
        const nodes: any[] = Array.from(
          document.querySelectorAll('button, a, [role=button]'),
        );
        for (const node of nodes) {
          const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
          if (text !== label) continue;
          const r = node.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      }, fund.openLoginLabel);
      if (point) {
        await page.mouse.click(point.x, point.y);
        await delay(1500);
      }
    } catch {
      // fall through — the idSelector wait below will fail clearly
    }
  }
  // Wait for the ID field and fill it. Menora's login can re-render between
  // the wait and the fill (Radware bot-check, SPA hydration), so the element
  // found a moment ago can be gone by fill time — retry a few rounds.
  let idFilled = false;
  for (let attempt = 1; attempt <= 6 && !idFilled; attempt += 1) {
    const ready = await page
      .waitForSelector(fund.idSelector, { timeout: 20_000 })
      .then(() => true)
      .catch(() => false);
    if (!ready) {
      plog(`fillAndSubmitLogin: idSelector absent, attempt ${attempt}, portal navigation pending`);
      continue;
    }
    await delay(1500); // let the form finish rendering
    idFilled = await fillField(page, fund.idSelector, (credentials.id ?? '').trim());
    if (!idFilled) {
      plog(`fillAndSubmitLogin: fillField missed, attempt ${attempt}, portal navigation pending`);
    }
  }
  if (!idFilled) return false;
  plog('fillAndSubmitLogin: ID field filled');
  if (fund.phoneSelector) {
    await fillPhone(page, fund, credentials.phone ?? '');
  }
  if (fund.smsRadioSelector) {
    // A JS click checks the radio even when it is a visually-hidden custom
    // control (Puppeteer's page.click needs a visible, hit-testable target).
    await page
      .evaluate((sel: string) => {
        const radio: any = document.querySelector(sel);
        if (radio) radio.click();
      }, fund.smsRadioSelector)
      .catch(() => {});
  }
  // A terms checkbox is never ticked here; scrapePension returns NEEDS_CONSENT first.
  await delay(800); // let Angular validate the form and enable the button
  if (!(await clickByText(page, fund.submitLabels))) {
    await page.keyboard.press('Enter');
  }
  return true;
}

/**
 * Assists an interactive login: waits for the login form to appear — the user
 * is clearing the portal's CAPTCHA during that wait — then fills the ID and
 * phone fields with the stored credentials. The user still does the CAPTCHA,
 * the submit and the OTP; Hon only types the details it already holds. A no-op
 * when the fund exposes no selectors or no credentials were stored.
 */
async function prefillCredentials(
  page: Page,
  fund: PensionFund,
  credentials: ScrapePensionArgs['credentials'],
): Promise<void> {
  const id = (credentials.id ?? '').trim();
  if (!fund.idSelector || !id) return;
  // This wait spans the time the user spends on the CAPTCHA — the login form
  // only renders once they clear it.
  const formAppeared = await page
    .waitForSelector(fund.idSelector, { timeout: INTERACTIVE_LOGIN_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!formAppeared) return;
  await delay(900); // let the form settle
  await fillField(page, fund.idSelector, id).catch(() => false);
  await fillPhone(page, fund, credentials.phone ?? '');
}

/**
 * Types the verification code and submits it. The code field may be a single
 * input or several single-digit boxes — Migdal uses six boxes named
 * otp, otp2…otp6, so each digit is typed into its own box.
 */
async function enterOtpCode(page: Page, code: string): Promise<void> {
  const digits = code.replace(/\D/g, '');
  // Tag the OTP box(es): prefer inputs that identify themselves as OTP — named
  // otp/otp2… (Migdal), formcontrolname="otp" (Clal) or autocomplete="one-time-
  // code" (Harel/Clal). Only if none match fall back to the visible empty text
  // inputs, and even then skip search boxes — a stray search field next to the
  // OTP box would otherwise be mistaken for a second code box.
  const boxes = await page.evaluate(() => {
    const inputs: any[] = Array.from(document.querySelectorAll('input'));
    const visible = (el: any): boolean => Boolean(el.offsetWidth || el.offsetHeight);
    const isSearch = (el: any): boolean => {
      const id = (el.id || '') + ' ' + (el.getAttribute('name') || '');
      return (
        (el.getAttribute('type') || '').toLowerCase() === 'search' ||
        el.getAttribute('role') === 'searchbox' ||
        /search|חיפוש/i.test(id)
      );
    };
    let picked: any[] = inputs.filter((el: any) => {
      const key =
        el.getAttribute('name') || el.getAttribute('formcontrolname') || el.id || '';
      const oneTimeCode =
        (el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code';
      return (/^otp\d*$/i.test(key) || oneTimeCode) && visible(el) && !el.disabled;
    });
    if (picked.length === 0) {
      picked = inputs.filter((el: any) => {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const textLike = ['text', 'tel', 'number', 'password', ''].includes(type);
        return (
          textLike &&
          visible(el) &&
          !el.disabled &&
          !el.readOnly &&
          !el.value &&
          !isSearch(el)
        );
      });
    }
    picked.forEach((el: any, i: number) => el.setAttribute('data-hon-otp', String(i)));
    return picked.length;
  });

  if (!boxes) throw new Error('OTP_INPUT_UNAVAILABLE');
  if (boxes >= 2) {
    for (let i = 0; i < boxes && i < digits.length; i += 1) {
      await page.click(`[data-hon-otp="${i}"]`).catch(() => {});
      await page.type(`[data-hon-otp="${i}"]`, digits[i] ?? '', { delay: 80 });
    }
  } else if (boxes === 1) {
    await page.click('[data-hon-otp="0"]', { clickCount: 3 }).catch(() => {});
    await page.type('[data-hon-otp="0"]', digits, { delay: 60 });
  }

  await delay(600);
  // Submit — scoped to the OTP field's dialog so a stray "המשך" on a form
  // behind it (Harel keeps its login panel open behind the OTP modal) is not
  // clicked. Handles both real buttons and div/span-built buttons.
  const submitted = await page.evaluate(() => {
    const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
    const labels = ['המשך', 'אישור', 'כניסה', 'התחברות', 'שלח', 'Continue', 'Submit', 'Verify'];
    // "שלחו לי את הקוד שוב" (resend) contains "שלח" — never click a resend
    // control, or the code is re-sent instead of verified.
    const isResend = (t: string): boolean =>
      /שוב|חוזר|resend|send.?again|שלחו לי/i.test(t);
    const field: any = document.querySelector('[data-hon-otp]');
    const scopes: any[] = [];
    if (field) {
      const dialog = field.closest(
        '[role=dialog], dialog, [class*="modal" i], [class*="dialog" i], form',
      );
      if (dialog) scopes.push(dialog);
    }
    scopes.push(document);
    for (const scope of scopes) {
      const controls: any[] = Array.from(
        scope.querySelectorAll('button, input[type=submit], [role=button]'),
      ).filter((b: any) => !b.disabled && !isResend(norm(b.innerText || b.value || '')));
      // Prefer an exact label match; only then fall back to a contains match.
      let hit: any = controls.find((b: any) =>
        labels.includes(norm(b.innerText || b.value || '')),
      );
      if (!hit) {
        hit = controls.find((b: any) => {
          const t = norm(b.innerText || b.value || '');
          return labels.some((l) => t.includes(l));
        });
      }
      if (!hit) {
        // div/span-built buttons (Migdal's "המשך"): innermost exact-text node.
        const plain: any[] = Array.from(scope.querySelectorAll('span, div, a')).filter(
          (n: any) => labels.includes(norm(n.innerText || '')),
        );
        plain.sort(
          (a: any, b: any) => a.querySelectorAll('*').length - b.querySelectorAll('*').length,
        );
        hit = plain[0];
      }
      if (hit) {
        (hit.closest('button, a, [role=button]') || hit).click();
        return true;
      }
    }
    return false;
  });
  if (!submitted) await page.keyboard.press('Enter');
}

/**
 * Only source-evidenced fields are read. Missing IDs/dates never become invented
 * accounts/current balances. Provider member identity and coverage remain unverified.
 */
interface BalanceRead {
  accounts: NormalizedAccount[];
  unresolvedProducts: NonNullable<ScrapeOutcome['unresolvedProducts']>;
  warnings: string[];
}
function emptyRead(warning: string): BalanceRead {
  return { accounts: [], unresolvedProducts: [], warnings: [warning] };
}
function hasObservations(read: BalanceRead): boolean {
  return read.accounts.length > 0 || read.unresolvedProducts.length > 0;
}
function outcome(read: BalanceRead): ScrapeOutcome {
  return {
    success: read.accounts.length > 0,
    accounts: read.accounts,
    unresolvedProducts: read.unresolvedProducts,
    complete: false,
    identityVerified: false,
    warnings: [...new Set(['MEMBER_IDENTITY_UNVERIFIED', 'PRODUCT_COVERAGE_UNVERIFIED',
      'BALANCE_AS_OF_UNAVAILABLE', ...read.warnings])],
    ...(read.accounts.length ? {} : { errorType: 'NEEDS_MAPPING',
      errorMessage: 'No products with stable provider IDs could be returned. Inspect warnings and unresolvedProducts.' }),
  };
}

async function readBalances(companyId: string, page: Page): Promise<BalanceRead> {
  if (companyId === 'meitav') return readMeitavBalances(page);
  if (companyId === 'menora') return readMenoraBalances(page);
  if (companyId === 'migdal' || companyId === 'clal') return readLabelledBalances(page, companyId);
  // Harel's broad keyword/largest-number reader matched IDs, totals and years.
  // No stable product ID or unambiguous balance selector is evidenced here.
  return emptyRead('PRODUCT_AND_BALANCE_MAPPING_REQUIRED');
}

function unresolved(rows: { name: string; balance: unknown }[]): BalanceRead {
  const read = emptyRead('PRODUCT_ID_UNAVAILABLE');
  for (const row of rows) {
    if (typeof row.name !== 'string' || !row.name.trim()
      || (typeof row.balance !== 'string' && typeof row.balance !== 'number')
      || (typeof row.balance === 'string' && !/^-?\d+(?:\.\d+)?$/.test(row.balance.trim()))) {
      read.warnings.push('INVALID_PRODUCT_OBSERVATION');
      continue;
    }
    const amount = Number(row.balance);
    if (!Number.isFinite(amount)) {
      read.warnings.push('INVALID_BALANCE_OBSERVATION');
      continue;
    }
    read.unresolvedProducts.push({ label: row.name, observedBalance: amount,
      balanceAsOf: null, observedAt: new Date().toISOString(), currency: 'ILS', reason: 'PRODUCT_ID_UNAVAILABLE' });
  }
  return read;
}

async function readLabelledBalances(page: Page, companyId: string): Promise<BalanceRead> {
  if (companyId === 'migdal') await page.waitForSelector('.table', { timeout: 30_000 }).catch(() => {});
  try {
    const rows = await page.evaluate((company: string, keywords: string[]) => {
      const norm = (s: string): string => (s || '').replace(/\s+/g, ' ').trim();
      const amount = (s: string): number | null => {
        const text = norm(s).replace(/[₪\s]/g, '');
        if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) return null;
        const value = Number(text.replace(/,/g, ''));
        return Number.isFinite(value) ? value : null;
      };
      const found: { name: string; balance: number | null }[] = [];
      if (company === 'migdal') {
        const tables: any[] = Array.from(document.querySelectorAll('.table'));
        for (const table of tables) {
          const name = norm(table.querySelector('a')?.innerText || '');
          if (!name) continue;
          const balances: (number | null)[] = [];
          const strongs: any[] = Array.from(table.querySelectorAll('strong'));
          for (const strong of strongs) {
            let label = '';
            let previous = strong.previousElementSibling;
            for (let i = 0; previous && !label && i < 4; i += 1) {
              label = norm(previous.innerText || '');
              previous = previous.previousElementSibling;
            }
            if (/ערכי פדיון|צבירה|יתרה|סך חיסכון|סך צבירה/.test(label)) balances.push(amount(strong.innerText));
          }
          // Multiple labelled values have no evidenced date ordering. Do not take max.
          found.push({ name, balance: balances.length === 1 ? balances[0] ?? null : null });
        }
      } else {
        const titles: any[] = Array.from(document.querySelectorAll('h2.link-title'));
        for (const title of titles) {
          const name = norm(title.innerText || '');
          if (!keywords.some((keyword) => name.includes(keyword))) continue;
          const sum = title.parentElement?.querySelector('.financial-data-sum');
          found.push({ name, balance: sum ? amount(sum.innerText) : null });
        }
      }
      return found;
    }, companyId, PRODUCT_KEYWORDS);
    return unresolved(rows);
  } catch {
    return emptyRead('BALANCE_READ_FAILED');
  }
}

interface MeitavRow { name: unknown; accountNum: unknown; balance: unknown; }
async function readMeitavBalances(page: Page): Promise<BalanceRead> {
  try {
    const response: { rows: MeitavRow[]; missingCollections: boolean } | null = await page.evaluate(async () => {
      const res = await fetch('/v2/api/AllAccounts/GetAllAmitAccounts', { credentials: 'include' });
      if (!res.ok) return null;
      const data: any = await res.json();
      const t: any = data?.t ?? data;
      const collections = [t?.CustomPensionAccountMain, t?.CustomAccountMain];
      if (!collections.some(Array.isArray)) return null;
      return { missingCollections: !collections.every(Array.isArray),
        rows: collections.filter(Array.isArray).flat().map((p: any) => ({
          name: p?.AccountNumForShow, accountNum: p?.AccountNum, balance: p?.YitrotAccountSum,
        })) };
    });
    if (!response) return emptyRead('BALANCE_RESPONSE_UNAVAILABLE');
    const read: BalanceRead = { accounts: [], unresolvedProducts: [], warnings: [] };
    if (response.missingCollections) read.warnings.push('PRODUCT_COLLECTION_UNAVAILABLE');
    const grouped = new Map<string, MeitavRow[]>();
    for (const row of response.rows) {
      if ((typeof row.accountNum !== 'string' && typeof row.accountNum !== 'number')
        || (typeof row.accountNum === 'number' && !Number.isSafeInteger(row.accountNum))
        || !String(row.accountNum).trim()) {
        read.warnings.push('PRODUCT_ID_UNAVAILABLE');
        if (typeof row.name === 'string') {
          const missing = unresolved([{ name: row.name, balance: row.balance }]);
          read.unresolvedProducts.push(...missing.unresolvedProducts);
          read.warnings.push(...missing.warnings);
        }
        continue;
      }
      const key = String(row.accountNum);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    for (const [id, matches] of grouped) {
      if (matches.length !== 1) {
        // Even equal amounts may represent different periods. No date field is evidenced.
        read.warnings.push('AMBIGUOUS_DUPLICATE_PRODUCT');
        for (const candidate of matches) {
          if (typeof candidate.name !== 'string') continue;
          const observations = unresolved([{ name: candidate.name, balance: candidate.balance }]);
          read.unresolvedProducts.push(...observations.unresolvedProducts.map((observation) => ({
            ...observation, reason: 'AMBIGUOUS_DUPLICATE_PRODUCT' as const, providerProductId: 'meitav:' + id,
          })));
          if (!observations.unresolvedProducts.length) read.warnings.push('INVALID_BALANCE_OBSERVATION');
        }
        continue;
      }
      const row = matches[0]!;
      if ((typeof row.balance !== 'string' && typeof row.balance !== 'number')
        || (typeof row.balance === 'string' && !/^-?\d+(?:\.\d+)?$/.test(row.balance.trim()))
        || !Number.isFinite(Number(row.balance))) {
        read.warnings.push('INVALID_BALANCE_OBSERVATION');
        continue;
      }
      read.accounts.push({ accountNumber: 'meitav:' + id,
        label: typeof row.name === 'string' ? row.name : undefined,
        observedBalance: Number(row.balance), balanceAsOf: null, observedAt: new Date().toISOString(),
        currency: 'ILS', transactions: [] });
    }
    return read;
  } catch {
    return emptyRead('BALANCE_READ_FAILED');
  }
}

async function readMenoraBalances(page: Page): Promise<BalanceRead> {
  try {
    const response = await page.evaluate(async () => {
      const uuid = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
      const res = await fetch('/personal/dashboard/api/v1/customer-summary/active?counter=1&uuid=' + uuid,
        { method: 'POST', credentials: 'include' });
      if (!res.ok) return null;
      const body: any = await res.json();
      const d: any = body?.data;
      if (!d) return null;
      const collections = [d.pension, d.socialBenefit, d.managerFund, d.annuity];
      if (!collections.some(Array.isArray)) return null;
      return { missingCollections: !collections.every(Array.isArray),
        rows: collections.filter(Array.isArray).flat()
          .map((p: any) => ({ name: p?.title, balance: p?.cashSurrenderValue })) };
    });
    if (!response) return emptyRead('BALANCE_RESPONSE_UNAVAILABLE');
    const read = unresolved(response.rows);
    if (response.missingCollections) read.warnings.push('PRODUCT_COLLECTION_UNAVAILABLE');
    return read;
  } catch {
    return emptyRead('BALANCE_READ_FAILED');
  }
}
