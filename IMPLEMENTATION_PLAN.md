# ABW.by Валюты — execution plan

## 1. Goal and boundaries

Create a Manifest V3 browser extension for Firefox and Chromium-based browsers that replaces supported **BYN** prices on `abw.by` with a user-selected currency (**BYN**, **USD**, **EUR**, or **RUB**). Rates come from the public National Bank of the Republic of Belarus (NBRB) API.

This project deliberately follows the extension part of [`../av_currencies`](../av_currencies): the same separation of pure currency logic, privileged background service, standalone content script, popup UI, tests, and cross-browser packaging.

### Included

- NBRB rate retrieval, validation, caching, scheduled refresh, and fallback to cached data.
- BYN-to-USD/EUR/RUB price replacement and exact restoration to original BYN text.
- The four supplied ABW HTML pages as real regression fixtures.
- Popup with rates, manual refresh, converter, display-currency setting, and per-currency custom rate overrides.
- Firefox, Firefox Android, and Chromium development/package commands.

### Explicitly excluded

- AV.by VIN collection, the `worker/` project, Cloudflare Worker calls, VIN UI, days-on-sale annotations, and AV price-analysis features.
- Any network destination other than `https://api.nbrb.by/*`.
- Conversion of USD/EUR/RUB prices or non-price text on ABW pages.

## 2. Target repository layout

Populate the existing empty scaffold; do not create `worker/`.

```text
abw_currencies/
├── IMPLEMENTATION_PLAN.md
├── manifest.json
├── Makefile
├── package.json
├── package-lock.json
├── vitest.config.js
├── README.md
├── LICENSE.md
├── icons/
│   ├── icon.svg
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── src/
│   ├── background.js
│   ├── lib/rates.js
│   ├── content/abw.js
│   └── popup/
│       ├── popup.html
│       ├── popup.css
│       └── popup.js
├── scripts/
│   ├── package-utils.mjs
│   ├── build-firefox.mjs
│   └── build-chrome.mjs
├── tests/
│   ├── parse.test.js
│   ├── background.test.js
│   ├── content.test.js
│   └── popup.test.js
├── examples/
│   ├── car_catalog.html
│   ├── car_page.html
│   ├── index.html
│   ├── product_page.html
│   └── nbrb_response.json
└── build/                         # generated and ignored
    ├── firefox/
    └── chrome/
```

`package.json` and `package-lock.json` already contain the initial toolchain: Vitest, V8 coverage, JSDOM, and Prettier. Add `web-ext` as a development dependency before enabling the Firefox run commands.

## 3. Architecture and non-negotiable rules

Use the AV extension architecture with ABW names and no worker branch:

```text
NBRB API
   ↓ fetch (background only)
src/background.js ── browser.storage.local ── src/popup/popup.js
       ↑                     ↑                         │
       └─ runtime messages ──┴── src/content/abw.js ───┘
                                     ↓
                                  ABW DOM

src/lib/rates.js is imported only by background/popup/tests.
```

1. `src/lib/rates.js` must remain a pure Node-importable module: no `browser`, `chrome`, DOM, `fetch`, or `window` access.
2. `src/background.js` is the sole network owner. Neither popup nor content script may call `fetch`.
3. `src/content/abw.js` is a self-contained IIFE. It has no runtime imports/exports because it runs as an MV3 content script.
4. Popup/content/background use `globalThis.browser ??= globalThis.chrome` for cross-browser API compatibility.
5. Use `textContent`, `nodeValue`, DOM factories, and event listeners; never use `innerHTML` or inline handlers.
6. Always convert from the preserved original BYN amount, never from a currently displayed converted value.
7. A failed API response may update `lastError` only; it must never erase a valid cached `ratesData`.
8. Keep custom overrides in `customRates`, separately from NBRB `ratesData`; a successful forced refresh clears overrides.
9. Keep permissions minimal: NBRB only. No AV worker URL or ABW page host permission beyond content-script match patterns.

## 4. Manifest and browser compatibility

Create `manifest.json` as the **Firefox source manifest**.

- Manifest version: `3`.
- Name/title: `ABW.by Валюты`.
- Initial version: `0.1.0`.
- Description: Russian text stating that BYN prices on ABW.by are converted using NBRB rates.
- Permissions: `alarms`, `storage`.
- Host permission: `https://api.nbrb.by/*` only.
- Background: module `src/background.js` through Firefox-compatible `background.scripts`.
- Action popup: `src/popup/popup.html`; declare 16/32/48 action icons and 16/32/48/128 extension icons.
- Content script: `src/content/abw.js`, `run_at: document_idle`, with explicit matches for both `https://abw.by/*` and `https://*.abw.by/*`.
- Firefox metadata: use a new, stable ID such as `abw-by-currencies@redpandadev`; confirm the final ID before the first public release. Set `strict_min_version` only after manual verification in the intended Firefox versions and declare no data collection.

