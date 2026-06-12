// create-checkout-session
//
// ログイン済みユーザーの JWT を検証し、Stripe Checkout（subscription モード）
// のセッションを作って URL を返す。
//
// リクエスト body: { "plan": "standard" | "premium", "interval": "monthly" | "yearly" }
//   Price ID をクライアントから受け取らず、サーバー側の環境変数で解決する
//   （クライアント改ざんで任意の Price を購入される事故を防ぐ）。
//
// レスポンス: { "url": "https://checkout.stripe.com/..." }

import {
  errorResponse,
  jsonResponse,
  preflightResponse,
} from "../_shared/cors.ts";
import { getUserFromRequest, serviceClient } from "../_shared/billing.ts";
import { priceIdFor, stripe } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse();
  if (req.method !== "POST") {
    return errorResponse(405, "method_not_allowed", "POST のみ対応しています");
  }

  // 1. JWT 検証
  const user = await getUserFromRequest(req);
  if (!user) {
    return errorResponse(401, "unauthorized", "ログインが必要です");
  }

  // 2. 入力検証（plan/interval → Price ID はサーバー側で解決）
  let body: { plan?: string; interval?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "JSON ボディが必要です");
  }
  const plan = body.plan === "standard" || body.plan === "premium"
    ? body.plan
    : null;
  const interval = body.interval === "monthly" || body.interval === "yearly"
    ? body.interval
    : null;
  if (!plan || !interval) {
    return errorResponse(
      400,
      "bad_request",
      "plan は standard/premium、interval は monthly/yearly を指定してください",
    );
  }
  const priceId = priceIdFor(plan, interval);
  if (!priceId) {
    return errorResponse(
      500,
      "price_not_configured",
      `${plan}/${interval} の Price ID が設定されていません`,
    );
  }

  const db = serviceClient();

  try {
    // 3. Stripe Customer を取得 or 作成（user_id と相互に紐付ける）
    const { data: existing } = await db
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .maybeSingle();

    let customerId = existing?.stripe_customer_id ?? null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email ?? undefined,
        metadata: { user_id: user.id },
      });
      customerId = customer.id;
      // webhook 側で customer → user を逆引きできるよう先に保存しておく
      await db.from("subscriptions").upsert(
        {
          user_id: user.id,
          stripe_customer_id: customerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
    }

    // 4. Checkout Session 作成
    const appUrl = Deno.env.get("APP_URL") ?? "http://localhost:5500";
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: user.id,
      subscription_data: { metadata: { user_id: user.id } },
      allow_promotion_codes: true,
      success_url: `${appUrl}/?billing=success`,
      cancel_url: `${appUrl}/?billing=cancel`,
    });

    if (!session.url) {
      return errorResponse(502, "stripe_error", "Checkout URL を取得できませんでした");
    }
    return jsonResponse({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session failed:", e);
    return errorResponse(
      502,
      "stripe_error",
      "決済ページの作成に失敗しました。時間をおいて再度お試しください",
    );
  }
});
