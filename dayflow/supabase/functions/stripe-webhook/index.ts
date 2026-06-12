// stripe-webhook
//
// Stripe からの webhook を受けて subscriptions テーブルを更新する。
//   * checkout.session.completed      → 初回購読の反映
//   * customer.subscription.updated   → プラン変更・更新・解約予約の反映
//   * customer.subscription.deleted   → 解約（期間満了）の反映
//
// 署名検証必須。このエンドポイントは JWT 検証を無効化する
// （supabase/config.toml の [functions.stripe-webhook] verify_jwt = false）。
// 認証は Stripe-Signature ヘッダの HMAC 検証で行う。

import type Stripe from "npm:stripe@17";
import { serviceClient } from "../_shared/billing.ts";
import {
  planForPriceId,
  stripe,
  stripeCryptoProvider,
} from "../_shared/stripe.ts";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") ?? "";

/** subscription オブジェクトの内容を subscriptions テーブルへ同期する */
async function syncSubscription(
  sub: Stripe.Subscription,
  fallbackUserId?: string | null,
): Promise<void> {
  const db = serviceClient();
  const customerId = typeof sub.customer === "string"
    ? sub.customer
    : sub.customer.id;

  // user_id の解決: metadata → checkout の client_reference_id → customer 逆引き
  let userId = (sub.metadata?.user_id as string | undefined) ??
    fallbackUserId ?? null;
  if (!userId) {
    const { data } = await db
      .from("subscriptions")
      .select("user_id")
      .eq("stripe_customer_id", customerId)
      .maybeSingle();
    userId = data?.user_id ?? null;
  }
  if (!userId) {
    // user に紐付かない subscription はこのアプリ外のもの。リトライさせない。
    console.warn(`subscription ${sub.id}: user_id を解決できませんでした`);
    return;
  }

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? "";
  const plan = planForPriceId(priceId);
  if (!plan) {
    console.warn(`subscription ${sub.id}: 未知の price ${priceId}`);
  }

  // current_period_end は API バージョンにより subscription 直下 or item 配下
  const periodEndUnix =
    (sub as unknown as { current_period_end?: number }).current_period_end ??
      (item as unknown as { current_period_end?: number })
        ?.current_period_end ?? null;

  const { error } = await db.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: sub.id,
      plan, // 未知の price のときは null（= 無料扱い）
      status: sub.status,
      current_period_end: periodEndUnix
        ? new Date(periodEndUnix * 1000).toISOString()
        : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(`subscriptions upsert failed: ${error.message}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const signature = req.headers.get("Stripe-Signature");
  if (!signature || !WEBHOOK_SECRET) {
    return new Response("missing signature", { status: 400 });
  }

  // 署名検証（生のボディが必要）
  const rawBody = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      WEBHOOK_SECRET,
      undefined,
      stripeCryptoProvider,
    );
  } catch (e) {
    console.error("webhook signature verification failed:", e);
    return new Response("invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode === "subscription" && session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          const sub = await stripe.subscriptions.retrieve(subId);
          await syncSubscription(sub, session.client_reference_id);
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        // deleted のとき status は "canceled" になり、
        // getServerPlan() 側で free 扱いになる（ローカルデータは無傷）。
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(sub);
        break;
      }
      default:
        // 購読対象外のイベントは黙って 200（Stripe にリトライさせない）
        break;
    }
  } catch (e) {
    console.error(`webhook ${event.type} handling failed:`, e);
    // 500 を返して Stripe に再送させる（一時的な DB 障害などに備える）
    return new Response("internal error", { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
});
