/**
 * Vendora API Service
 *
 * Centralized HTTP client for communicating with the FastAPI backend.
 * All endpoints go through /api/v1/.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://vendora.lexmakesit.com/api/v1";

const TOKEN_KEY = "vendora_access_token";
const REFRESH_TOKEN_KEY = "vendora_refresh_token";

async function secureStorageAvailable(): Promise<boolean> {
  return Platform.OS !== "web" && (await SecureStore.isAvailableAsync());
}

async function readSecret(key: string): Promise<string | null> {
  if (await secureStorageAvailable()) return SecureStore.getItemAsync(key);
  return AsyncStorage.getItem(key);
}

async function writeSecret(key: string, value: string): Promise<void> {
  if (await secureStorageAvailable()) {
    await SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

async function deleteSecret(key: string): Promise<void> {
  if (await secureStorageAvailable()) await SecureStore.deleteItemAsync(key);
  await AsyncStorage.removeItem(key);
}

// ─── Global 401 handler ─────────────────────────────
// Set by AuthProvider so any expired-token API call auto-signs out.
type UnauthorizedHandler = () => void;
let _unauthorizedHandler: UnauthorizedHandler | null = null;

export function onUnauthorized(handler: UnauthorizedHandler): void {
  _unauthorizedHandler = handler;
}

// ─── Token Management ────────────────────────────────

export async function getToken(): Promise<string | null> {
  return readSecret(TOKEN_KEY);
}

export async function getRefreshToken(): Promise<string | null> {
  return readSecret(REFRESH_TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await writeSecret(TOKEN_KEY, token);
}

export async function setSession(accessToken: string, refreshToken: string): Promise<void> {
  await Promise.all([
    writeSecret(TOKEN_KEY, accessToken),
    writeSecret(REFRESH_TOKEN_KEY, refreshToken),
  ]);
}

export async function clearToken(): Promise<void> {
  await Promise.all([deleteSecret(TOKEN_KEY), deleteSecret(REFRESH_TOKEN_KEY)]);
}

// ─── HTTP Helpers ────────────────────────────────────

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const refreshToken = await getRefreshToken();
    if (!refreshToken) return false;
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!response.ok) return false;
      const session = (await response.json()) as TokenResponse;
      await setSession(session.access_token, session.refresh_token);
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  allowRefresh = true,
): Promise<T> {
  const token = await getToken();
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (!isFormData && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type");
  const isJson = contentType && contentType.includes("application/json");

  let data: any;

  if (isJson) {
    try {
      const text = await response.text();
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      console.error("Failed to parse JSON response:", e);
      throw new Error("Invalid JSON response from server");
    }
  } else {
    // Non-JSON response (e.g. 500 HTML error or 404 text)
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(text || `Request failed (${response.status})`, response.status);
    }
    // If OK but not JSON (e.g. text/csv, 204 empty), return text content
    return text as unknown as T;
  }

  if (!response.ok) {
    const message =
      typeof data.detail === "string"
        ? data.detail
        : data?.detail?.message || `Request failed (${response.status})`;
    if (response.status === 401) {
      // Token expired or invalid — clear storage and notify auth context.
      if (allowRefresh && (!path.startsWith("/auth/") || path === "/auth/me")) {
        const refreshed = await refreshAccessToken();
        if (refreshed) return request<T>(path, options, false);
      }
      await clearToken();
      _unauthorizedHandler?.();
    }
    throw new ApiError(message, response.status, data?.detail);
  }

  return data as T;
}

export class ApiError extends Error {
  status: number;
  detail: any;
  constructor(message: string, status: number, detail?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

// ─── Auth Endpoints ──────────────────────────────────

export interface User {
  id: string;
  email: string;
  business_name: string | null;
  profile_picture: string | null;  // base64 data URL
  subscription_tier: string;
  is_partner: boolean;
  created_at: string;
  updated_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export async function register(
  email: string,
  password: string,
  businessName?: string
): Promise<User> {
  return request<User>("/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      business_name: businessName || null,
    }),
  });
}

export async function login(
  email: string,
  password: string
): Promise<TokenResponse> {
  return request<TokenResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function logoutSession(): Promise<void> {
  const refreshToken = await getRefreshToken();
  if (refreshToken) {
    try {
      await request<{ message: string }>("/auth/logout", {
        method: "POST",
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // Local credential removal remains authoritative when offline.
    }
  }
  await clearToken();
}

export async function deleteAccount(password: string): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/account", {
    method: "DELETE",
    body: JSON.stringify({ password, confirmation: "DELETE" }),
  });
}

export async function requestPasswordReset(
  email: string
): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPassword(
  token: string,
  password: string
): Promise<{ message: string }> {
  return request<{ message: string }>("/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, password }),
  });
}

export async function getMe(): Promise<User> {
  return request<User>("/auth/me");
}

export async function updateProfile(
  businessName?: string | null,
  profilePicture?: string | null
): Promise<User> {
  return request<User>("/auth/profile", {
    method: "PATCH",
    body: JSON.stringify({
      business_name: businessName,
      profile_picture: profilePicture,
    }),
  });
}

export interface InvoicePdfResponse {
  pdf_base64: string;
  filename: string;
}

export async function exportInvoicePdf(
  invoiceId: string
): Promise<InvoicePdfResponse> {
  return request<InvoicePdfResponse>(`/invoices/${invoiceId}/pdf`);
}

// ─── Inventory Endpoints ─────────────────────────────

/** A single size/quantity pair for clothing variants. */
export interface SizeVariant {
  size: string;
  quantity: number;
}