The Chrome build must derive its manifest from this file: remove `browser_specific_settings`, replace `background.scripts` with `background.service_worker`, and retain `type: "module"`.

## 5. Currency domain model (`src/lib/rates.js`)

Implement and test the same reliable primitives used by AV:

- Supported target codes: `USD`, `EUR`, `RUB`; display codes: `BYN`, `USD`, `EUR`, `RUB`.
- Parse NBRB payloads only when all three target rates are present, numeric, positive, and have valid scale/name information.
- Preserve NBRB scale: RUB normally has scale 100, so conversion must use `amount × scale / officialRate`.
- Convert the selected foreign amount back to BYN for the popup converter.
- Parse BYN price text with spaces/NBSP/narrow-NBSP, decimals, `р.`, `руб.`, and `BYN`; preserve an `от` prefix and a trailing unit such as `/мес`.
- Reject non-prices such as `договорная`, `бесплатно`, `обмен`, `цена не указана`, and range/upper-bound labels that must not be treated as a single price.
- Format converted values with `Intl.NumberFormat("ru-BY")`, at most two decimal places, and the project currency symbols.
- Format rate rows, dates, times, and converter results for the Russian popup.

The content script must duplicate the small parsing/conversion/formatting helpers needed at runtime. Keep their behavior synchronized through shared test cases.

## 6. Background service (`src/background.js`)

Adapt AV’s rate-only background service; remove every VIN action, endpoint, and storage field.

### Persistent storage contract

| Key | Value | Owner |
| --- | --- | --- |
| `ratesData` | `{ rates, ratesDate, fetchedAt }` | background |
| `lastError` | serializable `{ message }` or `null` | background |
| `selectedCurrency` | `BYN`, `USD`, `EUR`, or `RUB` | popup |
| `customRates` | partial map of positive target-code rates | background |

### Required behavior

1. Fetch the NBRB daily-rates endpoint using a 10-second `AbortController` timeout.
2. De-duplicate concurrent non-forced refreshes with one in-flight promise.
3. Fetch on installation and browser startup; create/recreate the named alarm at a 240-minute interval.
4. On success, validate through `parseRates`, add `fetchedAt`, persist `ratesData`, clear `lastError`, and return the new data.
5. On failure, serialize/persist the error to `lastError` and keep `ratesData` unchanged.
6. A forced `refreshRates` clears `customRates` only after a successful NBRB response.
7. Apply custom overrides only in a derived effective-rates response; never mutate the stored NBRB result.

### Message protocol

Support the following actions and return a consistent `{ ok, ratesData?, customRates?, error? }` shape:

- `ensureRates`: return cache when present; otherwise fetch.
- `getRates`: return raw cached NBRB data.
- `refreshRates`: force an NBRB refresh.
- `getEffectiveRates`: return NBRB data with overrides applied.
- `getCustomRates`: return the partial override map.
- `saveCustomRate`: validate code/rate and persist one override.
- `clearCustomRate`: remove one override.
- `clearCustomRates`: remove all overrides.

## 7. ABW content script (`src/content/abw.js`)

### 7.1 Safe selector registry

Use narrow selectors verified from the supplied fixture markup. Do not use a broad `.price`, `.byn`, or text-only page-wide query.

| Fixture | Price role | Selector | Example |
| --- | --- | --- | --- |
| `car_catalog.html` | main card price | `.top__right > .price > .price-byn` | `36 085` plus `.nbrb-icon` |
| `car_catalog.html` | leasing monthly price | `.top__right > a.leasing-offer` | `Лизинг от 438 р./мес` |
| `car_page.html` | main price | `ul.price > li.byn` | `164 832` plus converter button |
| `car_page.html` | full-screen gallery price | `.modal-info__price > .byn` | `31 498` plus `.nbrb-icon` |
| `car_page.html` | leasing monthly price | `.detail-info > a.leasing__link` | `В лизинг от 1 432 р./мес` |
| `car_page.html` | leasing offer list price | `.detail-micro-list__item-action > span.text` | `от 2 016 BYN / месяц` |
| `index.html` | main card price | `.card__price-block .card__price_byn` | `27 829` plus `.nbrb-icon` |
| `product_page.html` | main price | `ul.price > li.byn` | `1 376` plus converter button |

The shared `ul.price > li.byn` selector is valid only because it is constrained by the actual `byn` marker in the provided product/detail markup. Before adding support for a new ABW template, save a real fixture first, identify its price element, add a narrow selector, and add fixture-specific tests.

### 7.2 Rewrite and restoration algorithm

