/**
 * 人形の Worker の呼び出し
 *
 * 人形のページ（/dolls/）と視聴者のページ（/viewers/）が、ログインのセッションで人形の組を読み書きし、視聴者に人形を手で渡す。
 * 呼び出しと失敗の扱いは `@/core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 応答が想定した形でなければエラーにする。黙って空の一覧にすると、人形が無いように見えてしまう（Fail-Fast）。
 */
import { createCaller, isRecord, readList } from '@/core/api'
import { isDollHolding, isDollSet, type DollFigure, type DollHolding, type DollKind, type DollSet } from './doll'

const DOLLS_PATH = '/api/admin/dolls'
const CURRENT_PATH = '/api/admin/doll-current'

/** 追加・書き換えで送る、人形の組1組の中身。検証は Worker（worker/doll.ts）だけが持つ */
export interface DollSetInput {
  readonly normal: DollFigure
  readonly super: DollFigure
}

/** 人形の組と、持っている人の所持数 */
export interface DollState {
  readonly sets: DollSet[]
  readonly holdings: DollHolding[]
}

export interface DollApi {
  /** 人形の組（追加した順）と、持っている人の組ごとの所持数を読む */
  list(): Promise<DollState>
  /** 人形の組を追加し、追加した組を返す */
  create(input: DollSetInput): Promise<DollSet>
  /** 人形の組の名前と画像を書き換え、書き換えた組を返す */
  update(id: number, input: DollSetInput): Promise<DollSet>
  /** 人形の組を消す（誰かに渡したことのある組は Worker が拒む） */
  remove(id: number): Promise<void>
  /** いまの人形を選び（null なら選ばない）、組の一覧を返す */
  selectCurrent(setId: number | null): Promise<DollSet[]>
  /** 視聴者にいまの人形を渡す（delta が正）・取り上げる（負）。増減したあとの、その人のいまの人形の所持数を返す */
  change(userId: string, kind: DollKind, delta: number): Promise<DollHolding>
}

/**
 * 応答の set を読む。
 *
 * @throws 想定した形でない場合
 */
const readSet = (body: unknown): DollSet => {
  const set = isRecord(body) ? body.set : undefined
  if (!isDollSet(set)) throw new Error('Workerの人形の組の応答が想定した形ではありません')
  return set
}

export const createDollApi = (fetchImpl: typeof fetch): DollApi => {
  const call = createCaller(fetchImpl)
  const send = (path: string, method: string, body: unknown): Promise<unknown> =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    list: async () => {
      const body = await call(DOLLS_PATH)
      return { sets: readList(body, 'sets', isDollSet), holdings: readList(body, 'holdings', isDollHolding) }
    },
    create: async (input) => readSet(await send(DOLLS_PATH, 'POST', input)),
    update: async (id, input) => readSet(await send(`${DOLLS_PATH}/${id}`, 'PUT', input)),
    remove: async (id) => {
      await call(`${DOLLS_PATH}/${id}`, { method: 'DELETE' })
    },
    selectCurrent: async (setId) => readList(await send(CURRENT_PATH, 'PUT', { setId }), 'sets', isDollSet),
    change: async (userId, kind, delta) => {
      const body = await send(`/api/admin/viewers/${encodeURIComponent(userId)}/dolls`, 'POST', { kind, delta })
      const holding = isRecord(body) ? body.holding : undefined
      if (!isDollHolding(holding)) throw new Error('Workerの人形の増減の応答が想定した形ではありません')
      return holding
    },
  }
}
