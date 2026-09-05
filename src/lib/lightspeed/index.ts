/**
 * Lightspeed Retail integration (spec v2 Slice F). Covers the OAuth connection
 * (obtain/store/refresh a Retail API token) and the product push (US-F1/F2):
 * finding an item by EAN, updating its content, and uploading cover images.
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
export {
  RetailApiError,
  createItem,
  findItemByEan,
  retailBaseUrl,
  updateItem,
  uploadItemImage,
  type CreateItemPayload,
  type ImageUpload,
  type ItemUpdatePayload,
  type RetailClient,
  type RetailItem,
} from "./api";
export {
  buildItemUpdate,
  pushBookToRetail,
  type PushImage,
  type PushInput,
  type PushResult,
} from "./push";
