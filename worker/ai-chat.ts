/**
 * LLMによるチャットの文面づくり
 *
 * トリガーの動作 aiChat（worker/alert-config.ts の StoredAiChatAction）のために、配信者が書いた指示と
 * その人の記録（viewers のメモ・来訪の履歴）と発言の本文を材料に、Workers AI へ文面を作らせる。
 * 固定文言の chat と違い、初見の人と常連とで違う言葉をかけられる。
 *
 * 材料の組み立て（buildPrompt）はLLMを呼ばない純粋な関数として分けてテストし、
 * 呼び出し（generateChatMessage）は Workers AI のバインディング（Env.AI）を引数で受け取って差し替えられるようにする。
 *
 * 注意: 返ってきた文面をそのまま信用しない。Twitchのチャットは1通500文字までで、超えたままではTwitchが1通まるごと拒む。
 * 超えていたら切り詰めずに投げる（呼び出し側が alert-aichat-failed として記録する）。切り詰めて送ると意味の壊れた文が流れるためである。
 * 注意: 無料枠（1日10,000 Neurons）を使い切ったときは Workers AI が失敗を返す。黙って固定文言に落とさず、
 * その失敗をそのまま投げる（Fail-Fast。呼び出し側が記録する）。
 */
import type { Extracted } from './alert-event'
import type { ConditionState } from './alert-event'
import type { Viewer } from './viewer-store'

/**
 * 文面づくりに使うモデル。
 *
 * 無料枠（1日10,000 Neurons）の中で何度も呼べる軽さと、日本語の指示に従えることの兼ね合いで選んでいる。
 * 変えるときはここ1か所を書き換える（Neuronsの単価は https://developers.cloudflare.com/workers-ai/platform/pricing/ ）。
 */
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8'

/** 作らせる文面の長さの上限（トークン）。500文字に収めるうえで足りる長さにし、長話で Neurons を使わせない */
const MAX_TOKENS = 300

/** Twitchへ送る1通の上限（worker/alert-config.ts・worker/alert-event.ts と同じ値） */
const MAX_CHAT_MESSAGE_LENGTH = 500

/**
 * Workers AI のバインディング（Env.AI）のうち、このファイルが使う部分だけを写した型。
 *
 * KV・R2・D1 と同じく、Cloudflareの型をそのまま使わずに最小の形で受け取り、テストでは代役に差し替える。
 */
