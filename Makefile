# Makefile for Mochi apps
# Copyright © 2026 Mochisoft OÜ
# SPDX-License-Identifier: AGPL-3.0-only
# This file is part of Mochi, licensed under the GNU AGPL v3 with the
# Mochi Application Interface Exception - see license.txt and license-exception.md.

APP = $(notdir $(CURDIR))
VERSION = $(shell grep -m1 '"version"' app.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
RELEASE = ../../release
# The sandbox wrapper lives in the umbrella repo, which a standalone checkout
# (CI, a build server holding only the app repos) does not have - fall back to
# plain pnpm there rather than failing on a path outside this repo.
SAFE_PNPM = $(abspath ../../claude/scripts/safe-pnpm.sh)

all: web/dist/index.html

clean:
	rm -rf web/dist

web/dist/index.html: $(shell find web/src web/public ../../lib/web/src -type f 2>/dev/null)
	bash -c 'cd web && if [ -x "$(SAFE_PNPM)" ]; then "$(SAFE_PNPM)" run build; else pnpm run build; fi'
release: web/dist/index.html
	rm -f $(RELEASE)/$(APP)_*.zip
	zip -r $(RELEASE)/$(APP)_$(VERSION).zip app.json *.star labels web/dist
	git tag -a $(VERSION) -m "$(VERSION)" 2>/dev/null || true

deploy:
	../../test/claude/deploy.sh $(APP)

commit:
	git add -A && git commit -m "$(VERSION)" || true

push:
	git push --follow-tags

everything: clean release deploy commit push

install:
	bash -c 'cd web && $(SAFE_PNPM) install'

dev:
	bash -c 'cd web && $(SAFE_PNPM) run dev'

i18n-extract:
	bash -c 'cd web && $(SAFE_PNPM) i18n:extract --clean'
