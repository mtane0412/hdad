/**
 * 手書きで描いたものの保存
 *
 * 描いた線は中継先（worker/draw-channel.ts）を通って合成ページへ届くが、中継先は開いている接続の間だけの
 * 通り道である。OBSのブラウザソースを作り直したりOBSを再起動したりすると、それまでに描いたものは消えてしまう。
 * そこで引き終えた線をここでKVへ写し、合成ページと描く画面が開いたときに読み直せるようにする（issue #133）。
 *
 * 書くのは線を1本引き終えた時点（描く画面の側で数秒デバウンスしてまとめる。src/draw/save.ts）で、
 * Workerは受け取ったものを検証して書くだけである。KVは反映まで最大60秒かかるため、描いた直後に
 * 合成ページを読み込み直すと最後の数本が欠けた状態が出ることがある。取り繕わずに受け入れている
 * （理由は docs/decisions/draw.md）。
 *
 * 作りは focus-config.ts と同じで、問題点は最初の1件で止めずにすべて集めてから拒む。
 * 線1本ぶんとして読めるかの判定は src/draw/strokes.ts の isStroke だけが持ち、ここはそれを何本目かの
 * 名前付きで呼ぶ通り道である（描く画面・合成ページとWorkerで書き分けると、片方だけが通す形ができる）。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない（focus-config.ts と同じ）。
 */
import { MAX_STROKES, isStroke, type Stroke } from '../src/draw/strokes'
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

const CONFIG_KEY = 'draw-strokes'
/** 問題点のメッセージに出す、何の設定かの名前 */
const SUBJECT = '手書きで描いたもの'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * 描く画面から送られてきた内容を検証し、保存用の形にする。
 *
 * @param input { strokes: 描いた線の配列 } の形を期待する（全消しの直後は空の配列になる）
 * @throws ConfigError 問題が1件でもある場合
 */
export const parseStrokes = (input: unknown): readonly Stroke[] => {
  if (!isRecord(input)) throw new ConfigError(SUBJECT, ['保存する内容はオブジェクトで指定してください'])
  const strokes = input.strokes
  if (!Array.isArray(strokes)) throw new ConfigError(SUBJECT, ['strokes: 描いた線の配列で指定してください'])

  const problems: string[] = []
  if (strokes.length > MAX_STROKES) problems.push(`strokes: 描いた線は${MAX_STROKES}本までにしてください`)

  // 送り主が足した項目を抱え込まないよう、読めた項目だけを写して持つ
  const 読んだ線: Stroke[] = []
  for (const [番号, 線] of strokes.entries()) {
    if (!isStroke(線)) {
      problems.push(`strokes[${番号}]: 線は名前・点の配列・選べる色と太さの名前を持つ形で指定してください`)
      continue
    }
    読んだ線.push({ id: 線.id, points: 線.points.map(({ x, y }) => ({ x, y })), color: 線.color, width: 線.width })
  }
  if (problems.length > 0) throw new ConfigError(SUBJECT, problems)
  return 読んだ線
}

export const saveStrokes = (store: KeyValueStore, strokes: readonly Stroke[]): Promise<void> =>
  store.put(CONFIG_KEY, JSON.stringify({ strokes }))

/**
 * 保存済みの描いたものを読む。一度も保存していなければ空の配列（何も描かれていない）を返す。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
export const loadStrokes = async (store: KeyValueStore): Promise<readonly Stroke[]> => {
  const text = await store.get(CONFIG_KEY)
  if (text === null) return []
  return (JSON.parse(text) as { strokes: readonly Stroke[] }).strokes
}