1. Read `ratesData`, `selectedCurrency`, and `customRates` from local storage. Ask background to `ensureRates` if rates are absent.
2. Query the selector registry and process each matching element at most once per pass.
3. Preserve original text and parsed BYN amount in ABW-namespaced dataset fields, for example `data-abw-currencies-original-text` and `data-abw-currencies-byn-amount`.
4. For structured main-price nodes, replace only the number/text portion while preserving required sibling controls such as `.nbrb-icon` and `.converter-trigger`; never replace a parent’s complete markup.
5. For leasing text elements, parse the number inside their existing text, retain semantic text (`Лизинг от`, `В лизинг от`, `от`) and the monthly suffix (`/мес` or `/ месяц`), and replace only the BYN amount/currency representation.
6. If the selected currency is `BYN`, restore the exact initial text including NBSP and original punctuation.
7. Ignore elements that do not parse cleanly, are inside a script/style/form control, or are already a foreign-currency value.
8. Apply custom rate overrides when present; otherwise use validated NBRB rates.

### 7.3 Dynamic-page behavior

- Run once at `document_idle`.
- Observe `document.body` for `childList`, `subtree`, and relevant text changes.
- Coalesce repeated mutations into one `requestAnimationFrame` pass to avoid work loops created by the extension’s own writes.
- Subscribe to `browser.storage.onChanged`; reapply conversion when `ratesData`, `customRates`, or `selectedCurrency` changes.
- Keep observer-driven passes idempotent: no nested output, duplicated unit suffixes, or conversion drift.

## 8. Popup UI and UX (`src/popup/`)

Mirror AV’s Russian-language popup quality and visual system, but remove the VIN setting/block entirely.

### Layout and visual language

- Fixed 320px popup with responsive padding below 380px; no horizontal scrolling.
- Semantic layout: `header` → rates section → loading state → error state → converter → currency setting → footer.
- Use AV’s Kanagawa Wave token palette: dark card background, high-contrast primary/muted text, blue interactive accent, green confirmation, red error, amber cached/custom-rate state.
- Use CSS custom properties rather than raw repeated colors.
- Maintain visible focus states, 44px minimum primary control height, labels/`aria-label`s, `aria-live` status/loading, and error `role="alert"`.

### Interactions

1. Header title: `ABW.by Валюты`; status shows `Обновление...` or the cached-data warning.
2. Rate rows show flags and current NBRB USD/EUR/RUB rates with scale-aware labels.
3. Each rate row has an accessible edit button. Edit mode provides numeric input, save, and reset actions; invalid/non-positive input is rejected without modifying storage.
4. Converter takes an amount and USD/EUR/RUB selector, then displays the equivalent BYN value.
5. `Валюта для цен на ABW` selector persists `selectedCurrency`, defaulting to BYN.
6. Footer shows the last successful update date/time and an `Обновить` button. Disable it while the forced refresh runs.
7. With no cached rates, show loading and obtain rates through `ensureRates`; with stale cached data plus an error, retain/show the rates and display a warning rather than a blank popup.

Popup code imports pure helpers from `../lib/rates.js`, reads storage, and uses the background message protocol. It must not fetch directly.

## 9. Tests and real fixtures

Use the existing real ABW HTML snapshots without replacing them with synthetic pages.

### Unit tests: `tests/parse.test.js`

- Valid/invalid NBRB parsing; all required currencies and scale handling.
- BYN → foreign and foreign → BYN conversion, including RUB scale 100.
- BYN parser with NBSP, `р.`, `BYN`, decimals, `от`, `/мес`, and negative/non-price cases.
- Currency/rate/date/time formatting.

### Background tests: `tests/background.test.js`

- Install/startup/alarm schedule and 240-minute interval.
- Success persistence, validation failure, timeout/network error, and stale-cache preservation.
- In-flight de-duplication.
- Every supported message action, custom-rate validation, effective-rate derivation, and forced-refresh override reset.

### Content tests: `tests/content.test.js`

Load each real fixture through JSDOM and mock only extension APIs/time, never the ABW price markup.

- `car_catalog.html`: convert `.price-byn` and `.leasing-offer`; retain leasing wording and `/мес`.
- `car_page.html`: convert `ul.price > li.byn` without destroying icon/converter child controls; convert `.modal-info__price > .byn`, `.leasing__link`, and `.detail-micro-list__item-action > span.text`.
- `index.html`: convert `.card__price_byn` without removing `.nbrb-icon`.
- `product_page.html`: convert its `ul.price > li.byn` without destroying child controls.
- Restore original exact BYN text after selecting BYN.
- Switch currency in storage without a reload.
- Append a supported price node and verify the mutation observer processes it once.
- Assert unsupported price-like text and existing USD/EUR/RUB values remain untouched.

### Popup tests: `tests/popup.test.js`

- Initial loading/error/cached-rate states.
- Rate rendering, refresh-button disabled state, and last-updated display.
- Currency setting persistence and converter output.
- Custom-rate edit/save/reset flows and accessible controls.

