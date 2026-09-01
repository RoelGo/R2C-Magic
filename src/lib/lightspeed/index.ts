/**
 * Lightspeed Retail integration (spec v2 Slice F). This first slice covers the
 * OAuth connection only — obtaining, storing, and refreshing a Retail API
 * token. The actual product push (US-F1/F2/F3) builds on top of
 * `getValidAccessToken()` in a later slice.
 */
export {
  disconnect,
  getConnectionStatus,
  getOAuthClient,
  getValidAccessToken,
  isLightspeedConfigured,
  saveTokens,
  type LightspeedConnectionStatus,
} from "./connection";
export {
  OAuthError,
  buildAuthorizeUrl,
  createPkce,
  createState,
  exchangeCodeForTokens,
} from "./oauth";
