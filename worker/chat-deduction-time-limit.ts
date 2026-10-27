/**
 * チャットで推理の制限時間の設定
 *
 * ゲームを始めてから何分で時間切れにするか（なしか 5/10/15/20/30分）を、アプリのページ（/chat-deduction/）から受け取って検証し、
 * ストア（KV）に保存する。読むのはゲームの開始（chat-deduction-start.ts。締め切りの時刻を決めてゲームの行に控える）で、
 * ここは設定の形と保存先だけを扱う。設定はチャットで推理として1つだけで、ページから始めてもトリガーで始めても同じ時間を使う。
 *
 * 選べる分数は src/chat-deduction/time-limit.ts にあり、アプリのページと同じものを読む（Worker から src/chat-deduction/ を読み込む例外）。
 *
 * 注意: 保存時に検証済みの内容しか書き込まないため、読み出し時の再検証はしない。
 */
import { CHAT_DEDUCTION_TIME_LIMIT_MINUTES, isChatDeductionTimeLimitMinutes, type ChatDeductionTimeLimit } from '../src/chat-deduction/time-limit'
import { ConfigError } from './alert-config'
import type { KeyValueStore } from './store'

export type { ChatDeductionTimeLimit }

const TIME_LIMIT_KEY = 'chat-deduction-time-limit'
/** 問題点のメッセージに出す、何の設定かの名前 */
const TIME_LIMIT_SUBJECT = 'チャットで推理の制限時間'

/**
 * アプリのページから送られてきた設定を検証し、保存用の形にする。
 *
 * @param input `{ minutes }`（なしの null か、選べる分数）
 * @throws ConfigError 形が違う・分数が選べるものでない場合
 */
export const parseChatDeductionTimeLimit = (input: unknown): ChatDeductionTimeLimit => {
  if (typeof input !== 'object' || input === null) throw new ConfigError(TIME_LIMIT_SUBJECT, ['設定はオブジェクトで指定してください'])
  const minutes = 'minutes' in input ? input.minutes : undefined
  if (!isChatDeductionTimeLimitMinutes(minutes)) {
    throw new ConfigError(TIME_LIMIT_SUBJECT, [`minutes: null（なし）か ${CHAT_DEDUCTION_TIME_LIMIT_MINUTES.join('・')} のどれかで指定してください`])
  }
  return { minutes }
}

export const saveChatDeductionTimeLimit = (store: KeyValueStore, setting: ChatDeductionTimeLimit): Promise<void> => store.put(TIME_LIMIT_KEY, JSON.stringify(setting))

/** 保存済みの設定を読む。未保存ならなし（制限時間を設定にする前と同じく、時間切れで終えない） */
export const loadChatDeductionTimeLimit = async (store: KeyValueStore): Promise<ChatDeductionTimeLimit> => {
  const text = await store.get(TIME_LIMIT_KEY)
  return text === null ? { minutes: null } : (JSON.parse(text) as ChatDeductionTimeLimit)
}
