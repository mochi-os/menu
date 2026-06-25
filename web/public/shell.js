// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Mochi Shell: postMessage relay, URL sync, localStorage proxy
// This runs in the top-level shell page. No UI rendering — that's the menu app's job.

(function() {
    'use strict';

    var staleIframe = null; // old iframe kept visible during transition
    var menuEl = document.getElementById('menu');
    var shellConfig = null; // populated by /_/shell fetch
    var currentAppPath = getAppNameFromPath(window.location.pathname);
    var currentAppId = currentAppPath;

    // Title = "(N) baseTitle" where baseTitle comes from the current app
    // (via postMessage) and N comes from the menu app (via custom event).
    var baseTitle = 'Mochi';
    var notificationCount = 0;
    function updateTitle() {
        document.title = notificationCount > 0
            ? '(' + notificationCount + ') ' + baseTitle
            : baseTitle;
    }
    window.addEventListener('mochi-notification-count', function(e) {
        var n = parseInt(e.detail, 10);
        notificationCount = isNaN(n) || n < 0 ? 0 : n;
        updateTitle();
    });

    // Create the initial iframe — derive src from current URL
    var initialSrc = window.location.pathname + window.location.search + window.location.hash;
    initialSrc += (initialSrc.indexOf('?') >= 0 ? '&' : '?') + '_shell=1';
    var container = document.getElementById('app-container');
    var iframe = document.createElement('iframe');
    iframe.id = 'app-frame';
    iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
    iframe.src = initialSrc;
    container.appendChild(iframe);
    var tokenRefreshTimer = null;
    var navigating = false; // true during cross-app navigation (blocks storage requests)
    var progressBar = document.getElementById('shell-progress');

    // --- Locale state ---
    var currentLocale = null;

    // --- Language state ---
    // BCP 47 tag (e.g. "en", "fr", "zh-Hant") for the active i18n catalog.
    // Sourced from /_/shell init data; updated when an app broadcasts
    // language-set so all open iframes pick up the change without a reload.
    var currentLanguage = null;

    // --- Color theme state ---
    // Read initial color theme from server-injected inline style on <html>
    var currentColorTheme = null;
    (function() {
        var root = document.documentElement;
        var hue = root.style.getPropertyValue('--hue');
        // Collect any overrides (non-anchor CSS variables like --radius)
        var overrides = {};
        for (var i = 0; i < root.style.length; i++) {
            var prop = root.style[i];
            if (prop.startsWith('--') && prop !== '--hue' && prop !== '--hue-chroma' && prop !== '--hue-bg') {
                overrides[prop] = root.style.getPropertyValue(prop).trim();
            }
        }
        var hasOverrides = Object.keys(overrides).length > 0;
        if (hue) {
            currentColorTheme = {
                hue: hue.trim(),
                chroma: (root.style.getPropertyValue('--hue-chroma') || '').trim(),
                hueBg: (root.style.getPropertyValue('--hue-bg') || '').trim()
            };
            if (hasOverrides) currentColorTheme.overrides = overrides;
        } else if (hasOverrides) {
            // No color theme, but has CSS var overrides (e.g. border_radius pref) — use empty hue
            currentColorTheme = { hue: '', chroma: '', hueBg: '', overrides: overrides };
        }
    })();

    function applyThemeVars(theme) {
        clearThemeVars();
        if (!theme) { currentColorTheme = null; return; }
        var root = document.documentElement;
        if (theme.hue) {
            root.style.setProperty('--hue', theme.hue);
            root.style.setProperty('--hue-chroma', theme.chroma);
            root.style.setProperty('--hue-bg', theme.hueBg);
        }
        if (theme.overrides) {
            for (var key in theme.overrides) {
                root.style.setProperty(key, theme.overrides[key]);
            }
        }
        currentColorTheme = theme;
    }

    function clearThemeVars() {
        var root = document.documentElement;
        // Remove all inline CSS custom properties
        var props = [];
        for (var i = 0; i < root.style.length; i++) {
            if (root.style[i].startsWith('--')) props.push(root.style[i]);
        }
        for (var j = 0; j < props.length; j++) {
            root.style.removeProperty(props[j]);
        }
        currentColorTheme = null;
    }

    // --- Sidebar state ---
    // Persisted across app switches so the sidebar stays collapsed/expanded.
    var sidebarOpen = localStorage.getItem('sidebar_state') !== 'false';
    // Whether the currently-loaded app has a sidebar at all. Apps without one
    // (e.g. home) still want the menu rendered horizontally even when the
    // persisted collapse state is "collapsed".
    var sidebarPresent = false;

    function setSidebarState(open) {
        sidebarOpen = open;
        try { localStorage.setItem('sidebar_state', String(open)); } catch(e) {}
        if (menuEl) menuEl.setAttribute('data-sidebar', open ? 'expanded' : 'collapsed');
    }

    function setSidebarPresent(present) {
        sidebarPresent = !!present;
        if (menuEl) menuEl.setAttribute('data-sidebar-present', sidebarPresent ? 'true' : 'false');
    }

    function setCurrentApp(appPath) {
        if (menuEl) menuEl.setAttribute('data-app', appPath);
    }

    // Set initial state
    setSidebarState(sidebarOpen);
    setSidebarPresent(false);
    setCurrentApp(currentAppPath);

    var progressInterval = null;
    var progressWidth = 0;
    // Watchdog for transitions: if the new iframe never sends 'ready'
    // (broken bundle, network stall, infinite redirect), we still want
    // to clean up the staleIframe and show whatever did load instead of
    // leaving the user staring at a dimmed old page forever.
    var READY_TIMEOUT_MS = 10000;
    var readyTimeout = null;

    function armReadyTimeout() {
        clearTimeout(readyTimeout);
        readyTimeout = setTimeout(function() {
            readyTimeout = null;
            // Force the new iframe visible and tear down the stale one;
            // the new iframe may keep loading in the background or it
            // may be broken — either way the user sees what's there now.
            try { console.warn('[shell] iframe ready timeout — forcing transition'); } catch(e) {}
            completeTransition();
        }, READY_TIMEOUT_MS);
    }

    function clearReadyTimeout() {
        if (readyTimeout) {
            clearTimeout(readyTimeout);
            readyTimeout = null;
        }
    }

    function showProgress() {
        if (!progressBar) return;
        clearInterval(progressInterval);
        progressWidth = 0;
        progressBar.style.transition = 'none';
        progressBar.style.width = '0%';
        progressBar.style.opacity = '1';
        void progressBar.offsetHeight;
        progressBar.style.transition = 'width 0.3s ease-out';
        progressInterval = setInterval(function() {
            var remaining = 95 - progressWidth;
            progressWidth = Math.min(95, progressWidth + Math.max(0.5, remaining * 0.1));
            progressBar.style.width = progressWidth + '%';
        }, 100);
        // Note: the ready timeout is armed by callers when the iframe
        // is actually created — not here — so a slow fetchToken doesn't
        // eat into the iframe's load budget.
    }

    function hideProgress() {
        if (!progressBar) return;
        clearInterval(progressInterval);
        progressInterval = null;
        progressBar.style.transition = 'width 0.2s ease-out, opacity 0.3s ease 0.2s';
        progressBar.style.width = '100%';
        progressBar.style.opacity = '0';
    }

    // Tag an iframe URL with _shell=1 so the server can identify it as an
    // iframe load even when the browser doesn't send Sec-Fetch-Dest.
    function shellSrc(url) {
        if (url.indexOf('_shell=1') >= 0) return url;
        return url + (url.indexOf('?') >= 0 ? '&' : '?') + '_shell=1';
    }

    // Replace the iframe with a new one, keeping the old visible until the new
    // one sends its ready message. This avoids both history pollution (creating
    // a new element instead of setting .src) and white flashes during transitions.
    function swapIframe(newSrc) {
        var container = iframe.parentNode;

        // Reset sidebar presence — the new app will re-announce whether it
        // has a sidebar via postMessage. Without this, switching from a
        // sidebar-app to a sidebar-less app would leave the menu collapsed.
        setSidebarPresent(false);
        // Clean up any previous stale iframe
        if (staleIframe && staleIframe.parentNode) {
            staleIframe.parentNode.removeChild(staleIframe);
        }

        // Dim and disable the current iframe while the new one loads
        staleIframe = iframe;
        staleIframe.style.opacity = '0.6';
        staleIframe.style.pointerEvents = 'none';
        staleIframe.removeAttribute('id');

        // Create the new iframe hidden behind the old one
        var next = document.createElement('iframe');
        next.id = 'app-frame';
        next.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
        next.style.visibility = 'hidden';
        next.src = shellSrc(newSrc);
        container.insertBefore(next, staleIframe);

        iframe = next;
        armReadyTimeout();
    }

    // Called when the new iframe sends ready — complete the visual transition.
    // Also called by the ready-timeout watchdog if 'ready' never arrives.
    function completeTransition() {
        clearReadyTimeout();
        hideProgress();
        iframe.style.visibility = '';
        iframe.style.opacity = '';
        iframe.style.pointerEvents = '';
        if (staleIframe && staleIframe.parentNode) {
            staleIframe.parentNode.removeChild(staleIframe);
        }
        staleIframe = null;
    }

    // --- Favicon ---
    // Update the tab favicon to match the current app.
    // Each app serves its favicon at /<path>/images/favicon.svg via the images action.
    var faviconLink = document.querySelector('link[rel="icon"]');

    function updateFavicon(appPath) {
        if (!faviconLink) return;
        var base = appPath ? '/' + appPath : '';
        faviconLink.href = base + '/images/favicon.svg';
    }

    // Set initial favicon
    updateFavicon(currentAppPath);

    // --- Shell config (menuToken, domain) — fetched once on load ---

    var shellConfigReady = fetch('/_/shell', {
        method: 'POST',
        credentials: 'same-origin'
    }).then(function(r) {
        if (!r.ok) return {};
        return r.json();
    }).then(function(data) {
        shellConfig = data || {};
        return shellConfig;
    }).catch(function() {
        shellConfig = {};
    });

    // Expose promise for menu app (runs in shell page, needs menuToken before rendering)
    window.__mochi_shell_ready = shellConfigReady.then(function() {
        return { menuToken: (shellConfig && shellConfig.menuToken) || '' };
    });

    // --- Token management ---

    function fetchToken(appName) {
        return fetch('/_/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin'
        ,   body: JSON.stringify({ app: appName })
        }).then(function(r) {
            if (!r.ok) throw new Error('Token fetch failed');
            return r.json();
        }).then(function(data) {
            if (data.app) {
                currentAppId = data.app;
                // Expose for menu app (e.g. subscribe-notifications needs entity ID)
                if (!window.__mochi_shell) window.__mochi_shell = {};
                window.__mochi_shell.appId = data.app;
            }
            return data;
        });
    }

    function scheduleTokenRefresh(appName) {
        if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
        // Refresh 10 minutes before expiry. JWT tokens are long-lived (1 year),
        // but we refresh periodically to handle session invalidation gracefully.
        tokenRefreshTimer = setTimeout(function() {
            fetchToken(appName).then(function(data) {
                postToIframe({ type: 'token-refresh', token: data.token || '' });
                scheduleTokenRefresh(appName);
            }).catch(function() {
                // Token refresh failed — session may be expired
            });
        }, 10 * 60 * 1000);
    }

    // --- postMessage helpers ---

    function postToIframe(msg) {
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage(msg, '*');
        }
    }

    window.addEventListener('mochi-sidebar-toggle', function() {
        postToIframe({ type: 'sidebar-toggle' });
    });

    // --- localStorage proxy (namespaced by app ID) ---

    var storagePrefix = 'app:' + currentAppId + ':';

    function handleStorageGet(data) {
        if (navigating) return;
        var value = null;
        try {
            value = localStorage.getItem(storagePrefix + data.key);
        } catch(e) { /* ignore */ }
        postToIframe({
            type: 'storage.result',
            id: data.id,
            value: value
        });
    }

    function handleStorageSet(data) {
        if (navigating) return;
        try {
            localStorage.setItem(storagePrefix + data.key, data.value);
        } catch(e) { /* ignore */ }
    }

    function handleStorageRemove(data) {
        if (navigating) return;
        try {
            localStorage.removeItem(storagePrefix + data.key);
        } catch(e) { /* ignore */ }
    }

    // --- Clipboard proxy ---
    // Sandboxed iframes can't access navigator.clipboard (opaque origin).
    // The shell proxies clipboard writes on behalf of the app.

    function handleClipboardWrite(data) {
        if (navigating) return;
        var id = data.id;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(data.text).then(function() {
                postToIframe({ type: 'clipboard.result', id: id, ok: true });
            }).catch(function() {
                postToIframe({ type: 'clipboard.result', id: id, ok: false });
            });
        } else {
            postToIframe({ type: 'clipboard.result', id: id, ok: false });
        }
    }

    // Download a file on the app's behalf. The sandboxed app iframe (opaque
    // origin, no allow-same-origin) can't trigger a real save — a bare
    // <a download> is ignored cross-origin and a blob click is blocked. The
    // top window is same-origin and unsandboxed, so it can fetch (with cookies,
    // so private attachments authorize) and save normally.
    function handleDownload(data) {
        if (navigating) return;
        var id = data.id;
        var url;
        try { url = new URL(data.url, window.location.href); } catch (e) { url = null; }
        // Only ever fetch a URL belonging to the current app on this origin —
        // never let an app use the shell as a fetch proxy for anything else.
        var currentApp = getAppNameFromPath(window.location.pathname);
        if (!url || url.origin !== window.location.origin ||
                getAppNameFromPath(url.pathname) !== currentApp) {
            postToIframe({ type: 'download.result', id: id, ok: false });
            return;
        }
        fetch(url.href, { credentials: 'same-origin' }).then(function(r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.blob();
        }).then(function(blob) {
            var objectUrl = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = objectUrl;
            a.download = data.name || '';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            // Delay cleanup so the browser resolves the blob URL before it's
            // revoked; revoking immediately races with the download.
            setTimeout(function() {
                document.body.removeChild(a);
                URL.revokeObjectURL(objectUrl);
            }, 1000);
            postToIframe({ type: 'download.result', id: id, ok: true });
        }).catch(function() {
            postToIframe({ type: 'download.result', id: id, ok: false });
        });
    }

    // WebAuthn ceremony bridge. The sandboxed app iframe has an opaque
    // origin so navigator.credentials.create()/get() fails immediately
    // with NotAllowedError. The shell runs in the top window with a real
    // origin, so it can host the ceremony on the iframe app's behalf and
    // post the JSON-serialized response back. Uses the native
    // PublicKeyCredential.parseCreationOptionsFromJSON /
    // parseRequestOptionsFromJSON / toJSON helpers (Chrome 119+,
    // Safari 17.4+, Firefox 119+).
    function handleWebauthnCeremony(data, create) {
        var requestId = data.requestId;
        var optionsJSON = data.optionsJSON;
        var resultType = create ? 'webauthn.create.result' : 'webauthn.get.result';
        if (typeof PublicKeyCredential === 'undefined') {
            postToIframe({ type: resultType, requestId: requestId,
                error: { name: 'NotSupportedError', message: 'WebAuthn unavailable in this browser' } });
            return;
        }
        var publicKey;
        try {
            publicKey = create
                ? PublicKeyCredential.parseCreationOptionsFromJSON(optionsJSON)
                : PublicKeyCredential.parseRequestOptionsFromJSON(optionsJSON);
        } catch (err) {
            postToIframe({ type: resultType, requestId: requestId,
                error: { name: err && err.name || 'TypeError', message: err && err.message || String(err) } });
            return;
        }
        var promise = create
            ? navigator.credentials.create({ publicKey: publicKey })
            : navigator.credentials.get({ publicKey: publicKey });
        promise.then(function(cred) {
            if (!cred || typeof cred.toJSON !== 'function') {
                postToIframe({ type: resultType, requestId: requestId,
                    error: { name: 'NotSupportedError', message: 'Credential JSON serialisation unavailable' } });
                return;
            }
            postToIframe({ type: resultType, requestId: requestId, credential: cred.toJSON() });
        }).catch(function(err) {
            postToIframe({ type: resultType, requestId: requestId,
                error: { name: err && err.name || 'Error', message: err && err.message || String(err) } });
        });
    }

    // --- URL sync ---

    function getAppNameFromPath(path) {
        var match = path.match(/^\/([^/]+)/);
        return match ? match[1] : '';
    }

    var lastNavigatedPath = window.location.pathname + window.location.search + window.location.hash;

    function handleNavigate(data) {
        if (!data.path) return;
        // Reject navigate messages for paths outside the current app (anti-spoofing)
        var currentApp = getAppNameFromPath(window.location.pathname);
        var navApp = getAppNameFromPath(data.path);
        if (navApp && navApp !== currentApp) return;
        // Only touch history when the path actually changed. Honor the iframe's
        // push-vs-replace intent: a replace (URL canonicalization, filter state,
        // the reload that fires on back) must NOT add a back-stack entry, else
        // it buries the app-home entry and browser-back skips it.
        if (data.path !== lastNavigatedPath) {
            if (data.replace) {
                history.replaceState(null, '', data.path);
            } else {
                history.pushState(null, '', data.path);
            }
            lastNavigatedPath = data.path;
        }
    }

    function handleNavigateExternal(data) {
        if (!data.url) return;
        var newApp = getAppNameFromPath(data.url);

        if (newApp !== currentAppPath) {
            // Cross-app navigation: update URL, fetch new token, swap iframe
            navigating = true;
            currentAppPath = newApp;
            setCurrentApp(newApp);
            updateFavicon(newApp);
            baseTitle = 'Mochi';
            updateTitle();
            history.pushState(null, '', data.url);

            // Show progress bar and dim current iframe immediately (before token fetch)
            showProgress();
            iframe.style.opacity = '0.6';
            iframe.style.pointerEvents = 'none';

            fetchToken(newApp).then(function(token) {
                currentAppId = newApp;
                storagePrefix = 'app:' + currentAppId + ':';
                swapIframe(data.url);
                scheduleTokenRefresh(newApp);
            }).catch(function() {
                currentAppId = newApp;
                storagePrefix = 'app:' + currentAppId + ':';
                swapIframe(data.url);
            });
        } else {
            // Same app — just update iframe location
            history.pushState(null, '', data.url);
            postToIframe({ type: 'popstate', path: data.url });
        }
    }

    // --- popstate (back/forward) ---

    window.addEventListener('popstate', function() {
        var path = window.location.pathname + window.location.search + window.location.hash;
        lastNavigatedPath = path;
        var newApp = getAppNameFromPath(path);

        if (newApp !== currentAppPath) {
            // Different app — swap iframe and fetch new token
            navigating = true;
            currentAppPath = newApp;
            setCurrentApp(newApp);
            updateFavicon(newApp);
            baseTitle = 'Mochi';
            updateTitle();

            // Show progress bar and dim current iframe immediately (before token fetch)
            showProgress();
            iframe.style.opacity = '0.6';
            iframe.style.pointerEvents = 'none';

            fetchToken(newApp).then(function() {
                currentAppId = newApp;
                storagePrefix = 'app:' + currentAppId + ':';
                swapIframe(path);
                scheduleTokenRefresh(newApp);
            }).catch(function() {
                currentAppId = newApp;
                storagePrefix = 'app:' + currentAppId + ':';
                swapIframe(path);
            });
        } else {
            // Same app — reload iframe at the new path
            // (pushState/replaceState don't work in sandboxed iframes with opaque origins)
            showProgress();
            swapIframe(path);
        }
    });

    // --- Message handler ---

    window.addEventListener('message', function(event) {
        // Validate: must come from the sandboxed iframe (opaque origin = "null")
        if (event.source !== iframe.contentWindow) return;

        var data = event.data;
        if (!data || typeof data !== 'object' || !data.type) return;

        switch (data.type) {
            case 'ready':
                // App is ready — fetch token and shell config, then send init.
                navigating = false;
                var appName = getAppNameFromPath(window.location.pathname);
                Promise.all([fetchToken(appName), shellConfigReady]).then(function(results) {
                    var tokenData = results[0];
                    var sc = shellConfig || {};
                    if (!currentLocale && sc.locale) currentLocale = sc.locale;
                    if (!currentLanguage && sc.language) currentLanguage = sc.language;
                    var theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
                    var initMsg = {
                        type: 'init',
                        token: tokenData.token || '',
                        theme: theme,
                        inShell: true,
                        sidebarOpen: sidebarOpen,
                        domain: sc.domain || null,
                        locale: currentLocale || null,
                        language: currentLanguage || null,
                        restoreSource: sc.restoreSource || null,
                        relinks: sc.relinks || null
                    };
                    if (currentColorTheme) initMsg.colorTheme = currentColorTheme;
                    postToIframe(initMsg);
                    scheduleTokenRefresh(appName);
                    completeTransition();
                }).catch(function() {
                    var theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
                    var initMsg = {
                        type: 'init',
                        token: '',
                        theme: theme,
                        inShell: true,
                        sidebarOpen: sidebarOpen,
                        domain: null,
                        locale: currentLocale || null,
                        language: currentLanguage || null
                    };
                    if (currentColorTheme) initMsg.colorTheme = currentColorTheme;
                    postToIframe(initMsg);
                    completeTransition();
                });
                break;

            case 'navigate':
                handleNavigate(data);
                break;

            case 'navigate-external':
                handleNavigateExternal(data);
                break;

            case 'navigate-top':
                if (data.url) window.location.href = data.url;
                break;

            case 'navigate-back':
                // The iframe's own history is frozen (opaque origin), so the
                // top window owns the real history. Pop here; popstate above
                // re-renders the iframe at the previous path.
                window.history.back();
                break;

            case 'title':
                if (data.title) {
                    baseTitle = data.title;
                    updateTitle();
                }
                break;

            case 'storage.get':
                handleStorageGet(data);
                break;

            case 'storage.set':
                handleStorageSet(data);
                break;

            case 'storage.remove':
                handleStorageRemove(data);
                break;

            case 'clipboard.write':
                handleClipboardWrite(data);
                break;

            case 'download':
                handleDownload(data);
                break;

            case 'sidebar-state':
                setSidebarState(!!data.open);
                break;

            case 'sidebar-present':
                setSidebarPresent(!!data.present);
                break;

            case 'overlay': {
                var menuEl = document.getElementById('menu');
                if (menuEl) menuEl.classList.toggle('shell-overlay-active', !!data.open);
                break;
            }

            case 'theme-set':
                // App changed appearance — update shell class (preference persisted server-side by the app)
                var newTheme = data.theme;
                if (newTheme === 'dark' || newTheme === 'light' || newTheme === 'auto' || newTheme === 'system') {
                    var resolved = newTheme;
                    if (newTheme === 'auto' || newTheme === 'system') {
                        resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
                    }
                    document.documentElement.classList.remove('light', 'dark');
                    document.documentElement.classList.add(resolved);
                }
                break;

            case 'color-theme-set':
                // App changed color theme — apply and sync to iframe
                if (data.colorTheme) {
                    applyThemeVars(data.colorTheme);
                } else {
                    clearThemeVars();
                }
                postToIframe({ type: 'color-theme-change', colorTheme: data.colorTheme || null });
                break;

            case 'locale-set':
                // App changed locale prefs — store and forward to iframe
                if (data.locale) currentLocale = data.locale;
                postToIframe({ type: 'locale-change', locale: data.locale || null });
                break;

            case 'webauthn.create':
                handleWebauthnCeremony(data, true);
                break;

            case 'webauthn.get':
                handleWebauthnCeremony(data, false);
                break;

            case 'language-set':
                // App changed the i18n language — store and forward so every
                // open iframe re-activates its Lingui catalog without a reload.
                if (typeof data.language === 'string') currentLanguage = data.language;
                postToIframe({ type: 'language-change', language: currentLanguage });
                if (typeof data.language === 'string') {
                    try { localStorage.setItem('mochi:language', data.language); } catch (e) {}
                    try {
                        var oneYear = 60 * 60 * 24 * 365;
                        document.cookie = 'mochi_language=' + encodeURIComponent(data.language) +
                            '; path=/; max-age=' + oneYear + '; SameSite=Lax';
                    } catch (e) {}
                }
                // Flip the shell page's own direction so #menu's logical
                // positioning lands on the correct visual side without reload.
                (function() {
                    var rtl = { ar:1, he:1, iw:1, fa:1, ur:1, ps:1, sd:1, ku:1, ckb:1, yi:1, dv:1 };
                    var lang = (currentLanguage || 'en').toLowerCase();
                    var isRtl = lang === 'en-x-pseudo-rtl' || !!rtl[lang.split('-')[0]];
                    document.documentElement.lang = lang;
                    document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
                })();
                break;
        }
    });

    // --- Theme sync ---
    // Listen for theme changes from the menu app and forward to iframe
    var observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.attributeName === 'class') {
                var isDark = document.documentElement.classList.contains('dark');
                postToIframe({ type: 'theme-change', theme: isDark ? 'dark' : 'light' });
            }
            if (mutation.attributeName === 'style') {
                postToIframe({ type: 'color-theme-change', colorTheme: currentColorTheme });
            }
        });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

    // --- Initial load progress ---
    showProgress();
    armReadyTimeout();

    // --- Service worker registration ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(function() {});
    }
})();
