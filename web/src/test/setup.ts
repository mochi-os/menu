// Copyright © 2026 Mochi OÜ
// SPDX-License-Identifier: AGPL-3.0-only
// This file is part of Mochi, licensed under the GNU AGPL v3 with the
// Mochi Application Interface Exception - see license.txt and license-exception.md.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock the observers jsdom omits but @formkit/auto-animate constructs on
// import (ResizeObserver + IntersectionObserver). A class is used, not
// vi.fn().mockImplementation(() => ...), because an arrow implementation is
// not usable as a constructor and `new ResizeObserver()` then throws.
// MutationObserver is provided natively by jsdom, so it is left untouched.
class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
global.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver;
global.IntersectionObserver = ObserverStub as unknown as typeof IntersectionObserver;
