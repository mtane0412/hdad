/**
 * 作業机の組み込みコマンドの読み取りと、返す文言
 *
 * 作業配信で視聴者も「一緒に作業している側」として画面に出られるよう、チャットの組み込みのコマンドで作業を宣言してもらい、
 * 合成ページの素材「作業机」に並べる（issue #207）。組み込みのコマンドは次の2つで、配信者が登録しなくても動く（方針1）。
 * - `!task <作業>`: 作業を宣言する。打ち直すと差し替える（1人1件）
 * - `!done`: 宣言した作業を完了にする。作業机のその行にチェックが付いて祝われる
 *
 * 通信も時刻も持たない純粋な関数だけを置き、読み書きは worker/task-desk-store.ts、押し出しと返信は worker/task-desk-command.ts が持つ。
 * コマンドのたびに LLM は呼ばない（無料枠が視聴者の発言数しだいにならないため。方針8）。
 *
 * 注意: 作業の文言が上限を超えたら、切り詰めずに受け付けない（方針4）。黙って切り詰めると、本人の書いたものと違う文が配信画面に出る。
 */
import type { WorkTime } from './task-desk-worktime'

/** 組み込みのコマンドの名前（`!` を除き、小文字で比べる）。管理画面で同じ名前のコマンドは登録させない（worker/bot-config.ts） */
export const BUILT_IN_COMMAND_NAMES = ['task', 'done'] as const

/** 作業の文言の上限（見た目の文字数。組み合わせの絵文字も1文字と数える）。作業机の1行に収まる長さにする */
export const MAX_TASK_LENGTH = 40

/** 作業机に並べる人数の上限。未完了の人を優先して残す（worker/task-desk-store.ts の readTaskDesk） */
export const TASK_DESK_LIMIT = 12

/** 作業机の1行。項目は src/task-desk/entry.ts と合わせる */
export interface TaskDeskEntry {
  /** 宣言した視聴者のユーザーID（行を見分けるのに使う） */
  readonly userId: string
  /** 作業机に出す名前（宣言したときの表示名） */
  readonly name: string
  readonly task: string
  /** 宣言した時刻（ISO 8601） */
  readonly declaredAt: string
  /** 完了した時刻（ISO 8601）。未完了なら null */
  readonly doneAt: string | null
}

/**
 * 作業机に出す、作業した時間の合計（worker/task-desk-worktime.ts の WorkTime に、読んだ時刻を添えたもの）。
 * 合成ページは measuredAt からの経過時間 × 作業中の人数を足して、読み直さずに合計を進める。項目は src/task-desk/entry.ts と合わせる
 */
export interface TaskDeskWorkTime extends WorkTime {
  /** 合計を読んだ時刻（ISO 8601） */
  readonly measuredAt: string
}

/** 合成ページへ押し出す、いまの作業机。少人数なので1行ずつではなく丸ごと送り、合成ページは受け取るたびに置き換える */
export interface TaskDeskSnapshot {
  readonly entries: readonly TaskDeskEntry[]
  /** 配信でみんなが作業した時間の合計。配信していない・まだ誰も宣言していなければ null（issue #209） */
  readonly workTime: TaskDeskWorkTime | null
}

/** 受け付けない理由。botがチャットで返す */
export type TaskDeskRefusal =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-long'; readonly length: number }
  | { readonly kind: 'offline' }
  | { readonly kind: 'no-task' }

/** 発言から読み取った組み込みのコマンド */
export type TaskDeskCommand =
  | { readonly kind: 'declare'; readonly task: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'refuse'; readonly refusal: TaskDeskRefusal }

/** コマンドの先頭に付ける文字（worker/chat-command.ts の登録したコマンドと同じ） */
const PREFIX = '!'

/** 見た目の1文字（書記素クラスタ）ごとに分ける。家族や国旗のような組み合わせの絵文字も1文字になる */
const graphemes = new Intl.Segmenter('ja', { granularity: 'grapheme' })

/**
 * 発言から組み込みのコマンドを読み取る。
 *
 * 最初の語だけをコマンド名として見る（worker/chat-command.ts の findCommand と同じ見方）。`!tasks` のように続けて打ったものは別のコマンドとして扱う。
 * `!done` のあとに続く文字（「!done おわった！」など）は無視する。
 *
 * @returns 組み込みのコマンドでなければ null
 */
export const readTaskDeskCommand = (text: string): TaskDeskCommand | null => {
  const trimmed = text.trim()
  if (!trimmed.startsWith(PREFIX)) return null

  const [name = '', ...rest] = trimmed.slice(PREFIX.length).split(/(\s+)/)
  switch (name.toLowerCase()) {
    case 'task': {
      // 区切りの空白も含めて分けたので、つなぎ直せば途中の空白はそのまま残る
      const task = rest.join('').trim()
      if (task === '') return { kind: 'refuse', refusal: { kind: 'empty' } }
      // 文字数は見た目の1文字ずつ数える（UTF-16 の長さやコードポイントの数だと、絵文字が何文字にも数えられて見た目より早く断ってしまう）
      const length = [...graphemes.segment(task)].length
      if (length > MAX_TASK_LENGTH) return { kind: 'refuse', refusal: { kind: 'too-long', length } }
      return { kind: 'declare', task }
    }
    case 'done':
      return { kind: 'complete' }
    default:
      return null
  }
}

/**
 * 受け付けない理由を、botがチャットで返す文言にする。
 *
 * @param login 発言者のログイン名。誰への返事かが分かるよう、先頭で呼びかける
 */
export const refusalReply = (refusal: TaskDeskRefusal, login: string): string => {
  switch (refusal.kind) {
    case 'empty':
      return `@${login} 作業の内容を書いてください（例: !task 資料を読む）`
    case 'too-long':
      return `@${login} 作業は${MAX_TASK_LENGTH}文字以内で書いてください（いまは${refusal.length}文字です）`
    case 'offline':
      return `@${login} 作業机は配信中だけ使えます`
    case 'no-task':
      return `@${login} 完了にする作業がありません。!task 作業の内容 で宣言してください`
  }
}
