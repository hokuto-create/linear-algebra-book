/* ============================================================
 * DayFlow 収益化モジュール（index.html 貼り込み用）
 * ============================================================
 *
 * index.html の単一ファイル・ビルドなし方針に合わせて、
 * このファイルの中身はそのまま index.html の <script> 内
 * （既存アプリ定義の直前）に貼り込むことを想定している。
 * JSX を使わず React.createElement だけで書いてあるため、
 * Babel 等の変換は一切不要。
 *
 * ---- index.html への統合ポイント（4箇所） --------------------
 *
 * 1) プラン状態の取得（App コンポーネント内）:
 *      const sub = DayFlowMonetization.useSubscription(supabase, session?.user?.id);
 *      // sub.plan は 'free' | 'standard' | 'premium'
 *
 * 2) クラウド同期のゲート（既存の3秒デバウンス同期 effect 内）:
 *      if (!DayFlowMonetization.canSync(sub.plan)) return; // ← 同期だけスキップ
 *      // ★ localStorage(dayflow_v1_*) への保存処理は絶対に変更しない。
 *      //   未課金・解約・期限切れでもローカルデータはそのまま使い続けられる。
 *    未課金ログイン時は UpsellCard({feature:'sync'}) を表示する。
 *
 * 3) テンプレート検索でヒット0件のとき:
 *      TocImportButton を表示（プレミアムなら撮影フロー、未課金ならプラン比較へ）。
 *
 * 4) 設定画面に「プランを管理」:
 *      ManagePlanButton（Stripe Customer Portal のノーコードリンクを開く）。
 *
 * 依存: window.React (UMD), supabase-js v2 のクライアントインスタンス。
 * ============================================================ */
