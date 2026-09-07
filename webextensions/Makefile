NPM_MOD_DIR := $(CURDIR)/node_modules
NPM_BIN_DIR := $(NPM_MOD_DIR)/.bin

EXTERNAL_LIB_DIR := $(CURDIR)/extlib
TOOLS_DIR := $(CURDIR)/tools

CHROME_ZIP := treestyletab-chrome.zip
CHROME_PACKAGE_FILES := manifest.json _locales background common options sidebar resources extlib tests

.PHONY: xpi chrome inline_masks install_dependency lint format knip init_extlib update_extlib install_extlib fix_locale_errors

all: xpi

install_dependency:
	[ -e "$(NPM_BIN_DIR)/eslint" -a -e "$(NPM_BIN_DIR)/jsonlint"  -a -e "$(NPM_BIN_DIR)/knip" ] || npm install --save-dev

# --max-warnings=0 treats every warning as an error, so `lint` (and therefore
# `make chrome`, which depends on it) fails on any new style regression. Most
# of this project's rules are configured as warnings rather than errors, so
# without this the exit status stays 0 no matter how many are reported.
lint: install_dependency
	"$(NPM_BIN_DIR)/eslint" . --report-unused-disable-directives --max-warnings=0
	find . -type d -name node_modules -prune -o -type f -name '*.json' -print | xargs "$(NPM_BIN_DIR)/jsonlint" --quiet

format: install_dependency
	"$(NPM_BIN_DIR)/eslint" . --report-unused-disable-directives --fix

# Find unused exports and dependencies across the project (https://knip.dev/)
knip: install_dependency
	"$(NPM_BIN_DIR)/knip"

# NOTE (chrome-port branch): `xpi` rebuilds extlib/ via install_extlib, but on
# this branch extlib/ is vendored and patched for Chrome. Run `make chrome`
# instead; use `xpi` only when deliberately regenerating the Firefox package.
xpi: init_extlib install_extlib lint
	rm -f ./*.xpi
	zip -r -9 treestyletab-we.xpi manifest.json _locales common options background sidebar resources extlib tests -x '*/.*' >/dev/null 2>/dev/null

# Chrome (MV3) package. Deliberately does NOT depend on init_extlib/
# install_extlib: extlib/ is vendored and patched on this branch, so
# regenerating it would discard the port's patches.
chrome: inline_masks lint
	rm -f ./$(CHROME_ZIP)
	zip -r -9 $(CHROME_ZIP) $(CHROME_PACKAGE_FILES) -x '*/.*' >/dev/null
	@echo "built ./$(CHROME_ZIP)"

# Chrome fetches CSS mask images in CORS mode, which chrome-extension:// does
# not satisfy, so masked icons must be inlined as data: URIs. Idempotent:
# prints "total: 0" when everything is already inlined.
inline_masks:
	node $(TOOLS_DIR)/inline-mask-images.mjs

init_extlib:
	git submodule update --init

update_extlib:
	git submodule foreach 'git checkout trunk || git checkout main || git checkout master && git pull'

