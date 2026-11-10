/**
 * Real profit per item.
 * - Sold: what actually landed (net after marketplace fees, which eBay auto-sync fills in)
 *   minus what the pairs/cards cost.
 * - Not sold yet: list price minus the marketplace's typical fees minus cost.
 * Fee rates are estimates for planning; real fees replace them once the sale syncs.
 */
import type { InventoryItem, Transaction } from "./api";

export interface FeeModel {
  label: string;
  /** Fee for one unit sold at `price`. */
  fee: (price: number) => number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export const FEE_MODELS: Record<string, FeeModel> = {
  // eBay sneakers $150+ : 8%, no per-order fee. Otherwise ~13.6% + $0.40.
  ebay: { label: "eBay", fee: (p) => round2(p >= 150 ? p * 0.08 : p * 0.136 + 0.4) },
  stockx: { label: "StockX", fee: (p) => round2(p * 0.12) }, // ~9% transaction + 3% processing
  goat: { label: "GOAT", fee: (p) => round2(p * 0.095 + 5 + p * 0.029) },
  tcgplayer: { label: "TCGplayer", fee: (p) => round2(p * 0.1075 + p * 0.025 + 0.3) },
  whatnot: { label: "Whatnot", fee: (p) => round2(p * 0.08 + p * 0.029 + 0.3) },
  card: { label: "card", fee: (p) => round2(p * 0.029 + 0.3) },
};

export function feeModelFor(platform?: string | null): FeeModel | null {
  const p = (platform ?? "").toLowerCase();
  if (!p) return null;
  for (const key of Object.keys(FEE_MODELS)) {
    if (p.includes(key)) return FEE_MODELS[key];
  }
  if (/stripe|square|clover|card/.test(p)) return FEE_MODELS.card;
  return null; // in person / cash: no fees
}

export type SaleLike = Pick<Transaction, "status" | "is_refund" | "gross_amount" | "fee_amount" | "net_amount" | "quantity"> & {
  cost_amount?: string | null;
};

export interface ProfitView {
  kind: "realized" | "estimate";
  profit: number;
  fees: number;
  cost: number;
  revenue: number;
  /** Short explanation under the number, e.g. "after $26 eBay fees". */
  note: string;
  roi: number | null;
}

const num = (v?: string | number | null) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function itemProfit(
  item: Pick<InventoryItem, "buy_price" | "expected_sell_price" | "platform">,
  sales: SaleLike[] = [],
): ProfitView {
  const unitCost = num(item.buy_price);
  const sold = sales.filter((t) => !t.is_refund && t.status !== "refunded" && t.status !== "voided");
  if (sold.length) {
    let revenue = 0;
    let fees = 0;
    let cost = 0;
    for (const t of sold) {
      // Same rule as the dashboard: profit = net (gross after fees) - cost of goods.
      revenue += num(t.gross_amount);
      fees += num(t.fee_amount);
      cost += t.cost_amount != null ? num(t.cost_amount) : unitCost * (t.quantity || 1);
    }
    const profit = round2(revenue - fees - cost);
    return {
      kind: "realized",
      profit,
      fees: round2(fees),
      cost: round2(cost),
      revenue: round2(revenue),
      note: fees > 0 ? `after $${Math.round(fees)} in fees` : "no fees recorded",
      roi: cost > 0 ? Math.round((profit / cost) * 100) : null,
    };
  }
  const list = num(item.expected_sell_price);
  const model = feeModelFor(item.platform);
  const fees = model && list > 0 ? model.fee(list) : 0;
  const profit = round2(list - fees - unitCost);
  return {
    kind: "estimate",
    profit,
    fees,
    cost: unitCost,
    revenue: list,
    note: model ? `est. after $${Math.round(fees)} ${model.label} fees` : "before fees",
    roi: unitCost > 0 ? Math.round((profit / unitCost) * 100) : null,
  };
}
