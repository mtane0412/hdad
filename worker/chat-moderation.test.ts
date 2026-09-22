/**
 * チャットの自動モデレーションの判定（chat-moderation.ts）のテスト
 *
 * 判定は通信も時刻も持ち込まない純関数なので、設定・発言・連投の件数を並べて確かめる。
 * 特に重要なのは次の3点。
 * - 無効のあいだは何も起きないこと（既定は無効で、画面から明示的に有効にしてもらう）
 * - 配信者・モデレーター・VIP・サブスクライバーを対象外にできること（誤って処分すると取り返しがつかない）
 * - 複数のルールに当たったときは、重い処分を採ること
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from './chat-command'
import { judge, repeatRuleOf, type ModerationConfig, type ModerationRule } from './chat-moderation'

/** 除外をすべて有効にした、ルールなしの設定。各テストでルールだけを足して使う */
const 既定の設定: ModerationConfig = {
  enabled: true,
  exemptBroadcaster: true,
  exemptVip: true,
  exemptSubscriber: true,
  rules: [],
}

const 設定 = (rules: readonly ModerationRule[], 上書き: Partial<ModerationConfig> = {}): ModerationConfig => ({
  ...既定の設定,
  ...上書き,
  rules: [...rules],
})

const 発言 = (text: string, badges: readonly string[] = []): ChatMessage => ({
  broadcasterUserId: '12345',
  messageId: 'message-id-0123456789',
  chatterUserId: '11111',
  chatterUserLogin: 'shichousha',
  chatterUserName: '視聴者さん',
  text,
  badges: [...badges],
})

/** 連投のルールを使わないテストでは、直近の同じ文面は自分の1件だけとして渡す */
const 連投なし = 1

