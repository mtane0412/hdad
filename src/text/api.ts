/**
 * テキストの Worker の呼び出し
 *
 * 2つの呼び出し手がある。
 * - 合成ページの素材「テキスト」: ログインを持たないので、オーバーレイ用キー（URLの ?key=）で Worker に受け付けてもらう。
 *   テキストが変わるたびに WebSocket（TEXT_SOCKET_PATH）で一覧を丸ごと押し出してもらい、ここで読むのは開いたとき・つなぎ直したとき・
 *   定期的に取り戻す分だけである
 * - アプリのページ（/texts/）・下部バー・オーバーレイのページ: ログインのセッションで、テキストを読み・追加し・書き換え・消す
 *
 * 呼び出しと失敗の扱いは `../core/api` に任せ、fetch を引数で受け取るのはテストで差し替えるためである。
 *
 * 注意: 想定した形でなければエラーにする（Fail-Fast）。テキストの形の確かめは entry.ts の isTextEntry だけが持つ。
 */
import { createCaller, isRecord } from '../core/api'
import { isTextEntry, readTextList, type TextEntry } from './entry'

const OVERLAY_PATH = '/api/overlay/texts'
const ADMIN_PATH = '/api/admin/texts'

/** 変わったテキストの一覧を押し出してもらう WebSocket のパス */
export const TEXT_SOCKET_PATH = '/api/overlay/texts/socket'

/** 一度もつながらないまま閉じたときに出す、いちばんありそうな原因 */
export const TEXT_SOCKET_HINT = 'テキストの配送先につながりません。URLのオーバーレイ用キーが正しいか確かめてください'

/** 追加・書き換えで送る、テキスト1件の中身。検証は Worker（worker/text.ts）だけが持つ */
export interface TextInput {
  readonly name: string
  readonly body: string
}

export interface TextOverlayApi {
  /** テキストの一覧を読む */
  read(): Promise<TextEntry[]>
}

export interface TextApi {
  /** テキストを追加した順に読む */
  list(): Promise<TextEntry[]>
  /** テキストを追加し、追加したテキスト（振られたIDを含む）を返す */
  create(input: TextInput): Promise<TextEntry>
  /** テキストの名前と本文を書き換え、書き換えたテキストを返す */
  update(id: number, input: TextInput): Promise<TextEntry>
  /** テキストを消す */
  remove(id: number): Promise<void>
}

/**
 * 応答の text を読む。
 *
 * @throws 想定した形でない場合
 */
const readText = (body: unknown): TextEntry => {
  const text = isRecord(body) ? body.text : undefined
  if (!isTextEntry(text)) throw new Error('テキストの応答の形が想定と違います')
  return text
}

/**
 * 合成ページからの読み出しを組み立てる。
 *
 * @param fetchImpl 通信の実装。fetch をそのまま渡すと this が外れるブラウザがあるため、包んだものを受け取る
 * @param key オーバーレイ用キー
 */
export const createTextOverlayApi = (fetchImpl: typeof fetch, key: string): TextOverlayApi => {
  const call = createCaller(fetchImpl)
  const path = `${OVERLAY_PATH}?key=${encodeURIComponent(key)}`
  return {
    read: async () => readTextList(await call(path)),
  }
}

/**
 * アプリのページ・下部バー・オーバーレイのページからの読み書きを組み立てる。
 *
 * @param fetchImpl 通信の実装（同上）
 */
export const createTextApi = (fetchImpl: typeof fetch): TextApi => {
  const call = createCaller(fetchImpl)
  const send = (path: string, method: string, body: unknown): Promise<unknown> =>
    call(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    list: async () => readTextList(await call(ADMIN_PATH)),
    create: async (input) => readText(await send(ADMIN_PATH, 'POST', input)),
    update: async (id, input) => readText(await send(`${ADMIN_PATH}/${id}`, 'PUT', input)),
    remove: async (id) => {
      await call(`${ADMIN_PATH}/${id}`, { method: 'DELETE' })
    },
  }
}
