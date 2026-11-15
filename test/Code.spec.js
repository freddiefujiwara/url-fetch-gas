import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Code from '../src/Code.js';

describe('Code.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clean up globals
    delete global.UrlFetchApp;
    delete global.ContentService;
    delete global.PropertiesService;
    // Default: both client tokens are configured
    global.PropertiesService = {
      getScriptProperties: () => ({
        getProperty: (name) => ({ TOKEN_PORTFOLIO: 'portfolio-token', TOKEN_READER: 'reader-token' })[name] || null
      })
    };
  });

  describe('doGet', () => {
    it('should return 200 and content when valid URL is provided', () => {
      const targetUrl = 'https://example.com';
      // Mock UrlFetchApp
      const mockFetchResponse = {
        getResponseCode: vi.fn().mockReturnValue(200),
        getContentText: vi.fn().mockReturnValue('<html><body>Example</body></html>')
      };
      global.UrlFetchApp = {
        fetch: vi.fn().mockReturnValue(mockFetchResponse)
      };

      // Mock ContentService
      const mockTextOutput = {
        setMimeType: vi.fn().mockReturnThis()
      };
      global.ContentService = {
        createTextOutput: vi.fn().mockReturnValue(mockTextOutput),
        MimeType: { JSON: 'application/json' }
      };

      const e = {
        parameter: { u: targetUrl, token: 'portfolio-token' }
      };

      Code.doGet(e);

      expect(global.UrlFetchApp.fetch).toHaveBeenCalledWith(
        targetUrl,
        { muteHttpExceptions: true }
      );

      const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
      expect(jsonResponse.url).toBe(targetUrl);
      expect(jsonResponse.content).toBe('<html><body>Example</body></html>');
      expect(jsonResponse.error).toBeNull();
    });

    it('should return error when u parameter is missing', () => {
      global.ContentService = {
        createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn() }),
        MimeType: { JSON: 'application/json' }
      };

      const e = { parameter: {} };
      Code.doGet(e);

      const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
      expect(jsonResponse.error).toContain('Error: Missing required parameter: u');
    });

    it('should return error when URL format is invalid', () => {
      global.ContentService = {
        createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn() }),
        MimeType: { JSON: 'application/json' }
      };

      const e = { parameter: { u: 'ftp://invalid.com', token: 'portfolio-token' } };
      Code.doGet(e);

      const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
      expect(jsonResponse.error).toContain('Error: Invalid URL format');
    });

    it('should return error when target URL returns non-200 status', () => {
      const targetUrl = 'https://example.com/404';
      global.UrlFetchApp = {
        fetch: vi.fn().mockReturnValue({
          getResponseCode: vi.fn().mockReturnValue(404),
          getContentText: vi.fn().mockReturnValue('Not Found')
        })
      };
      global.ContentService = {
        createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn() }),
        MimeType: { JSON: 'application/json' }
      };

      const e = { parameter: { u: targetUrl, token: 'portfolio-token' } };
      Code.doGet(e);

      const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
      expect(jsonResponse.error).toContain('Error: Target URL returned HTTP 404');
    });

    it('should catch unexpected exceptions', () => {
      global.UrlFetchApp = {
        fetch: vi.fn().mockImplementation(() => {
          throw new Error('Network failure');
        })
      };
      global.ContentService = {
        createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn() }),
        MimeType: { JSON: 'application/json' }
      };

      const e = { parameter: { u: 'https://example.com', token: 'portfolio-token' } };
      Code.doGet(e);

      const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
      expect(jsonResponse.error).toContain('Error: Network failure');
    });

    it('should handle undefined event object', () => {
      global.ContentService = {
        createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn() }),
        MimeType: { JSON: 'application/json' }
      };

      Code.doGet(undefined);

      const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
      expect(jsonResponse.error).toContain('Error: Missing required parameter: u');
    });

    describe('client token authentication', () => {
      const setupFetchAndContent = () => {
        global.UrlFetchApp = {
          fetch: vi.fn().mockReturnValue({
            getResponseCode: vi.fn().mockReturnValue(200),
            getContentText: vi.fn().mockReturnValue('<html>ok</html>')
          })
        };
        global.ContentService = {
          createTextOutput: vi.fn().mockReturnValue({ setMimeType: vi.fn() }),
          MimeType: { JSON: 'application/json' }
        };
      };

      it('should reject a request without a token and not fetch', () => {
        setupFetchAndContent();

        Code.doGet({ parameter: { u: 'https://example.com' } });

        const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
        expect(jsonResponse.error).toContain('Error: Unauthorized.');
        expect(jsonResponse.content).toBeNull();
        expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
      });

      it('should reject a request with a wrong token and not fetch', () => {
        setupFetchAndContent();

        Code.doGet({ parameter: { u: 'https://example.com', token: 'wrong-token' } });

        const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
        expect(jsonResponse.error).toContain('Error: Unauthorized.');
        expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
      });

      it('should accept the reader token', () => {
        setupFetchAndContent();

        Code.doGet({ parameter: { u: 'https://example.com', token: 'reader-token' } });

        const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
        expect(jsonResponse.error).toBeNull();
        expect(jsonResponse.content).toBe('<html>ok</html>');
      });

      it('should reject every request when no token is configured (fail closed)', () => {
        setupFetchAndContent();
        global.PropertiesService = {
          getScriptProperties: () => ({
            getProperty: () => null
          })
        };

        Code.doGet({ parameter: { u: 'https://example.com', token: 'portfolio-token' } });

        const jsonResponse = JSON.parse(global.ContentService.createTextOutput.mock.calls[0][0]);
        expect(jsonResponse.error).toContain('Error: Unauthorized.');
        expect(global.UrlFetchApp.fetch).not.toHaveBeenCalled();
      });
    });
  });
});
