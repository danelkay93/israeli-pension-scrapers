// Public types. Consumers must inspect identity, date and completeness metadata.

/** Catalog entry shown in an "add a pension connection" picker. */
export interface PensionCompanyInfo {
  /** Stable id used as the catalog key (`migdal`, `harel`, …). */
  id: string;
  /** Display name with the Hebrew form in brackets. */
  name: string;
  /** Inputs the user fills in to authenticate (`id`, sometimes `phone`). */
  loginFields: string[];
  /** Always `"pension"`, kept for symmetry with bank catalogs. */
  type: 'pension';
  /** Provider website host, handy for favicon lookups. */
  domain: string;
  /**
   * True when the fund opens a visible Chromium window for the user to sign
   * in by hand — used for providers that wall their login with CAPTCHA
   * (Meitav / Menora today).
   */
  interactive: boolean;
}

/** A single product (pension, gemel, study fund) the member holds. */
export interface PensionAccount {
  /** Provider-qualified product ID. Never a label or an amount. */
  accountNumber: string;
  /** Human-readable product name as the portal shows it. */
  label?: string;
  /** Current accumulated balance, only available with a verified provider date. */
  balance?: number;
  /** Amount observed in the response; not a verified current balance. */
  observedBalance?: number;
  balanceAsOf: string | null;
  observedAt: string;
  /** ISO-4217 code — `ILS` in practice for every Israeli provider. */
  currency: string;
  /**
   * Empty for pension providers (there are no individual transactions to
   * scrape), kept so consumers can treat a PensionAccount the same way they
   * treat an israeli-bank-scrapers Account.
   */
  transactions: never[];
}

/** What a scrape returns — either a list of accounts or a typed failure. */
export interface PensionScrapeOutcome {
  success: boolean;
  accounts: PensionAccount[];
  complete: boolean;
  identityVerified: boolean;
  warnings: string[];
  /** Observations without a usable unique product mapping. Never aggregate or deduplicate by label/amount. */
  unresolvedProducts?: { label: string; observedBalance: number; balanceAsOf: null; observedAt: string;
    currency: string; reason: 'PRODUCT_ID_UNAVAILABLE' | 'AMBIGUOUS_DUPLICATE_PRODUCT'; providerProductId?: string }[];
  /** Fixed code: CONFIG, CONNECTION_BUSY, LOGIN_FAILED, OTP_REJECTED, OTP_UNCONFIRMED,
   * INTERACTIVE_TIMEOUT, NEEDS_MAPPING, NEEDS_CONSENT or SCRAPE_FAILED. */
  errorType?: string;
  errorMessage?: string;
}

/** Resolves with the user-supplied SMS / one-time-password code. */
export type OtpCallback = () => Promise<string>;

/**
 * Pluggable session storage. Each scrape defaults to fresh memory-only state.
 * A consumer can explicitly supply a vault, shared memory or file store.
 *
 * `cookies` is a Puppeteer cookie list — the same shape `page.cookies()`
 * returns. The library treats them as opaque on save/load.
 */
export interface SessionStore {
  /** Returns the saved cookies for a connection, or `null` if none / expired. */
  load(connectionId: string): Promise<unknown[] | null>;
  /** Persists the current browser cookies under the connection id. */
  save(connectionId: string, cookies: unknown[]): Promise<void>;
  clear(connectionId: string): Promise<void>;
}

/** Arguments for {@link scrapePension}. */
export interface ScrapePensionArgs {
  /** One of {@link FUND_IDS}. */
  fundId: string;
  /** ID number (תעודת זהות) and, for some funds, the phone number. */
  credentials: { id?: string; phone?: string };
  /** Streaming progress updates ("Logging in…", "Reading balances…"). */
  onProgress?: (message: string) => void;
  /** Called when the OTP code is needed — your UI prompts the user. */
  onOtpNeeded?: OtpCallback;
  /** Full connection identity; required when credentials.id is absent. Do not reuse for another member. */
  connectionId?: string;
  /** Explicit session store; defaults to fresh memory-only state per scrape. */
  session?: SessionStore;
  /** Deprecated: raw screenshots/HTML/JSON are no longer captured or written. */
  screenshotPath?: string;
  /** Explicit opt-in root for persistent browser profiles. Omit for ephemeral profiles,
   * including with a vault SessionStore. Profiles contain unencrypted session state;
   * use an owner-only directory/Windows ACL. Keyed by the full connection identity. */
  profileBaseDir?: string;
  /**
   * Defaults to `true`. Set `false` to launch a visible browser even for the
   * headless-friendly funds to inspect normal sign-in. Stop on an access refusal.
   */
  headless?: boolean;
}