install_extlib: install_dependency
	rm -f $(EXTERNAL_LIB_DIR)/*.css
	rm -f $(EXTERNAL_LIB_DIR)/*.html
	rm -f $(EXTERNAL_LIB_DIR)/*.js
	rm -f $(EXTERNAL_LIB_DIR)/*.map
	rm -f $(EXTERNAL_LIB_DIR)/*.mjs
	rm -rf $(EXTERNAL_LIB_DIR)/codemirror-theme
	mkdir -p $(EXTERNAL_LIB_DIR)/codemirror-theme
	cp ../submodules/webextensions-lib-event-listener-manager/EventListenerManager.js $(EXTERNAL_LIB_DIR)/
	cp ../submodules/webextensions-lib-tab-favicon-helper/TabFavIconHelper.js $(EXTERNAL_LIB_DIR)/; echo 'export default TabFavIconHelper;' >> $(EXTERNAL_LIB_DIR)/TabFavIconHelper.js
	cp ../submodules/webextensions-lib-rich-confirm/RichConfirm.js $(EXTERNAL_LIB_DIR)/
	cp ../submodules/webextensions-lib-rich-confirm/RichConfirmDialog.* $(EXTERNAL_LIB_DIR)/
	cp ../submodules/webextensions-lib-menu-ui/MenuUI.js $(EXTERNAL_LIB_DIR)/; echo 'export default MenuUI;' >> $(EXTERNAL_LIB_DIR)/MenuUI.js
	cp ../submodules/webextensions-lib-configs/Configs.js $(EXTERNAL_LIB_DIR)/; echo 'export default Configs;' >> $(EXTERNAL_LIB_DIR)/Configs.js
	cp ../submodules/webextensions-lib-options/Options.js $(EXTERNAL_LIB_DIR)/; echo 'export default Options;' >> $(EXTERNAL_LIB_DIR)/Options.js
	cp ../submodules/webextensions-lib-l10n/l10n.js $(EXTERNAL_LIB_DIR)/; echo 'export default l10n;' >> $(EXTERNAL_LIB_DIR)/l10n.js
	cp ../submodules/webextensions-lib-l10n/l10n.js $(EXTERNAL_LIB_DIR)/l10n-classic.js; echo 'window.l10n = l10n;' >> $(EXTERNAL_LIB_DIR)/l10n-classic.js
	cp ../submodules/webextensions-lib-dom-updater/src/diff.js $(EXTERNAL_LIB_DIR)/
	cp ../submodules/webextensions-lib-dom-updater/src/dom-updater.js $(EXTERNAL_LIB_DIR)/
	cp ../submodules/webextensions-lib-placeholder-parser/src/placeholder-parser.js $(EXTERNAL_LIB_DIR)/
	cp ../submodules/webextensions-lib-cross-context-messaging/cross-context-messaging-*.js $(EXTERNAL_LIB_DIR)/
	cp ../submodules/qrcode-generator/js/dist/qrcode.mjs $(EXTERNAL_LIB_DIR)/
	echo "/* CodeMirror version $$(cat node_modules/codemirror/package.json | jq -r .version) */" > $(EXTERNAL_LIB_DIR)/codemirror.js
	cp $(EXTERNAL_LIB_DIR)/codemirror.js $(EXTERNAL_LIB_DIR)/codemirror.css
	cp $(EXTERNAL_LIB_DIR)/codemirror.js $(EXTERNAL_LIB_DIR)/codemirror-mode-css.js
	cat node_modules/codemirror/lib/codemirror.js >> $(EXTERNAL_LIB_DIR)/codemirror.js; echo 'window.CodeMirror = CodeMirror;' >> $(EXTERNAL_LIB_DIR)/codemirror.js
	cat node_modules/codemirror/lib/codemirror.css >> $(EXTERNAL_LIB_DIR)/codemirror.css
	cat node_modules/codemirror/mode/css/css.js >> $(EXTERNAL_LIB_DIR)/codemirror-mode-css.js
	cp node_modules/codemirror/theme/*.css $(EXTERNAL_LIB_DIR)/codemirror-theme/
	echo "/* codemirror-colorpicker version $$(cat node_modules/codemirror-colorpicker/package.json | jq -r .version) */" > $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js
	cp $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.css
	cat node_modules/codemirror-colorpicker/dist/codemirror-colorpicker.js >> $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js
# Not `sed -i -e`: BSD/macOS sed reads the next argument as -i's backup
# suffix, silently leaving a stray codemirror-colorpicker.js-e behind.
	sed -e "s/(this, (function () { 'use strict';/(this || self, (function () { 'use strict';/" $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js > $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js.tmp
	mv $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js.tmp $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js
	echo 'window["codemirror-picker"] = self["codemirror-picker"];' >> $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.js
	cat node_modules/codemirror-colorpicker/dist/codemirror-colorpicker.css >> $(EXTERNAL_LIB_DIR)/codemirror-colorpicker.css
	cp node_modules/dompurify/dist/purify.es.mjs* $(EXTERNAL_LIB_DIR)/
	cp node_modules/morphdom/dist/morphdom-esm.js $(EXTERNAL_LIB_DIR)/

fix_locale_errors:
	find ./_locales -name messages.json | xargs "$(TOOLS_DIR)/shell/escape-special-characters.sh"
	find ./_locales -name messages.json | xargs "$(TOOLS_DIR)/shell/remove-blank-entries.sh"
