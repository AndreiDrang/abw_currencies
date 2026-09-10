(function initAbwCurrencyContentScript() {
  globalThis.browser ??= globalThis.chrome;

  // Narrow selectors verified against real ABW.by snapshots in examples/.
  // Never widen them without capturing a fresh fixture first.
  const MAIN_PRICE_SELECTORS = [
    ".top__right > .price > .price-byn", // catalog card price
    ".card__price-block .card__price_byn", // index card price
    "ul.price > li.byn", // detail/product page price
    ".modal-info__price > .byn", // full-screen gallery modal price
  ];

  const LEASING_SELECTORS = [
    ".top__right > a.leasing-offer", // catalog card leasing
    ".detail-info > a.leasing__link", // detail page leasing
    ".detail-micro-list__item-action > span.text", // leasing offer list
  ];

  const DISPLAY_CURRENCIES = ["BYN", "USD", "EUR", "RUB"];
  const CURRENCY_SYMBOLS = { USD: "$", EUR: "€", RUB: "RUB" };

  const NEGATIVE_LABELS = [
    "Договорная",
    "Бесплатно",
    "Обмен",
    "Цена не указана",
  ];

  const ORIGINAL_TEXT_ATTR = "data-abw-original-text";
  const ORIGINAL_AMOUNT_ATTR = "data-abw-original-amount";
  const ORIGINAL_NUMBER_ATTR = "data-abw-original-number";
  const ICON_DISPLAY_ATTR = "data-abw-icon-display";

  let ratesData = null;
  let customRates = {};
  let selectedCurrency = "BYN";
  let observer = null;
  let applyScheduled = false;

  function normalizeCurrency(value) {
    return DISPLAY_CURRENCIES.includes(value) ? value : "BYN";
  }

  function hasNegativeLabel(normalized) {
    return NEGATIVE_LABELS.some((label) => normalized.includes(label));
  }

  function looksForeignCurrency(normalized) {
    return /[$€]/i.test(normalized) && !/(р\.|руб\.|BYN)/i.test(normalized);
  }

  function parseAmount(raw) {
    const normalized = String(raw).replace(/[\u00A0\u202F\s]/g, "");
    const value = Number.parseFloat(normalized.replace(",", "."));
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /**
   * Finds the raw number substring inside a whitespace-padded price text
   * node, e.g. "\n  164\u00A0832\n" -> { raw: "164\u00A0832", amount: 164832 }.
   */
  function parsePriceTextNode(nodeValue) {
    const normalizedForChecks = nodeValue
      .replace(/[\u00A0\u202F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (hasNegativeLabel(normalizedForChecks)) return null;
    if (looksForeignCurrency(normalizedForChecks)) return null;
    if (/до\s+\d/i.test(normalizedForChecks)) return null;

    const match = nodeValue.match(/\d[\d\u00A0\u202F\s]*(?:[.,]\d+)?/);
    if (!match) return null;

    // Trim trailing whitespace so the raw number never swallows the layout
    // newlines that surround it in whitespace-padded price nodes.
    const raw = match[0].replace(/[\s\u00A0\u202F]+$/, "");
    const amount = parseAmount(raw);
    if (amount == null) return null;

    return { raw, amount };
  }

  /**
   * Parses leasing text like "Лизинг от 438 р./мес",
   * "В лизинг от 1 432 р./мес", or "от 510 BYN / месяц" while
   * keeping the original wording.
   */
  function parseLeasingText(text) {
    const normalized = text
      .replace(/[\u00A0\u202F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (hasNegativeLabel(normalized)) return null;
    if (looksForeignCurrency(normalized)) return null;

    const match = normalized.match(
      /^(.*?от)\s+(\d[\d\s]*(?:[.,]\d+)?)\s*(р\.|руб\.|BYN)(\s*\/\s*(?:мес(?:\.|яц)?|month(?:s)?).*)?$/i,
    );
    if (!match) return null;

    const amount = parseAmount(match[2]);
    if (amount == null) return null;

    return {
      prefix: match[1].trim(),
      amount,
      suffix: match[4] || "",
    };
  }

  function convertFromBYN(amountInByn, rateInfo) {
    if (!Number.isFinite(amountInByn) || !rateInfo) return null;
    const scale = Number(rateInfo.scale);
    const rate = Number(rateInfo.rate);
    if (
      !Number.isFinite(scale) ||
      scale <= 0 ||
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      return null;
    }
    return (amountInByn * scale) / rate;
  }

  function formatDisplayPrice(amount, currency) {
    if (!Number.isFinite(amount)) return null;
    const symbol = CURRENCY_SYMBOLS[currency];
    if (!symbol) return null;

    const rounded = Math.round(amount * 100) / 100;
    const numberText = new Intl.NumberFormat("ru-BY", {
      minimumFractionDigits: rounded % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(rounded);

    return `${numberText} ${symbol}`;
  }

  function getEffectiveRate(currency) {
    const rateInfo = ratesData?.rates?.[currency];
    if (!rateInfo) return null;
    const override = customRates?.[currency];
    if (override != null && Number.isFinite(Number(override)) && override > 0) {
      return { ...rateInfo, rate: Number(override) };
    }
    return rateInfo;
  }

  function isInIgnoredContext(element) {
    return Boolean(element.closest("script, style, input, textarea, select"));
  }

  function collectElements(selectors) {
    const found = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        found.add(element);
      }
    }
    return found;
  }

  function findNumberTextNode(element) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && /\d/.test(node.nodeValue)) {
        return node;
      }
    }
    return null;
  }

  function getIcon(element) {
    return element.querySelector(".nbrb-icon");
  }

  function restoreMainPrice(element) {
    const originalText = element.getAttribute(ORIGINAL_TEXT_ATTR);
    if (originalText == null) return;

    const textNode = findNumberTextNode(element);
    if (textNode && textNode.nodeValue !== originalText) {
      textNode.nodeValue = originalText;
    }

    const icon = getIcon(element);
    if (icon) {
      const storedDisplay = element.getAttribute(ICON_DISPLAY_ATTR);
      const targetDisplay = storedDisplay == null ? "" : storedDisplay;
      if (icon.style.display !== targetDisplay) {
        icon.style.display = targetDisplay;
      }
    }
  }

  function applyToMainPrice(element, rateInfo, currency) {
    if (isInIgnoredContext(element)) return;

    if (!element.hasAttribute(ORIGINAL_AMOUNT_ATTR)) {
      const textNode = findNumberTextNode(element);
      if (!textNode) return;
      const parsed = parsePriceTextNode(textNode.nodeValue);
      if (!parsed) return;

      element.setAttribute(ORIGINAL_TEXT_ATTR, textNode.nodeValue);
      element.setAttribute(ORIGINAL_AMOUNT_ATTR, String(parsed.amount));
      element.setAttribute(ORIGINAL_NUMBER_ATTR, parsed.raw);
    }

    const originalText = element.getAttribute(ORIGINAL_TEXT_ATTR);
    const rawNumber = element.getAttribute(ORIGINAL_NUMBER_ATTR);
    const amount = Number.parseFloat(
      element.getAttribute(ORIGINAL_AMOUNT_ATTR) || "",
    );
    if (originalText == null || rawNumber == null || !Number.isFinite(amount)) {
      return;
    }

    const converted = convertFromBYN(amount, rateInfo);
    const formatted =
      converted == null ? null : formatDisplayPrice(converted, currency);
    if (!formatted) return;

    const textNode = findNumberTextNode(element);
    if (!textNode) return;

    const newNodeValue = originalText.replace(rawNumber, formatted);
    if (textNode.nodeValue !== newNodeValue) {
      textNode.nodeValue = newNodeValue;
    }

    const icon = getIcon(element);
    if (icon && !element.hasAttribute(ICON_DISPLAY_ATTR)) {
      element.setAttribute(ICON_DISPLAY_ATTR, icon.style.display || "");
    }
    if (icon && icon.style.display !== "none") {
      icon.style.display = "none";
    }
  }

  function restoreLeasing(element) {
    const originalText = element.getAttribute(ORIGINAL_TEXT_ATTR);
    if (originalText == null) return;
    if (element.textContent !== originalText) {
      element.textContent = originalText;
    }
  }

  function applyToLeasing(element, rateInfo, currency) {
    if (isInIgnoredContext(element)) return;
    // Leasing anchors must stay pure text: rewriting textContent would
    // destroy any element children.
    if (element.children.length > 0) return;

    if (!element.hasAttribute(ORIGINAL_AMOUNT_ATTR)) {
      const parsed = parseLeasingText(element.textContent);
      if (!parsed) return;

      element.setAttribute(ORIGINAL_TEXT_ATTR, element.textContent);
      element.setAttribute(ORIGINAL_AMOUNT_ATTR, String(parsed.amount));
    }

    const amount = Number.parseFloat(
      element.getAttribute(ORIGINAL_AMOUNT_ATTR) || "",
    );
    if (!Number.isFinite(amount)) return;

    const converted = convertFromBYN(amount, rateInfo);
    const formatted =
      converted == null ? null : formatDisplayPrice(converted, currency);
    if (!formatted) return;

    const originalLeasing = parseLeasingText(
      element.getAttribute(ORIGINAL_TEXT_ATTR) || "",
    );
    if (!originalLeasing) return;

    const newText = `${originalLeasing.prefix} ${formatted}${originalLeasing.suffix}`;
    if (element.textContent !== newText) {
      element.textContent = newText;
    }
  }

  function restoreAll() {
    for (const element of document.querySelectorAll(
      `[${ORIGINAL_TEXT_ATTR}]`,
    )) {
      if (element.matches(LEASING_SELECTORS.join(","))) {
        restoreLeasing(element);
      } else {
        restoreMainPrice(element);
      }
    }
  }

  function applyConversion() {
    if (selectedCurrency === "BYN") {
      restoreAll();
      return;
    }

    const rateInfo = getEffectiveRate(selectedCurrency);
    if (!rateInfo) return;

    for (const element of collectElements(MAIN_PRICE_SELECTORS)) {
      applyToMainPrice(element, rateInfo, selectedCurrency);
    }

    for (const element of collectElements(LEASING_SELECTORS)) {
      applyToLeasing(element, rateInfo, selectedCurrency);
    }
  }

  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    const run = () => {
      applyScheduled = false;
      applyConversion();
    };
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }

  async function ensureRatesIfNeeded() {
    if (ratesData?.rates) return;

    const result = await browser.runtime.sendMessage({ action: "ensureRates" });
    if (result?.ratesData) {
      ratesData = result.ratesData;
    }
  }

  function setupStorageListener() {
    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

      if (changes.ratesData) {
        ratesData = changes.ratesData.newValue || null;
      }
      if (changes.customRates) {
        customRates = changes.customRates.newValue || {};
      }
      if (changes.selectedCurrency) {
        selectedCurrency = normalizeCurrency(changes.selectedCurrency.newValue);
      }

      scheduleApply();
    });
  }

  function setupObserver() {
    if (!document.body) return;
    if (observer) {
      observer.disconnect();
    }

    observer = new MutationObserver(() => {
      scheduleApply();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  async function start() {
    const state = await browser.storage.local.get([
      "ratesData",
      "selectedCurrency",
      "customRates",
    ]);
    ratesData = state.ratesData || null;
    selectedCurrency = normalizeCurrency(state.selectedCurrency);
    customRates = state.customRates || {};

    await ensureRatesIfNeeded();
    setupStorageListener();
    setupObserver();
    scheduleApply();
  }

  start();
})();