(function (global) {
  "use strict";

  const React = global.React;
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef } = React;

  /* ----------------------------------------------------------
   * 設定（公開値のみ。secret は絶対にここへ置かない）
   * ---------------------------------------------------------- */
  const CONFIG = {
    // Stripe カスタマーポータルのノーコード・ログインリンク
    // （ダッシュボードで有効化したURLに差し替える）
    portalLoginUrl: "https://billing.stripe.com/p/login/test_XXXXXXXX",
  };

  const PRICING = {
    standard: { monthly: 600, yearly: 6000 },
    premium: { monthly: 1000, yearly: 10000 },
  };

  /* ----------------------------------------------------------
   * entitlement ヘルパー（クライアント側ゲートは UX 目的。
   * 本物の判定は Edge Function 側で再検証される）
   * ---------------------------------------------------------- */
  const PLAN_RANK = { free: 0, standard: 1, premium: 2 };

  function canSync(plan) {
    return (PLAN_RANK[plan] || 0) >= PLAN_RANK.standard;
  }
  function canViewStats(plan) {
    return (PLAN_RANK[plan] || 0) >= PLAN_RANK.standard;
  }
  function canUseAI(plan) {
    return (PLAN_RANK[plan] || 0) >= PLAN_RANK.premium;
  }
  function planLabel(plan) {
    return { free: "無料", standard: "スタンダード", premium: "プレミアム" }[
      plan
    ] || "無料";
  }

  /**
   * subscriptions 行 → 現在有効なプラン。
   * status と current_period_end（サーバーが webhook で更新する値）を信頼する。
   */
  function effectivePlan(row) {
    if (!row || !row.plan) return "free";
    if (row.status !== "active" && row.status !== "trialing") return "free";
    const end = row.current_period_end
      ? new Date(row.current_period_end).getTime()
      : 0;
    const GRACE_MS = 24 * 60 * 60 * 1000;
    if (end + GRACE_MS < Date.now()) return "free";
    return row.plan;
  }

  /* ----------------------------------------------------------
   * useSubscription: ログイン時に自分の subscription 行を読み、
   * plan を React state に保持する（RLS により本人行のみ読める）
   * ---------------------------------------------------------- */
  function useSubscription(supabase, userId) {
    const [state, setState] = useState({
      plan: "free",
      row: null,
      loading: !!userId,
    });

    const refresh = useCallback(async () => {
      if (!supabase || !userId) {
        setState({ plan: "free", row: null, loading: false });
        return;
      }
      const { data, error } = await supabase
        .from("subscriptions")
        .select("plan, status, current_period_end")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        // 読めないときは安全側（free）に倒す。ローカル機能は全て使える。
        setState({ plan: "free", row: null, loading: false });
        return;
      }
      setState({ plan: effectivePlan(data), row: data, loading: false });
    }, [supabase, userId]);

    useEffect(() => {
      refresh();
    }, [refresh]);

    return { plan: state.plan, row: state.row, loading: state.loading, refresh };
  }

  /* ----------------------------------------------------------
   * Checkout / Customer Portal
   * ---------------------------------------------------------- */
  async function startCheckout(supabase, plan, interval) {
    const { data, error } = await supabase.functions.invoke(
      "create-checkout-session",
      { body: { plan, interval } },
    );
    if (error || !data || !data.url) {
      throw new Error("決済ページを開けませんでした。時間をおいて再度お試しください");
    }
    global.location.href = data.url;
  }

  function openCustomerPortal() {
    global.open(CONFIG.portalLoginUrl, "_blank", "noopener");
  }

  /* ----------------------------------------------------------
   * AI目次取り込み: 画像縮小 → Edge Function 呼び出し
   * ---------------------------------------------------------- */

  /** 長辺 maxLongEdge px に縮小して JPEG base64（dataURL プレフィックスなし）を返す */
  function resizeImageToJpegBase64(file, maxLongEdge, quality) {
    maxLongEdge = maxLongEdge || 1568;
    quality = quality || 0.85;
    return new Promise(function (resolve, reject) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        try {
          const long = Math.max(img.width, img.height);
          const scale = long > maxLongEdge ? maxLongEdge / long : 1;
          const w = Math.round(img.width * scale);
          const hgt = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = hgt;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#ffffff"; // PNG の透過対策
          ctx.fillRect(0, 0, w, hgt);
          ctx.drawImage(img, 0, 0, w, hgt);
          const dataUrl = canvas.toDataURL("image/jpeg", quality);
          resolve(dataUrl.split(",")[1]);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした"));
      };
      img.src = url;
    });
  }

  /** Edge Function のエラーを利用者向けメッセージに変換する */
  async function functionErrorMessage(error, fallback) {
    try {
      if (error && error.context && typeof error.context.json === "function") {
        const body = await error.context.json();
        if (body && body.message) return body.message;
      }
    } catch (_) { /* ignore */ }
    return fallback;
  }

  /**
   * 目次写真 → 構造化データ。
   * 成功: { bookTitle, chapters: [{ title, items: [{ text }] }] }
   * 失敗: Error を throw（message は表示用の日本語）
   */
  async function importToc(supabase, file) {
    const image = await resizeImageToJpegBase64(file);
    const { data, error } = await supabase.functions.invoke("ai-toc-import", {
      body: { image: image, media_type: "image/jpeg" },
    });
    if (error) {
      const msg = await functionErrorMessage(
        error,
        "AI目次取り込みに失敗しました。時間をおいて再度お試しください",
      );
      throw new Error(msg);
    }
    return data;
  }

  /* ----------------------------------------------------------
   * UI コンポーネント
   * 既存のカラーパレット定数 C を props で受け取り、デザインに従う。
   * C が無い場合に備えてフォールバック値を持つ。
   * ---------------------------------------------------------- */
  function palette(C) {
    C = C || {};
    return {
      bg: C.bg || "#ffffff",
      card: C.card || "#f7f7f8",
      text: C.text || "#1a1a1a",
      sub: C.sub || "#6b7280",
      accent: C.accent || "#4f6ef7",
      border: C.border || "#e5e7eb",
      danger: C.danger || "#e0524d",
    };
  }

  function Btn(props) {
    const p = palette(props.C);
    const primary = props.variant !== "ghost";
    return h("button", {
      onClick: props.onClick,
      disabled: props.disabled,
      style: Object.assign({
        padding: "10px 16px",
        borderRadius: 10,
        border: primary ? "none" : "1px solid " + p.border,
        background: primary ? p.accent : "transparent",
        color: primary ? "#fff" : p.text,
        fontSize: 14,
        fontWeight: 600,
        cursor: props.disabled ? "default" : "pointer",
        opacity: props.disabled ? 0.5 : 1,
        width: props.block ? "100%" : undefined,
      }, props.style || {}),
    }, props.children);
  }

  /** 未課金ユーザーがゲート機能に触れたときの小さなアップセル表示 */
  function UpsellCard(props) {
    const p = palette(props.C);
    const copy = {
      sync: {
        title: "クラウド同期はスタンダードプランの機能です",
        body: "今のデータはこの端末に保存されていて、このまま使えます。" +
          "スマホとPCの両方で勉強するなら、年額¥6,000（月あたり¥500）の" +
          "スタンダードプランで自動同期できます。",
      },
      ai: {
        title: "📷 AI目次取り込みはプレミアムプランの機能です",
        body: "参考書の目次を撮るだけで、章と問題リストをまとめて登録できます。" +
          "年額¥10,000（月あたり約¥833）のプレミアムプランで使えます。",
      },
      stats: {
        title: "学習統計はスタンダードプランの機能です",
        body: "学習時間や達成率のグラフで振り返りができます。",
      },
    }[props.feature] || { title: "有料プランの機能です", body: "" };

    return h(
      "div",
      {
        style: {
          background: p.card,
          border: "1px solid " + p.border,
          borderRadius: 12,
          padding: 16,
          margin: "8px 0",
        },
      },
      h("div", {
        style: { fontWeight: 700, fontSize: 14, color: p.text, marginBottom: 6 },
      }, copy.title),
      h("div", {
        style: { fontSize: 13, color: p.sub, lineHeight: 1.6, marginBottom: 12 },
      }, copy.body),
      h(Btn, { C: props.C, onClick: props.onShowPlans }, "プランを見る"),
    );
  }

  /** プラン比較モーダル（無料/スタンダード/プレミアムの3列、年額を推奨表示） */
  function PlanComparisonModal(props) {
    const p = palette(props.C);
    const [interval, setInterval_] = useState("yearly");
    const [busy, setBusy] = useState(null);
    const [err, setErr] = useState("");

    const cols = [
      {
        key: "free",
        name: "無料",
        price: "¥0",
        note: "",
        features: ["全機能をこの端末で利用", "定番教材テンプレート"],
      },
      {
        key: "standard",
        name: "スタンダード",
        price: interval === "yearly" ? "¥6,000/年" : "¥600/月",
        note: interval === "yearly" ? "月あたり¥500" : "年額なら¥6,000（月あたり¥500）",
        features: ["無料プランの全機能", "クラウド同期（スマホ⇄PC）", "学習統計"],
      },
      {
        key: "premium",
        name: "プレミアム",
        price: interval === "yearly" ? "¥10,000/年" : "¥1,000/月",
        note: interval === "yearly" ? "月あたり約¥833" : "年額なら¥10,000（月あたり約¥833）",
        features: ["スタンダードの全機能", "📷 AI目次取り込み"],
        highlight: props.highlight === "ai",
      },
    ];

    function choose(planKey) {
      if (planKey === "free") return;
      setErr("");
      setBusy(planKey);
      startCheckout(props.supabase, planKey, interval).catch(function (e) {
        setErr(e.message);
        setBusy(null);
      });
    }

    return h(
      "div",
      { // オーバーレイ
        onClick: props.onClose,
        style: {
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 16,
        },
      },
      h(
        "div",
        {
          onClick: function (e) { e.stopPropagation(); },
          style: {
            background: p.bg, borderRadius: 16, padding: 20,
            maxWidth: 720, width: "100%", maxHeight: "90vh", overflowY: "auto",
          },
        },
        h("div", {
          style: { fontSize: 17, fontWeight: 700, color: p.text, marginBottom: 4 },
        }, "プランをえらぶ"),
        h("div", {
          style: { fontSize: 13, color: p.sub, marginBottom: 14 },
        }, "いつでも解約できます。解約してもローカルのデータはそのまま残ります。"),
        // 月額/年額トグル
        h(
          "div",
          { style: { display: "flex", gap: 8, marginBottom: 14 } },
          ["yearly", "monthly"].map(function (iv) {
            const active = interval === iv;
            return h("button", {
              key: iv,
              onClick: function () { setInterval_(iv); },
              style: {
                padding: "6px 14px", borderRadius: 999, fontSize: 13,
                border: "1px solid " + (active ? p.accent : p.border),
                background: active ? p.accent : "transparent",
                color: active ? "#fff" : p.sub, cursor: "pointer",
                fontWeight: active ? 700 : 400,
              },
            }, iv === "yearly" ? "年額（2か月分おトク）" : "月額");
          }),
        ),
        // 3列カード
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            },
          },
          cols.map(function (col) {
            const isCurrent = props.currentPlan === col.key;
            return h(
              "div",
              {
                key: col.key,
                style: {
                  border: "2px solid " + (col.highlight ? p.accent : p.border),
                  borderRadius: 12, padding: 16,
                  display: "flex", flexDirection: "column", gap: 8,
                },
              },
              h("div", {
                style: { fontWeight: 700, fontSize: 15, color: p.text },
              }, col.name),
              h("div", {
                style: { fontSize: 20, fontWeight: 800, color: p.text },
              }, col.price),
              col.note
                ? h("div", { style: { fontSize: 12, color: p.sub } }, col.note)
                : null,
              h(
                "ul",
                {
                  style: {
                    margin: "4px 0", paddingLeft: 18, fontSize: 13,
                    color: p.text, lineHeight: 1.8, flexGrow: 1,
                  },
                },
                col.features.map(function (f, i) {
                  return h("li", { key: i }, f);
                }),
              ),
              col.key === "free"
                ? h("div", {
                  style: { fontSize: 12, color: p.sub, textAlign: "center" },
                }, isCurrent ? "利用中" : "")
                : h(Btn, {
                  C: props.C,
                  block: true,
                  disabled: isCurrent || busy !== null,
                  onClick: function () { choose(col.key); },
                }, isCurrent
                  ? "利用中"
                  : busy === col.key
                  ? "決済ページへ移動中…"
                  : "このプランにする"),
            );
          }),
        ),
        err
          ? h("div", {
            style: { color: p.danger, fontSize: 13, marginTop: 10 },
          }, err)
          : null,
        h("div", { style: { textAlign: "right", marginTop: 14 } },
          h(Btn, { C: props.C, variant: "ghost", onClick: props.onClose }, "閉じる")),
      ),
    );
  }

  /** 設定画面用「プランを管理」ボタン（解約・支払い方法変更は Customer Portal で） */
  function ManagePlanButton(props) {
    const p = palette(props.C);
    return h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 10 } },
      h("span", { style: { fontSize: 13, color: p.sub } },
        "現在のプラン: " + planLabel(props.plan)),
      props.plan === "free"
        ? h(Btn, { C: props.C, onClick: props.onShowPlans }, "プランを見る")
        : h(Btn, { C: props.C, variant: "ghost", onClick: openCustomerPortal },
          "プランを管理（解約・支払い方法）"),
    );
  }

  /* ----------------------------------------------------------
   * AI目次取り込みフロー
   * ---------------------------------------------------------- */

  /**
   * テンプレート検索 0 件のときに置くボタン。
   *   canUse=true  : ファイル選択/カメラ → 解析 → onResult(result)
   *   canUse=false : onShowPlans()（プラン比較モーダルへ）
   */
  function TocImportButton(props) {
    const p = palette(props.C);
    const inputRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    function onPick(e) {
      const file = e.target.files && e.target.files[0];
      e.target.value = ""; // 同じファイルの再選択を許可
      if (!file) return;
      setErr("");
      setBusy(true);
      importToc(props.supabase, file)
        .then(function (result) {
          setBusy(false);
          props.onResult(result);
        })
        .catch(function (e2) {
          setBusy(false);
          setErr(e2.message);
        });
    }

    return h(
      "div",
      null,
      h("input", {
        ref: inputRef,
        type: "file",
        accept: "image/*",
        capture: "environment",
        style: { display: "none" },
        onChange: onPick,
      }),
      h(Btn, {
        C: props.C,
        disabled: busy,
        onClick: function () {
          if (!props.canUse) {
            props.onShowPlans();
            return;
          }
          inputRef.current && inputRef.current.click();
        },
      }, busy
        ? "目次を解析中…（数十秒かかることがあります）"
        : "📷 目次を撮って取り込む" + (props.canUse ? "" : "（プレミアム）")),
      err
        ? h("div", {
          style: { color: p.danger, fontSize: 13, marginTop: 8 },
        }, err)
        : null,
    );
  }

  /**
   * 解析結果のプレビュー（章タイトル・問題リストを編集・削除可能）。
   * 確定すると onConfirm({ bookTitle, chapters }) を呼ぶので、
   * 既存のテンプレート取り込みと同じ展開処理
   * （subjects / subjectTodos への変換）をそのまま再利用すること。
   */
  function TocPreviewModal(props) {
    const p = palette(props.C);
    const [bookTitle, setBookTitle] = useState(props.result.bookTitle || "");
    const [chapters, setChapters] = useState(
      (props.result.chapters || []).map(function (ch) {
        return { title: ch.title, items: (ch.items || []).slice() };
      }),
    );

    function updateChapter(ci, patch) {
      setChapters(function (prev) {
        const next = prev.slice();
        next[ci] = Object.assign({}, next[ci], patch);
        return next;
      });
    }
    function removeChapter(ci) {
      setChapters(function (prev) {
        return prev.filter(function (_, i) { return i !== ci; });
      });
    }
    function updateItem(ci, ii, text) {
      setChapters(function (prev) {
        const next = prev.slice();
        const items = next[ci].items.slice();
        items[ii] = { text: text };
        next[ci] = Object.assign({}, next[ci], { items: items });
        return next;
      });
    }
    function removeItem(ci, ii) {
      setChapters(function (prev) {
        const next = prev.slice();
        next[ci] = Object.assign({}, next[ci], {
          items: next[ci].items.filter(function (_, i) { return i !== ii; }),
        });
        return next;
      });
    }
    function addItem(ci) {
      setChapters(function (prev) {
        const next = prev.slice();
        next[ci] = Object.assign({}, next[ci], {
          items: next[ci].items.concat([{ text: "" }]),
        });
        return next;
      });
    }

    const total = chapters.reduce(function (n, ch) {
      return n + ch.items.length;
    }, 0);

    const inputStyle = {
      fontSize: 13, color: p.text, background: p.bg,
      border: "1px solid " + p.border, borderRadius: 6,
      padding: "4px 8px", width: "100%", boxSizing: "border-box",
    };

    return h(
      "div",
      {
        onClick: props.onCancel,
        style: {
          position: "fixed", inset: 0, zIndex: 1000,
          background: "rgba(0,0,0,0.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 16,
        },
      },
      h(
        "div",
        {
          onClick: function (e) { e.stopPropagation(); },
          style: {
            background: p.bg, borderRadius: 16, padding: 20,
            maxWidth: 560, width: "100%", maxHeight: "90vh",
            display: "flex", flexDirection: "column",
          },
        },
        h("div", {
          style: { fontSize: 16, fontWeight: 700, color: p.text, marginBottom: 4 },
        }, "取り込み内容の確認"),
        h("div", { style: { fontSize: 12, color: p.sub, marginBottom: 10 } },
          "間違いがあればここで直せます（" + chapters.length + "章・" + total + "問）"),
        h("input", {
          value: bookTitle,
          placeholder: "教材名",
          onChange: function (e) { setBookTitle(e.target.value); },
          style: Object.assign({}, inputStyle, {
            fontWeight: 700, fontSize: 14, marginBottom: 10,
          }),
        }),
        h(
          "div",
          { style: { overflowY: "auto", flexGrow: 1, minHeight: 0 } },
          chapters.length === 0
            ? h("div", { style: { fontSize: 13, color: p.sub, padding: 12 } },
              "目次を読み取れませんでした。明るい場所で目次ページ全体を撮り直してみてください。")
            : chapters.map(function (ch, ci) {
              return h(
                "div",
                {
                  key: ci,
                  style: {
                    border: "1px solid " + p.border, borderRadius: 10,
                    padding: 10, marginBottom: 10,
                  },
                },
                h("div", { style: { display: "flex", gap: 6, marginBottom: 6 } },
                  h("input", {
                    value: ch.title,
                    onChange: function (e) {
                      updateChapter(ci, { title: e.target.value });
                    },
                    style: Object.assign({}, inputStyle, { fontWeight: 600 }),
                  }),
                  h("button", {
                    onClick: function () { removeChapter(ci); },
                    title: "この章を削除",
                    style: {
                      border: "none", background: "transparent",
                      color: p.danger, cursor: "pointer", fontSize: 14,
                    },
                  }, "✕")),
                ch.items.map(function (it, ii) {
                  return h("div", {
                    key: ii,
                    style: { display: "flex", gap: 6, marginBottom: 4, paddingLeft: 12 },
                  },
                    h("input", {
                      value: it.text,
                      onChange: function (e) { updateItem(ci, ii, e.target.value); },
                      style: inputStyle,
                    }),
                    h("button", {
                      onClick: function () { removeItem(ci, ii); },
                      title: "削除",
                      style: {
                        border: "none", background: "transparent",
                        color: p.sub, cursor: "pointer", fontSize: 13,
                      },
                    }, "✕"));
                }),
                h("button", {
                  onClick: function () { addItem(ci); },
                  style: {
                    border: "none", background: "transparent", color: p.accent,
                    cursor: "pointer", fontSize: 13, paddingLeft: 12,
                  },
                }, "+ 問題を追加"),
              );
            }),
        ),
        h(
          "div",
          {
            style: {
              display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12,
            },
          },
          h(Btn, { C: props.C, variant: "ghost", onClick: props.onCancel },
            "キャンセル"),
          h(Btn, {
            C: props.C,
            disabled: total === 0,
            onClick: function () {
              props.onConfirm({
                bookTitle: bookTitle,
                chapters: chapters.filter(function (ch) {
                  return ch.items.length > 0 || ch.title.trim() !== "";
                }).map(function (ch) {
                  return {
                    title: ch.title,
                    items: ch.items.filter(function (it) {
                      return it.text.trim() !== "";
                    }),
                  };
                }),
              });
            },
          }, "この内容で登録"),
        ),
      ),
    );
  }

  /* ----------------------------------------------------------
   * 公開 API
   * ---------------------------------------------------------- */
  global.DayFlowMonetization = {
    // entitlement
    canSync: canSync,
    canUseAI: canUseAI,
    canViewStats: canViewStats,
    planLabel: planLabel,
    effectivePlan: effectivePlan,
    PRICING: PRICING,
    CONFIG: CONFIG,
    // 状態
    useSubscription: useSubscription,
    // 決済
    startCheckout: startCheckout,
    openCustomerPortal: openCustomerPortal,
    // AI目次取り込み
    resizeImageToJpegBase64: resizeImageToJpegBase64,
    importToc: importToc,
    // UI
    UpsellCard: UpsellCard,
    PlanComparisonModal: PlanComparisonModal,
    ManagePlanButton: ManagePlanButton,
    TocImportButton: TocImportButton,
    TocPreviewModal: TocPreviewModal,
  };
})(window);
