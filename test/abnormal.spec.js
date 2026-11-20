import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

// Abnormal-case tests: deformed request parameters and deformed
// fetcher behaviour. The contract under test is that doGet ALWAYS
// answers with the structured JSON { url, content, error } and never
// throws, no matter what arrives from outside.
//
// Domain note: in production, e.parameter values are always strings
// (the GAS platform guarantees this), so non-string parameter shapes
// other than the token checks below are out of domain. The fetcher
// (UrlFetchApp) and PropertiesService are platform APIs whose thrown
// values and return values are outside this app's control, so those
// shapes ARE in domain: the error path itself must never throw.

const TOKENS = { TOKEN_PORTFOLIO: 'portfolio-token', TOKEN_READER: 'reader-token' };

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

function installTokens(map = TOKENS) {
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

function installFetchStatus(status, content = 'body') {
  global.UrlFetchApp = {
    fetch: vi.fn().mockReturnValue({
      getResponseCode: vi.fn().mockReturnValue(status),
      getContentText: vi.fn().mockReturnValue(content)
    })
  };
}

describe('abnormal cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete global.UrlFetchApp;
    delete global.ContentService;
    delete global.PropertiesService;
    installContentService();
    installTokens();
  });

  describe('request parameter deformities', () => {
    it('rejects an empty-string u as missing', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: '', token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toContain('Error: Missing required parameter: u');
      expect(json.content).toBeNull();
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('rejects a whitespace-only u as an invalid URL', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: '   ', token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toContain('Error: Invalid URL format');
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('accepts an uppercase scheme (URL schemes are case-insensitive)', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: 'HTTPS://example.com', token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe('<html>ok</html>');
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith('HTTPS://example.com', {
        muteHttpExceptions: true
      });
    });

    it('accepts a mixed-case scheme with path and query', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: 'Https://example.com/path?q=1', token: 'reader-token' } });
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe('<html>ok</html>');
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith('Https://example.com/path?q=1', {
        muteHttpExceptions: true
      });
    });

    it('rejects a bare scheme with nothing after it', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: 'https://', token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toContain('Error: Invalid URL format');
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('fetches a minimal http URL', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: 'http://a', token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith('http://a', {
        muteHttpExceptions: true
      });
    });

    it('passes a URL with credentials through to the fetcher unchanged', () => {
      installFetchOk();
      const u = 'https://user:pass@example.com/';
      Code.doGet({ parameter: { u, token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.url).toBe(u);
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(u, { muteHttpExceptions: true });
    });

    it('passes a URL with a fragment through to the fetcher unchanged', () => {
      installFetchOk();
      const u = 'https://example.com/page#section';
      Code.doGet({ parameter: { u, token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.url).toBe(u);
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(u, { muteHttpExceptions: true });
    });

    it('passes an extremely long URL through unchanged', () => {
      installFetchOk();
      const u = 'https://example.com/' + 'a'.repeat(10000);
      Code.doGet({ parameter: { u, token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.url).toBe(u);
      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(u, { muteHttpExceptions: true });
    });

    it('degrades to an error JSON when the fetcher rejects a malformed-percent URL', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw new Error('Invalid argument: malformed URL');
        })
      };
      Code.doGet({ parameter: { u: 'https://example.com/%zz%2', token: 'portfolio-token' } });
      const json = lastJson();
      expect(json.error).toContain('Invalid argument: malformed URL');
      expect(json.content).toBeNull();
    });

    it.each([
      ['null event', null],
      ['numeric event', 42],
      ['string event', 'a string'],
      ['parameter is null', { parameter: null }],
      ['parameter without u', { parameter: { token: 'portfolio-token' } }]
    ])('answers Missing-u JSON for a %s', (_label, e) => {
      installFetchOk();
      Code.doGet(e);
      const json = lastJson();
      expect(json.error).toContain('Error: Missing required parameter: u');
      expect(json.content).toBeNull();
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('rejects an array token (only the exact string matches)', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: 'https://example.com', token: ['portfolio-token'] } });
      const json = lastJson();
      expect(json.error).toContain('Error: Unauthorized.');
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('rejects a numeric token', () => {
      installFetchOk();
      Code.doGet({ parameter: { u: 'https://example.com', token: 12345 } });
      const json = lastJson();
      expect(json.error).toContain('Error: Unauthorized.');
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });
  });

  describe('fetcher deformities', () => {
    const authed = { parameter: { u: 'https://example.com', token: 'portfolio-token' } };

    it('still answers JSON when fetch throws a null-prototype object', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw Object.create(null);
        })
      };
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(typeof json.error).toBe('string');
      expect(json.error.length).toBeGreaterThan(0);
      expect(json.content).toBeNull();
    });

    it('still answers JSON when fetch throws an object whose toString is not a function', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw { toString: [] };
        })
      };
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(typeof json.error).toBe('string');
      expect(json.error.length).toBeGreaterThan(0);
      expect(json.content).toBeNull();
    });

    it('still answers JSON when fetch throws null', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw null;
        })
      };
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(json.error).toBe('null');
      expect(json.content).toBeNull();
    });

    it('reports a thrown string verbatim', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw 'plain string failure';
        })
      };
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBe('plain string failure');
      expect(json.content).toBeNull();
    });

    it('reports a thrown number as its decimal string', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw 42;
        })
      };
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBe('42');
      expect(json.content).toBeNull();
    });

    it('still answers JSON when getResponseCode throws an unstringifiable value', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockReturnValue({
          getResponseCode: vi.fn().mockImplementation(() => {
            throw { toString: [] };
          }),
          getContentText: vi.fn().mockReturnValue('never read')
        })
      };
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(typeof json.error).toBe('string');
      expect(json.content).toBeNull();
    });

    it('still answers JSON when getContentText throws a null-prototype object', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockReturnValue({
          getResponseCode: vi.fn().mockReturnValue(200),
          getContentText: vi.fn().mockImplementation(() => {
            throw Object.create(null);
          })
        })
      };
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(typeof json.error).toBe('string');
      expect(json.content).toBeNull();
    });

    it('still answers JSON when the script-properties lookup throws an unstringifiable value', () => {
      global.PropertiesService = {
        getScriptProperties: () => {
          throw { toString: [] };
        }
      };
      installFetchOk();
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(typeof json.error).toBe('string');
      expect(json.content).toBeNull();
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it.each([301, 302, 204, 500])('reports HTTP %i as an error with no content', (status) => {
      installFetchStatus(status);
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toContain('Error: Target URL returned HTTP ' + status);
      expect(json.content).toBeNull();
    });

    it('returns an empty-string content for a 200 with an empty body', () => {
      installFetchOk('');
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe('');
    });

    it('returns content containing numeric character references verbatim (they are data, never decoded here)', () => {
      const content = '<p>&#x110000; &#1114112; &amp;</p>';
      installFetchOk(content);
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe(content);
    });

    it('returns content with lone surrogates byte-identically through the JSON round trip', () => {
      const content = 'a\ud800b\udfff c';
      installFetchOk(content);
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe(content);
    });

    it('returns content with NUL and control characters byte-identically', () => {
      const content = 'x\u0000y\u0001\u001fz';
      installFetchOk(content);
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe(content);
    });

    it('returns a huge body byte-identically', () => {
      const content = '<p>あ</p>'.repeat(100000); // ~1 MB of text
      installFetchOk(content);
      Code.doGet(authed);
      const json = lastJson();
      expect(json.error).toBeNull();
      expect(json.content).toBe(content);
    });
  });

  describe('auth deformities', () => {
    const authed = { parameter: { u: 'https://example.com', token: 'portfolio-token' } };

    it('fails closed when the configured token is an empty string', () => {
      installTokens({ TOKEN_PORTFOLIO: '', TOKEN_READER: '' });
      installFetchOk();
      Code.doGet({ parameter: { u: 'https://example.com', token: '' } });
      const json = lastJson();
      expect(json.error).toContain('Error: Unauthorized.');
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });

    it('answers with an error JSON when the token lookup throws an ordinary error', () => {
      global.PropertiesService = {
        getScriptProperties: () => ({
          getProperty: () => {
            throw new Error('Properties backend unavailable');
          }
        })
      };
      installFetchOk();
      expect(() => Code.doGet(authed)).not.toThrow();
      const json = lastJson();
      expect(json.error).toContain('Properties backend unavailable');
      expect(json.content).toBeNull();
      expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
    });
  });
});
