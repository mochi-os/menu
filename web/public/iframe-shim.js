// Copyright © 2026 Mochisoft OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

// Mochi iframe shim — injected into app HTML served inside sandboxed iframes.
// Sandboxed iframes without allow-same-origin cannot access cookies,
// localStorage, or sessionStorage. This shim provides in-memory fallbacks
// so third-party libraries (TanStack Router, js-cookie, etc.) don't throw.
// Runs before any app code; kept compact since it ships on every iframe page.
(function () {
  var p = function () { this._d = {}; };
  p.prototype = {
    getItem: function (k) { return this._d.hasOwnProperty(k) ? this._d[k] : null; },
    setItem: function (k, v) { this._d[k] = String(v); },
    removeItem: function (k) { delete this._d[k]; },
    clear: function () { this._d = {}; },
    key: function (i) { return Object.keys(this._d)[i] || null; },
    get length() { return Object.keys(this._d).length; }
  };
  try { window.localStorage; } catch (e) {
    Object.defineProperty(window, 'localStorage', { value: new p(), configurable: true });
  }
  try { window.sessionStorage; } catch (e) {
    Object.defineProperty(window, 'sessionStorage', { value: new p(), configurable: true });
  }
  try { document.cookie; } catch (e) {
    var c = '';
    Object.defineProperty(document, 'cookie', {
      get: function () { return c; },
      set: function (v) {
        var parts = String(v).split(';');
        var kv = parts[0].split('=');
        if (kv.length >= 2) {
          var key = kv[0].trim();
          var val = kv.slice(1).join('=').trim();
          var pairs = c ? c.split('; ') : [];
          var found = false;
          for (var i = 0; i < pairs.length; i++) {
            if (pairs[i].split('=')[0] === key) {
              pairs[i] = key + '=' + val;
              found = true;
              break;
            }
          }
          if (!found) pairs.push(key + '=' + val);
          c = pairs.join('; ');
        }
      },
      configurable: true
    });
  }
})();
