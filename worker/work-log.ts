/**
 * 作業ログの1行の組み立て
 *
 * 作業配信に途中から来た人へ「今日ここまでにやったこと」を見せるため、合成ページの素材「作業ログ」に
 * その配信の出来事を時刻つきで並べる（issue #211）。並べるのは次の2つで、どちらもここで同じ形（WorkLogEntry）にする。
 * - 開発の出来事（GitHub の Webhook で届くコミットの push・PR のマージ）。実際に起きたこと
 * - 章の見出し（cron が LLM に作らせたもの。worker/stream-chapter.ts）。機械がまとめたこと
 *
 * 機械が作った見出しと実際に起きた出来事は、種類（kind）で見分けて画面でも別の見た目にする（方針11）。
 * 通信も時刻も持たない純粋な関数だけを置き、読み書きは worker/work-log-store.ts、押し出しは worker/alert-channel.ts が持つ。
 *
 * 注意: 通知の中身は読み解かない。読み解くのは worker/alert-event.ts の extract だけで、ここはその結果を受け取る
 * （同じ通知を2か所で読み解かない）。
 */
import type { Extracted } from './alert-event'
import type { StreamChapter } from './stream-chapter-store'

/** 1回に読み出す・合成ページが持っておく行数の上限。古いものから落とす（配信画面の箱に収まるのはこれより少ない） */
export const WORK_LOG_LIMIT = 20

/** 開発の出来事の種類。commit はコミットの push、merge は PR のマージ */
export type DevEventKind = 'commit' | 'merge'

/** 作業ログの1行の種類。chapter だけが機械（LLM）の作ったもの */
export type WorkLogKind = DevEventKind | 'chapter'

/** 作業ログの1行。項目は src/work-log/entry.ts と合わせる */
export interface WorkLogEntry {
  /** 押し出しと読み直しで同じ行を重ねるための識別子（開発の出来事は 'github:<X-GitHub-Delivery>'、章は 'chapter:<区間の始まり>'） */
  readonly id: string
  readonly kind: WorkLogKind
  /** 並べる時刻（ISO 8601）。開発の出来事は届いた時刻、章は区間の始まり */
  readonly at: string
  /** 出す1行 */
  readonly text: string
}

/** 残す開発の出来事（時刻と配信は残すときに決まる） */
export interface DevEventInput {
  readonly id: string
  readonly kind: DevEventKind
  readonly text: string
}

/**
 * 通知から取り出した項目を、開発の出来事の種類と1行にする。
 *
 * push は最後のコミットのメッセージの1行目（トリガーの差し込み語 {message} と同じもの）、PR のマージは「#番号 タイトル」にする。
 * リポジトリ名は出さない。Webhook を設定するのは配信者自身のリポジトリで、毎行に同じ名前が並ぶだけになるためである。
 *
 * @returns 開発の出来事でなければ null
 */
export const devEventOf = (extracted: Extracted): Pick<DevEventInput, 'kind' | 'text'> | null => {
  switch (extracted.event) {
    case 'github.push':
      return { kind: 'commit', text: extracted.commitMessage }
    case 'github.pull_request.merged':
      return { kind: 'merge', text: `#${extracted.number} ${extracted.title}` }
    default:
      return null
  }
}

/**
 * 章を作業ログの1行にする。
 *
 * 出すのは見出しだけで、要約は出さない（配信画面の1行に収まらず、読み返すのはダッシュボードの配信の詳細で足りるため）。
 * 時刻は区間の始まりにする。区間の終わりは章ができた時刻に近く、その間の出来事より上に並ぶと「この話のあとにマージした」と読めなくなる。
 */
export const chapterEntryOf = (chapter: StreamChapter): WorkLogEntry => ({
  id: `chapter:${chapter.startedAt}`,
  kind: 'chapter',
  at: chapter.startedAt,
  text: chapter.title,
})
