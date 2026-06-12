# DayFlow 収益化システム（Stripe 課金基盤 ＋ AI目次取り込み）

学習計画 PWA「DayFlow」にサブスクリプション課金（Stripe）と
プレミアム機能「AI目次取り込み」（Claude API）を追加するための一式です。

> **⚠️ このリポジトリについての注意**
> このリポジトリ（linear-algebra-book）には DayFlow 本体の `index.html` が
> 含まれていません（git 履歴にも存在しません）。そのため本ディレクトリには
> **アプリ本体に依存しない部分（Supabase バックエンド一式・クライアント貼り込み用
> モジュール・セットアップ手順）** を完全な形で実装してあります。
> `index.html` が置かれているリポジトリ／ディレクトリが確定したら、
> 下記「7. クライアント統合」の4箇所を組み込めば完成します。

## プラン構成

| プラン | 価格 | 解放される機能 |
|---|---|---|
| 無料 | ¥0 | 全機能をローカルのみで利用、定番教材テンプレート |
| スタンダード | ¥600/月・¥6,000/年 | クラウド同期（マルチデバイス）、学習統計 |
| プレミアム | ¥1,000/月・¥10,000/年 | スタンダードの全機能＋AI目次取り込み |

## 構成

```
dayflow/
├── .env.example                  # 必要な環境変数の一覧（すべて Supabase secrets）
├── client/
│   └── monetization.js           # index.html に貼り込むクライアントモジュール
└── supabase/
    ├── config.toml               # verify_jwt 設定（webhook のみ無効）
    ├── migrations/
    │   └── 20260612000000_billing.sql   # subscriptions / ai_usage + RLS
    └── functions/
        ├── _shared/              # cors / billing(プラン判定) / stripe 共有コード
        ├── create-checkout-session/     # JWT検証 → Checkout Session 作成
        ├── stripe-webhook/              # 署名検証 → subscriptions 更新
        └── ai-toc-import/               # JWT+premium検証 → Claude で目次抽出
```

### セキュリティ設計の要点

- **API キー類（Stripe secret / Anthropic key）は Supabase secrets のみ。**
  クライアント（index.html）に出るのは anon key と公開ポータルURLだけ。
- `subscriptions` / `ai_usage` は RLS で **本人 SELECT のみ・書き込みは service role のみ**。
- クライアントの `canSync()` / `canUseAI()` ゲートは UX 目的。
  **本物の判定は Edge Function 側**で `subscriptions` の `status` と
  `current_period_end` を見て再検証する（直叩きしても 403）。
- 未課金・解約・期限切れになっても **localStorage（`dayflow_v1_*`）には一切触れない**。
  同期だけが止まり、ローカルデータはそのまま使い続けられる。

---

## セットアップ手順

### 1. データベース（migration 適用）

```sh
cd dayflow
supabase link --project-ref <your-project-ref>
supabase db push          # migrations/20260612000000_billing.sql を適用
```

### 2. Stripe: Product / Price の作成（テストモード）

Stripe ダッシュボード（テストモード）→ 商品カタログ で2商品4価格を作成:

| 商品 | Price | 金額 | 課金間隔 |
|---|---|---|---|
| DayFlow スタンダード | `STRIPE_PRICE_STANDARD_MONTHLY` | ¥600 | 月 |
| DayFlow スタンダード | `STRIPE_PRICE_STANDARD_YEARLY` | ¥6,000 | 年 |
| DayFlow プレミアム | `STRIPE_PRICE_PREMIUM_MONTHLY` | ¥1,000 | 月 |
| DayFlow プレミアム | `STRIPE_PRICE_PREMIUM_YEARLY` | ¥10,000 | 年 |

CLI 派は:

```sh
stripe products create --name "DayFlow スタンダード"
stripe prices create --product <prod_id> --currency jpy --unit-amount 600  -d "recurring[interval]=month"
stripe prices create --product <prod_id> --currency jpy --unit-amount 6000 -d "recurring[interval]=year"
# プレミアムも同様に 1000 / 10000 で作成
```

作成した4つの `price_...` を `.env` に控える。

### 3. Stripe: Customer Portal の有効化（解約・支払い方法変更）

ダッシュボード → 設定 → Billing → **カスタマーポータル** を有効化し、
「解約」「支払い方法の更新」を許可。発行される **ノーコード・ログインリンク**
（`https://billing.stripe.com/p/login/...`）を `client/monetization.js` の
`CONFIG.portalLoginUrl` に設定する。
（顧客はメール認証でポータルに入るため、サーバー実装は不要）