Set Vitest V8 coverage to require at least 80% lines, functions, branches, and statements for `src/background.js` and `src/lib/**/*.js`. Content and popup remain behavior-tested in JSDOM but may be excluded from the numeric threshold, matching AV’s practical policy.

Capture a real NBRB daily endpoint response into `examples/nbrb_response.json` and use it only as a test fixture; network tests must remain mocked and deterministic.

## 10. Build scripts (`scripts/`)

Implement AV-equivalent build behavior with the `abw-currencies` artifact name.

### `package-utils.mjs`

- Export a copy filter that excludes source-control, `node_modules`, generated artifacts, coverage, `.agents`, and local agent/cache files.
- Export helpers to remove agent-only files from staged output and produce deterministic ZIP archives.

### `build-firefox.mjs`

1. Remove and recreate `build/firefox`.
2. Copy `src/` and `icons/` using the shared filter.
3. Copy the source `manifest.json` unchanged.
4. Remove agent-only files from staged output.
5. Create `abw-currencies-firefox.zip` from `build/firefox`.

### `build-chrome.mjs`

1. Remove and recreate `build/chrome`.
2. Read the source manifest.
3. Remove `browser_specific_settings` and transform background scripts into a module service worker.
4. Copy `src/` and `icons/`, write the transformed manifest, remove agent-only files.
5. Add `README_CHROME_INSTALL.txt` with unpacked-extension instructions.
6. Create `abw-currencies-chrome.zip` from `build/chrome`.

Generated `build/` content and ZIP archives stay ignored and are never hand-edited.

## 11. Makefile commands

Create a worker-free Makefile with these variables:

- `EXT_DIR := .`
- `BUILD_DIR := build`
- `CHROME_BUILD_DIR := $(BUILD_DIR)/chrome`
- `EXT_NAME := abw-currencies`
- `EXT_ID := abw-by-currencies@redpandadev`
- `ANDROID_APK ?= org.mozilla.fenix`
- `ADB_DEVICE ?=`
- `CHROME_BIN ?= chromium`
- `CHROME_PROFILE_DIR ?= /tmp/$(EXT_NAME)-chrome-profile`

Provide these targets:

| Target | Command/behavior |
| --- | --- |
| `make test` | `npm run test` |
| `make format` | apply Prettier |
| `make lint` | verify Prettier only |
| `make package-firefox` | build Firefox ZIP |
| `make package-chrome` | build Chrome directory and ZIP |
| `make build-chrome` | `format → lint → test → package-chrome` |
| `make build` | `format → lint → test → package-firefox → package-chrome` |
| `make clean` | remove `build/`, `coverage/`, and both ABW ZIPs |
| `make run` | lint then `npx web-ext run --source-dir . --target firefox-desktop` |
| `make run-chrome` | package Chrome then start Chromium with isolated profile and only `build/chrome` loaded |
| `make run-android` | lint then run with `web-ext` against Firefox Android; respect optional `ADB_DEVICE` |
| `make run-android-nightly` | same Android flow with explicit optional `ANDROID_APK` |

Do not add `test-worker`, `deploy-worker`, or worker-related variables/targets.

## 12. Ordered implementation checklist

1. Add root metadata: manifest, Vitest config, Makefile, README/license, icon assets, and an actual NBRB response fixture.
2. Implement/test `src/lib/rates.js` first. This establishes the parsing/conversion contract.
3. Implement/test `src/background.js` with mocked NBRB fetch, storage, alarms, and messages.
4. Implement `src/content/abw.js` with the selector registry above; write fixture tests before widening selectors.
5. Implement popup HTML/CSS/JS and popup behavior tests; apply the AV visual/accessibility system without VIN controls.
6. Implement packaging utilities and both platform build scripts.
7. Add Makefile commands, then run `make build`.
8. Manually smoke-test in Firefox, Chromium, and (when available) Firefox Android against live ABW pages; save a new real fixture before supporting any unrecognized layout.
9. Document supported selectors/page types, data handling, local storage keys, manual installation, development commands, and known limitations in `README.md`.

## 13. Definition of done

- Both `make build` and `make clean` succeed from a fresh install.
- Firefox ZIP and Chromium ZIP/unpacked build contain no agent/cache/test/source-control artifacts.
- Manifest has no VIN/worker endpoint, source, setting, or permission.
- Popup works without direct network calls and communicates through background messages.
- NBRB failure leaves usable cached prices/rates available and shows a clear warning.
- Each supplied ABW fixture has passing conversion and restoration tests using the selectors in section 7.
- Main prices preserve required ABW icon/button markup; leasing prices preserve wording and their `/мес` or `/ месяц` suffix.
- No page-wide or generic selector converts unrelated numeric content.
- Coverage thresholds for background and pure rate logic meet or exceed 80%.
