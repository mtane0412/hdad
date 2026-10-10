/**
 * 意見ボードの形と検証（opinion.ts）のテスト
 *
 * 次の点を確かめる。
 * - テーマは前後の空白を落として受け取り、空や上限を超えるものは切り詰めずに拒むこと
 * - コメントのうち、コマンド・エモートだけ・短い反応は規則で落とし、その理由を返すこと（LLM に渡さない）
 * - 返信は、短くても落とさないこと（「それな」は返信先の意見への賛同になりうるため）
 * - 同じ人が短い間隔で続けて書いたコメントは1つの発言につなげ、続きが来るかもしれないあいだは待つこと
 * - 救い出して作る意見（札の種類・1文・論点）と論点の名前を、切り詰めずに検証すること（issue #308）
 * - 選んだ論点が、いまの論点と食い違わないか（無い論点・重なる名前・数の上限）を見分けること（issue #308）
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import {
  MAX_OPINION_LENGTH,
  MAX_THEME_LENGTH,
  MAX_TOPICS,
  MAX_TOPIC_TITLE_LENGTH,
  MERGE_GAP_MS,
  dropReasonOf,
  parseRescuedOpinionInput,
  parseThemeInput,
  parseTopicTitleInput,
  readyUtterances,
  topicChoiceProblem,
  type PendingComment,
} from './opinion'

describe('parseThemeInput', () => {
  it('前後の空白を落としたテーマを返す', () => {
    expect(parseThemeInput({ title: '  配信中にAIをどこまで使っていい？ ' })).toEqual({ title: '配信中にAIをどこまで使っていい？' })
  })

  it('空のテーマは拒む', () => {
    expect(() => parseThemeInput({ title: '   ' })).toThrow(ConfigError)
  })

  it('上限を超えるテーマは切り詰めずに拒む', () => {
    expect(() => parseThemeInput({ title: 'あ'.repeat(MAX_THEME_LENGTH + 1) })).toThrow(`${MAX_THEME_LENGTH}文字以内`)
    expect(parseThemeInput({ title: 'あ'.repeat(MAX_THEME_LENGTH) }).title).toHaveLength(MAX_THEME_LENGTH)
  })

  it('テーマが文字列でなければ拒む', () => {
    expect(() => parseThemeInput({ title: 1 })).toThrow(ConfigError)
    expect(() => parseThemeInput(null)).toThrow(ConfigError)
  })
})

describe('dropReasonOf', () => {
  /** エモートを含まない、返信でもないコメント */
  const plain = (text: string) => ({ text, fragments: [{ text, emoteId: null }], replied: false })

  it('意見になりうるコメントは落とさない', () => {
    expect(dropReasonOf(plain('AIが返事すると人と話してる感じが薄れる'))).toBeNull()
  })

  it('コマンドは落とす', () => {
    expect(dropReasonOf(plain('!task 洗濯物をたたむ'))).toBe('command')
  })

  it('エモートだけのコメントは落とす', () => {
    expect(
      dropReasonOf({
        text: 'Kappa PogChamp',
        fragments: [
          { text: 'Kappa', emoteId: '25' },
          { text: ' ', emoteId: null },
          { text: 'PogChamp', emoteId: '88' },
        ],
        replied: false,
      }),
    ).toBe('emote')
  })

  it('エモートと文の混ざったコメントは落とさない', () => {
    expect(
      dropReasonOf({
        text: 'Kappa 印があれば気にならない',
        fragments: [
          { text: 'Kappa', emoteId: '25' },
          { text: ' 印があれば気にならない', emoteId: null },
        ],
        replied: false,
      }),
    ).toBeNull()
  })

  it('短い反応は落とす', () => {
    for (const text of ['草', 'www', 'ｗｗｗ', '888', '笑', '？！', 'うん']) expect(dropReasonOf(plain(text)), text).toBe('reaction')
  })

  it('返信なら短くても落とさない', () => {
    expect(dropReasonOf({ ...plain('それな'), replied: true })).toBeNull()
    expect(dropReasonOf({ ...plain('草'), replied: true })).toBeNull()
  })
})

