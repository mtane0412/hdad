/**
 * Twitchのトークンの保管庫（Durable Object）
 *
 * 配信者とチャットボットのトークンを、この Durable Object の保管（storage）に役割ごとに持つ。読む・書く・消すに加えて、
 * 「保存済みのトークンが期待どおりのときだけ置き換える」を1回の要求で受け付ける。トークンの更新（worker/token.ts の
 * getAccessToken）は、Twitchで取り直した結果をこの置き換えで書き戻す。
 *
 * 置き場所をKV（STORE）からここへ移したのは、更新と切断・付け替えの競合をなくすためである（issue #201・#220）。
 * KVには条件付きの書き込みがなく、読み直してから書き込むまでの間に切断・付け替えが割り込むと、旧トークンが書き戻される。
 * さらにKVは書き込みが他の拠点へ届くまで最大60秒かかるので、別の拠点で切断した直後には読み直しても古い値が見える。
 * Durable Object は1か所で動き、置き換えの要求の中では同期の保管（ctx.storage.kv）を読んで比べてから書くまでの間に
 * await を挟まないので、ほかの要求が割り込めない。
 *
 * この Durable Object は保管と比べることだけを受け持ち、Twitchへの更新はしない（呼ぶのは Worker 側で、Twitchの代役を
 * 差し替えてテストできる形を保つ）。
 *
 * 注意: 以前はKVに保存していたので、起きるたびに1度だけ（保管に移し終えた目印が無いときだけ）KVから移し、KVからは消す
 * （migrateLegacyTokens）。移し終えたあとはKVを読まない。KVの古い値が遅れて見えても、切断で消したトークンを戻さないため。
 */
import type { StoredToken, TokenRole } from './token'
import type { KeyValueStore } from './store'
import type { Env } from './http'
import { STATUS } from './http'

/** Durable Object の名前。保管庫は1つだけなので、決め打ちの名前で同じものを指す */
export const TOKEN_VAULT_NAME = 'tokens'

/** トークンの読み書き（GET・PUT・DELETE）のパス。外には出ない（呼ぶのは Worker だけ） */
export const TOKEN_PATH = '/token'

/** 期待どおりのときだけ置き換えるパス（POST） */
export const REPLACE_PATH = '/token/replace'

const TOKEN_ROLES: readonly TokenRole[] = ['broadcaster', 'bot']

/**
 * 以前トークンを保存していたKVのキー。移し替え（migrateLegacyTokens）でだけ読む。
 *
 * 配信者のキーは、役割を分ける前から使っていた 'twitch-token' である。
 */
const LEGACY_KV_KEYS: Record<TokenRole, string> = {
  broadcaster: 'twitch-token',
  bot: 'twitch-token:bot',
}

/** KVからの移し替えを済ませた目印の鍵 */
const MIGRATED_KEY = 'legacy-kv-migrated'

/**
 * 保管庫が使う同期の保管。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の SQLite を土台にした Durable Object の ctx.storage.kv（SyncKvStorage）はこの形を満たす。
 * 同期なので、読んでから書くまでの間に await を挟まずに済む（置き換えに割り込まれない理由）。
 */
export interface TokenVaultStorage {
  get(key: string): string | undefined
  put(key: string, value: string): void
  delete(key: string): boolean
}

/**
 * Worker が保管庫を呼ぶための入口。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectNamespace はこの形を満たす。
 */
export interface TokenVaultNamespace {
  idFromName(name: string): DurableObjectId
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> }
}

/** 置き換えの条件。保存済みのトークンがこのアカウントの、このリフレッシュトークンのものであること */
export interface ReplaceExpectation {
  userId: string
  refreshToken: string
}

/**
 * 置き換えの結果。
 *
 * - replaced: 置き換えた
 * - missing: 保存済みのトークンが無い（切断された）ので書き込まなかった
 * - changed: 保存済みのトークンが別のもの（付け替えられた・接続し直された）なので書き込まなかった
 */
export type ReplaceResult = 'replaced' | 'missing' | 'changed'

/** 置き換えの要求の本文 */
interface ReplaceRequest {
  expected: ReplaceExpectation
  next: StoredToken
}

const isTokenRole = (value: string | null): value is TokenRole => TOKEN_ROLES.some((role) => role === value)

