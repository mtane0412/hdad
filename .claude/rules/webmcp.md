---
paths:
  - "src/webmcp/**"
  - "src/app/bottom-bar.tsx"
---

# エージェント向けのツール（WebMCP）

アプリのページ（`src/app/`）は、WebMCP（`document.modelContext.registerTool`）でページUIの操作をツールとして登録し、ブラウザのエージェントから呼べるようにする（issue #279〜#282）。

- **ツールの定義は `src/webmcp/` の `tools.ts`（段階1）と段階ごとのファイル（`broadcast-tools.ts` など）だけが持ち**、通信もDOMも持たない。`tools.ts` の `buildTools` がまとめて返す。アプリの枠の状態と操作は `WebMcpDeps` で受け取り、状態は呼ぶたびに最新を返す関数で渡す（登録し直さない）。Worker の Api は `WebMcpDeps.apis` にアプリの枠の `PageContext` をそのまま渡す
- 入力の読み取り（型と候補の確かめ）は `src/webmcp/input.ts` に集める
- **登録は下部バーに置いた `src/webmcp/webmcp-tools.tsx` が行い**、ログインしているあいだだけ登録して、ログアウトでは `AbortSignal` を止めてまとめて消す。OBSに載せるページには持ち込まない
- **ツールは画面のボタンと同じ道を通す**（BGMは `useBgmPlayer`、ポモドーロは `usePomodoroTimer`、文字起こしは `useRecognition`）。Workerの Api を直接呼ぶのは、画面側が状態を持ち続けないもの（読み上げのミュート・チャットの送信・注目コメント・試し再生）だけ
- `document.modelContext` が無いのはブラウザが対応していないだけなので、何も登録せず何も出さない。登録を断られたら、先に登録できたツールも消して下部バーに理由を出す
- 入力は `inputSchema` で示したうえで `execute` でも確かめ、受け付けない値は投げる（既定値に丸めない）。結果は文字列で返し、状態は JSON の文字列にする
- 状態を読むだけのツールには `readOnlyHint: true` を付ける。配信に直接出る操作（チャットの送信など。段階2）には `consequentialHint: true`、視聴者が書いた文を返すもの（段階3）には `untrustedContentHint: true` を付ける
- 値の検証は Worker だけが持つ（`.claude/rules/implementation.md`）。設定を保存するツール（段階4）は、Worker が返した問題点をそのまま返す
- ツールを足したら `docs/guide/webmcp.md` のツールの一覧も直す

経緯は `docs/decisions/webmcp.md`、利用者向けの説明は `docs/guide/webmcp.md`。
