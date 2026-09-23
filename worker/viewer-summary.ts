/**
 * LLMによる人物像づくり
 *
 * 配信が終わったあとに、その配信でその人が話したこと（stream-chat-store.ts）と、これまでの記録
 * （viewers のメモ・発言数・バッジ）を材料に、Workers AI へ人物像を作らせる（worker/collect.ts が呼ぶ）。
 * 作った人物像は viewers の summary に貯め、次にその人が発言したときの文面づくり（ai-chat.ts）の材料になる。
 *
 * 材料の組み立て（buildSummaryPrompt）はLLMを呼ばない純粋な関数として分けてテストし、
 * 呼び出し（generateViewerSummary）は Workers AI のバインディング（Env.AI）を引数で受け取って差し替えられるようにする。
 * ここは ai-chat.ts と同じ作りで、モデルとバインディングの型もそちらと共有する。
 *
 * 注意: 返ってきた人物像をそのまま信用しない。上限より長ければ切り詰めずに投げる（呼び出し側が記録する）。
 * 注意: 人物像は前回までのものを踏まえて書き直させる。配信を重ねるほど、その人のことが積み上がるようにするためである。
 * 注意: 配信者が書いたメモ（note）は材料として読ませるだけで、決して書き換えない。人が書いたものと機械の推測を混ぜない。
 * 注意: 材料の発言は視聴者が書いたものなので、指示のように書かれた発言（「これまでの指示を無視して…」など）が混ざりうる。
 * 人物像は配信者しか見ないうえ、長さの上限で弾けるので実害は小さいが、ここで作った人物像はチャットの文面づくり
 * （ai-chat.ts）の材料にもなる。発言から読み取れないことを書かせない指示を必ず添える。
 */
import { MODEL, readResponse, type TextGenerator } from './ai-chat'
import type { Viewer } from './viewer-store'

/**
 * 人物像の長さの上限（文字）。
 *
 * 短くするのは、次の文面づくり（ai-chat.ts）の材料として毎回読ませるためである。長い人物像は
 * そのぶんLLMへ渡すトークンが増え、Neurons を食う。人物像は要点だけでよい。
 */
export const MAX_VIEWER_SUMMARY_LENGTH = 200

/** 作らせる人物像の長さの上限（トークン）。上限の文字数に収めるうえで足りる長さにする */
const MAX_TOKENS = 200

/**
 * 返ってきた人物像そのものに問題があったときの失敗（空・上限より長い）。
 *
 * LLMを呼べなかった失敗（無料枠切れ・通信の失敗）と区別するために分けている。呼び出し側（worker/collect.ts）は、
 * この失敗ならその人を飛ばして次の人へ進む（同じ材料からは何度やっても同じ結果になりやすく、その人が
 * 列の先頭を塞ぐとほかの人の人物像がいつまでも作られないため）。
 */
export class ViewerSummaryContentError extends Error {}

/** 人物像を作るための材料 */
export interface ViewerSummaryMaterial {
  /** その人の記録。前回までの人物像（summary）と配信者のメモ（note）もここから読む */
  viewer: Viewer
  /** その配信でのその人の発言の本文（古い順） */
  messages: readonly string[]
}

/** これまでの記録を、LLMに読ませる形にする */
const viewerDetails = (viewer: Viewer): string[] => [
  `表示名: ${viewer.displayName}`,
  `初めて発言した日: ${viewer.firstSeenAt}`,
  `これまでのおおよその発言数: ${viewer.messageCount}`,
  `最後に見たバッジ: ${viewer.badges.length === 0 ? 'なし' : viewer.badges.join('・')}`,
  `配信者が書いたメモ: ${viewer.note === '' ? 'なし' : viewer.note}`,
]

/**
 * 材料から、LLMへ渡す指示の文章を組み立てる。
 *
 * LLMを呼ばないので、材料が漏れなく入っているかをテストで確かめられる。
 */
export const buildSummaryPrompt = (material: ViewerSummaryMaterial): string => {
  const { viewer, messages } = material
  return [
    '# やること',
    'この視聴者がどんな人かを、配信者があとで思い出せるように短くまとめてください。',
    '',
    '# これまでの記録',
    ...viewerDetails(viewer),
    '',
    '# 前回までの人物像',
    viewer.summary === '' ? 'まだありません' : viewer.summary,
    '',
    '# この配信でのその人の発言',
    ...messages,
    '',
    '# 守ること',
    '- 人物像の文章そのものだけを出力してください（前置き・説明・引用符・箇条書き・改行を付けない）',
    `- 日本語で、必ず${MAX_VIEWER_SUMMARY_LENGTH}文字以内にしてください`,
    '- 前回までの人物像があれば、それを踏まえて書き直してください（打ち消すのではなく積み上げる）',
    '- 発言から読み取れないことを事実のように書かないでください',
  ].join('\n')
}

/**
 * 材料から人物像を1つ作る。
 *
 * @throws ViewerSummaryContentError 返ってきた人物像が空、または上限より長い場合（その人を飛ばして次へ進める）
 * @throws Error LLMが失敗した（無料枠切れを含む）、応答の形が違う場合。
 *   いずれも呼び出し側（worker/collect.ts）が viewer-summary-failed として記録し、材料は消さずに残す
 */
export const generateViewerSummary = async (ai: TextGenerator, material: ViewerSummaryMaterial): Promise<string> => {
  const result = await ai.run(MODEL, {
    messages: [
      { role: 'system', content: 'あなたはTwitchの配信者の助手です。視聴者の発言と記録から、その人がどんな人かを短くまとめます。' },
      { role: 'user', content: buildSummaryPrompt(material) },
    ],
    max_tokens: MAX_TOKENS,
  })

  // 人物像は1行で貯めるので、改行はそのまま残さず空白へ直す
  const summary = readResponse(result).replaceAll(/\s*\n\s*/g, ' ').trim()
  if (summary === '') throw new ViewerSummaryContentError('LLMが空の人物像を返したため、記録しませんでした')
  if (summary.length > MAX_VIEWER_SUMMARY_LENGTH) {
    throw new ViewerSummaryContentError(
      `LLMが作った人物像が${summary.length}文字で、上限（${MAX_VIEWER_SUMMARY_LENGTH}文字）を超えたため記録しませんでした: ${summary.slice(0, 100)}…`,
    )
  }
  return summary
}
