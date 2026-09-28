# HDAD

**Hyperfocus-Driven Assistant Director** — Twitch配信の進行を裏で受け持つアシスタントです。

Twitch配信用の素材と、配信中に動くアシスタント（チャットボット・アラート・テロップ・読み上げ）を1つのリポジトリにまとめています。Cloudflare Workers で公開し、OBSのブラウザソースからURLで読み込みます。

- **素材とオーバーレイ** — 壁紙・時計・チャットボックス・アラート・サイドスーパー・注目コメントを、OBSに貼るURLとして配ります
- **配信のアシスタント** — Twitchのイベントを受けてアラートを出し、botとしてチャットへ返し、視聴者と配信の記録を残します
- **ページUI** — ダッシュボード・ギャラリー・各管理画面は、配信者のTwitchログインを前提にしたサイドバー付きのアプリ（トップの `index.html` ひとつ）です。OBSに載せる素材ページはログインなしで動きます

## 使いはじめる

自分の配信で使うには、このリポジトリをフォークして自分の Cloudflare アカウントへデプロイします。下のボタンを押すと、フォーク・リソース（KV・R2・D1）の作成・シークレットの入力・デプロイまで進みます。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mtane0412/hdad)

**押す前に済ませることと、押したあとの仕上げの手順は [デプロイ](./docs/guide/deploy.md) にあります**（R2の有効化とTwitchのアプリ登録が先に必要です）。

## ドキュメント

画面・素材ごとの使い方は [`docs/guide/`](./docs/guide/README.md) にあります。

| 分類 | 文書 |
| --- | --- |
| 素材とオーバーレイ | [壁紙](./docs/guide/wallpaper.md)・[時計](./docs/guide/clock.md)・[チャットボックス](./docs/guide/chat.md)・[アラート](./docs/guide/alerts.md)・[チャットの読み上げ](./docs/guide/speech.md)・[配信中の文字起こし](./docs/guide/transcript.md)・[サイドスーパー](./docs/guide/side-super.md)・[注目コメント](./docs/guide/focus.md)・[合成オーバーレイ](./docs/guide/overlay.md)・[裏方](./docs/guide/backstage.md) |
| 配信のアシスタント | [チャットボット](./docs/guide/bot.md)・[文面を作らせるLLM](./docs/guide/llm.md)・[視聴者の記録](./docs/guide/viewers.md)・[配信の記録](./docs/guide/stats.md) |
| 導入と開発 | [デプロイ](./docs/guide/deploy.md)・[開発](./docs/guide/development.md) |
| 設計判断の記録 | [`docs/decisions/`](./docs/decisions/) |

## 開発

```bash
npm install
npm run dev         # 開発サーバー（Workerも一緒に動く。http://localhost:5173/）
npm run lint        # Lint（警告ゼロ必須）
npm run type-check  # 型チェック
npm test            # テスト
npm run build       # dist/ へビルド
```

シークレットの渡し方、素材やデザインを足す手順は [開発](./docs/guide/development.md) にあります。

## ライセンス

[MIT License](./LICENSE)
