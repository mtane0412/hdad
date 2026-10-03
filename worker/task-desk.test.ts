/**
 * 作業机のコマンドの読み取りと返す文言（task-desk.ts）のテスト
 *
 * 視聴者がチャットに打った文字から、組み込みのコマンド !task・!done を見分け、受け付けない理由を返す文言を確かめる。
 */
import { describe, expect, it } from 'vitest'
import { MAX_TASK_LENGTH, readTaskDeskCommand, refusalReply } from './task-desk'

describe('readTaskDeskCommand', () => {
  it('!task のあとの文字を作業として読む', () => {
    expect(readTaskDeskCommand('!task 資料を読む')).toEqual({ kind: 'declare', task: '資料を読む' })
  })

  it('作業の前後の空白は落とし、途中の空白は残す', () => {
    expect(readTaskDeskCommand('  !task   英単語 50個   ')).toEqual({ kind: 'declare', task: '英単語 50個' })
  })

  it('コマンド名の大文字小文字は区別しない', () => {
    expect(readTaskDeskCommand('!TASK 洗濯物をたたむ')).toEqual({ kind: 'declare', task: '洗濯物をたたむ' })
    expect(readTaskDeskCommand('!Done')).toEqual({ kind: 'complete' })
  })

  it('!done は完了として読み、あとに続く文字は無視する', () => {
    expect(readTaskDeskCommand('!done')).toEqual({ kind: 'complete' })
    expect(readTaskDeskCommand('!done おわった！')).toEqual({ kind: 'complete' })
  })

  it('作業が空なら、受け付けない理由として読む', () => {
    expect(readTaskDeskCommand('!task')).toEqual({ kind: 'refuse', refusal: { kind: 'empty' } })
    expect(readTaskDeskCommand('!task    ')).toEqual({ kind: 'refuse', refusal: { kind: 'empty' } })
  })

  it('作業が上限の文字数ちょうどなら受け付ける', () => {
    const task = 'あ'.repeat(MAX_TASK_LENGTH)
    expect(readTaskDeskCommand(`!task ${task}`)).toEqual({ kind: 'declare', task })
  })

  it('作業が上限を超えたら、切り詰めずに受け付けない理由として読む', () => {
    const task = 'あ'.repeat(MAX_TASK_LENGTH + 1)
    expect(readTaskDeskCommand(`!task ${task}`)).toEqual({ kind: 'refuse', refusal: { kind: 'too-long', length: MAX_TASK_LENGTH + 1 } })
  })

  it('絵文字は1文字として数える（UTF-16 の長さで数えて、見た目より早く断らない）', () => {
    const task = '📚'.repeat(MAX_TASK_LENGTH)
    expect(readTaskDeskCommand(`!task ${task}`)).toEqual({ kind: 'declare', task })
  })

  it('家族や国旗のような組み合わせの絵文字も、見た目どおり1文字として数える', () => {
    const family = '👨‍👩‍👧'
    expect(readTaskDeskCommand(`!task ${family.repeat(MAX_TASK_LENGTH)}`)).toEqual({ kind: 'declare', task: family.repeat(MAX_TASK_LENGTH) })
    expect(readTaskDeskCommand(`!task ${'🇯🇵'.repeat(MAX_TASK_LENGTH + 1)}`)).toEqual({ kind: 'refuse', refusal: { kind: 'too-long', length: MAX_TASK_LENGTH + 1 } })
  })

  it('組み込みのコマンドでない発言は null', () => {
    expect(readTaskDeskCommand('こんにちは')).toBeNull()
    expect(readTaskDeskCommand('!ping')).toBeNull()
    expect(readTaskDeskCommand('!tasks 資料を読む')).toBeNull()
    expect(readTaskDeskCommand('いま !task と打てばいいの？')).toBeNull()
  })
})

describe('refusalReply', () => {
  it('作業が空なら、書き方の例を返す', () => {
    expect(refusalReply({ kind: 'empty' }, 'shichousha')).toBe('@shichousha 作業の内容を書いてください（例: !task 資料を読む）')
  })

  it('作業が長すぎれば、上限といまの文字数を返す', () => {
    expect(refusalReply({ kind: 'too-long', length: 52 }, 'shichousha')).toBe(
      `@shichousha 作業は${MAX_TASK_LENGTH}文字以内で書いてください（いまは52文字です）`,
    )
  })

  it('配信していなければ、配信中だけ使えることを返す', () => {
    expect(refusalReply({ kind: 'offline' }, 'shichousha')).toBe('@shichousha 作業机は配信中だけ使えます')
  })

  it('完了にする作業が無ければ、宣言のしかたを返す', () => {
    expect(refusalReply({ kind: 'no-task' }, 'shichousha')).toBe('@shichousha 完了にする作業がありません。!task 作業の内容 で宣言してください')
  })
})
