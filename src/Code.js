/**
 * Script property names that hold the accepted client tokens.
 * Each client gets its own token so that one can be rotated or
 * revoked without affecting the other client.
 */
const TOKEN_PROPERTY_NAMES = ['TOKEN_PORTFOLIO', 'TOKEN_READER'];

/**
 * Checks whether the given token matches one of the client tokens
 * stored in the script properties.
 * Fails closed: when no token is configured, every request is rejected.
 *
 * @param {string} token The token supplied by the client.
 * @returns {boolean} True when the token is accepted.
 */
function isAuthorized(token) {
  if (!token) {
    return false;
  }
  const properties = PropertiesService.getScriptProperties();
  return TOKEN_PROPERTY_NAMES.some(function (name) {
    const expected = properties.getProperty(name);
    return !!expected && token === expected;
  });
}

/**
 * Handles GET requests to the web app.
 * Fetches the HTML content of a given URL.
 *
 * @param {Object} e The event object from GAS.
 * @param {Object} e.parameter Query parameters.
 * @param {string} e.parameter.u The target URL to fetch.
 * @param {string} e.parameter.token The client token.
 * @returns {GoogleAppsScript.Content.TextOutput} JSON response.
 */
function doGet(e) {
  const result = {
    url: null,
    content: null,
    error: null
  };

  try {
    const params = (e && e.parameter) || {};

    // 1. Get URL from query parameter 'u'
    const url = params.u;
    if (!url) {
      throw new Error('Missing required parameter: u');
    }
    result.url = url;

    // 2. Authenticate the client token before fetching anything
    if (!isAuthorized(params.token)) {
      throw new Error('Unauthorized.');
    }

    // 3. Validate URL format
    if (!/^https?:\/\/.+/.test(url)) {
      throw new Error('Invalid URL format. Must start with http:// or https://');
    }

    // 4. Fetch data from the provided URL
    const fetchResponse = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true
    });

    // 5. Check response status
    const responseCode = fetchResponse.getResponseCode();
    if (responseCode !== 200) {
      throw new Error('Target URL returned HTTP ' + responseCode);
    }

    // 6. Set the content
    result.content = fetchResponse.getContentText();
  } catch (error) {
    // 7. Handle errors
    result.error = error.toString();
  }

  // 8. Return structured JSON response
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// Export for testing in Node.js environment
if (typeof exports !== 'undefined') {
  exports.doGet = doGet;
}