### 4. Stripe: Webhook の登録

ダッシュボード → 開発者 → Webhook → エンドポイントを追加:

- URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
- イベント:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

発行された署名シークレット（`whsec_...`）を控える。

ローカル開発では:

```sh
stripe listen --forward-to http://127.0.0.1:54321/functions/v1/stripe-webhook
```

### 5. Supabase secrets の設定

```sh
cp .env.example .env   # 値を埋める
supabase secrets set --env-file ./.env
```

（`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は
Edge Functions に自動で注入されるため設定不要）

### 6. Edge Functions のデプロイ

```sh
supabase functions deploy create-checkout-session
supabase functions deploy ai-toc-import
supabase functions deploy stripe-webhook --no-verify-jwt   # config.toml でも指定済み
```

### 7. クライアント統合（index.html への組み込み）

`client/monetization.js` の中身を index.html の `<script>` 内
（既存アプリ定義の直前）へそのまま貼り込む（JSX 不使用・ビルド不要）。
組み込みポイントは4箇所（詳細はファイル冒頭のコメント参照）:

1. **プラン状態**: App 内で
   `const sub = DayFlowMonetization.useSubscription(supabase, session?.user?.id);`
2. **同期ゲート**: 既存の3秒デバウンス同期 effect の先頭に
   `if (!DayFlowMonetization.canSync(sub.plan)) return;` を追加し、
   未課金ログイン時は `UpsellCard({feature:'sync'})` を表示。
   **localStorage への保存処理はそのまま**（ローカルデータは失わない）。
3. **テンプレート検索ヒット0件**: `TocImportButton` を表示
   （プレミアムなら撮影→`TocPreviewModal`→確定で既存のテンプレート展開処理を再利用、
   未課金なら `PlanComparisonModal` を `highlight:'ai'` で表示）。
4. **設定画面**: `ManagePlanButton`（無課金→プラン比較 / 課金中→Customer Portal）。

UI コンポーネントはすべて既存のカラーパレット定数 `C` を props で受け取る
（`{bg, card, text, sub, accent, border, danger}` を参照。無ければフォールバック値）。

---

## 動作確認（受け入れ条件のチェック）

1. **Checkout → webhook → 反映 → 解放**:
   テストカード `4242 4242 4242 4242` で Checkout を完走 →
   `stripe listen` 経由で webhook が `subscriptions` を upsert →
   アプリ再読込で `useSubscription` がプランを取得し同期/統計が解放される。
2. **解約 → 期間満了で無効化、ローカル無傷**:
   Customer Portal で解約（期間終了時）→ 満了時に
   `customer.subscription.deleted` が `status='canceled'` を書き込み →
   サーバー/クライアント双方の判定が free に落ち、同期と AI が止まる。
   `dayflow_v1_*` のデータはそのまま使える。
3. **直叩き 403**: 未課金ユーザーの JWT で
   `POST /functions/v1/ai-toc-import` → `403 {"error":"premium_required"}`。
   JWT なし → 401。日次上限超過 → 429。
4. **AI目次取り込み**: 目次写真 → プレビュー（編集・削除可）→ 確定で
   テンプレートと同じ展開処理により `subjects`/`subjectTodos` に登録され、
   既存の間隔反復ロジックがそのまま動く（本実装はデータ構造に手を入れない）。
5. **キー非露出**: Stripe secret / webhook secret / Anthropic key は
   Edge Functions の secrets のみ。クライアント側コードに secret の参照はない。

## AI目次取り込みの仕様メモ

- モデル: `claude-opus-4-8`（既定・精度優先）。`ANTHROPIC_MODEL` で
  `claude-haiku-4-5`（$1/$5 per MTok）等に切り替え可能。
- 画像はクライアントで長辺 ~1568px に縮小・JPEG圧縮してから base64 で送信。
- 構造化出力（`output_config.format: json_schema`）でスキーマを強制するため、
  返ってくる JSON のバリデーションは不要。
- プロンプトで「写っていない問題を推測で補完しない」「範囲表記（例題1〜34）は展開」を指示。
- `max_tokens: 16000`。`stop_reason` が `refusal` / `max_tokens` の場合は
  それぞれ撮り直し・分割撮影を促すエラーメッセージを返す。
- 乱用対策: `ai_usage` テーブルで 1ユーザー 20回/日（`AI_DAILY_LIMIT`）。
