# 線形代数教科書プロジェクト

## 概要
高卒直後の読者向け線形代数教科書（第2版改訂中）。
第1版（全9部・約108ページ）を250〜400ページの「学習できる教科書」に増補する。
コンパイルは CloudLaTeX / pLaTeX (ptex2pdf, dvipdfmx)。コンパイル対象は master.tex。

## ファイル構成
- master.tex : プリアンブルと \include のみ。文書クラスは jsbook (oneside)
- part1_basics.tex 〜 part9_applications.tex : 本文（各部1ファイル）
- kaito.tex : 巻末解答（必ず最後に include）

## LaTeX 規約（厳守）
- pLaTeX で通らないパッケージ禁止。使用可: amsmath, amssymb, bm, amsthm,
  ascmac, graphicx/color ([dvipdfmx])
- 行列は \mat{...}（pmatrix のマクロ）、ベクトルは \vect{...}（\bm）
- 定理環境: teigi(定義)/teiri(定理)/rei(例)/mondai(問)/chui(注意)/hanrei(反例)
  ※番号は章単位で共通カウンタ
- 囲み枠は itembox。「深掘り」コラムは itembox タイトルに「深掘り:」
- 章冒頭に goal 環境、章末に matome 環境（第2版で追加）
- 問は \begin{mondai}[基本/標準/発展/証明]\label{q:識別子} 形式。
  解答は kaito.tex に \ref{q:識別子} で追記（問と解答は必ず同時に書く）
- include されるファイルに \documentclass や \begin{document} を書かない

## 第2版の方針
- 範囲は増やさない。厚みと演習を増やす
- 各章: ゴール → 動機 → 定義 → 例題(基本3+標準3) → 定理(重要なものは証明) →
  反例1〜2 → まとめ → 章末問題10問以上（基本/標準/発展/証明）
- 重要証明: 階段形の一意性、行rank=列rank、次元定理、基底本数の不変性、
  det の多重線形性・交代性、det(AB)、対角化可能条件、スペクトル定理、
  ジョルダン標準形(骨格)、SVD の存在、エッカート・ヤング
- 優先順位: Phase 1(ゴール/まとめ/例題/章末問題/解答) →
  Phase 2(証明・反例) → Phase 3(第VI部・第VII部の増強)
- 最優先増補: 第III部（60〜90ページ目標）、次いで第VI部（40〜70ページ）
- 第IX部は読み物のため演習増強の対象外

## 作業ルール
- 1コミット = 1章の改訂を基本とする
- 問を追加・変更したら kaito.tex の対応解答を同じコミットで更新
- 既存の \label を変更・削除しない（相互参照が壊れる）
- 数値例は必ず手計算で検算してから書く