export interface InventoryItem {
  id: string;
  user_id: string;
  name: string;
  category: string | null;
  sku: string | null;
  upc: string | null;
  size: string | null;
  color: string | null;
  condition: string | null;
  serial_number: string | null;
  custom_attributes: Record<string, any> | null;
  buy_price: string | null;
  expected_sell_price: string | null;
  actual_sell_price: string | null;
  platform: string | null;
  status: string;
  photo_front_url: string | null;
  photo_back_url: string | null;
  quantity: number;
  vendor_name: string | null;
  notes: string | null;
  source: string | null;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InventoryActivityEntry {
  id: string;
  inventory_item_id: string;
  delta_quantity: number;
  quantity_after: number;
  event_type: string;
  source_type: string | null;
  source_id: string | null;
  created_at: string;
}

export interface PaginatedItems {
  items: InventoryItem[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface CreateItemPayload {
  name: string;
  category?: string;
  sku?: string;
  upc?: string;
  size?: string;
  color?: string;
  condition?: string;
  serial_number?: string;
  custom_attributes?: Record<string, any>;
  buy_price?: string;
  expected_sell_price?: string;
  actual_sell_price?: string;
  platform?: string;
  quantity?: number;
  vendor_name?: string;
  notes?: string;
}

export interface ListItemsParams {
  page?: number;
  perPage?: number;
  q?: string;
  status?: string;
  source?: string;
  availableOnly?: boolean;
}

export async function listItems(
  pageOrParams: number | ListItemsParams = 1,
  perPage = 20
): Promise<PaginatedItems> {
  let page: number;
  let params: ListItemsParams;

  if (typeof pageOrParams === "number") {
    page = pageOrParams;
    params = { page, perPage };
  } else {
    params = pageOrParams;
    page = params.page ?? 1;
    perPage = params.perPage ?? 20;
  }

  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("per_page", String(perPage));
  if (params.q) qs.set("q", params.q);
  if (params.status) qs.set("status", params.status);
  if (params.source) qs.set("source", params.source);
  if (params.availableOnly) qs.set("available_only", "true");

  return request<PaginatedItems>(`/inventory?${qs.toString()}`);
}

export async function getItem(id: string): Promise<InventoryItem> {
  return request<InventoryItem>(`/inventory/${id}`);
}

export async function getItemActivity(
  id: string,
  limit = 25
): Promise<InventoryActivityEntry[]> {
  return request<InventoryActivityEntry[]>(`/inventory/${id}/activity?limit=${limit}`);
}

export async function createItem(
  payload: CreateItemPayload
): Promise<InventoryItem> {
  return request<InventoryItem>("/inventory", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateItem(
  id: string,
  payload: Partial<CreateItemPayload>
): Promise<InventoryItem> {
  return request<InventoryItem>(`/inventory/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function deleteItem(id: string): Promise<void> {
  return request<void>(`/inventory/${id}`, { method: "DELETE" });
}

export async function updateItemStatus(
  id: string,
  status: string
): Promise<InventoryItem> {
  return request<InventoryItem>(`/inventory/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

/**
 * Upload front and/or back photos for an inventory item.
 * Each photo should be a base64 data URL (e.g. "data:image/jpeg;base64,...").
 */
export async function uploadItemPhotos(
  id: string,
  photoFront?: string | null,
  photoBack?: string | null
): Promise<InventoryItem> {
  return request<InventoryItem>(`/inventory/${id}/photos`, {
    method: "PATCH",
    body: JSON.stringify({
      photo_front: photoFront ?? null,
      photo_back: photoBack ?? null,
    }),
  });
}

/**
 * Save size variants for a clothing item.
 * Variants are stored in custom_attributes.variants.
 */
export async function updateItemVariants(
  id: string,
  variants: SizeVariant[]
): Promise<InventoryItem> {
  const item = await getItem(id);
  const existing = item.custom_attributes ?? {};
  return updateItem(id, {
    custom_attributes: { ...existing, variants },
  });
}

export interface ImportPreviewRow {
  row_number: number;
  action: string | null;
  inventory_item_id: string | null;
  mapped_data: Record<string, any> | null;
  match_key: string | null;
  match_value: string | null;
  error_message: string | null;
}

export interface InventoryImportPreview {
  job_id: string;
  status: string;
  filename: string | null;
  detected_mapping: Record<string, string>;
  rows: ImportPreviewRow[];
  total_rows: number;
  rows_to_create: number;
  rows_to_update: number;
  rows_to_skip: number;
  rows_errored: number;
}

export interface InventoryImportCommit {
  job_id: string;
  status: string;
  rows_created: number;
  rows_updated: number;
  rows_skipped: number;
  rows_errored: number;
}

export interface InventoryImportIssue {
  row: number;
  message: string;
}

export interface InventoryImportResult {
  dry_run: boolean;
  rows_seen: number;
  rows_importable: number;
  created: number;
  updated: number;
  skipped: number;
  errors: InventoryImportIssue[];
  warnings: InventoryImportIssue[];
  sample_items: Record<string, any>[];
}

export async function previewInventoryImport(
  formData: FormData
): Promise<InventoryImportPreview> {
  return request<InventoryImportPreview>("/inventory/imports/preview", {
    method: "POST",
    body: formData,
  });
}

export async function importInventoryFromLink(
  url: string,
  dryRun = false
): Promise<InventoryImportResult> {
  const payload = {
    method: "POST",
    body: JSON.stringify({
      url,
      dry_run: dryRun,
      source_name: "mobile-link",
    }),
  };

  try {
    return await request<InventoryImportResult>("/inventory/import", payload);
  } catch (error) {
    if (
      !dryRun &&
      error instanceof ApiError &&
      [502, 503, 504].includes(error.status)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return request<InventoryImportResult>("/inventory/import", payload);
    }
    throw error;
  }
}

export async function importInventoryFile(
  file: { uri: string; name: string; mimeType?: string },
  dryRun = false
): Promise<InventoryImportResult> {
  const formData = new FormData();
  formData.append("file", {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || "text/csv",
  } as any);

  return request<InventoryImportResult>(
    `/inventory/import/file?dry_run=${dryRun ? "true" : "false"}`,
    {
      method: "POST",
      body: formData,
    }
  );
}

export async function commitInventoryImport(
  jobId: string
): Promise<InventoryImportCommit> {
  return request<InventoryImportCommit>(`/inventory/imports/${jobId}/commit`, {
    method: "POST",
  });
}

// ─── Transaction Endpoints ───────────────────────────

export interface Transaction {
  id: string;
  user_id: string;
  item_id: string | null;
  invoice_id: string | null;
  method: string;
  status: string;
  gross_amount: string;
  fee_amount: string;
  net_amount: string;
  quantity: number;
  external_reference_id: string | null;
  notes: string | null;
  is_refund: boolean;
  original_transaction_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaginatedTransactions {
  items: Transaction[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface CreateTransactionPayload {
  item_id?: string;
  method: string;
  gross_amount: string;
  fee_amount?: string;
  quantity?: number;
  external_reference_id?: string;
  notes?: string;
}

export async function createTransaction(
  payload: CreateTransactionPayload
): Promise<Transaction> {
  return request<Transaction>("/transactions", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listTransactions(
  pageOrParams: number | { page?: number; perPage?: number; itemId?: string } = 1,
  perPage = 20
): Promise<PaginatedTransactions> {
  let page = 1;
  let itemId: string | undefined;
  if (typeof pageOrParams === "number") {
    page = pageOrParams;
  } else {
    page = pageOrParams.page ?? 1;
    perPage = pageOrParams.perPage ?? 20;
    itemId = pageOrParams.itemId;
  }

  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("per_page", String(perPage));
  if (itemId) qs.set("item_id", itemId);
  return request<PaginatedTransactions>(`/transactions?${qs.toString()}`);
}

export async function getTransaction(id: string): Promise<Transaction> {
  return request<Transaction>(`/transactions/${id}`);
}

export async function refundTransaction(
  id: string,
  reason?: string
): Promise<Transaction> {
  return request<Transaction>(`/transactions/${id}/refund`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || null }),
  });
}

// ─── Dashboard Endpoints ─────────────────────────────

export interface Dashboard {
  revenue_today: string;
  revenue_week: string;
  revenue_month: string;
  net_profit_today: string;
  net_profit_week: string;
  net_profit_month: string;
  net_profit_all_time: string;
  total_inventory_value: string;
  total_expected_value: string;
  potential_profit: string;
  total_items: number;
  items_in_stock: number;
  items_listed: number;
  items_sold: number;
  total_transactions: number;
  total_refunds: number;
}

export async function getDashboard(): Promise<Dashboard> {
  return request<Dashboard>("/dashboard");
}

// ─── Invoice Endpoints ───────────────────────────────

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  inventory_item_id: string | null;
  size_label: string | null;
  description: string;
  quantity: number;
  unit_price: string;
  line_total: string;
}

export interface InvoiceData {
  id: string;
  user_id: string;
  customer_name: string;
  customer_email: string | null;
  status: string;
  subtotal: string;
  tax: string;
  shipping: string;
  discount: string;
  total: string;
  stripe_payment_intent_id: string | null;
  notes: string | null;
  items: InvoiceItem[];
  created_at: string;
  updated_at: string;
}

export interface PaginatedInvoices {
  items: InvoiceData[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface CreateInvoicePayload {
  customer_name: string;
  customer_email?: string;
  items: {
    inventory_item_id?: string;
    size_label?: string;
    description: string;
    quantity: number;
    unit_price: string;
  }[];
  tax?: string;
  shipping?: string;
  discount?: string;
  notes?: string;
}

export interface UpdateInvoicePayload {
  customer_name: string;
  customer_email?: string;
  items: {
    inventory_item_id?: string;
    size_label?: string;
    description: string;
    quantity: number;
    unit_price: string;
  }[];
  tax?: string;
  shipping?: string;
  discount?: string;
  notes?: string;
}

export async function createInvoice(
  payload: CreateInvoicePayload
): Promise<InvoiceData> {
  return request<InvoiceData>("/invoices", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listInvoices(
  pageOrParams:
    | number
    | { page?: number; perPage?: number; status?: string; inventoryItemId?: string } = 1,
  perPage = 20
): Promise<PaginatedInvoices> {
  let page = 1;
  let status: string | undefined;
  let inventoryItemId: string | undefined;
  if (typeof pageOrParams === "number") {
    page = pageOrParams;
  } else {
    page = pageOrParams.page ?? 1;
    perPage = pageOrParams.perPage ?? 20;
    status = pageOrParams.status;
    inventoryItemId = pageOrParams.inventoryItemId;
  }

  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("per_page", String(perPage));
  if (status) qs.set("status", status);
  if (inventoryItemId) qs.set("inventory_item_id", inventoryItemId);
  return request<PaginatedInvoices>(`/invoices?${qs.toString()}`);
}

export async function getInvoice(id: string): Promise<InvoiceData> {
  return request<InvoiceData>(`/invoices/${id}`);
}

export async function updateInvoice(
  id: string,
  payload: UpdateInvoicePayload
): Promise<InvoiceData> {
  return request<InvoiceData>(`/invoices/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function updateInvoiceStatus(
  id: string,
  status: string
): Promise<InvoiceData> {
  return request<InvoiceData>(`/invoices/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}
// ─── Feature Flags ───────────────────────────────────

export interface FeatureFlags {
  tier: string;
  is_partner: boolean;
  features: Record<string, boolean>;
}

export interface TierInfo {
  name: string;
  price: number;
  item_limit: number | null;
  features: string[];
}

export interface TiersResponse {
  tiers: { free: TierInfo; pro: TierInfo };
  partner_addon: { price: number; requires: string; features: string[] };
}

export async function getFeatureFlags(): Promise<FeatureFlags> {
  return request<FeatureFlags>("/features");
}

export async function getTiers(): Promise<TiersResponse> {
  return request<TiersResponse>("/features/tiers");
}

export interface SubscriptionStatus {
  tier: string;
  is_partner: boolean;
  status: string;
  current_period_end: string | null;
  managed_billing: boolean;
}

export async function getSubscriptionStatus(): Promise<SubscriptionStatus> {
  return request<SubscriptionStatus>("/subscriptions/me");
}

export async function createSubscriptionCheckout(plan: "pro" | "partner"): Promise<{ checkout_url: string; session_id: string }> {
  return request("/subscriptions/checkout", { method: "POST", body: JSON.stringify({ plan }) });
}

export async function createBillingPortal(): Promise<{ portal_url: string }> {
  return request("/subscriptions/portal", { method: "POST" });
}

export async function submitSupportRequest(subject: string, message: string): Promise<{
  id: string;
  status: string;
  priority: string;
  email_queued: boolean;
}> {
  return request("/support", { method: "POST", body: JSON.stringify({ subject, message }) });
}

// ─── Export ──────────────────────────────────────────

export async function exportInventoryCSV(): Promise<string> {
  return request<string>("/export/inventory");
}

export async function exportInventoryWarehouseCSV(): Promise<string> {
  return request<string>("/export/inventory?template=warehouse");
}

export async function exportTransactionsCSV(): Promise<string> {
  return request<string>("/export/transactions");
}

// ─── Public Seller Page ──────────────────────────────

export interface SellerProfile {
  seller: {
    id: string;
    business_name: string;
    is_partner: boolean;
    verified: boolean;
    member_since: string | null;
  };
  stats: {
    total_items: number;
    items_sold: number;
    total_transactions: number;
  };
  listings: {
    id: string;
    name: string;
    category: string | null;
    size: string | null;
    color: string | null;
    condition: string | null;
    price: string | null;
    status: string;
  }[];
  disclaimer: string;
}

export async function getSellerProfile(
  userId: string
): Promise<SellerProfile> {
  return request<SellerProfile>(`/sellers/${userId}`);
}

// ─── Market Price + Pricing ──────────────────────────

export interface MarketPriceSource {
  source: string;
  price: number | null;
  label: string;
  low?: number;
  high?: number;
  avg?: number;
  count?: number;
}

export interface MarketPriceResult {
  query: string;
  upc: string | null;
  product_info: {
    title: string | null;
    brand: string | null;
    description: string | null;
    image_url: string | null;
    lowest_price: number | null;
    highest_price: number | null;
  } | null;
  sources: MarketPriceSource[];
  internal_history: {
    avg_sold_price: number | null;
    sample_count: number;
  };
}

export interface PricingSuggestion {
  item_id: string;
  suggested_price: number | null;
  reason: string;
  confidence: "high" | "medium" | "low";
  basis: string;
}

export async function getMarketPrice(
  query: string,
  upc?: string
): Promise<MarketPriceResult> {
  const params = new URLSearchParams({ query });
  if (upc) params.append("upc", upc);
  return request<MarketPriceResult>(`/inventory/market-price?${params}`);
}

export async function getPricingSuggestion(
  itemId: string
): Promise<PricingSuggestion> {
  return request<PricingSuggestion>(`/inventory/${itemId}/pricing-suggestion`);
}

export interface AdvancedAnalytics {
  period_days: number;
  revenue: string;
  net: string;
  average_order_value: string;
  sell_through_rate: string;
  daily: { date: string; revenue: string; net: string; transactions: number }[];
  categories: { category: string; revenue: string; units_sold: number }[];
}

export async function getAdvancedAnalytics(days = 30): Promise<AdvancedAnalytics> {
  return request<AdvancedAnalytics>(`/dashboard/advanced?days=${days}`);
}

// ─── Lightspeed Integration ──────────────────────────

export interface LightspeedStatus {
  connected: boolean;
  account_id: string | null;
  expires_at: string | null;
  last_synced_at: string | null;
}

export async function getLightspeedStatus(): Promise<LightspeedStatus> {
  return request<LightspeedStatus>("/integrations/lightspeed/status");
}

export async function getLightspeedConnectUrl(): Promise<{ authorization_url: string }> {
  return request<{ authorization_url: string }>("/integrations/lightspeed/connect");
}

export async function triggerLightspeedSync(): Promise<{
  status: string;
  run_id: string;
  items_imported: number;
  items_updated: number;
  items_skipped: number;
  transactions_imported: number;
  transactions_updated: number;
  errors_count: number;
}> {
  return request("/integrations/lightspeed/sync", { method: "POST" });
}

export async function pushLightspeedInventory(): Promise<{ status: string; items_created: number; items_updated: number; errors_count: number }> {
  return request("/integrations/lightspeed/push", { method: "POST" });
}

export async function pushItemToLightspeed(itemId: string): Promise<{ status: string; items_created: number; items_updated: number; errors_count: number }> {
  return request(`/integrations/lightspeed/items/${itemId}/push`, { method: "POST" });
}

export async function disconnectLightspeed(): Promise<{ disconnected: boolean; links_retained: number }> {
  return request("/integrations/lightspeed", { method: "DELETE" });
}

// ─── Square Integration ───────────────────────────────

export interface SquareStatus {
  connected: boolean;
  merchant_id: string | null;
  location_id: string | null;
  last_synced_at: string | null;
}

export async function getSquareStatus(): Promise<SquareStatus> {
  return request<SquareStatus>("/integrations/square/status");
}

export async function connectSquare(body: {
  access_token: string;
  merchant_id?: string;
  location_id?: string;
}): Promise<{ message: string; merchant_id: string | null; location_id: string | null }> {
  return request("/integrations/square/connect", { method: "POST", body: JSON.stringify(body) });
}

export async function triggerSquareSync(): Promise<{
  status: string;
  run_id: string;
  items_imported: number;
  items_updated: number;
  items_skipped: number;
  transactions_imported: number;
  transactions_updated: number;
  errors_count: number;
}> {
  return request("/integrations/square/sync", { method: "POST" });
}

// ─── Clover Integration ───────────────────────────────

export interface CloverStatus {
  connected: boolean;
  merchant_id: string | null;
  last_synced_at: string | null;
}

export async function getCloverStatus(): Promise<CloverStatus> {
  return request<CloverStatus>("/integrations/clover/status");
}

export async function connectClover(body: {
  merchant_id: string;
  access_token: string;
}): Promise<{ message: string; merchant_id: string }> {
  return request("/integrations/clover/connect", { method: "POST", body: JSON.stringify(body) });
}

export async function triggerCloverSync(): Promise<{
  status: string;
  run_id: string;
  items_imported: number;
  items_updated: number;
  items_skipped: number;
  transactions_imported: number;
  transactions_updated: number;
  errors_count: number;
}> {
  return request("/integrations/clover/sync", { method: "POST" });
}

// ─── Provider Health ──────────────────────────────────

export interface ProviderHealthEntry {
  provider: string;
  last_run_at: string | null;
  last_run_status: string | null;
  failed_runs_24h: number;
  open_issues_count: number;
}

export async function getProviderHealth(): Promise<{ providers: ProviderHealthEntry[] }> {
  return request<{ providers: ProviderHealthEntry[] }>("/integrations/health");
}

export interface ProviderSyncRun {
  id: string;
  provider: string;
  user_id: string;
  account_id: string | null;
  started_at: string;
  completed_at: string | null;
  status: string;
  trigger_type: string;
  items_imported: number;
  items_updated: number;
  items_skipped: number;
  transactions_imported: number;
  transactions_updated: number;
  errors_count: number;
  error_message: string | null;
}

export interface ReconciliationIssue {
  id: string;
  provider: string;
  user_id: string;
  inventory_item_id: string | null;
  sync_run_id: string | null;
  external_id: string | null;
  issue_type: string;
  severity: string;
  status: string;
  details: Record<string, any> | null;
  detected_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
}

export async function listSyncRuns(params?: {
  provider?: string;
  limit?: number;
}): Promise<ProviderSyncRun[]> {
  const qs = new URLSearchParams();
  if (params?.provider) qs.set("provider", params.provider);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<ProviderSyncRun[]>(`/integrations/sync-runs${suffix}`);
}

export async function retrySyncRun(runId: string): Promise<{
  message: string;
  new_run_id: string;
  status: string;
  items_imported: number;
  items_updated: number;
  errors_count: number;
}> {
  return request(`/integrations/sync-runs/${runId}/retry`, { method: "POST" });
}

export async function listReconciliationIssues(params?: {
  provider?: string;
  status?: string;
  limit?: number;
}): Promise<ReconciliationIssue[]> {
  const qs = new URLSearchParams();
  if (params?.provider) qs.set("provider", params.provider);
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request<ReconciliationIssue[]>(`/integrations/reconciliation-issues${suffix}`);
}

export async function updateReconciliationIssue(
  issueId: string,
  body: { status: "resolved" | "dismissed"; resolution_note?: string }
): Promise<ReconciliationIssue> {
  return request<ReconciliationIssue>(`/integrations/reconciliation-issues/${issueId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ─── App Health ──────────────────────────────────────────

export async function healthCheck(): Promise<{ status: string; version: string }> {
  return request("/health");
}
