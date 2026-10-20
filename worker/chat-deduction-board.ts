/**
 * 合成ページの素材「チャットで推理」に映すもの（issue #378）
 *
 * 最後に始めたゲーム（開催中か、最後に終えたもの）の区分と問題集の括り（例: 古代史）、質問と答え・解答のカードの一覧を丸ごと組み立てる。
 * 正解の表記と解説・解説に添える画像（src/chat-deduction/images.json）はゲームを終えたあとにだけ載せる
 * （開催中に合成ページへ渡すと、ページの中身から答えが分かってしまうため）。
 * 変わるたびに AlertChannel の目印 chatDeduction で押し出し、合成ページはつながるたびに GET /api/overlay/chat-deduction で読み直す。
 * 場面ごとに鳴らす音の設定（chat-deduction-sound.ts）も、音声のURLにして一緒に載せる（合成ページは一覧の差から鳴らす音を決めるため、
 * 一覧と別に読ませると、設定を読む前に届いた押し出しの音を鳴らせない）。
 */
import type { ChatDeductionCategory } from '../src/chat-deduction/category'
import type { ChatDeductionImage } from '../src/chat-deduction/images'
import { CHAT_DEDUCTION_IMAGES, CHAT_DEDUCTION_PROBLEM_SETS } from '../src/chat-deduction/problem-set'
import type { ChatDeductionProblemSet } from '../src/chat-deduction/problems'
import { pushChatDeduction, type AlertChannelNamespace } from './alert-channel'
import { loadChatDeductionSound, playbackChatDeductionSoundOf, type ChatDeductionSound } from './chat-deduction-sound'
import { readGameCards, readLatestGame, type ChatDeductionCard, type ChatDeductionEndReason } from './chat-deduction-store'
import type { Database } from './database'
import type { Context } from './http'
import { loadOverlayKey } from './overlay-key'
import { recordFailure } from './stats-store'
import type { KeyValueStore } from './store'

/** 合成ページに映すゲーム */
export interface ChatDeductionBoardGame {
  id: number
  category: ChatDeductionCategory
  /** 問題集の時代などの括り（例: 古代史）。括りの無い問題集なら null */
  topic: string | null
  startedAt: string
  /** 開催中なら null */
  endedAt: string | null
  /** 開催中なら null */
  endReason: ChatDeductionEndReason | null
  /** 正解の表記。開催中なら null（答えを漏らさない） */
  answer: string | null
  /** 正解の解説。開催中なら null（解説から答えが分かるため） */
  explanation: string | null
  /** 解説に添える画像。開催中・出せる画像の無い問題なら null */
  image: ChatDeductionImage | null
}

/** 合成ページに映すもの丸ごと */
export interface ChatDeductionBoard {
  /** 一度もゲームを始めていなければ null */
  game: ChatDeductionBoardGame | null
  cards: ChatDeductionCard[]
  /** 場面ごとに鳴らす音（素材のIDを音声のURLにしたもの） */
  sound: ChatDeductionSound
}

/**
 * 最後に始めたゲームの、合成ページに映すものを読む。
 *
 * @param store 音の設定とオーバーレイ用キーを読む KV
 * @param problemSets 問題集の一覧（CHAT_DEDUCTION_PROBLEM_SETS。テストで差し替えるため引数で受け取る）
 * @param images 問題のIDから画像を引く表（CHAT_DEDUCTION_IMAGES。同じくテストで差し替える）
 * @throws 最後のゲームの問題が問題集に無い場合（問題集から消した問題のゲームだった。黙って空にしない）
 * @throws 最後のゲームの問題が画像の表に無い場合（images.json の作り直し忘れ。黙って画像なしにしない）
 * @throws 音を選んだ枠があるのにオーバーレイ用キーが未発行の場合（黙って無音にしない）
 */
export const readChatDeductionBoard = async (
  db: Database,
  store: KeyValueStore,
  problemSets: readonly ChatDeductionProblemSet[],
  images: ReadonlyMap<string, ChatDeductionImage | null>,
): Promise<ChatDeductionBoard> => {
  const [game, savedSound, overlayKey] = await Promise.all([readLatestGame(db), loadChatDeductionSound(store), loadOverlayKey(store)])
  const sound = playbackChatDeductionSoundOf(savedSound, overlayKey)
  if (game === null) return { game: null, cards: [], sound }
  // 括りは問題集が持つので、問題とそれを含む問題集を組で引く
  const found = problemSets.flatMap((set) => set.problems.map((problem) => ({ set, problem }))).find(({ problem }) => problem.id === game.problemId)
  if (found === undefined) throw new Error(`最後のゲーム（${game.id}）の問題「${game.problemId}」が問題集にありません`)
  const { set, problem } = found
  const image = images.get(problem.id)
  if (image === undefined) throw new Error(`最後のゲーム（${game.id}）の問題「${problem.id}」が画像の表（images.json）にありません`)
  const { id, startedAt, endedAt, endReason } = game
  const ended = endedAt !== null
  return {
    game: {
      id,
      category: problem.category,
      topic: set.topic ?? null,
      startedAt,
      endedAt,
      endReason,
      answer: ended ? problem.answer : null,
      explanation: ended ? problem.explanation : null,
      image: ended ? image : null,
    },
    cards: await readGameCards(db, game.id),
    sound,
  }
}

/**
 * 最後に始めたゲームの、合成ページに映すものを組み立てて押し出す。
 *
 * 注意: 失敗を黙って握りつぶさない。呼び出し側が管理画面へ返すか、失敗として記録する。
 */
export const pushLatestChatDeductionBoard = async (
  db: Database,
  store: KeyValueStore,
  namespace: AlertChannelNamespace,
  problemSets: readonly ChatDeductionProblemSet[],
  images: ReadonlyMap<string, ChatDeductionImage | null>,
): Promise<void> => pushChatDeduction(namespace, await readChatDeductionBoard(db, store, problemSets, images))

/**
 * Twitch へ2xxを返したあと（質問に答えた・解答の正誤を決めた）に、カードの一覧を押し出す。
 *
 * 押し出せなくても投げずに、収集の失敗（chat-deduction-push-failed）として残す。呼び出し側は交換の更新を続ける
 * （合成ページに映らないだけで視聴者のポイントを宙に浮かせないため。合成ページは次につながったときに読み直す）。
 *
 * @param what 押し出すきっかけ（失敗の記録に添える。「田中太郎さんの質問」など）
 */
export const pushBoardAfterRedemption = async (context: Context, what: string): Promise<void> => {
  const { env, now } = context
  await pushLatestChatDeductionBoard(env.DB, env.STORE, env.ALERTS, CHAT_DEDUCTION_PROBLEM_SETS, CHAT_DEDUCTION_IMAGES).catch((error: unknown) =>
    recordFailure(env.DB, 'chat-deduction-push-failed', `${what}を合成ページへ知らせられませんでした: ${error instanceof Error ? error.message : String(error)}`, now),
  )
}