describe('judge', () => {
  describe('有効・無効', () => {
    it('無効なら、ルールに当てはまっても処分しない', () => {
      const config = 設定([{ kind: 'word', word: '死ね', punishment: { type: 'ban' } }], { enabled: false })

      expect(judge(config, 発言('死ね'), 連投なし)).toBeNull()
    })

    it('どのルールにも当てはまらなければ処分しない', () => {
      const config = 設定([{ kind: 'word', word: '死ね', punishment: { type: 'ban' } }])

      expect(judge(config, 発言('こんばんは'), 連投なし)).toBeNull()
    })
  })

  describe('対象外の判定', () => {
    const 禁止語のルール = 設定([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }])

    it('配信者のバッジが付いた発言は、除外が有効なら処分しない', () => {
      expect(judge(禁止語のルール, 発言('宣伝します', ['broadcaster']), 連投なし)).toBeNull()
    })

    it('モデレーターのバッジが付いた発言も、配信者と同じ除外で処分しない（Twitchはモデレーター同士の処分を許さない）', () => {
      expect(judge(禁止語のルール, 発言('宣伝します', ['moderator']), 連投なし)).toBeNull()
    })

    it('VIPのバッジが付いた発言は、除外が有効なら処分しない', () => {
      expect(judge(禁止語のルール, 発言('宣伝します', ['vip']), 連投なし)).toBeNull()
    })

    it('サブスクライバーのバッジが付いた発言は、除外が有効なら処分しない', () => {
      expect(judge(禁止語のルール, 発言('宣伝します', ['subscriber']), 連投なし)).toBeNull()
    })

    it('創設者（founder）のバッジも、サブスクライバーの除外の対象にする（古参のサブスクはこちらのバッジになる）', () => {
      expect(judge(禁止語のルール, 発言('宣伝します', ['founder']), 連投なし)).toBeNull()
    })

    it('サブスクライバーの除外を切れば、サブスクライバーでも処分する', () => {
      const config = 設定([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }], { exemptSubscriber: false })

      expect(judge(config, 発言('宣伝します', ['subscriber']), 連投なし)).toEqual({ type: 'delete' })
    })

    it('バッジが付いていない視聴者は、除外の対象にならない', () => {
      expect(judge(禁止語のルール, 発言('宣伝します'), 連投なし)).toEqual({ type: 'delete' })
    })
  })

  describe('禁止語（word）', () => {
    it('本文に禁止語を含めば処分する（部分一致）', () => {
      const config = 設定([{ kind: 'word', word: 'スパム', punishment: { type: 'timeout', durationSeconds: 600 } }])

      expect(judge(config, 発言('これはスパムです'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 600 })
    })

    it('大文字小文字は区別しない', () => {
      const config = 設定([{ kind: 'word', word: 'spam', punishment: { type: 'delete' } }])

      expect(judge(config, 発言('THIS IS SPAM'), 連投なし)).toEqual({ type: 'delete' })
    })
  })

  describe('URL（url）', () => {
    const URLのルール = 設定([{ kind: 'url', punishment: { type: 'timeout', durationSeconds: 60 } }])

    it('http から始まるURLを含む発言を処分する', () => {
      expect(judge(URLのルール, 発言('見てください http://example.com/campaign'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 60 })
    })

    it('https から始まるURLを含む発言を処分する', () => {
      expect(judge(URLのルール, 発言('https://example.com'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 60 })
    })

    it('www. から始まる書き方も処分する', () => {
      expect(judge(URLのルール, 発言('www.example.com にどうぞ'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 60 })
    })

    it('scheme を省いた短縮URL（ドメインとスラッシュ）も処分する', () => {
      expect(judge(URLのルール, 発言('bit.ly/abcdefg で配布中'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 60 })
    })

    it('URLを含まない普通の発言は処分しない', () => {
      expect(judge(URLのルール, 発言('こんばんは。今日もよろしくお願いします'), 連投なし)).toBeNull()
    })

    it('小数点や「。」を含むだけの発言をURLと取り違えない', () => {
      expect(judge(URLのルール, 発言('今日の勝率は 3.5 割でした。惜しい'), 連投なし)).toBeNull()
    })
  })

  describe('連投（repeat）', () => {
    const 連投のルール = 設定([{ kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'timeout', durationSeconds: 300 } }])

    it('同じ文面の件数が閾値に達したら処分する（自分の発言を含めて数える）', () => {
      expect(judge(連投のルール, 発言('うおおおお'), 3)).toEqual({ type: 'timeout', durationSeconds: 300 })
    })

    it('閾値に達していなければ処分しない', () => {
      expect(judge(連投のルール, 発言('うおおおお'), 2)).toBeNull()
    })
  })

  describe('複数のルールに当たったとき', () => {
    it('BANと削除なら、重いほうのBANを採る', () => {
      const config = 設定([
        { kind: 'word', word: '宣伝', punishment: { type: 'delete' } },
        { kind: 'url', punishment: { type: 'ban' } },
      ])

      expect(judge(config, 発言('宣伝です https://example.com'), 連投なし)).toEqual({ type: 'ban' })
    })

    it('タイムアウトと削除なら、重いほうのタイムアウトを採る', () => {
      const config = 設定([
        { kind: 'word', word: '宣伝', punishment: { type: 'delete' } },
        { kind: 'url', punishment: { type: 'timeout', durationSeconds: 60 } },
      ])

      expect(judge(config, 発言('宣伝です https://example.com'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 60 })
    })

    it('タイムアウトが2つなら、長いほうを採る', () => {
      const config = 設定([
        { kind: 'word', word: '宣伝', punishment: { type: 'timeout', durationSeconds: 60 } },
        { kind: 'url', punishment: { type: 'timeout', durationSeconds: 600 } },
      ])

      expect(judge(config, 発言('宣伝です https://example.com'), 連投なし)).toEqual({ type: 'timeout', durationSeconds: 600 })
    })
  })
})

describe('repeatRuleOf', () => {
  it('連投のルールが無ければ null（直近の発言をデータベースに記録しないため）', () => {
    const config = 設定([{ kind: 'word', word: '宣伝', punishment: { type: 'delete' } }])

    expect(repeatRuleOf(config)).toBeNull()
  })

  it('連投のルールがあれば、そのルールを返す（何秒のあいだ数えるかが分かる）', () => {
    const ルール: ModerationRule = { kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'delete' } }

    expect(repeatRuleOf(設定([ルール]))).toEqual(ルール)
  })

  it('無効なら、連投のルールがあっても null', () => {
    const config = 設定([{ kind: 'repeat', count: 3, windowSeconds: 30, punishment: { type: 'delete' } }], { enabled: false })

    expect(repeatRuleOf(config)).toBeNull()
  })
})
