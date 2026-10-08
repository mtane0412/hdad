/**
 * テキストの読み書き（text-store.ts）のテスト
 *
 * migrations/ のSQLをそのまま適用したメモリ上のSQLite（fake-database.ts）で、次の点を確かめる。
 * - 追加したテキストに新しいIDが振られ、一覧は追加した順に並ぶこと
 * - 持てる数に達していたら、件数の確認と追加を1つの文で行って追加せず null を返すこと（並んだ追加で上限を超えないため）
 * - 書き換えは名前・本文・書き換えた時刻を差し替え、無いIDなら null を返すこと
 * - 同じ名前は、検証のあとで別の窓が先に書いた場合でも、表の制約で拒んで問題点にすること
 * - 消したテキストは一覧から消え、消したIDは次に追加したテキストに使い回されないこと
 *   （素材のパラメータが消えたテキストのIDを指したまま、別のテキストを映してしまわないため）
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { ConfigError } from './alert-config'
import { createFakeDatabase } from './fake-database'
import { MAX_TEXT_COUNT, type TextEntry } from './text'
import { deleteText, insertText, readTexts, updateText } from './text-store'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const LATER = Date.parse('2026-10-08T12:30:00.000Z')

let db: ReturnType<typeof createFakeDatabase>

/** テキストを追加し、追加したものを返す（上限に達して追加できなければテストを失敗させる） */
const addText = async (...args: Parameters<typeof insertText>): Promise<TextEntry> => {
  const text = await insertText(...args)
  if (text === null) throw new Error('テキストを追加できませんでした（持てる数に達しています）')
  return text
}

beforeEach(() => {
  db = createFakeDatabase()
})

describe('insertText・readTexts', () => {
  it('追加したテキストにIDを振り、一覧は追加した順に並べる', async () => {
    const goal = await addText(db, { name: '目標', body: 'ログイン画面を作り終える' }, NOW)
    const doing = await addText(db, { name: '今やってること', body: 'テストを書いている' }, NOW)

    expect(goal).toEqual({ id: goal.id, name: '目標', body: 'ログイン画面を作り終える', updatedAt: '2026-10-08T12:00:00.000Z' })
    expect(doing.id).not.toBe(goal.id)
    expect(await readTexts(db)).toEqual([goal, doing])
  })

  it('持てる数に達していたら追加せず、null を返す', async () => {
    for (let index = 0; index < MAX_TEXT_COUNT; index += 1) await insertText(db, { name: `メモ${index + 1}`, body: '' }, NOW)

    expect(await insertText(db, { name: '目標', body: '' }, LATER)).toBeNull()
    expect(await readTexts(db)).toHaveLength(MAX_TEXT_COUNT)
  })

  it('テキストが無ければ空の一覧を返す', async () => {
    expect(await readTexts(db)).toEqual([])
  })
})

describe('updateText', () => {
  it('名前と本文と書き換えた時刻を差し替える', async () => {
    const goal = await addText(db, { name: '目標', body: 'ログイン画面を作り終える' }, NOW)

    const updated = await updateText(db, goal.id, { name: '今日の目標', body: 'ログイン画面をデプロイする' }, LATER)

    expect(updated).toEqual({ id: goal.id, name: '今日の目標', body: 'ログイン画面をデプロイする', updatedAt: '2026-10-08T12:30:00.000Z' })
    expect(await readTexts(db)).toEqual([updated])
  })

  it('無いIDなら null を返す', async () => {
    expect(await updateText(db, 999, { name: '目標', body: '' }, LATER)).toBeNull()
  })
})

describe('名前の重なり（表の制約）', () => {
  it('追加で同じ名前になったら、名前の問題点として拒む', async () => {
    await insertText(db, { name: '目標', body: '' }, NOW)

    await expect(insertText(db, { name: '目標', body: '別の目標' }, LATER)).rejects.toThrow(ConfigError)
    await expect(insertText(db, { name: '目標', body: '別の目標' }, LATER)).rejects.toMatchObject({ problems: ['name: 「目標」という名前のテキストはもうあります'] })
  })

  it('書き換えで同じ名前になったら、名前の問題点として拒む', async () => {
    await insertText(db, { name: '目標', body: '' }, NOW)
    const doing = await addText(db, { name: '今やってること', body: '' }, NOW)

    await expect(updateText(db, doing.id, { name: '目標', body: '' }, LATER)).rejects.toMatchObject({ problems: ['name: 「目標」という名前のテキストはもうあります'] })
  })
})

describe('deleteText', () => {
  it('消したテキストは一覧から消え、消したなら true を返す', async () => {
    const goal = await addText(db, { name: '目標', body: 'ログイン画面を作り終える' }, NOW)
    const doing = await addText(db, { name: '今やってること', body: 'テストを書いている' }, NOW)

    expect(await deleteText(db, goal.id)).toBe(true)
    expect(await readTexts(db)).toEqual([doing])
  })

  it('無いIDなら false を返す', async () => {
    expect(await deleteText(db, 999)).toBe(false)
  })

  it('消したIDは、次に追加したテキストに使い回さない', async () => {
    await insertText(db, { name: '目標', body: '' }, NOW)
    const last = await addText(db, { name: '今やってること', body: '' }, NOW)
    await deleteText(db, last.id)

    const added = await addText(db, { name: '次にやること', body: '' }, LATER)

    expect(added.id).toBeGreaterThan(last.id)
  })
})
