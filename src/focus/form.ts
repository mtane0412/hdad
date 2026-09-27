/**
 * 注目コメントの入力欄の値の変換
 *
 * 画面（focus-page.tsx）から分けてテストする（src/admin/form.ts・src/speech/form.ts と同じ扱い）。
 */
import type { PickableMessage } from './api'

/** 追従する相手の選択欄に並べる1人 */
export interface Speaker {
  /** ログイン名（そのまま保存する値になる） */
  readonly login: string
  /** 選択欄に出す表示名 */
  readonly displayName: string
}

/**
 * 直近の発言の一覧から、発言した人を重複なく取り出す。
 *
 * 一覧は発言ごとの並び（新しい順）なので、同じ人が何度も発言していれば同じ人が何度も現れる。
 * 選択欄にはその人を1回だけ、いちばん新しい発言の順・いちばん新しい表示名で並べる
 * （名前を変えた人を古い名前で出さないため。視聴者の記録が login と display_name を
 * 「最後に見た名前」として持つのと同じ考え方）。
 *
 * @param messages 直近の発言（新しい順）
 */
export const speakersOf = (messages: readonly PickableMessage[]): Speaker[] => {
  const speakers = new Map<string, Speaker>()
  for (const message of messages) {
    // 先に入った（＝より新しい発言の）名前を残す
    if (!speakers.has(message.login)) speakers.set(message.login, { login: message.login, displayName: message.displayName })
  }
  return [...speakers.values()]
}