describe('readyUtterances', () => {
  const NOW = Date.parse('2026-10-10T12:00:00.000Z')
  const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString()

  /** 返信ではない保留中のコメント */
  const comment = (id: number, userId: string, text: string, secondsAgo: number): PendingComment => ({
    id,
    userId,
    userName: userId,
    text,
    replyName: null,
    replyText: null,
    sentAt: at(secondsAgo),
  })

  it('同じ人が続けて書いたコメントは1つの発言につなげる', () => {
    const utterances = readyUtterances([comment(1, 'aoi', 'AIのコメ返しは', 60), comment(2, 'riku', '作業ログ便利', 55), comment(3, 'aoi', 'ちょっと寂しいかも', 50)], NOW)
    expect(utterances).toEqual([
      { commentIds: [1, 3], userName: 'aoi', text: 'AIのコメ返しは ちょっと寂しいかも', replyName: null, replyText: null },
      { commentIds: [2], userName: 'riku', text: '作業ログ便利', replyName: null, replyText: null },
    ])
  })

  it('間隔が空いたコメントは別の発言にする', () => {
    const gapSeconds = MERGE_GAP_MS / 1000 + 1
    const utterances = readyUtterances([comment(1, 'aoi', '最初の意見', 60 + gapSeconds), comment(2, 'aoi', '別の意見', 60)], NOW)
    expect(utterances.map(({ commentIds }) => commentIds)).toEqual([[1], [2]])
  })

  it('続きが来るかもしれないあいだは、その人の発言をまるごと待つ', () => {
    const recent = MERGE_GAP_MS / 1000 - 1
    const utterances = readyUtterances([comment(1, 'aoi', 'AIのコメ返しは', recent + 5), comment(2, 'aoi', 'ちょっと', recent), comment(3, 'riku', '便利', 60)], NOW)
    expect(utterances.map(({ commentIds }) => commentIds)).toEqual([[3]])
  })

  it('返信は最初のコメントの返信先を添える', () => {
    const reply: PendingComment = { ...comment(1, 'pon_pon', 'それな', 60), replyName: 'tsukimi_dev', replyText: 'AIのまとめが間違ってたら困る' }
    expect(readyUtterances([reply], NOW)[0]).toMatchObject({ replyName: 'tsukimi_dev', replyText: 'AIのまとめが間違ってたら困る' })
  })
})

describe('parseRescuedOpinionInput', () => {
  it('前後の空白を落とし、既にある論点に入れる意見を返す', () => {
    expect(parseRescuedOpinionInput({ kind: 'issue', text: ' AIの返事は寂しい ', topic: { type: 'existing', id: 3 } })).toEqual({
      kind: 'issue',
      text: 'AIの返事は寂しい',
      topic: { type: 'existing', id: 3 },
    })
  })

  it('新しい論点に入れる意見を返す', () => {
    expect(parseRescuedOpinionInput({ kind: 'question', text: 'AIの声は誰の声？', topic: { type: 'new', title: ' 声と人格 ' } })).toEqual({
      kind: 'question',
      text: 'AIの声は誰の声？',
      topic: { type: 'new', title: '声と人格' },
    })
  })

  it('知らない札の種類・空の1文・上限を超える1文は切り詰めずに拒む', () => {
    expect(() => parseRescuedOpinionInput({ kind: 'agree', text: 'AIの返事は寂しい', topic: { type: 'existing', id: 3 } })).toThrow(ConfigError)
    expect(() => parseRescuedOpinionInput({ kind: 'issue', text: '  ', topic: { type: 'existing', id: 3 } })).toThrow('意見を入力してください')
    expect(() => parseRescuedOpinionInput({ kind: 'issue', text: 'あ'.repeat(MAX_OPINION_LENGTH + 1), topic: { type: 'existing', id: 3 } })).toThrow(
      `${MAX_OPINION_LENGTH}文字以内`,
    )
  })

  it('論点の指し方が崩れていれば拒む', () => {
    expect(() => parseRescuedOpinionInput({ kind: 'issue', text: 'AIの返事は寂しい', topic: { type: 'existing', id: 0 } })).toThrow(ConfigError)
    expect(() => parseRescuedOpinionInput({ kind: 'issue', text: 'AIの返事は寂しい', topic: { type: 'new', title: '' } })).toThrow(ConfigError)
    expect(() => parseRescuedOpinionInput({ kind: 'issue', text: 'AIの返事は寂しい' })).toThrow(ConfigError)
  })
})

describe('parseTopicTitleInput', () => {
  it('前後の空白を落とした論点の名前を返す', () => {
    expect(parseTopicTitleInput({ title: ' 視聴者との距離 ' })).toEqual({ title: '視聴者との距離' })
  })

  it('空・上限を超える名前は切り詰めずに拒む', () => {
    expect(() => parseTopicTitleInput({ title: ' ' })).toThrow(ConfigError)
    expect(() => parseTopicTitleInput({ title: 'あ'.repeat(MAX_TOPIC_TITLE_LENGTH + 1) })).toThrow(`${MAX_TOPIC_TITLE_LENGTH}文字以内`)
  })
})

describe('topicChoiceProblem', () => {
  const topics = [
    { id: 1, title: '視聴者との距離' },
    { id: 2, title: '配信の負担' },
  ]

  it('いまの論点と食い違わなければ null を返す', () => {
    expect(topicChoiceProblem(topics, { type: 'existing', id: 2 })).toBeNull()
    expect(topicChoiceProblem(topics, { type: 'new', title: '声と人格' })).toBeNull()
  })

  it('無い論点・既にある名前の新しい論点を見分ける', () => {
    expect(topicChoiceProblem(topics, { type: 'existing', id: 9 })).toContain('見つかりません')
    expect(topicChoiceProblem(topics, { type: 'new', title: '配信の負担' })).toContain('既にあります')
  })

  it('論点が上限まであれば、新しい論点は作れない', () => {
    const full = Array.from({ length: MAX_TOPICS }, (_, index) => ({ id: index + 1, title: `論点${index + 1}` }))
    expect(topicChoiceProblem(full, { type: 'new', title: '声と人格' })).toContain(`${MAX_TOPICS}つまで`)
    expect(topicChoiceProblem(full, { type: 'existing', id: 1 })).toBeNull()
  })
})
