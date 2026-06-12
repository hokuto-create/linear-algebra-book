// ai-toc-import（プレミアム機能）
//
// 参考書の目次写真（base64 JPEG）を受け取り、Claude API で
// 「書名 + 章 → 問題リスト」の構造化 JSON を生成して返す。
//
// セキュリティ:
//   * JWT 検証 → subscriptions テーブルで premium をサーバー側で再検証（403）
//   * ANTHROPIC_API_KEY は Supabase secrets のみに置き、クライアントへは一切出さない
//   * 1ユーザーあたり日次回数制限（AI_DAILY_LIMIT, 既定 20回/日）を ai_usage で管理
//
// リクエスト body: { "image": "<base64>", "media_type": "image/jpeg" }
// レスポンス: { "bookTitle": string, "chapters": [{ "title": string, "items": [{ "text": string }] }] }

import Anthropic from "npm:@anthropic-ai/sdk";
import {
  errorResponse,
  jsonResponse,
  preflightResponse,
} from "../_shared/cors.ts";
import {
  getServerPlan,
  getUserFromRequest,
  serviceClient,
} from "../_shared/billing.ts";

// 精度優先のデフォルト。コスト最適化したいときだけ環境変数で
// claude-haiku-4-5（$1/$5 per MTok）等に切り替える。
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-opus-4-8";
const DAILY_LIMIT = Number(Deno.env.get("AI_DAILY_LIMIT") ?? "20");
const MAX_TOKENS = 16000;

// base64 で約 10MB 相当まで（クライアントは長辺 1568px に縮小して送る想定）
const MAX_IMAGE_B64_LENGTH = 14_000_000;

const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

// 構造化出力スキーマ（valid JSON が保証されるためバリデーション不要）
const TOC_SCHEMA = {
  type: "object",
  properties: {
    bookTitle: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "items"],
        additionalProperties: false,
      },
    },
  },
  required: ["bookTitle", "chapters"],
  additionalProperties: false,
} as const;

const PROMPT = `あなたは参考書の目次画像から、学習管理アプリ用のデータを抽出するアシスタントです。
画像に写っている目次から、書名・章タイトル・問題/例題番号の一覧を抽出してください。

ルール:
- 画像に実際に写っている情報だけを抽出する。写っていない章や問題を推測で補完しない。
- 問題番号が範囲表記の場合（例:「例題1〜34」「問1-15」）は、個々の項目に展開する
  （「例題1」「例題2」…「例題34」のように1件ずつ）。
- 章タイトルからページ番号は除く。
- 各問題/例題の text は「例題12」「問3」「練習問題5」のような短い名前にする。
- 書名が画像から読み取れない場合、bookTitle は空文字列にする。
- 画像が目次ではない、または判読できない場合は chapters を空配列にする。`;

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

  // 2. premium をサーバー側で再検証（クライアントのゲートは信用しない）
  const plan = await getServerPlan(user.id);
  if (plan !== "premium") {
    return errorResponse(
      403,
      "premium_required",
      "AI目次取り込みはプレミアムプランの機能です",
    );
  }

  // 3. 入力検証
  let body: { image?: string; media_type?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "bad_request", "JSON ボディが必要です");
  }
  const image = body.image ?? "";
  const mediaType = body.media_type ?? "image/jpeg";
  if (!image || typeof image !== "string") {
    return errorResponse(400, "bad_request", "image (base64) が必要です");
  }
  if (image.length > MAX_IMAGE_B64_LENGTH) {
    return errorResponse(
      413,
      "image_too_large",
      "画像が大きすぎます。長辺 1568px 程度に縮小して送信してください",
    );
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return errorResponse(400, "bad_request", "対応していない画像形式です");
  }

  // 4. 日次回数制限（アトミックにチェック＆加算）
  const { data: allowed, error: usageError } = await serviceClient().rpc(
    "increment_ai_usage",
    { p_user_id: user.id, p_limit: DAILY_LIMIT },
  );
  if (usageError) {
    console.error("increment_ai_usage failed:", usageError);
    return errorResponse(500, "internal_error", "内部エラーが発生しました");
  }
  if (!allowed) {
    return errorResponse(
      429,
      "rate_limited",
      `AI目次取り込みは1日${DAILY_LIMIT}回までです。明日また試してください`,
    );
  }

  // 5. Claude API 呼び出し（構造化出力）
  const anthropic = new Anthropic({
    apiKey: Deno.env.get("ANTHROPIC_API_KEY")!,
  });

  let message;
  try {
    // max_tokens が大きいためストリーミングで受けてタイムアウトを避ける
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: {
        format: { type: "json_schema", schema: TOC_SCHEMA },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: image },
            },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    } as Parameters<typeof anthropic.messages.stream>[0]);
    message = await stream.finalMessage();
  } catch (e) {
    console.error("anthropic request failed:", e);
    return errorResponse(
      502,
      "ai_error",
      "AIの呼び出しに失敗しました。時間をおいて再度お試しください",
    );
  }

  // 6. stop_reason の確認
  if (message.stop_reason === "refusal") {
    return errorResponse(
      422,
      "refused",
      "この画像は処理できませんでした。参考書の目次ページを撮影し直してください",
    );
  }
  if (message.stop_reason === "max_tokens") {
    return errorResponse(
      422,
      "truncated",
      "目次の情報量が多すぎて途中で切れました。目次を数ページに分けて1枚ずつ取り込んでください",
    );
  }

  const text = message.content.find((b) => b.type === "text")?.text ?? "";
  if (!text) {
    return errorResponse(502, "ai_error", "AIから結果を取得できませんでした");
  }

  // 構造化出力により valid JSON が保証されている
  const result = JSON.parse(text);
  return jsonResponse(result);
});
