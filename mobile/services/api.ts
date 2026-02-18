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

// ─── Health ──────────────────────────────────────────

export async function healthCheck(): Promise<{ status: string; version: string }> {
  return request("/health");
}
