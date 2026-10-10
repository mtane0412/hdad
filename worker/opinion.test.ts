/**
 * 意見ボードの形と検証（opinion.ts）のテスト
 *
 * 次の点を確かめる。
 * - テーマは前後の空白を落として受け取り、空や上限を超えるものは切り詰めずに拒むこと
 * - コメントのうち、コマンド・エモートだけ・短い反応は規則で落とし、その理由を返すこと（LLM に渡さない）
 * - 返信は、短くても落とさないこと（「それな」は返信先の意見への賛同になりうるため）
 * - 同じ人が短い間隔で続けて書いたコメントは1つの発言につなげ、続きが来るかもしれないあいだは待つこと
 */
import { describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { MAX_THEME_LENGTH, MERGE_GAP_MS, dropReasonOf, parseThemeInput, readyUtterances, type PendingComment } from './opinion'

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
