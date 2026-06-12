// Stripe クライアント（Deno / Edge Functions 用）

import Stripe from "npm:stripe@17";

export const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", {
  // Deno には Node の http がないため fetch ベースのクライアントを使う
  httpClient: Stripe.createFetchHttpClient(),
});

/** webhook 署名検証用（SubtleCrypto ベース・非同期） */
export const stripeCryptoProvider = Stripe.createSubtleCryptoProvider();

export type PaidPlan = "standard" | "premium";
export type Interval = "monthly" | "yearly";

/** プラン×期間 → Price ID（環境変数で注入） */
export function priceIdFor(plan: PaidPlan, interval: Interval): string | null {
  const key = {
    "standard:monthly": "STRIPE_PRICE_STANDARD_MONTHLY",
    "standard:yearly": "STRIPE_PRICE_STANDARD_YEARLY",
    "premium:monthly": "STRIPE_PRICE_PREMIUM_MONTHLY",
    "premium:yearly": "STRIPE_PRICE_PREMIUM_YEARLY",
  }[`${plan}:${interval}`];
  if (!key) return null;
  return Deno.env.get(key) ?? null;
}

/** Price ID → プラン（webhook 側で使う逆引き） */
export function planForPriceId(priceId: string): PaidPlan | null {
  const map: Record<string, PaidPlan> = {};
  for (const [env, plan] of [
    ["STRIPE_PRICE_STANDARD_MONTHLY", "standard"],
    ["STRIPE_PRICE_STANDARD_YEARLY", "standard"],
    ["STRIPE_PRICE_PREMIUM_MONTHLY", "premium"],
    ["STRIPE_PRICE_PREMIUM_YEARLY", "premium"],
  ] as const) {
    const id = Deno.env.get(env);
    if (id) map[id] = plan;
  }
  return map[priceId] ?? null;
}
