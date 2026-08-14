// Copyright © 2026 Mochisoft OÜ
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
    // Server-resolved entity id of the loaded app — set by fetchToken, null
    // until the first token resolves and while a cross-app navigation is in
    // flight. Permission and microphone checks key on this; localStorage
    // namespacing keys on currentAppPath so stored state survives an app's
    // dev-id/entity-id difference between instances.
    var currentAppEntity = null;

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
    iframe.setAttribute('allow', 'gamepad *; fullscreen');   // the Gamepad API is blocked in cross-origin (opaque) iframes by default permissions policy
    iframe.src = initialSrc;
    container.appendChild(iframe);
    var tokenRefreshTimer = null;
    // Incremented on every cross-app navigation. Token fetches and refresh
    // timers capture it first and bail when it has moved: a response that
    // resolves after a navigation names the PREVIOUS app, and acting on it
    // would record permissions against the wrong entity or deliver its
    // token to the app mounted after it.
    var navigationEpoch = 0;
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

    // A color theme arrives from an (untrusted) app over postMessage and is
    // applied to the shell's own root element. Only CSS custom properties
    // (--foo) may be set: without this an app could set standard properties such
    // as display:none or pointer-events:none on the trusted shell root, hiding
    // or disabling the menu and permission dialogs.
    // Exactly the inline properties applyThemeDeclarations installed, so cleanup
    // can undo a theme without touching properties owned by anything else.
    var installedThemeProps = [];
    (function() {
        var root = document.documentElement;
        for (var i = 0; i < root.style.length; i++) {
            if (root.style[i].startsWith('--')) installedThemeProps.push(root.style[i]);
        }
    })();

    // Install the user's theme on the shell root. The text is the server's own
    // resolved declarations — the same ones it injects into the shell page at
    // load — and NEVER values from an app. Custom properties on this root style
    // the trusted chrome, the consent dialog included, so an app that could
    // write them could paint the dialog's text in its background colour and
    // lure a click onto Allow. Apps report that the preference changed; the
    // server says what it is.
    function applyThemeDeclarations(text) {
        clearThemeVars();
        if (typeof text !== 'string' || !text) return;
        var root = document.documentElement;
        var parts = text.split(';');
        for (var i = 0; i < parts.length; i++) {
            var at = parts[i].indexOf(':');
            if (at < 0) continue;
            var key = parts[i].slice(0, at).trim();
            var value = parts[i].slice(at + 1).trim();
            if (!key || !value) continue;
            root.style.setProperty(key, value);
            installedThemeProps.push(key);
        }
    }

    // Re-read the user's theme from the server and install it.
    function refreshTheme() {
        return fetch('/_/shell', {
            method: 'POST',
            credentials: 'same-origin'
        }).then(function(r) {
            return r.ok ? r.json() : null;
        }).then(function(data) {
            if (data) applyThemeDeclarations(data.theme);
        }).catch(function() {
            // Leave the theme installed at page load in place.
        });
    }

    function clearThemeVars() {
        var root = document.documentElement;
        for (var i = 0; i < installedThemeProps.length; i++) {
            root.style.removeProperty(installedThemeProps[i]);
        }
        installedThemeProps = [];
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

    // Immersive mode: an app (e.g. a fullscreen game) asks the shell to hide its
    // chrome. Heartbeat-driven — if the app stops sending `immersive: true` (it
    // crashed, froze, was backgrounded, or was closed), the watchdog restores the
    // chrome, so the menu can never be permanently lost. Cleared on navigation too.
    var immersiveTimer = null;
    function setImmersive(on) {
        if (immersiveTimer) { clearTimeout(immersiveTimer); immersiveTimer = null; }
        if (menuEl) menuEl.classList.toggle('shell-immersive', !!on);
        if (on) immersiveTimer = setTimeout(function() { setImmersive(false); }, 6000);
    }
    // Dropping out of fullscreen (Esc is always permitted) restores the chrome at once.
    document.addEventListener('fullscreenchange', function() {
        if (!document.fullscreenElement) setImmersive(false);
    });

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

        setImmersive(false);   // never carry immersive chrome-hiding across an app navigation
        abortMicSession();     // never leave microphone tracks live across app navigation
        abortCameraSession();  // nor the camera's — the light must follow the app that asked

        // Create the new iframe hidden behind the old one
        var next = document.createElement('iframe');
        next.id = 'app-frame';
        next.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads');
        next.setAttribute('allow', 'gamepad *; fullscreen');
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
        var epoch = navigationEpoch;
        return fetch('/_/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin'
        ,   body: JSON.stringify({ app: appName })
        }).then(function(r) {
            if (!r.ok) throw new Error('Token fetch failed');
            return r.json();
        }).then(function(data) {
            if (data.app && epoch === navigationEpoch) {
                currentAppEntity = data.app;
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
        var epoch = navigationEpoch;
        tokenRefreshTimer = setTimeout(function() {
            if (epoch !== navigationEpoch) return;
            fetchToken(appName).then(function(data) {
                // Navigated while the fetch was in flight: this token belongs
                // to the previous app, and the current iframe must not see it.
                if (epoch !== navigationEpoch) return;
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

    var storagePrefix = 'app:' + currentAppPath + ':';

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

    // Save a Blob the app already holds (e.g. a generated export file) on its
    // behalf. Structured cloning carries the Blob across the sandbox boundary;
    // nothing is fetched, so unlike handleDownload there is no proxy risk —
    // the bytes came from the app itself.
    function handleDownloadContent(data) {
        if (navigating) return;
        var id = data.id;
        if (!(data.blob instanceof Blob)) {
            postToIframe({ type: 'download.result', id: id, ok: false });
            return;
        }
        var objectUrl = URL.createObjectURL(data.blob);
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
    }

    // WebAuthn ceremony bridge. The sandboxed app iframe has an opaque
    // origin so navigator.credentials.create()/get() fails immediately
    // with NotAllowedError. The shell runs in the top window with a real
    // origin, so it can host the ceremony on the iframe app's behalf and
    // post the JSON-serialized response back. Uses the native
    // PublicKeyCredential.parseCreationOptionsFromJSON /
    // parseRequestOptionsFromJSON / toJSON helpers (Chrome 119+,
    // Safari 17.4+, Firefox 119+).
    //
    // Hosting it is a capability, not a convenience: the ceremony runs in the
    // top window, so the relying party is the real Mochi origin and the
    // assertion it returns is valid for Mochi whoever asked for it. The
    // browser's prompt names the relying party rather than the caller, so the
    // user cannot tell which app is behind it - a hostile app would need only a
    // challenge from an attacker-side login to have that prompt answered for
    // it. So it takes a grant, like the microphone below: resolved against the
    // server-resolved app id rather than any name the message carries, and
    // refused when there is no app id yet (mid-navigation) or the check fails.
    // The permission is restricted, so it is granted deliberately from settings
    // and never by a dialog an app can raise at a moment of its choosing.
    function webauthnAllowed() {
        if (!currentAppEntity) return Promise.resolve(false);
        return shellConfigReady.then(function() {
            var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            var token = (shellConfig && shellConfig.menuToken) || '';
            if (token) headers['Authorization'] = 'Bearer ' + token;
            return fetch('/menu/-/permissions/check', {
                method: 'POST',
                credentials: 'same-origin',
                headers: headers,
                body: 'app=' + encodeURIComponent(currentAppEntity) +
                      '&permission=' + encodeURIComponent('user/authentication/sign')
            });
        }).then(function(r) {
            return r.ok ? r.json() : null;
        }).then(function(body) {
            return !!(body && body.data && body.data.granted);
        }).catch(function() {
            return false;
        });
    }

    function handleWebauthnCeremony(data, create) {
        webauthnAllowed().then(function(granted) {
            if (!granted) {
                postToIframe({
                    type: create ? 'webauthn.create.result' : 'webauthn.get.result',
                    requestId: data.requestId,
                    error: { name: 'SecurityError', message: 'This app is not allowed to sign with your passkey. Grant it in Settings, under Permissions.' }
                });
                return;
            }
            runWebauthnCeremony(data, create);
        });
    }

    function runWebauthnCeremony(data, create) {
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

    // --- Microphone recording bridge ---
    // Sandboxed iframes have an opaque origin (no allow-same-origin) so
    // getUserMedia is unavailable there. The shell records on the top-level
    // page and posts the Blob result back. Do NOT add allow-same-origin.
    // States: idle | requesting | recording | stopping
    var micSession = null; // single active/requesting session
    // Latest mic.start waiting for a cancelled permission wait to settle.
    // Never stack concurrent getUserMedia — that floods permission prompts.
    var micStartQueue = null;

    var MIC_PREFERRED_MIME = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus'
    ];

    function micDurationSecs(elapsedMs) {
        return Math.max(1, Math.round(elapsedMs / 1000));
    }

    function micFilenameForMime(mimeType) {
        var lower = String(mimeType || '').toLowerCase();
        if (lower.indexOf('mp4') >= 0 || lower.indexOf('m4a') >= 0 || lower.indexOf('aac') >= 0) {
            return 'Voice Note.mp4';
        }
        if (lower.indexOf('ogg') >= 0) return 'Voice Note.ogg';
        return 'Voice Note.webm';
    }

    function pickMicMimeType() {
        if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
            return '';
        }
        for (var i = 0; i < MIC_PREFERRED_MIME.length; i++) {
            if (MediaRecorder.isTypeSupported(MIC_PREFERRED_MIME[i])) return MIC_PREFERRED_MIME[i];
        }
        return '';
    }

    function stopMicTracks(stream) {
        if (!stream) return;
        try {
            stream.getTracks().forEach(function(track) {
                try { track.stop(); } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
    }

    function settleMicSession(session, payload) {
        if (!session || session.settled) return;
        session.settled = true;
        session.state = 'idle';

        if (session.recorder) {
            try {
                session.recorder.ondataavailable = null;
                session.recorder.onerror = null;
                session.recorder.onstop = null;
            } catch (e) { /* ignore */ }
        }
        stopMicTracks(session.stream);
        session.stream = null;
        session.recorder = null;
        session.chunks = [];
        if (typeof session.stopLevelMeter === 'function') {
            try { session.stopLevelMeter(); } catch (e) { /* ignore */ }
            session.stopLevelMeter = null;
        }

        if (micSession === session) micSession = null;
        hideMicIndicator();

        postToIframe(payload);

        // Flush a single queued retry after the in-flight GUM settles.
        if (!micSession && micStartQueue) {
            var queued = micStartQueue;
            micStartQueue = null;
            handleMicStart(queued);
        }
    }

    function startMicLevelMeter(session, stream) {
        if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') {
            return function() {};
        }
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return function() {};
        var stopped = false;
        var raf = 0;
        var ctx = new Ctx();
        var source = ctx.createMediaStreamSource(stream);
        var analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
        var data = new Uint8Array(analyser.frequencyBinCount);

        function tick() {
            if (stopped) return;
            analyser.getByteTimeDomainData(data);
            var sum = 0;
            for (var i = 0; i < data.length; i++) {
                var v = (data[i] - 128) / 128;
                sum += v * v;
            }
            var level = Math.min(1, Math.sqrt(sum / data.length) * 3.2);
            postToIframe({
                type: 'mic.level',
                requestId: session.requestId,
                level: level
            });
            raf = requestAnimationFrame(tick);
        }
        raf = requestAnimationFrame(tick);

        return function() {
            stopped = true;
            cancelAnimationFrame(raf);
            try { source.disconnect(); analyser.disconnect(); } catch (e) { /* ignore */ }
            try { ctx.close(); } catch (e) { /* ignore */ }
        };
    }

    function abortMicSession() {
        // A start waiting on its consent dialog must not record after navigation.
        if (micGate) micGate.cancelled = true;
        // Drop any queued retry — navigation/unload must not open a new GUM.
        if (micStartQueue && micStartQueue.requestId != null) {
            postToIframe({
                type: 'mic.result',
                requestId: micStartQueue.requestId,
                ok: false,
                cancelled: true,
                error: { name: 'AbortError', message: 'Microphone session aborted' }
            });
        }
        micStartQueue = null;

        var session = micSession;
        if (!session || session.settled) return;
        session.cancelled = true;
        if (session.recorder && session.recorder.state !== 'inactive') {
            try { session.recorder.stop(); } catch (e) { /* ignore */ }
        }
        settleMicSession(session, {
            type: 'mic.result',
            requestId: session.requestId,
            ok: false,
            cancelled: true,
            error: { name: 'AbortError', message: 'Microphone session aborted' }
        });
    }

    function beginMicRecording(session, stream) {
        if (session.cancelled || session.settled) {
            stopMicTracks(stream);
            settleMicSession(session, {
                type: 'mic.result',
                requestId: session.requestId,
                ok: false,
                cancelled: true
            });
            return;
        }

        if (typeof MediaRecorder === 'undefined') {
            stopMicTracks(stream);
            settleMicSession(session, {
                type: 'mic.result',
                requestId: session.requestId,
                ok: false,
                error: { name: 'NotSupportedError', message: 'MediaRecorder is unavailable in this browser' }
            });
            return;
        }

        var preferred = pickMicMimeType();
        var recorder;
        try {
            recorder = preferred
                ? new MediaRecorder(stream, { mimeType: preferred })
                : new MediaRecorder(stream);
        } catch (err) {
            stopMicTracks(stream);
            settleMicSession(session, {
                type: 'mic.result',
                requestId: session.requestId,
                ok: false,
                error: { name: err && err.name || 'NotSupportedError', message: err && err.message || String(err) }
            });
            return;
        }

        var mimeType = recorder.mimeType || preferred || 'audio/webm';
        session.stream = stream;
        session.recorder = recorder;
        session.mimeType = mimeType;
        session.chunks = [];
        session.startedAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
        session.state = 'recording';
        session.stopLevelMeter = startMicLevelMeter(session, stream);

        recorder.ondataavailable = function(e) {
            if (e.data && e.data.size > 0) session.chunks.push(e.data);
        };

        recorder.onerror = function() {
            if (session.settled) return;
            session.pendingError = {
                name: 'MediaRecorderError',
                message: 'MediaRecorder failed while recording'
            };
            session.cancelled = true;
            try {
                if (recorder.state !== 'inactive') recorder.stop();
                else {
                    settleMicSession(session, {
                        type: 'mic.result',
                        requestId: session.requestId,
                        ok: false,
                        error: session.pendingError
                    });
                }
            } catch (e) {
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    error: session.pendingError
                });
            }
        };

        recorder.onstop = function() {
            if (session.settled) return;
            if (session.pendingError) {
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    error: session.pendingError
                });
                return;
            }
            if (session.cancelled) {
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    cancelled: true
                });
                return;
            }
            var now = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            var durationSecs = micDurationSecs(now - session.startedAt);
            var type = session.mimeType || 'audio/webm';
            var blob = new Blob(session.chunks, { type: type });
            if (!blob.size) {
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    error: { name: 'EmptyRecordingError', message: 'Recording produced no audio data' }
                });
                return;
            }
            settleMicSession(session, {
                type: 'mic.result',
                requestId: session.requestId,
                ok: true,
                blob: blob,
                mimeType: type,
                filename: micFilenameForMime(type),
                durationSecs: durationSecs
            });
        };

        try {
            recorder.start(200);
        } catch (err) {
            settleMicSession(session, {
                type: 'mic.result',
                requestId: session.requestId,
                ok: false,
                error: { name: err && err.name || 'NotSupportedError', message: err && err.message || String(err) }
            });
            return;
        }

        showMicIndicator();
        postToIframe({ type: 'mic.started', requestId: session.requestId });
    }

    // --- Shell-owned recording indicator ---
    // A small pulsing marker the app cannot touch (it lives in the top window,
    // outside the sandboxed iframe), so the user always sees when this Mochi tab
    // is recording regardless of what the app's own UI claims. Icon-only, so no
    // translated text is needed in the shell relay.
    var micIndicatorEl = null;
    function ensureMicIndicatorStyle() {
        if (document.getElementById('mochi-mic-style')) return;
        var s = document.createElement('style');
        s.id = 'mochi-mic-style';
        s.textContent = '@keyframes mochi-mic-pulse{0%{box-shadow:0 0 0 0 rgba(225,29,72,0.7)}70%{box-shadow:0 0 0 10px rgba(225,29,72,0)}100%{box-shadow:0 0 0 0 rgba(225,29,72,0)}}';
        document.head.appendChild(s);
    }
    function showMicIndicator() {
        if (micIndicatorEl) return;
        ensureMicIndicatorStyle();
        var el = document.createElement('div');
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);' +
            'z-index:2147483647;width:14px;height:14px;border-radius:50%;background:#e11d48;' +
            'pointer-events:none;animation:mochi-mic-pulse 1.4s ease-out infinite;';
        micIndicatorEl = el;
        if (document.body) document.body.appendChild(el);
    }
    function hideMicIndicator() {
        if (micIndicatorEl && micIndicatorEl.parentNode) {
            micIndicatorEl.parentNode.removeChild(micIndicatorEl);
        }
        micIndicatorEl = null;
    }

    // --- Camera streaming bridge ---
    // Sandboxed iframes have an opaque origin (no allow-same-origin) so
    // getUserMedia is unavailable there — and permission grants cannot even
    // persist against an opaque origin. The shell owns the camera exactly as
    // it owns the microphone, with one structural difference: mic is
    // record-then-return (one Blob), camera is a CONTINUOUS STREAM — one
    // transferable ImageBitmap per camera frame until the app stops it,
    // navigation aborts it, or the tab hides (the webcam light must never
    // stay lit behind a hidden tab). Do NOT add allow-same-origin.
    var cameraSession = null;   // single active/requesting session
    var cameraGate = null;
    var cameraPermissionPending = false;
    var cameraIndicatorEl = null;

    function postCameraFrame(msg, transfer) {
        if (iframe && iframe.contentWindow) {
            iframe.contentWindow.postMessage(msg, '*', transfer);
        } else if (transfer) {
            // No destination: close the bitmap now — an unposted frame would
            // otherwise hold its texture until GC.
            for (var i = 0; i < transfer.length; i++) {
                try { transfer[i].close(); } catch (e) { /* ignore */ }
            }
        }
    }

    function ensureCameraIndicatorStyle() {
        if (document.getElementById('mochi-camera-style')) return;
        var s = document.createElement('style');
        s.id = 'mochi-camera-style';
        s.textContent = '@keyframes mochi-camera-pulse{0%{box-shadow:0 0 0 0 rgba(37,99,235,0.7)}70%{box-shadow:0 0 0 10px rgba(37,99,235,0)}100%{box-shadow:0 0 0 0 rgba(37,99,235,0)}}';
        document.head.appendChild(s);
    }
    function showCameraIndicator() {
        if (cameraIndicatorEl) return;
        ensureCameraIndicatorStyle();
        var el = document.createElement('div');
        el.setAttribute('aria-hidden', 'true');
        // Sits beside the mic dot's centre slot so both can show at once.
        el.style.cssText = 'position:fixed;top:8px;left:calc(50% + 24px);transform:translateX(-50%);' +
            'z-index:2147483647;width:14px;height:14px;border-radius:50%;background:#2563eb;' +
            'pointer-events:none;animation:mochi-camera-pulse 1.4s ease-out infinite;';
        cameraIndicatorEl = el;
        if (document.body) document.body.appendChild(el);
    }
    function hideCameraIndicator() {
        if (cameraIndicatorEl && cameraIndicatorEl.parentNode) {
            cameraIndicatorEl.parentNode.removeChild(cameraIndicatorEl);
        }
        cameraIndicatorEl = null;
    }

    function stopCameraTracks(stream) {
        if (!stream) return;
        try {
            stream.getTracks().forEach(function(track) {
                try { track.stop(); } catch (e) { /* ignore */ }
            });
        } catch (e) { /* ignore */ }
    }

    function settleCameraSession(session, payload) {
        if (!session || session.settled) return;
        session.settled = true;
        if (session.video) {
            try { session.video.srcObject = null; } catch (e) { /* ignore */ }
            session.video = null;
        }
        stopCameraTracks(session.stream);
        session.stream = null;
        if (cameraSession === session) cameraSession = null;
        hideCameraIndicator();
        if (payload) postToIframe(payload);
    }

    function abortCameraSession() {
        if (cameraGate) cameraGate.cancelled = true;
        var session = cameraSession;
        if (!session || session.settled) return;
        session.cancelled = true;
        settleCameraSession(session, session.opened
            ? { type: 'camera.end', requestId: session.requestId, reason: 'aborted' }
            : { type: 'camera.result', requestId: session.requestId, ok: false, cancelled: true,
                error: { name: 'AbortError', message: 'Camera session aborted' } });
    }

    // The webcam light must never stay lit behind a hidden tab: streaming
    // stops outright, and the app restarts it on its own visibility return.
    // The MIC deliberately does not do this — a voice note surviving a brief
    // tab switch is intended.
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) abortCameraSession();
    });

    function handleCameraStart(data) {
        if (navigating) return;
        if (cameraPermissionPending) {
            postToIframe({
                type: 'camera.result',
                requestId: data.requestId,
                ok: false,
                error: { name: 'InvalidStateError', message: 'A camera permission request is already open' }
            });
            return;
        }
        cameraPermissionPending = true;
        var gate = { requestId: data.requestId, cancelled: false };
        cameraGate = gate;
        permissionGranted(currentAppEntity, 'camera').then(function(granted) {
            return granted ? true : requestShellConsent('camera', 'camera');
        }).then(function(granted) {
            cameraPermissionPending = false;
            if (cameraGate === gate) cameraGate = null;
            if (gate.cancelled) {
                postToIframe({ type: 'camera.result', requestId: data.requestId, ok: false, cancelled: true });
                return;
            }
            if (!granted) {
                postToIframe({
                    type: 'camera.result',
                    requestId: data.requestId,
                    ok: false,
                    error: { name: 'NotAllowedError', message: 'Camera permission not granted' }
                });
                return;
            }
            beginCameraStart(data);
        }).catch(function() {
            cameraPermissionPending = false;
            if (cameraGate === gate) cameraGate = null;
            postToIframe({
                type: 'camera.result',
                requestId: data.requestId,
                ok: false,
                error: { name: 'NotAllowedError', message: 'Camera permission not granted' }
            });
        });
    }

    function beginCameraStart(data) {
        if (navigating) return;
        var requestId = data.requestId;
        if (cameraSession && !cameraSession.settled) {
            postToIframe({
                type: 'camera.result',
                requestId: requestId,
                ok: false,
                error: { name: 'InvalidStateError', message: 'A camera session is already active' }
            });
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof createImageBitmap === 'undefined') {
            postToIframe({
                type: 'camera.result',
                requestId: requestId,
                ok: false,
                error: { name: 'NotSupportedError', message: 'Camera access requires a secure context (HTTPS or localhost)' }
            });
            return;
        }

        var session = {
            requestId: requestId,
            cancelled: false,
            settled: false,
            opened: false,
            stream: null,
            video: null,
            pending: false
        };
        cameraSession = session;

        // A requested device that has since been unplugged must not fail the
        // whole start: retry once unconstrained rather than answer with a
        // puzzling OverconstrainedError.
        function open(constraints, retried) {
            navigator.mediaDevices.getUserMedia(constraints).then(function(stream) {
                if (session.cancelled || session.settled) {
                    stopCameraTracks(stream);
                    settleCameraSession(session, { type: 'camera.result', requestId: requestId, ok: false, cancelled: true });
                    return;
                }
                session.stream = stream;
                var track = stream.getVideoTracks && stream.getVideoTracks()[0];
                if (track) {
                    track.onended = function() {
                        settleCameraSession(session, { type: 'camera.end', requestId: requestId, reason: 'ended' });
                    };
                }
                var answer = function(devices) {
                    if (session.cancelled || session.settled) return;
                    session.opened = true;
                    showCameraIndicator();
                    postToIframe({ type: 'camera.result', requestId: requestId, ok: true, devices: devices });
                    pumpCameraFrames(session);
                };
                if (navigator.mediaDevices.enumerateDevices) {
                    navigator.mediaDevices.enumerateDevices().then(function(all) {
                        var cameras = [];
                        for (var i = 0; i < all.length; i++) {
                            if (all[i].kind === 'videoinput') {
                                cameras.push({ id: all[i].deviceId || '', label: all[i].label || '' });
                            }
                        }
                        answer(cameras);
                    }).catch(function() { answer([]); });
                } else {
                    answer([]);
                }
            }).catch(function(err) {
                if (!retried && constraints.video && constraints.video.deviceId) {
                    open({ video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } } }, true);
                    return;
                }
                settleCameraSession(session, {
                    type: 'camera.result',
                    requestId: requestId,
                    ok: false,
                    error: { name: err && err.name || 'Error', message: err && err.message || String(err) }
                });
            });
        }
        var video = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } };
        if (data.device) video.deviceId = { exact: data.device };
        open({ video: video }, false);
    }

    function pumpCameraFrames(session) {
        var video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = session.stream;
        session.video = video;
        var play = video.play();
        if (play && play.catch) play.catch(function() { /* autoplay of a muted local stream cannot fail meaningfully */ });
        function grab() {
            if (session.settled || session.cancelled) return;
            // One in-flight bitmap at a time: if the app (or this thread)
            // lags, frames are dropped at the source instead of queueing.
            if (!session.pending && video.readyState >= 2) {
                session.pending = true;
                createImageBitmap(video).then(function(bitmap) {
                    session.pending = false;
                    if (session.settled || session.cancelled) {
                        try { bitmap.close(); } catch (e) { /* ignore */ }
                        return;
                    }
                    postCameraFrame({ type: 'camera.frame', requestId: session.requestId, frame: bitmap }, [bitmap]);
                }).catch(function() { session.pending = false; });
            }
            schedule();
        }
        function schedule() {
            if (session.settled || session.cancelled) return;
            if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(grab);
            else setTimeout(grab, 33);
        }
        schedule();
    }

    function handleCameraStop(data) {
        if (cameraGate && (data.requestId == null || cameraGate.requestId === data.requestId)) {
            cameraGate.cancelled = true;
        }
        var session = cameraSession;
        if (!session || session.settled) return;
        if (data.requestId != null && session.requestId !== data.requestId) return;
        session.cancelled = true;
        settleCameraSession(session, { type: 'camera.end', requestId: session.requestId, reason: 'stopped' });
    }

    // --- Microphone permission gate ---
    // The shell, not the app, is the enforcement point: getUserMedia runs here
    // in the trusted top window, so a sandboxed app must never open the mic
    // without the user's per-app Mochi grant. We resolve the grant against the
    // server-resolved current app id and, when absent, drive the menu's own
    // consent dialog before recording.
    var micPermissionPending = false;
    // Tracks a start whose consent dialog is open, so a cancel/stop/navigation
    // arriving mid-consent prevents the recording from starting afterward.
    var micGate = null;

    function permissionGranted(appId, permission) {
        if (!appId) return Promise.resolve(false);
        return shellConfigReady.then(function() {
            var headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            var token = (shellConfig && shellConfig.menuToken) || '';
            if (token) headers['Authorization'] = 'Bearer ' + token;
            return fetch('/menu/-/permissions/check', {
                method: 'POST',
                credentials: 'same-origin',
                headers: headers,
                body: 'app=' + encodeURIComponent(appId) + '&permission=' + encodeURIComponent(permission)
            });
        }).then(function(r) {
            return r.ok ? r.json() : null;
        }).then(function(body) {
            return !!(body && body.data && body.data.granted);
        }).catch(function() {
            return false;
        });
    }

    function micHasPermission(appId) {
        return permissionGranted(appId, 'microphone');
    }

    // Ask the menu (same top window) to show its consent dialog for the current
    // app. The menu grants against its own server-resolved app id, not anything
    // the shell passes, so this cannot target a different app. Resolves true if
    // the user allowed. A same-window CustomEvent is unreachable from the
    // sandboxed iframe, so only trusted shell code can trigger it.
    var shellConsentSeq = 0;
    function requestShellConsent(permission, prefix) {
        return new Promise(function(resolve) {
            var id = prefix + '-' + (++shellConsentSeq);
            var settled = false;
            function done(result) {
                if (settled) return;
                settled = true;
                window.removeEventListener('mochi-shell-permission-result', onResult);
                resolve(result);
            }
            function onResult(e) {
                if (!e.detail || e.detail.id !== id) return;
                done(e.detail.result === 'granted');
            }
            window.addEventListener('mochi-shell-permission-result', onResult);
            window.dispatchEvent(new CustomEvent('mochi-shell-permission-request', {
                detail: { id: id, permission: permission }
            }));
            // If the menu isn't mounted/listening, fail closed rather than hang.
            setTimeout(function() { done(false); }, 60000);
        });
    }

    function requestMicConsent() {
        return requestShellConsent('microphone', 'mic');
    }

    function handleMicStart(data) {
        if (navigating) return;
        if (micPermissionPending) {
            postToIframe({
                type: 'mic.result',
                requestId: data.requestId,
                ok: false,
                error: { name: 'InvalidStateError', message: 'A microphone permission request is already open' }
            });
            return;
        }
        micPermissionPending = true;
        var gate = { requestId: data.requestId, cancelled: false };
        micGate = gate;
        micHasPermission(currentAppEntity).then(function(granted) {
            return granted ? true : requestMicConsent();
        }).then(function(granted) {
            micPermissionPending = false;
            if (micGate === gate) micGate = null;
            if (gate.cancelled) {
                // A stop/cancel/navigation landed while consent was open — honor
                // it and never open the microphone after the fact.
                postToIframe({
                    type: 'mic.result',
                    requestId: data.requestId,
                    ok: false,
                    cancelled: true
                });
                return;
            }
            if (!granted) {
                postToIframe({
                    type: 'mic.result',
                    requestId: data.requestId,
                    ok: false,
                    error: { name: 'NotAllowedError', message: 'Microphone permission not granted' }
                });
                return;
            }
            beginMicStart(data);
        }).catch(function() {
            micPermissionPending = false;
            if (micGate === gate) micGate = null;
            postToIframe({
                type: 'mic.result',
                requestId: data.requestId,
                ok: false,
                error: { name: 'NotAllowedError', message: 'Microphone permission not granted' }
            });
        });
    }

    function beginMicStart(data) {
        if (navigating) return;
        var requestId = data.requestId;
        if (micSession && !micSession.settled) {
            // Serialize cancel→retry (e.g. start-timeout retry): keep only the
            // latest queued start and wait for the in-flight getUserMedia to
            // settle before opening another permission request.
            if (micSession.cancelled && micSession.state === 'requesting') {
                if (micStartQueue && micStartQueue.requestId != null) {
                    postToIframe({
                        type: 'mic.result',
                        requestId: micStartQueue.requestId,
                        ok: false,
                        cancelled: true,
                        error: { name: 'AbortError', message: 'Microphone request superseded' }
                    });
                }
                micStartQueue = data;
                return;
            }
            postToIframe({
                type: 'mic.result',
                requestId: requestId,
                ok: false,
                error: { name: 'InvalidStateError', message: 'A microphone session is already active' }
            });
            return;
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            postToIframe({
                type: 'mic.result',
                requestId: requestId,
                ok: false,
                error: {
                    name: 'NotSupportedError',
                    message: 'Microphone access requires a secure context (HTTPS or localhost)'
                }
            });
            return;
        }

        var session = {
            requestId: requestId,
            state: 'requesting',
            cancelled: false,
            settled: false,
            stream: null,
            recorder: null,
            chunks: [],
            startedAt: 0,
            mimeType: '',
            pendingError: null,
            stopLevelMeter: null
        };
        micSession = session;

        // No transient-activation requirement for getUserMedia (unlike getDisplayMedia).
        // Call immediately from this validated message handler.
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
            if (session.cancelled || session.settled) {
                stopMicTracks(stream);
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    cancelled: true
                });
                return;
            }
            beginMicRecording(session, stream);
        }).catch(function(err) {
            if (session.settled) return;
            settleMicSession(session, {
                type: 'mic.result',
                requestId: session.requestId,
                ok: false,
                error: { name: err && err.name || 'NotAllowedError', message: err && err.message || String(err) }
            });
        });
    }

    function handleMicStop(data) {
        var session = micSession;
        var requestId = data.requestId;
        if (micGate && micGate.requestId === requestId) {
            // Stop arrived while the consent dialog is still open — cancel the
            // pending start so it doesn't begin recording once consent resolves.
            micGate.cancelled = true;
            return;
        }
        if (!session || session.settled || session.requestId !== requestId) {
            postToIframe({
                type: 'mic.result',
                requestId: requestId,
                ok: false,
                error: { name: 'InvalidStateError', message: 'No matching microphone session' }
            });
            return;
        }
        if (session.state === 'requesting') {
            session.cancelled = true;
            // Stream may still arrive — drop it in the getUserMedia then-handler.
            return;
        }
        if (session.state === 'recording' && session.recorder) {
            session.state = 'stopping';
            try {
                if (session.recorder.state !== 'inactive') session.recorder.stop();
                else {
                    settleMicSession(session, {
                        type: 'mic.result',
                        requestId: session.requestId,
                        ok: false,
                        cancelled: true
                    });
                }
            } catch (err) {
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    error: { name: err && err.name || 'Error', message: err && err.message || String(err) }
                });
            }
            return;
        }
        if (session.state === 'stopping') return;
        settleMicSession(session, {
            type: 'mic.result',
            requestId: session.requestId,
            ok: false,
            cancelled: true
        });
    }

    function handleMicCancel(data) {
        var session = micSession;
        var requestId = data.requestId;
        if (micGate && (requestId == null || micGate.requestId === requestId)) {
            // Cancel arrived while the consent dialog is still open (e.g. the
            // app's start-timeout) — prevent the deferred start from recording.
            micGate.cancelled = true;
        }
        if (!session || session.settled) {
            postToIframe({ type: 'mic.cancelled', requestId: requestId || 0 });
            return;
        }
        if (requestId != null && requestId !== session.requestId) {
            postToIframe({ type: 'mic.cancelled', requestId: requestId || 0 });
            return;
        }

        session.cancelled = true;

        if (session.state === 'requesting') {
            postToIframe({ type: 'mic.cancelled', requestId: session.requestId });
            // Keep session until getUserMedia resolves so tracks can be stopped.
            return;
        }

        if (session.recorder && session.recorder.state !== 'inactive') {
            session.state = 'stopping';
            try {
                session.recorder.stop();
            } catch (e) {
                settleMicSession(session, {
                    type: 'mic.result',
                    requestId: session.requestId,
                    ok: false,
                    cancelled: true
                });
            }
            postToIframe({ type: 'mic.cancelled', requestId: session.requestId });
            return;
        }

        settleMicSession(session, {
            type: 'mic.result',
            requestId: session.requestId,
            ok: false,
            cancelled: true
        });
        postToIframe({ type: 'mic.cancelled', requestId: session.requestId });
    }

    window.addEventListener('pagehide', abortMicSession);
    window.addEventListener('beforeunload', abortMicSession);

    // --- URL sync ---

    function getAppNameFromPath(path) {
        var match = path.match(/^\/([^/]+)/);
        return match ? match[1] : '';
    }

    // True only when url resolves to this same origin. Relative paths resolve
    // against the shell origin and pass; absolute off-origin URLs (and anything
    // unparseable, including javascript:/data:) fail closed.
    function isSameOriginUrl(url) {
        try {
            return new URL(url, window.location.href).origin === window.location.origin;
        } catch (e) {
            return false;
        }
    }

    // Resolve url against the shell origin and return its origin-relative path
    // plus the app that owns it, or null when unparseable or off-origin.
    // The app name MUST come from the resolved pathname: an absolute or
    // protocol-relative URL carries no leading "/<app>" for getAppNameFromPath
    // to match, so reading it off the raw string yields '' and every app
    // comparison made against that value passes.
    function sameOriginTarget(url) {
        var resolved;
        try {
            resolved = new URL(url, window.location.href);
        } catch (e) {
            return null;
        }
        if (resolved.origin !== window.location.origin) return null;
        return {
            path: resolved.pathname + resolved.search + resolved.hash,
            app: getAppNameFromPath(resolved.pathname)
        };
    }

    var lastNavigatedPath = window.location.pathname + window.location.search + window.location.hash;

    function handleNavigate(data) {
        // Same-origin only — don't rely on pushState throwing on foreign URLs.
        // Reject paths outside the current app (anti-spoofing): moving the top
        // URL to another app while this iframe stays mounted would let the next
        // 'ready' mint that app's token and hand it to the iframe that asked.
        if (!data.path) return;
        var target = sameOriginTarget(data.path);
        if (!target) return;
        var currentApp = getAppNameFromPath(window.location.pathname);
        // Exact match, including the empty name. `target.app &&` skipped the
        // check whenever the name resolved empty — and getAppNameFromPath('/')
        // IS empty — so a request to move the top URL to the root passed the
        // one guard written to stop exactly that.
        if (target.app !== currentApp) return;
        // Only touch history when the path actually changed. Honor the iframe's
        // push-vs-replace intent: a replace (URL canonicalization, filter state,
        // the reload that fires on back) must NOT add a back-stack entry, else
        // it buries the app-home entry and browser-back skips it.
        if (target.path !== lastNavigatedPath) {
            if (data.replace) {
                history.replaceState(null, '', target.path);
            } else {
                history.pushState(null, '', target.path);
            }
            lastNavigatedPath = target.path;
        }
    }

    function handleNavigateExternal(data) {
        // Same-origin only — don't rely on pushState throwing on foreign URLs.
        // Crossing apps is the point here, but the destination must name one:
        // an empty name keys storage on a shared 'app::' prefix that every app
        // would then read, and asks for a token for no app at all.
        if (!data.url) return;
        var target = sameOriginTarget(data.url);
        if (!target || !target.app) return;
        var newApp = target.app;

        if (newApp !== currentAppPath) {
            // Cross-app navigation: update URL, fetch new token, swap iframe
            navigating = true;
            navigationEpoch++;
            // Fail closed: the previous app's entity id must never survive into
            // the next app's permission requests — the consent dialog and mic
            // gate reject when no id is set. fetchToken repopulates it.
            currentAppEntity = null;
            if (window.__mochi_shell) window.__mochi_shell.appId = null;
            currentAppPath = newApp;
            setCurrentApp(newApp);
            updateFavicon(newApp);
            baseTitle = 'Mochi';
            updateTitle();
            history.pushState(null, '', target.path);
            lastNavigatedPath = target.path;

            // Show progress bar and dim current iframe immediately (before token fetch)
            showProgress();
            iframe.style.opacity = '0.6';
            iframe.style.pointerEvents = 'none';

            var epoch = navigationEpoch;
            fetchToken(newApp).then(function(token) {
                if (epoch !== navigationEpoch) return; // a later navigation owns the iframe now
                storagePrefix = 'app:' + newApp + ':';
                swapIframe(target.path);
                scheduleTokenRefresh(newApp);
            }).catch(function() {
                if (epoch !== navigationEpoch) return;
                storagePrefix = 'app:' + newApp + ':';
                swapIframe(target.path);
                // Re-arm even without a token: this replaces the previous
                // app's timer, which would otherwise fire and deliver ITS
                // token into this app's iframe.
                scheduleTokenRefresh(newApp);
            });
        } else {
            // Same app — move the top URL and reload the iframe there.
            //
            // The iframe cannot navigate itself: its origin is opaque, so
            // pushState inside it is a no-op. That is why the popstate handler
            // below reloads for this same case rather than messaging the app.
            // This branch used to post a 'popstate' message instead, which no
            // app has ever listened for — the URL moved and the iframe went on
            // rendering the page it was already showing.
            history.pushState(null, '', target.path);
            // Keep the dedup in handleNavigate honest: left stale, the app's
            // own next relay for this path looks like a change and pushes a
            // duplicate entry over the one just made.
            lastNavigatedPath = target.path;
            showProgress();
            swapIframe(target.path);
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
            navigationEpoch++;
            // Fail closed, as in handleNavigateExternal: no stale entity id
            currentAppEntity = null;
            if (window.__mochi_shell) window.__mochi_shell.appId = null;
            currentAppPath = newApp;
            setCurrentApp(newApp);
            updateFavicon(newApp);
            baseTitle = 'Mochi';
            updateTitle();

            // Show progress bar and dim current iframe immediately (before token fetch)
            showProgress();
            iframe.style.opacity = '0.6';
            iframe.style.pointerEvents = 'none';

            var epoch = navigationEpoch;
            fetchToken(newApp).then(function() {
                if (epoch !== navigationEpoch) return; // a later navigation owns the iframe now
                storagePrefix = 'app:' + newApp + ':';
                swapIframe(path);
                scheduleTokenRefresh(newApp);
            }).catch(function() {
                if (epoch !== navigationEpoch) return;
                storagePrefix = 'app:' + newApp + ':';
                swapIframe(path);
                // Re-arm even without a token — same reason as in
                // handleNavigateExternal's failure path.
                scheduleTokenRefresh(newApp);
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
                // The iframe that ASKED. Everything below is asynchronous and
                // `iframe` is reassigned by a navigation, so without pinning
                // the requester the token minted for this app was posted to
                // whichever iframe happened to be mounted when the fetch
                // resolved — and fetchToken also sets currentAppEntity, which
                // names the app in the camera/microphone consent dialog and is
                // what a granted permission is RECORDED against.
                var requester = event.source;
                Promise.all([fetchToken(appName), shellConfigReady]).then(function(results) {
                    if (!iframe || iframe.contentWindow !== requester) return; // navigated away: this token is not theirs
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
                    if (!iframe || iframe.contentWindow !== requester) return; // same rule on the failure path
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
                // Only ever navigate the top window to a same-origin Mochi URL.
                // Navigating the trusted top window is privileged, and an app in
                // the sandboxed iframe is not trusted to choose an off-origin
                // destination (that is a phishing vector). Apps that must reach
                // an external site (e.g. Stripe checkout) navigate here to one of
                // their own same-origin actions, which issues a server-side
                // redirect to a destination the server — not the app — vouched for.
                if (data.url && isSameOriginUrl(data.url)) {
                    window.location.href = data.url;
                }
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

            case 'download.content':
                handleDownloadContent(data);
                break;

            case 'sidebar-state':
                setSidebarState(!!data.open);
                break;

            case 'sidebar-present':
                setSidebarPresent(!!data.present);
                break;

            case 'immersive':
                setImmersive(!!data.on);
                break;

            case 'overlay':
                if (menuEl) menuEl.classList.toggle('shell-overlay-active', !!data.open);
                break;

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
                // The app reports that the user's theme preference changed. Its
                // values are forwarded to iframes — an app styling its OWN
                // document is its business — but the trusted root is refreshed
                // from the server, which resolves the preference the user
                // actually holds.
                currentColorTheme = data.colorTheme || null;
                refreshTheme();
                postToIframe({ type: 'color-theme-change', colorTheme: currentColorTheme });
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

            case 'mic.start':
                handleMicStart(data);
                break;

            case 'mic.probe':
                postToIframe({
                    type: 'mic.probe.result',
                    requestId: data.requestId,
                    supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder)
                });
                break;

            case 'mic.stop':
                handleMicStop(data);
                break;

            case 'mic.cancel':
                handleMicCancel(data);
                break;

            case 'camera.start':
                handleCameraStart(data);
                break;

            case 'camera.stop':
                handleCameraStop(data);
                break;

            case 'camera.probe':
                postToIframe({
                    type: 'camera.probe.result',
                    requestId: data.requestId,
                    supported: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && typeof createImageBitmap !== 'undefined')
                });
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
