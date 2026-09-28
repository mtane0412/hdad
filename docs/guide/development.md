# 開発

```bash
npm install
npm run dev         # 開発サーバー（Workerも一緒に動く。http://localhost:5173/）
npm run dev:op      # シークレットを 1Password から渡して開発サーバーを起動する（下記）
npm run lint        # Lint（警告ゼロ必須）
npm run type-check  # 型チェック
npm test            # テスト
npm run build       # dist/ へビルド（静的アセットは dist/client/、Workerとデプロイ用の設定は dist/hdad/）
npm run preview:worker  # ビルドして、Workersと同じ配信挙動をローカルで確認（wrangler dev）
```

## シークレットを 1Password から渡す（任意）

`.dev.vars` を置かずに開発したい場合は、`npm run dev:op` を使います。`.dev.vars.op.example` を `.dev.vars.op` にコピーし、`op://<保管庫>/<項目>/<フィールド>` の参照を自分の 1Password に合わせて書き換えてください（`.dev.vars.op` は `.gitignore` 済みです）。

仕組みは「`op run` が参照を解決してプロセスの環境変数に入れ、wrangler がそれを Worker の vars として読む」というもので、後半は `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`（テンプレートに書いてあります）で有効になります。**`.dev.vars` が実ファイルとして在るときはそちらが優先される**ので、ふだんの `npm run dev` の手順は変わりません。

**`.dev.vars` を名前付きパイプ（1Password Environments が作るもの）にはできません。** `@cloudflare/vite-plugin` は Worker の環境を組み立てるたびに `.dev.vars` を読み直しますが、パイプは流された内容を一度しか渡せないため、2回目以降の読み出しで `socket hang up (ECONNRESET)` になる（書き手がいなければ起動したまま止まる）ためです。

## 壁紙の背景を追加する

1. `src/wallpaper/<id>.ts` に `defineBackground` で背景（パラメータのスキーマと描画関数）を定義する
2. `src/wallpaper/registry.ts` に登録する
3. 既存の `wallpaper/aurora/index.html` を `wallpaper/<id>/index.html` に複製し、`data-background` と `<title>` を `<id>` に変える

2と3の対応は `src/wallpaper/registry.test.ts` が検証します。ギャラリーの調整欄はスキーマから自動生成されます。

## 時計を追加する

1. `src/clock/<id>.ts` に `defineBackground` で時計を定義する（現在時刻は描画関数に渡される `frame.now` を使う）
2. `src/clock/registry.ts` に登録する
3. 既存の `clock/digital/index.html` を `clock/<id>/index.html` に複製し、`data-clock` と `<title>` を `<id>` に変える

2と3の対応は `src/clock/registry.test.ts` が検証します。ギャラリーの調整欄はスキーマから自動生成されます。

## チャットボックスのデザインを追加する

チャットボックスは canvas ではなくHTML要素で表示します。メッセージのHTML構造（`src/chat/view.ts`）は全デザイン共通で、デザインごとの違いはCSSで表します。

1. `src/chat/<id>.ts` に `defineChat` でデザインを定義する（スキーマの先頭に `commonChatSchema` を展開し、`cssVariables` でパラメータをCSSのカスタムプロパティに変換する）
2. `src/chat/<id>.css` に見た目を書く（セレクタは `[data-chat='<id>']` から始める）
3. `src/chat/registry.ts` に登録する
4. 既存の `chat/bubble/index.html` を `chat/<id>/index.html` に複製し、`data-chat`・CSSのパス・`<title>` を `<id>` に変える

3と4の対応は `src/chat/registry.test.ts` が検証します。
