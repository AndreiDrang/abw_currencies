// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = join(__dirname, "../examples");

const DEFAULT_RATES = {
  rates: {
    USD: { code: "USD", name: "Доллар США", scale: 1, rate: 2.8186 },
    EUR: { code: "EUR", name: "Евро", scale: 1, rate: 3.2937 },
    RUB: {
      code: "RUB",
      name: "Российских рублей",
      scale: 100,
      rate: 3.7556,
    },
  },
  fetchedAt: 1700000000000,
};

// Expected display helpers mirroring the content-script formatting rules.
const USD_SYMBOL = "$";
const EUR_SYMBOL = "€";
const nf2 = new Intl.NumberFormat("ru-BY", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const nf0 = new Intl.NumberFormat("ru-BY", { maximumFractionDigits: 0 });

function expectedForeign(bynAmount, rate, scale, symbol) {
  const value = (bynAmount * scale) / rate;
  const rounded = Math.round(value * 100) / 100;
  const numberText =
    rounded % 1 === 0 ? nf0.format(rounded) : nf2.format(rounded);
  return `${numberText} ${symbol}`;
}

const usd = (byn) => expectedForeign(byn, 2.8186, 1, USD_SYMBOL);
const eur = (byn) => expectedForeign(byn, 3.2937, 1, EUR_SYMBOL);

let state;
let storageListeners;
let observers;
let browserMock;

class MockMutationObserver {
  constructor(callback) {
    this.callback = callback;
    observers.push(this);
  }

  observe() {}

  disconnect() {}
}

function readFixture(name) {
  return readFileSync(join(EXAMPLES_DIR, name), "utf-8");
}

function freshFixtureDocument(name) {
  return new JSDOM(readFixture(name)).window.document;
}

function loadFixture(name) {
  const dom = new JSDOM(readFixture(name));
  document.head.innerHTML = "";
  document.body.innerHTML = dom.window.document.body.innerHTML;
}

async function flushTicks(count = 8) {
  for (let i = 0; i < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function startScript(fixture, overrides = {}) {
  state = {
    ratesData: DEFAULT_RATES,
    customRates: {},
    selectedCurrency: "USD",
    ...overrides,
  };
  loadFixture(fixture);

  vi.resetModules();
  await import("../src/content/abw.js");
  await flushTicks();
}

function triggerObservers() {
  for (const instance of observers) {
    instance.callback([], instance);
  }
}

function fireStorageChange(changes) {
  for (const listener of storageListeners) {
    listener(changes, "local");
  }
}

function firstNumberTextNode(element) {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && /\d/.test(node.nodeValue)) {
      return node;
    }
  }
  return null;
}

beforeEach(() => {
  state = null;
  storageListeners = [];
  observers = [];

  browserMock = {
    storage: {
      local: {
        get: vi.fn(async (keys) => {
          if (typeof keys === "string") return { [keys]: state[keys] };
          const result = {};
          for (const key of keys || []) result[key] = state[key];
          return result;
        }),
      },
      onChanged: {
        addListener: vi.fn((listener) => {
          storageListeners.push(listener);
        }),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (message) => {
        if (message?.action === "ensureRates") {
          if (!state.ratesData && !state.ensureRatesFails) {
            state.ratesData = DEFAULT_RATES;
          }
          return {
            ratesData: state.ratesData ?? null,
            lastError: state.lastError ?? null,
          };
        }
        return null;
      }),
    },
  };

  vi.stubGlobal("browser", browserMock);
  vi.stubGlobal("chrome", browserMock);
  vi.stubGlobal("MutationObserver", MockMutationObserver);
  vi.stubGlobal("requestAnimationFrame", undefined);
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("car_catalog.html — card prices and leasing", () => {
  it("converts the main card price and hides the NBRB icon", async () => {
    await startScript("car_catalog.html");

    const price = document.querySelector(".top__right > .price > .price-byn");
    expect(price).not.toBeNull();

    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain("12\u00A0802,46 $");
    expect(textNode.nodeValue).toContain(usd(36085));

    const icon = price.querySelector(".nbrb-icon");
    expect(icon).not.toBeNull();
    expect(icon.style.display).toBe("none");
  });

  it("converts all catalog cards, not only the first", async () => {
    await startScript("car_catalog.html");

    const prices = document.querySelectorAll(
      ".top__right > .price > .price-byn",
    );
    expect(prices.length).toBe(20);
    for (const price of prices) {
      const textNode = firstNumberTextNode(price);
      expect(textNode.nodeValue).toContain(USD_SYMBOL);
    }
  });

  it("converts the leasing monthly price keeping wording and /мес", async () => {
    await startScript("car_catalog.html");

    const leasing = document.querySelector(".top__right > a.leasing-offer");
    expect(leasing.textContent).toBe("Лизинг от 155,40 $/мес");
    expect(leasing.textContent).toBe(`Лизинг от ${usd(438)}/мес`);
  });
});

describe("car_page.html — detail page price and leasing", () => {
  it("converts the main price without destroying icon and converter tooltip", async () => {
    await startScript("car_page.html");

    const price = document.querySelector("ul.price > li.byn");
    expect(price).not.toBeNull();

    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain("58\u00A0480,10 $");
    expect(textNode.nodeValue).toContain(usd(164832));

    const icon = price.querySelector(".nbrb-icon");
    expect(icon).not.toBeNull();
    expect(icon.style.display).toBe("none");

    const tooltip = price.querySelector(".converter-tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip.textContent).toContain("Конвертер");

    const preservedComments = [...price.childNodes].filter(
      (node) => node.nodeType === Node.COMMENT_NODE,
    );
    expect(preservedComments.length).toBe(2);
  });

  it("converts the leasing link keeping the В лизинг wording", async () => {
    await startScript("car_page.html");

    const leasing = document.querySelector(".detail-info > a.leasing__link");
    expect(leasing.textContent).toBe(`В лизинг от ${usd(1432)}/мес`);
    expect(leasing.textContent).toContain("В лизинг от");
    expect(leasing.textContent).toContain("/мес");
  });

  it("converts leasing offer list prices while preserving action buttons", async () => {
    await startScript("car_page.html");

    const offers = document.querySelectorAll(
      ".detail-micro-list__item-action > span.text",
    );
    expect(offers.length).toBe(8);
    expect(offers[0].textContent).toBe(`от ${usd(2016)} / месяц`);
    expect(offers[1].textContent).toBe(`от ${usd(2060)} / месяц`);

    const pricedOffers = [...offers].filter((offer) =>
      offer.hasAttribute("data-abw-original-amount"),
    );
    expect(pricedOffers.length).toBe(7);
    for (const offer of pricedOffers) {
      expect(offer.textContent).not.toContain("BYN");
      expect(offer.parentElement.querySelector("button, a")).not.toBeNull();
    }

    expect(offers[2].textContent.trim()).toBe("");
    expect(offers[2].hasAttribute("data-abw-original-amount")).toBe(false);
  });

  it("converts the hidden full-screen gallery modal price", async () => {
    await startScript("car_page.html");

    const price = document.querySelector(".modal-info__price > .byn");
    expect(price).not.toBeNull();
    expect(firstNumberTextNode(price).nodeValue).toContain(usd(31498));
    expect(price.querySelector(".nbrb-icon").style.display).toBe("none");

    fireStorageChange({ selectedCurrency: { newValue: "BYN" } });
    await flushTicks(4);
    expect(firstNumberTextNode(price).nodeValue.trim()).toBe("31\u00A0498");
    expect(price.querySelector(".nbrb-icon").style.display).toBe("");
  });

  it("restores the leasing offer list text exactly in BYN", async () => {
    await startScript("car_page.html");

    const fresh = freshFixtureDocument("car_page.html");
    const original = [
      ...fresh.querySelectorAll(".detail-micro-list__item-action > span.text"),
    ].map((element) => element.textContent);

    fireStorageChange({ selectedCurrency: { newValue: "BYN" } });
    await flushTicks(4);

    const restored = [
      ...document.querySelectorAll(
        ".detail-micro-list__item-action > span.text",
      ),
    ].map((element) => element.textContent);
    expect(restored).toEqual(original);
  });
});

describe("index.html — homepage card prices", () => {
  it("converts card prices and hides NBRB icons", async () => {
    await startScript("index.html");

    const prices = document.querySelectorAll(
      ".card__price-block .card__price_byn",
    );
    expect(prices.length).toBe(7);

    const textNode = firstNumberTextNode(prices[0]);
    expect(textNode.nodeValue).toContain(usd(164832));

    const icon = prices[0].querySelector(".nbrb-icon");
    expect(icon.style.display).toBe("none");
  });
});

describe("product_page.html — product price", () => {
  it("converts the product price and preserves child controls", async () => {
    await startScript("product_page.html");

    const price = document.querySelector("ul.price > li.byn");
    expect(price).not.toBeNull();

    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain("488,19 $");
    expect(textNode.nodeValue).toContain(usd(1376));

    expect(price.querySelector(".converter-tooltip")).not.toBeNull();
    expect(price.querySelector(".nbrb-icon").style.display).toBe("none");
  });
});

describe("restoration to BYN", () => {
  it("restores exact original text, newlines and icons after switching to BYN", async () => {
    await startScript("car_catalog.html");

    fireStorageChange({ selectedCurrency: { newValue: "BYN" } });
    await flushTicks(4);

    const fresh = freshFixtureDocument("car_catalog.html");

    const price = document.querySelector(".top__right > .price > .price-byn");
    const freshPrice = fresh.querySelector(".top__right > .price > .price-byn");
    expect(firstNumberTextNode(price).nodeValue).toBe(
      firstNumberTextNode(freshPrice).nodeValue,
    );
    expect(firstNumberTextNode(price).nodeValue.trim()).toBe("36\u00A0085");
    expect(price.querySelector(".nbrb-icon").style.display).toBe("");

    const leasing = document.querySelector(".top__right > a.leasing-offer");
    const freshLeasing = fresh.querySelector(".top__right > a.leasing-offer");
    expect(leasing.textContent).toBe(freshLeasing.textContent);
    expect(leasing.textContent).toContain("р./мес");
  });

  it("leaves the page untouched when currency is BYN from the start", async () => {
    await startScript("car_catalog.html", { selectedCurrency: "BYN" });

    const price = document.querySelector(".top__right > .price > .price-byn");
    const fresh = freshFixtureDocument("car_catalog.html");
    const freshPrice = fresh.querySelector(".top__right > .price > .price-byn");
    expect(firstNumberTextNode(price).nodeValue).toBe(
      firstNumberTextNode(freshPrice).nodeValue,
    );
    expect(price.querySelector(".nbrb-icon").style.display).toBe("");
    expect(price.hasAttribute("data-abw-original-amount")).toBe(false);

    const leasing = document.querySelector(".top__right > a.leasing-offer");
    expect(leasing.textContent).toContain("438");
    expect(leasing.textContent).toContain("р./мес");
  });
});

describe("currency switching without reload", () => {
  it("re-converts from the original BYN amount when switching USD to EUR", async () => {
    await startScript("car_page.html");

    fireStorageChange({ selectedCurrency: { newValue: "EUR" } });
    await flushTicks(4);

    const price = document.querySelector("ul.price > li.byn");
    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain(eur(164832));
    expect(textNode.nodeValue).toContain("50\u00A0044,63 €");

    const leasing = document.querySelector(".detail-info > a.leasing__link");
    expect(leasing.textContent).toBe(`В лизинг от ${eur(1432)}/мес`);
  });

  it("converts with RUB scale awareness", async () => {
    await startScript("car_catalog.html", { selectedCurrency: "RUB" });

    const price = document.querySelector(".top__right > .price > .price-byn");
    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain("960\u00A0831,82 RUB");
  });
});

describe("custom rates", () => {
  it("applies a custom USD rate from storage", async () => {
    await startScript("car_catalog.html", {
      customRates: { USD: 3 },
    });

    const price = document.querySelector(".top__right > .price > .price-byn");
    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain("12\u00A0028,33 $");
  });
});

describe("dynamic content", () => {
  it("processes newly appended price nodes through the mutation observer once", async () => {
    await startScript("car_catalog.html");

    const wrapper = document.createElement("div");
    wrapper.innerHTML = [
      '<div class="top__right">',
      '<div class="price">',
      '<span class="price-byn">10\u00A0500\n<span class="nbrb-icon">\uE901</span></span>',
      "</div>",
      '<a class="leasing-offer hover_orange">Лизинг\nот\n77\nр./мес</a>',
      "</div>",
    ].join("");
    document.body.appendChild(wrapper);

    triggerObservers();
    await flushTicks(4);

    const price = wrapper.querySelector(".price-byn");
    const textNode = firstNumberTextNode(price);
    expect(textNode.nodeValue).toContain(usd(10500));
    expect(textNode.nodeValue.split(USD_SYMBOL).length - 1).toBe(1);

    const leasing = wrapper.querySelector("a.leasing-offer");
    expect(leasing.textContent).toBe(`Лизинг от ${usd(77)}/мес`);

    // A second observer pass must not re-format the already converted text.
    triggerObservers();
    await flushTicks(4);
    expect(firstNumberTextNode(price).nodeValue).toContain(usd(10500));
    expect(
      firstNumberTextNode(price).nodeValue.split(USD_SYMBOL).length - 1,
    ).toBe(1);
  });
});

describe("immunity to unsupported values", () => {
  it("ignores foreign-currency and negative-label prices", async () => {
    await startScript("car_catalog.html");

    const wrapper = document.createElement("div");
    wrapper.innerHTML = [
      '<div class="top__right"><div class="price">',
      '<span class="price-byn">1\u00A0500 $</span>',
      '<span class="price-byn">Договорная</span>',
      '<span class="price-byn">от 900 до 1\u00A0200</span>',
      "</div></div>",
      '<div class="unrelated-spec">120\u00A0000 км</div>',
    ].join("");
    document.body.appendChild(wrapper);

    triggerObservers();
    await flushTicks(4);

    const prices = wrapper.querySelectorAll(".price-byn");
    expect(prices[0].textContent).toContain("1\u00A0500 $");
    expect(prices[0].hasAttribute("data-abw-original-amount")).toBe(false);
    expect(prices[1].textContent).toBe("Договорная");
    expect(prices[2].hasAttribute("data-abw-original-amount")).toBe(false);
    expect(wrapper.querySelector(".unrelated-spec").textContent).toContain(
      "км",
    );
  });
});

describe("rate availability", () => {
  it("asks the background for rates when storage has none", async () => {
    await startScript("car_catalog.html", { ratesData: undefined });

    expect(browserMock.runtime.sendMessage).toHaveBeenCalledWith({
      action: "ensureRates",
    });

    const price = document.querySelector(".top__right > .price > .price-byn");
    expect(firstNumberTextNode(price).nodeValue).toContain(usd(36085));
  });

  it("leaves prices untouched when no currency rate exists", async () => {
    await startScript("car_catalog.html", {
      ratesData: undefined,
      ensureRatesFails: true,
    });

    const price = document.querySelector(".top__right > .price > .price-byn");
    expect(firstNumberTextNode(price).nodeValue).toContain("36\u00A0085");
    expect(firstNumberTextNode(price).nodeValue).not.toContain("$");
  });
});