export interface TextGenerator {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

/** 文面を作るための材料 */
export interface AiChatMaterial {
  /** 配信者が書いた、文面の作り方の指示 */
  instruction: string
  /** 通知から取り出したイベントの中身（相手の名前・発言の本文など） */
  extracted: Extracted
  /** その人の記録。まだ記録のない人なら null */
  viewer: Viewer | null
  /** 通知の中身だけでは決まらない判定（初めてか・何日空いたか） */
  state: ConditionState
}

/** イベント種別を、LLMに読ませるための日本語の名前にする */
const EVENT_LABELS: Readonly<Record<Extracted['event'], string>> = {
  'channel.channel_points_custom_reward_redemption.add': 'チャンネルポイントの交換',
  'channel.follow': 'フォロー',
  'channel.subscribe': 'サブスクライブ',
  'channel.subscription.message': 'サブスクライブの継続',
  'channel.raid': 'レイド',
  'channel.chat.message': 'チャットの発言',
}

/** イベントごとに、文面の手がかりになる中身を並べる */
const eventDetails = (extracted: Extracted): string[] => {
  switch (extracted.event) {
    case 'channel.channel_points_custom_reward_redemption.add':
      return [`交換した報酬: ${extracted.rewardTitle}`]
    case 'channel.subscribe':
      return [`ティア: ${extracted.tier}`]
    case 'channel.subscription.message':
      return [`ティア: ${extracted.tier}`, `継続した月数: ${extracted.cumulativeMonths}`]
    case 'channel.raid':
      return [`連れてきた視聴者数: ${extracted.viewers}`]
    case 'channel.chat.message':
      return [`その人の発言: ${extracted.text}`]
    case 'channel.follow':
      return []
  }
}

/** 来訪の別（初めて・久しぶり・それ以外）を、LLMに読ませる形にする */
const visitDetails = (state: ConditionState): string[] => {
  const details: string[] = []
  if (state.firstChatEver) details.push('このチャンネルで初めての発言です')
  if (state.firstChatOfStream && !state.firstChatEver) details.push('この配信で初めての発言です')
  // 日数は小数で届くので、読ませる前に日の単位へ丸める（「30.4日ぶり」とは言わせない）
  if (state.daysSinceLastChat !== null && state.daysSinceLastChat >= 1) {
    details.push(`前の発言から${Math.floor(state.daysSinceLastChat)}日ぶりです`)
  }
  return details
}

/** その人の記録を、LLMに読ませる形にする。記録のない人では何も書かない */
const viewerDetails = (viewer: Viewer | null): string[] => {
  if (viewer === null) return ['この人の記録はまだありません']
  return [
    `初めて発言した日: ${viewer.firstSeenAt}`,
    `最後に発言した日: ${viewer.lastSeenAt}`,
    `これまでのおおよその発言数: ${viewer.messageCount}`,
    `最後に見たバッジ: ${viewer.badges.length === 0 ? 'なし' : viewer.badges.join('・')}`,
    `配信者が書いたメモ: ${viewer.note === '' ? 'なし' : viewer.note}`,
  ]
}

/**
 * 材料から、LLMへ渡す指示の文章を組み立てる。
 *
 * LLMを呼ばないので、材料が漏れなく入っているかをテストで確かめられる。
 */
export const buildPrompt = (material: AiChatMaterial): string => {
  const { instruction, extracted, viewer, state } = material
  return [
    '# 配信者からの指示',
    instruction,
    '',
    '# 相手と出来事',
    `出来事: ${EVENT_LABELS[extracted.event]}`,
    `相手の表示名: ${extracted.userName}`,
    ...eventDetails(extracted),
    ...visitDetails(state),
    '',
    '# この人のこれまでの記録',
    ...viewerDetails(viewer),
    '',
    '# 守ること',
    '- 送るチャットの文面そのものだけを出力してください（前置き・説明・引用符・箇条書き・改行を付けない）',
    `- 文面は日本語で、必ず500文字以内にしてください`,
    '- 記録にないことを事実のように書かないでください',
  ].join('\n')
}

/** Workers AI の応答から文面を読む。想定した形でなければ黙って捨てずに投げる */
const readResponse = (result: unknown): string => {
  if (typeof result !== 'object' || result === null || !('response' in result) || typeof result.response !== 'string') {
    throw new Error(`LLMの応答を読めません（response の文字列がありません）: ${JSON.stringify(result)}`)
  }
  return result.response
}

/**
 * 材料からチャットへ送る文面を1つ作る。
 *
 * @throws Error LLMが失敗した（無料枠切れを含む）、応答の形が違う、文面が空、500文字を超えた場合。
 *   いずれも呼び出し側が alert-aichat-failed として記録し、Twitchへは2xxを返す
 */
export const generateChatMessage = async (ai: TextGenerator, material: AiChatMaterial): Promise<string> => {
  const result = await ai.run(MODEL, {
    messages: [
      { role: 'system', content: 'あなたはTwitchの配信のチャットボットです。配信者の指示に従って、視聴者へ送るチャットの文面を1つだけ作ります。' },
      { role: 'user', content: buildPrompt(material) },
    ],
    max_tokens: MAX_TOKENS,
  })

  // チャットは1行で流れるので、改行はそのまま送らずに空白へ直す
  const message = readResponse(result).replaceAll(/\s*\n\s*/g, ' ').trim()
  if (message === '') throw new Error('LLMが空の文面を返したため、チャットへ送りませんでした')
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new Error(`LLMが作った文面が${message.length}文字で、Twitchの上限（500文字）を超えたため送りませんでした: ${message.slice(0, 100)}…`)
  }
  return message
}
