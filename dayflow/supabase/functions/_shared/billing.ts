// 課金まわりの共有ロジック（Edge Functions 用）
//
// クライアントの plan 表示はあくまで UX 目的のゲートであり、
// 本物の判定は必ずここ（サーバー側）で subscriptions テーブルの
// status と current_period_end を見て行う。

import { createClient, type User } from "npm:@supabase/supabase-js@2";

export type Plan = "free" | "standard" | "premium";

const ACTIVE_STATUSES = new Set(["active", "trialing"]);

// 決済リトライ等のズレを吸収する猶予（期限ちょうどで突然死させない）
const GRACE_MS = 24 * 60 * 60 * 1000;

/** service role クライアント（RLS をバイパスして読み書きする） */
export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

/** Authorization ヘッダの JWT を検証してユーザーを返す（無効なら null） */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data.user) return null;
  return data.user;
}

/**
 * サーバー側の真実としての現在プラン。
 * status が active/trialing かつ current_period_end が未来のときだけ
 * 有料プランとみなす。それ以外（解約済み・期限切れ・行なし）は free。
 */
export async function getServerPlan(userId: string): Promise<Plan> {
  const { data, error } = await serviceClient()
    .from("subscriptions")
    .select("plan, status, current_period_end")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data || !data.plan) return "free";
  if (!ACTIVE_STATUSES.has(data.status ?? "")) return "free";

  const end = data.current_period_end
    ? new Date(data.current_period_end).getTime()
    : 0;
  if (end + GRACE_MS < Date.now()) return "free";

  return data.plan as Plan;
}
