.PHONY: test lint build build-chrome package-firefox package-chrome clean run run-chrome run-android run-android-nightly format format-check

EXT_DIR := .
BUILD_DIR := build
CHROME_BUILD_DIR := $(BUILD_DIR)/chrome
EXT_NAME := abw-currencies
EXT_ID := abw-by-currencies@redpandadev
ANDROID_APK ?= org.mozilla.fenix
ADB_DEVICE ?=
ifdef ADB_DEVICE
WEB_EXT_ADB_ARGS := --adb-device $(ADB_DEVICE)
endif
CHROME_BIN ?= chromium
CHROME_PROFILE_DIR ?= /tmp/$(EXT_NAME)-chrome-profile

test:
	npm run test

format:
	npm run format

lint:
	npm run format:check

package-firefox:
	npm run package:firefox

build-chrome: format lint test package-chrome

package-chrome:
	npm run package:chrome

build: format lint test package-firefox package-chrome

clean:
	rm -rf $(BUILD_DIR) coverage
	rm -f $(EXT_NAME)-firefox.zip $(EXT_NAME)-chrome.zip

run: lint
	npx web-ext run --source-dir $(EXT_DIR) --target firefox-desktop

run-chrome: package-chrome
	$(CHROME_BIN) --user-data-dir="$(CHROME_PROFILE_DIR)" --no-first-run --no-default-browser-check --disable-extensions-except="$(abspath $(CHROME_BUILD_DIR))" --load-extension="$(abspath $(CHROME_BUILD_DIR))"

run-android: lint
	npx web-ext run --source-dir $(EXT_DIR) --target firefox-android --adb-remove-old-artifacts $(WEB_EXT_ADB_ARGS)

run-android-nightly: lint
	npx web-ext run --source-dir $(EXT_DIR) --target firefox-android --firefox-apk $(ANDROID_APK) --adb-remove-old-artifacts $(WEB_EXT_ADB_ARGS)
