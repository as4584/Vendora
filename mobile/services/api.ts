/**
 * Vendora API Service
 *
 * Centralized HTTP client for communicating with the FastAPI backend.
 * All endpoints go through /api/v1/.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const API_BASE_URL = __DEV__
  ? "http://10.0.2.2:8000/api/v1" // Android emulator → localhost
  : "https://api.vendora.app/api/v1";

const TOKEN_KEY = "vendora_access_token";

// ─── Token Management ────────────────────────────────

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

// ─── HTTP Helpers ────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = await getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const data = await response.json();

  if (!response.ok) {
    const message =
      typeof data.detail === "string"
        ? data.detail
        : data.detail?.message || `Request failed (${response.status})`;
    throw new ApiError(message, response.status, data.detail);
  }

  return data as T;
}

export class ApiError extends Error {
  status: number;
  detail: any;
  constructor(message: string, status: number, detail?: any) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ─── Auth Endpoints ──────────────────────────────────

export interface User {
  id: string;
  email: string;
  business_name: string | null;
  subscription_tier: string;
  is_partner: boolean;
  created_at: string;
  updated_at: string;
}

export interface TokenResponse {
  access_token: string;
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

export async function getMe(): Promise<User> {
  return request<User>("/auth/me");
}

// ─── Inventory Endpoints ─────────────────────────────

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
  created_at: string;
  updated_at: string;
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
}

export async function listItems(
  page = 1,
  perPage = 20
): Promise<PaginatedItems> {
  return request<PaginatedItems>(
    `/inventory?page=${page}&per_page=${perPage}`
  );
}

export async function getItem(id: string): Promise<InventoryItem> {
  return request<InventoryItem>(`/inventory/${id}`);
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

// ─── Transaction Endpoints ───────────────────────────

export interface Transaction {
  id: string;
  user_id: string;
  item_id: string | null;
  method: string;
  status: string;
  gross_amount: string;
  fee_amount: string;
  net_amount: string;
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
  page = 1,
  perPage = 20
): Promise<PaginatedTransactions> {
  return request<PaginatedTransactions>(
    `/transactions?page=${page}&per_page=${perPage}`
  );
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
  page = 1,
  perPage = 20
): Promise<PaginatedInvoices> {
  return request<PaginatedInvoices>(
    `/invoices?page=${page}&per_page=${perPage}`
  );
}

export async function getInvoice(id: string): Promise<InvoiceData> {
  return request<InvoiceData>(`/invoices/${id}`);
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

// ─── Export ──────────────────────────────────────────

export async function exportInventoryCSV(): Promise<string> {
  return request<string>("/export/inventory");
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

// ─── Health ──────────────────────────────────────────

export async function healthCheck(): Promise<{ status: string; version: string }> {
  return request("/health");
}
