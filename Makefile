# Makefile for Mochi apps
# Copyright Alistair Cunningham 2025-2026

APP = $(notdir $(CURDIR))
VERSION = $(shell grep -m1 '"version"' app.json | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
RELEASE = ../../release

all: web/dist/index.html

clean:
	rm -rf web/dist

web/dist/index.html: $(shell find web/src ../../lib/common/src -type f 2>/dev/null)
	cd web && pnpm run build

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
