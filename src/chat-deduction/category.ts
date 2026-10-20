/**
 * チャットで推理の問題の区分（人物・場所・出来事・もの）
 *
 * 識別子と画面の言い方はここだけが持つ（issue #375）。問題集の検証・アプリのページ・Worker の材料づくりが同じものを読む。
 *
 * 注意: Worker からも読み込むので、DOM や src/core/ のブラウザ向けの部品に頼らない。
 */

/** 区分の識別子（並びは画面に出す順） */
export const CHAT_DEDUCTION_CATEGORIES = ['person', 'place', 'event', 'thing'] as const

export type ChatDeductionCategory = (typeof CHAT_DEDUCTION_CATEGORIES)[number]

const LABELS: Readonly<Record<ChatDeductionCategory, string>> = {
  person: '人物',
  place: '場所',
  event: '出来事',
  thing: 'もの',
}

/** 区分の識別子かどうか（画面の言い方は認めない） */
export const isChatDeductionCategory = (value: unknown): value is ChatDeductionCategory =>
  typeof value === 'string' && (CHAT_DEDUCTION_CATEGORIES as readonly string[]).includes(value)

/** 区分の画面の言い方 */
export const categoryLabelOf = (category: ChatDeductionCategory): string => LABELS[category]

/**
 * 合成ページのお題の言い方。問題集に時代などの括りがあれば区分の前に添える（例: 古代史の人物）。
 *
 * @param topic 問題集の括り（例: 古代史）。括りの無い問題集なら null
 */
export const subjectLabelOf = (category: ChatDeductionCategory, topic: string | null): string =>
  topic === null ? LABELS[category] : `${topic}の${LABELS[category]}`
