---
paths:
  - "worker/agent-*.ts"
---

# エージェント向けAPI（`/api/agent/*`・`/mcp`）

外部の AI エージェント（Muse・Claude Code など）に、過去の配信の文脈を読ませる読み取り専用の道（issue #434〜#436）。

- **守り方は `worker/http.ts` の `requireAgentToken` だけ**（`Authorization: Bearer` と Worker のシークレット `HDAD_AGENT_TOKEN`）。管理画面のセッションでは通さず、シークレットが無い・空なら503にする
- 読み取りだけにする。書き込み・配信に出る操作は足さない
- 返すのは長く残る記録だけ。文字起こしとチャット全文（保存期間が短い）は返さない
- 視聴者が書いた文と、それを材料に LLM が作った文を返す応答には `untrustedFields`（その欄の場所）と `notice` を添える。返す欄を足したら `untrustedFields` も直す
- **読み出しの中身は `worker/agent-routes.ts` の `readAgent*` だけが持つ**。REST の経路と MCP の入口（`worker/agent-mcp.ts`）は値を読んで渡すだけにする
- MCP の入口は SDK を使わず、stateless（1回の POST に JSON-RPC 1つ・`application/json` で応答・セッションも GET の SSE も持たない）にする。新しい Durable Object は足さない
- 経路やツールを足したら `docs/guide/agent-api.md` の一覧も直す

経緯は `docs/decisions/agent-api.md`、利用者向けの説明は `docs/guide/agent-api.md`。
