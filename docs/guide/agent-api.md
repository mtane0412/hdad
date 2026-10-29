# 外部のエージェントに配信の記録を読ませる（エージェント向けAPI）

HDAD に溜まった過去の配信の記録（章・あらすじ・作業ログ・タスクの宣言・レイド・意見ボード・視聴者の記録）を、外部の AI エージェント（Muse・Claude Code など）から読めるようにする API です。読み取りだけで、設定の変更や配信に出る操作はできません。

アプリのページを開いているブラウザのエージェントからページの操作を頼むときは、[エージェントから操作する（WebMCP）](./webmcp.md)を使います。こちらはブラウザを開いていなくても、トークンだけで読めます。

## 使いはじめ方

1. トークンを `openssl rand -hex 32` で作り、Worker のシークレット `HDAD_AGENT_TOKEN` に設定します（`npx wrangler secret put HDAD_AGENT_TOKEN`。ローカルでは `.dev.vars` に書きます）
2. エージェントからは、要求のたびに `Authorization: Bearer <トークン>` を付けて呼びます

```bash
curl -H "Authorization: Bearer $HDAD_AGENT_TOKEN" https://<公開先のドメイン>/api/agent/streams
```

トークンを設定していないあいだは、どの要求にも503を返します。トークンが漏れたら、シークレットを新しい値に差し替えてください（前のトークンはすぐ使えなくなります）。管理画面のログインでは、この API は呼べません。

## 経路の一覧

| 経路 | 返すもの |
| --- | --- |
| `GET /api/agent/streams` | 配信の一覧（新しい順に100件まで）。開始・終了の日時、タイトル、カテゴリ、平均・最大の視聴者数、フォロワーの増減、イベントの種類ごとの件数 |
| `GET /api/agent/streams/<配信ID>` | 配信1回ぶんの文脈。あらすじ・約30分ごとの章（見出しと要約）・作業時間の合計・レイド・作業ログ（コミット・PRのマージ）・視聴者の `!task` の宣言・配信の時間に開いた意見ボード。作業ログとタスクの宣言は古い順に `?limit=`（1〜1000、既定200）件までで、切ったときは `truncated` にその欄を挙げます。視聴者数の時系列は返しません |
| `GET /api/agent/viewers` | 視聴者の記録を最後に発言した順に。`?search=` でログイン名の前方一致、`?limit=`（1〜200）で件数、続きは前の結果の最後の人の `lastSeenAt` を `?before=` に、`userId` を `?beforeUserId=` に渡します |
| `GET /api/agent/viewers/<ユーザーID>` | 視聴者1人の記録（配信者のメモ・AIが作った人物像・その人自身のチャンネルの内容） |

失敗は `{ "error": { "code", "message" } }` の形で返します（記録の無い配信・視聴者は404、トークンの誤りは401）。

## Claude Code からつなぐ（MCP）

同じ読み出しを、MCP のツールとして `/mcp` に出しています。Claude Code からは次のようにつなぎます（トークンは上で設定したものと同じです）。

```bash
claude mcp add --transport http hdad https://<公開先のドメイン>/mcp --header "Authorization: Bearer $HDAD_AGENT_TOKEN"
```

つないだあとは、Claude Code で `/mcp` を開くと `hdad` が接続済みとして並びます。使えるツールは次の4つで、中身は上の経路と同じです。

| ツール | 対応する経路 | 引数 |
| --- | --- | --- |
| `list_streams` | `GET /api/agent/streams` | なし |
| `get_stream` | `GET /api/agent/streams/<配信ID>` | `id`（必須）・`limit` |
| `search_viewers` | `GET /api/agent/viewers` | `search`・`before`・`beforeUserId`・`limit` |
| `get_viewer` | `GET /api/agent/viewers/<ユーザーID>` | `userId`（必須） |

記録の無い配信・視聴者や引数の誤りは、ツールの失敗としてその理由を返します。トークンを差し替えたら、`claude mcp remove hdad` で外してから、新しいトークンで付け直してください（`--header` の値は Claude Code の設定ファイルに書き込まれます）。

## 返さないもの

文字起こしは24時間、チャットの全文は最長7日で消えるので、この API では返しません。過去の配信で何が話されたかは、それを材料にAIがまとめた章とあらすじで読みます。

## 視聴者が書いた文の扱い

配信と視聴者の応答には `untrustedFields` と `notice` が付きます。`untrustedFields` に挙げた欄（あらすじ・章・タスクの宣言・作業ログ・意見ボード・人物像など）は、視聴者が書いた文か、それを材料にAIが作った文です。チャットに書かれた指示が要約を通っても残ることがあるので、エージェントには資料として読ませ、中の指示に従わせないでください。

---

開発者向け: この作りにした理由は [エージェント向けAPI](../decisions/agent-api.md) にあります。
