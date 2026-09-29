/**
 * 描いたものの保存の間引き
 *
 * 描いた線を残す先はKV（worker/draw-config.ts）で、描いている最中の点ひとつごとには書けない
 * （書き込み回数の面でも成り立たない）。そこで書くのは線を1本引き終えた時点とし、そこから数秒
 * まとめてから1度だけ書く。間引きを描く画面の側に置き、Workerは受け取ったものを検証して書くだけにする。
 *
 * 全消しは待たずにすぐ書く。残っていると困る向きの操作なので、遅らせない。
 *
 * 書き込みは前のものが終わってから次を始める。KVへの書き込みの順番が入れ替わると、新しい状態を書いたあとに
 * 古い状態が上書きされてしまう。
 *
 * 注意: 通信そのものは持たず（src/draw/api.ts が持つ）、待ち方と順番だけをここに置く（テストしやすくするため）。
 * 注意: この間引きがあるので、描いた直後に合成ページを読み込み直すと最後の数本が欠けた状態が出ることがある。
 * KVの反映の遅れも合わせて、取り繕わずに受け入れている（docs/decisions/draw.md）。
 */
import type { Strokes } from './strokes'

/**
 * 線を引き終えてから書き込むまで待つ時間（ミリ秒）。
 *
 * 続けて何本も引くあいだは書かずにまとめたいが、待ちすぎると「描いたのに残っていない」時間が長くなる。
 * 数秒を目安にしてある。
 */
export const SAVE_DELAY_MS = 3000

export interface StrokeSaverOptions {
  /** 描いたものを書き込む（src/draw/api.ts の save） */
  save(strokes: Strokes): Promise<void>
  /** 書き込みに失敗した（画面に出して、残っていないことに気付けるようにする） */
  onFailure(message: string): void
}

export interface StrokeSaver {
  /** 線を1本引き終えた。数秒まとめてから書く */
  finished(strokes: Strokes): void
  /** 待たずにすぐ書く（全消し）。待っている書き込みは取り消して置き換える */
  saveNow(strokes: Strokes): void
  /** 待っている書き込みをやめる（画面を離れるときに呼ぶ） */
  cancel(): void
}

/** 描いたものの書き込みを間引く窓口を作る */
export const createStrokeSaver = ({ save, onFailure }: StrokeSaverOptions): StrokeSaver => {
  /** 待っている書き込みの時計 */
  let 待ち時間: ReturnType<typeof setTimeout> | null = null
  /** 直前の書き込み。これが終わってから次を始める（順番が入れ替わらないようにする） */
  let 書き込み中: Promise<void> = Promise.resolve()

  const 取り消す = (): void => {
    if (待ち時間 === null) return
    clearTimeout(待ち時間)
    待ち時間 = null
  }

  const 書く = (strokes: Strokes): void => {
    書き込み中 = 書き込み中.then(async () => {
      try {
        await save(strokes)
      } catch (error) {
        onFailure(error instanceof Error ? error.message : String(error))
      }
    })
  }

  return {
    finished: (strokes) => {
      取り消す()
      待ち時間 = setTimeout(() => {
        待ち時間 = null
        書く(strokes)
      }, SAVE_DELAY_MS)
    },

    saveNow: (strokes) => {
      取り消す()
      書く(strokes)
    },

    cancel: 取り消す,
  }
}
