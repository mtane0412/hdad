/**
 * 設定とトークンの保存先
 *
 * 実体は Cloudflare KV（wrangler.jsonc の STORE）。Workerのコードは KV のうち文字列の読み書きしか使わないため、
 * その範囲だけを型として宣言し、テストではメモリ上の実装（fake-store.ts）に差し替える。
 *
 * 注意: KVは書き込みが他の拠点へ届くまで最大60秒ほどかかる。保存するのは配信者1人分のトークンと
 * オーバーレイ用キーだけで、同時に書き換える利用者がいないため、この遅れは許容している。
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}