const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

/**
 * 保存済みのトークンを期待と比べ、一致すれば置き換える。
 *
 * 注意: 読んでから書くまでの間に await を挟まない。挟むとほかの要求（切断・付け替え）が割り込めてしまう。
 */
const replaceIfUnchanged = (storage: TokenVaultStorage, role: TokenRole, { expected, next }: ReplaceRequest): ReplaceResult => {
  const currentText = storage.get(role)
  if (currentText === undefined) return 'missing'
  const current = JSON.parse(currentText) as Partial<StoredToken>
  if (current.userId !== expected.userId || current.refreshToken !== expected.refreshToken) return 'changed'
  storage.put(role, JSON.stringify(next))
  return 'replaced'
}

/**
 * 保管庫への要求を処理する。
 *
 * - GET /token?role=… 保存済みのトークン（JSON）。無ければ404
 * - PUT /token?role=… 本文のトークンを保存する（ログイン・接続・付け替え）
 * - DELETE /token?role=… 消す（切断）。無くてもエラーにしない
 * - POST /token/replace?role=… 期待どおりのときだけ置き換え、結果を { result } で返す
 *
 * 本文の形は確かめない。呼ぶのは Worker（worker/token.ts）だけで、読み出す側（loadToken）が形を確かめるため。
 */
export const handleTokenVaultRequest = async (storage: TokenVaultStorage, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const role = url.searchParams.get('role')
  if (!isTokenRole(role)) return new Response(null, { status: STATUS.badRequest })

  if (url.pathname === REPLACE_PATH && request.method === 'POST') {
    const body = (await request.json()) as ReplaceRequest
    return json({ result: replaceIfUnchanged(storage, role, body) })
  }
  if (url.pathname !== TOKEN_PATH) return new Response(null, { status: STATUS.notFound })

  switch (request.method) {
    case 'GET': {
      const text = storage.get(role)
      return text === undefined ? new Response(null, { status: STATUS.notFound }) : new Response(text, { headers: { 'Content-Type': 'application/json' } })
    }
    case 'PUT': {
      const token = (await request.json()) as StoredToken
      storage.put(role, JSON.stringify(token))
      return new Response(null, { status: STATUS.noContent })
    }
    case 'DELETE':
      storage.delete(role)
      return new Response(null, { status: STATUS.noContent })
    default:
      return new Response(null, { status: STATUS.methodNotAllowed })
  }
}

/**
 * 以前KVに保存していたトークンを保管庫へ移し、KVからは消す。移し終えていれば何もしない。
 *
 * 注意: 移し終えた目印は、KVにトークンが無かったときにも付ける。付けないと、切断で消したあとに、
 * 他の拠点へ遅れて届いたKVの古い値を移し直してしまうため。
 */
export const migrateLegacyTokens = async (storage: TokenVaultStorage, legacyStore: KeyValueStore): Promise<void> => {
  if (storage.get(MIGRATED_KEY) !== undefined) return

  for (const role of TOKEN_ROLES) {
    const text = await legacyStore.get(LEGACY_KV_KEYS[role])
    if (text !== null) storage.put(role, text)
  }
  storage.put(MIGRATED_KEY, new Date().toISOString())
  // 保管庫へ移してから消す。逆にすると、消したあとに失敗したときトークンがどこにも残らない
  for (const role of TOKEN_ROLES) await legacyStore.delete(LEGACY_KV_KEYS[role])
}

/**
 * Durable Object から使う状態。テストで差し替えられるよう、使うものだけを受け取る。
 *
 * Cloudflare の DurableObjectState はこの形を満たす。
 */
export interface TokenVaultState {
  storage: { kv: TokenVaultStorage }
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>
}

/**
 * トークンを保管する Durable Object。
 *
 * 起きたときに、KVからの移し替えを済ませるまでほかの要求を待たせる（blockConcurrencyWhile）。
 */
export class TokenVault {
  constructor(
    private readonly ctx: TokenVaultState,
    env: Pick<Env, 'STORE'>,
  ) {
    void ctx.blockConcurrencyWhile(() => migrateLegacyTokens(ctx.storage.kv, env.STORE))
  }

  fetch(request: Request): Promise<Response> {
    return handleTokenVaultRequest(this.ctx.storage.kv, request)
  }
}
