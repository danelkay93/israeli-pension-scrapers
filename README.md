# israeli-pension-scrapers

A browser connector for pension, study-fund and provident-fund observations. This candidate has source corrections only; it has not been built, tested against portals or approved for live financial use.

## Result contract

Read `complete`, `identityVerified`, `warnings` and `unresolvedProducts` even when `success` is true.

- `accounts` contains only products with source-evidenced provider IDs. Currently only Meitav exposes such a field in this mapping (`AccountNum`). IDs are provider-qualified; labels and equal amounts are never deduplication keys.
- `observedBalance` is the amount in a fetched response, including zero. `observedAt` is retrieval time. `balanceAsOf: null` means the provider's balance date is unavailable. It does **not** mean the amount is current. `balance` remains absent until a dated current-balance mapping is evidenced.
- Duplicate Meitav IDs are excluded with `AMBIGUOUS_DUPLICATE_PRODUCT`, including equal-value duplicates: no largest/historical-maximum selection and no assumed date ordering. Their labelled amounts remain in `unresolvedProducts`, tagged with the product ID and ambiguity reason, for manual review only.
- Migdal, Clal and Menora retain specifically labelled source amounts in `unresolvedProducts`, with no fabricated account ID. Do not aggregate or merge these by name/value. Multiple Migdal balance candidates are rejected.
- Harel's broad number/keyword and generic fallback readers were removed: policy numbers, totals and years cannot safely identify product balances. It returns `NEEDS_MAPPING` before any login or OTP request.
- No reviewed provider mapping verifies member identity, product coverage or as-of dates. Every result therefore has `complete: false` and `identityVerified: false`. `success` only means at least one stable-ID observation was returned. Missing data is not a zero balance.

`PENSION_COMPANIES`, `FUND_IDS` and `isPensionCompany` remain available. Full types are in [src/types.ts](./src/types.ts).

## Session isolation and storage

`scrapePension({ fundId, credentials, connectionId, session, profileBaseDir, ... })` hashes the full tuple of provider, connection ID and member ID for **both** cookie-store keys and browser profiles. It never truncates or sanitizes IDs into a shared key. Supply a distinct connection ID per member; an ID is required when `credentials.id` is absent. Changing any tuple component starts a new session. This isolates state but cannot prove that a person signing in manually selected the intended member.

By default every scrape starts with fresh memory-only cookies and a temporary browser profile. Nothing is persisted. To reuse cookies within one process, explicitly share a `createMemorySessionStore()` instance. Persistence requires a caller-selected store, such as a vault or `createFileSessionStore(...)`.

The opt-in file store writes **unencrypted replayable cookies** in the OS user data directory:

| OS | Directory |
|---|---|
| macOS | `~/Library/Application Support/israeli-pension-scrapers/` |
| Windows | `%APPDATA%/israeli-pension-scrapers/` |
| Linux | `$XDG_DATA_HOME/israeli-pension-scrapers/`, defaulting to `~/.local/share/israeli-pension-scrapers/` |

Files are written atomically with POSIX 0600 modes and private directories. Invalid, future-dated or expired bundles are deleted on load (default TTL seven days). File modes do not secure Windows ACLs; use a private directory controlled by your OS. File expiration does not revoke a provider session.

A custom `SessionStore` must implement asynchronous `load(key)`, `save(key, cookies)` and `clear(key)`. The key is opaque. Store secrets outside source control and exported records.

Browser profiles are ephemeral by default, including when using a vault. `profileBaseDir` explicitly opts into persistent, unencrypted browser state under `<profileBaseDir>/<full-identity-hash>`. Keep that directory private. When cookies are missing/expired, the matching profile is removed before launch so it cannot resurrect an old session. A custom cookie `baseDir` never creates a hidden profile elsewhere.

Concurrent scrapes of the same full connection key are rejected with `CONNECTION_BUSY` within this process. Separate processes must coordinate access to persistent profiles; do not share one concurrently.

Close active scrapes before calling:

```ts
await clearPensionSession({
  fundId, connectionId, memberId: credentials.id, session, profileBaseDir,
});
```

Pass the same identity/store/profile options used to scrape. This clears local state only; use the provider's sign-out/revoke controls to invalidate remote sessions. Legacy fund-only profiles and sanitized cookie files are never reused or migrated automatically; remove those old files locally after closing browsers if they are no longer needed.

## Login and failures

Migdal uses the existing OTP form mapping and requires `onOtpNeeded`. Clal's login form has a terms checkbox that gates submission. The library never ticks it, so a fresh Clal login returns `NEEDS_CONSENT` before the login page is opened or any form is filled or submitted; a saved Clal session can still be read, and configuration still requires `onOtpNeeded`. Accepting the portal's current terms is for the account holder. No consent is recorded or implied, and any future consent step would need the exact terms version mapped and the holder's approval on each run. Harel's form mapping is kept but not run until a balance mapping exists. Meitav and Menora open a visible browser for manual sign-in. An empty or nonnumeric OTP returns `OTP_REJECTED`; a still-visible verification input returns `OTP_UNCONFIRMED`. Neither is labelled a successful login or a selector update. No automatic OTP retry is performed.

`CONFIG`, `CONNECTION_BUSY`, `LOGIN_FAILED`, `INTERACTIVE_TIMEOUT`, `NEEDS_MAPPING`, `NEEDS_CONSENT` and `SCRAPE_FAILED` are other failure codes. Errors omit raw portal exception text. Failed session persistence is best effort; a subsequent login may be required.

`screenshotPath` is deprecated and ignored. Raw screenshots, authenticated HTML, iframe dumps and network JSON are neither captured nor written on success or failure. Diagnostics contain fixed codes only. Contribute synthetic or fully redacted fixtures, never raw account/session data.

The browser uses ordinary Puppeteer settings, without stealth, spoofed user agents or automation-detection switches. If access is refused, stop and use the provider's official/manual channels. Automated financial access may have provider-terms or legal requirements; no legal authorization or open-API availability is asserted here.

`headless: false` or `PENSION_SCRAPERS_HEADFUL=1` displays the browser for inspection. Do not use a display-mode change to circumvent a refusal. `PENSION_SCRAPERS_NO_SANDBOX=1` is the existing explicit container option; ordinary launches retain the sandbox.

## Remaining verification

Current member identity fields, stable IDs outside Meitav, balance dates, response coverage and account-to-period semantics need provider evidence. No field names were invented. Dependency/browser compatibility and the changed TypeScript API still need an authorized offline build and synthetic validation before any separate live-use decision.

## License

MIT — see [LICENSE](./LICENSE).
