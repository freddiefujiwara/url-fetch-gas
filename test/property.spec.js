import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import * as Code from '../src/Code.js';

// Property-based tests (fast-check). The overarching contract:
// doGet NEVER throws and ALWAYS answers with the structured JSON
// { url, content, error } whose fields are null-or-string, with
// error === null exactly when content is a string.

const CONFIGURED = { TOKEN_PORTFOLIO: 'portfolio-token', TOKEN_READER: 'reader-token' };

function installContentService() {
  global.ContentService = {
    createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn().mockReturnThis() }),
    MimeType: { JSON: 'application/json' }
  };
}

function lastJson() {
  const calls = global.ContentService.createTextOutput.mock.calls;
  return JSON.parse(calls[calls.length - 1][0]);
}

function installTokenStore(map) {
  global.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (name) => (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : null)
    })
  };
}

function installFetchOk(content = '<html>ok</html>') {
  global.UrlFetchApp = {
    fetch: vi.fn().mockReturnValue({
      getResponseCode: vi.fn().mockReturnValue(200),
      getContentText: vi.fn().mockReturnValue(content)
    })
  };
}

// The documented validation rule, restated as a reference predicate:
// a non-empty u is fetchable exactly when it starts with http:// or
// https:// (schemes are case-insensitive per RFC 3986) followed by at
// least one character that `.` can match.
const FETCHABLE = /^https?:\/\/.+/i;

describe('property-based tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete global.UrlFetchApp;
    delete global.ContentService;
    delete global.PropertiesService;
    installContentService();
    installTokenStore(CONFIGURED);
  });

  it('always answers structured JSON for arbitrarily deformed events', () => {
    const deformedEvent = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.integer(),
      fc.string(),
      fc.constant({}),
      fc.constant({ parameter: null }),
      fc.constant({ parameter: {} }),
      fc.record({ parameter: fc.record({ token: fc.string() }) }),
      fc.record({ parameter: fc.record({ u: fc.string() }) }),
      fc.record({ parameter: fc.record({ u: fc.string(), token: fc.string() }) })
    );
    installFetchOk();
    fc.assert(
      fc.property(deformedEvent, (e) => {
        global.ContentService.createTextOutput.mockClear();
        global.UrlFetchApp.fetch.mockClear();
        expect(() => Code.doGet(e)).not.toThrow();
        const json = lastJson();
        expect(Object.keys(json).sort()).toEqual(['content', 'error', 'url']);
        expect(json.url === null || typeof json.url === 'string').toBe(true);
        expect(json.content === null || typeof json.content === 'string').toBe(true);
        expect(json.error === null || typeof json.error === 'string').toBe(true);
        // error is null exactly when a content string was produced.
        expect(json.error === null).toBe(typeof json.content === 'string');
      }),
      { numRuns: 100 }
    );
  });

  it('URL validation follows the documented scheme rule for arbitrary strings', () => {
    installFetchOk();
    const urlLike = fc.oneof(
      fc.string(),
      fc
        .record({
          scheme: fc.constantFrom(
            'http', 'https', 'HTTP', 'HTTPS', 'Http', 'hTtPs',
            'ftp', 'file', 'httpx', 'https:', '', 'http//'
          ),
          rest: fc.string()
        })
        .map(({ scheme, rest }) => scheme + '://' + rest),
      fc
        .record({ scheme: fc.constantFrom('http', 'https', 'HTTP', 'HTTPS'), rest: fc.string() })
        .map(({ scheme, rest }) => scheme + '://' + rest)
    );
    fc.assert(
      fc.property(urlLike, (u) => {
        global.ContentService.createTextOutput.mockClear();
        global.UrlFetchApp.fetch.mockClear();
        Code.doGet({ parameter: { u, token: 'portfolio-token' } });
        const json = lastJson();
        if (u === '') {
          expect(json.error).toContain('Missing required parameter: u');
          expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
        } else if (FETCHABLE.test(u)) {
          expect(json.error).toBeNull();
          expect(json.content).toBe('<html>ok</html>');
          expect(json.url).toBe(u);
          expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(u, {
            muteHttpExceptions: true
          });
        } else {
          expect(json.error).toContain('Invalid URL format');
          expect(json.content).toBeNull();
          expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 100 }
    );
  });

  it('fetched content round-trips byte-identically for arbitrary code units', () => {
    // Building strings from raw code units covers lone surrogates,
    // NUL and control characters, quotes and backslashes — everything
    // a fetched page body could contain after platform decoding.
    // String.fromCharCode never throws for 0..0xFFFF, so the harness
    // itself cannot fail before the code under test runs.
    const arbitraryText = fc
      .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 200 })
      .map((codes) => String.fromCharCode(...codes));
    fc.assert(
      fc.property(arbitraryText, (content) => {
        installFetchOk(content);
        Code.doGet({ parameter: { u: 'https://example.com', token: 'portfolio-token' } });
        const json = lastJson();
        expect(json.error).toBeNull();
        expect(json.content).toBe(content);
      }),
      { numRuns: 100 }
    );
  });

  it('only the exact configured token strings are accepted, for any stored values', () => {
    const storedValue = fc.oneof(fc.constant(null), fc.constant(''), fc.string());
    const storeArb = fc.record({ TOKEN_PORTFOLIO: storedValue, TOKEN_READER: storedValue });
    installFetchOk();
    fc.assert(
      fc.property(storeArb, fc.string(), (store, randomToken) => {
        installTokenStore(store);
        const accepted = [store.TOKEN_PORTFOLIO, store.TOKEN_READER].filter(
          (v) => typeof v === 'string' && v !== ''
        );
        const candidates = [...accepted, randomToken, ''];
        for (const token of candidates) {
          global.ContentService.createTextOutput.mockClear();
          global.UrlFetchApp.fetch.mockClear();
          Code.doGet({ parameter: { u: 'https://example.com', token } });
          const json = lastJson();
          if (accepted.includes(token)) {
            expect(json.error).toBeNull();
            expect(json.content).toBe('<html>ok</html>');
          } else {
            expect(json.error).toContain('Unauthorized.');
            expect(json.content).toBeNull();
            expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
          }
        }
      }),
      { numRuns: 100 }
    );
  });

  it('success is exactly the 200 status, for arbitrary status codes', () => {
    installTokenStore(CONFIGURED);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 999 }), (status) => {
        global.ContentService.createTextOutput.mockClear();
        global.UrlFetchApp = {
          fetch: vi.fn().mockReturnValue({
            getResponseCode: vi.fn().mockReturnValue(status),
            getContentText: vi.fn().mockReturnValue('body')
          })
        };
        Code.doGet({ parameter: { u: 'https://example.com', token: 'portfolio-token' } });
        const json = lastJson();
        if (status === 200) {
          expect(json.error).toBeNull();
          expect(json.content).toBe('body');
        } else {
          expect(json.error).toContain('Target URL returned HTTP ' + status);
          expect(json.content).toBeNull();
        }
      }),
      { numRuns: 100 }
    );
  });
});
