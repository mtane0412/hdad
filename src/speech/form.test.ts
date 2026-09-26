/**
 * 読み上げの設定の入力欄の値の変換（form.ts）のテスト
 *
 * 画面（speech-page.tsx）から分けてテストする（src/admin/form.ts と同じ扱い）。
 * 値の範囲の検証は Worker が行うので、ここで確かめるのは「入力欄の文字と設定の値を行き来できること」だけである。
 */
import { describe, expect, it } from 'vitest'
import { joinIgnoreLogins, numberOf, splitIgnoreLogins } from './form'

describe('numberOf', () => {
  it('数として書かれた文字を数にする', () => {
    expect(numberOf('50021')).toBe(50021)
    expect(numberOf('1.2')).toBe(1.2)
  })

  it('空欄は 0 ではなく「数でない」として扱う（Workerが範囲の外として理由を返せるようにする）', () => {
    expect(numberOf('')).toBeNaN()
    expect(numberOf('   ')).toBeNaN()
  })

  it('数として読めない文字も「数でない」にする', () => {
    expect(numberOf('ずんだもん')).toBeNaN()
  })
})

describe('splitIgnoreLogins', () => {
  it('カンマ区切りのログイン名を一覧にする', () => {
    expect(splitIgnoreLogins('hdad_bot,nightbot')).toEqual(['hdad_bot', 'nightbot'])
  })

  it('区切りのまわりの空白と改行を落とす（貼り付けた文字をそのまま受け取れるようにする）', () => {
    expect(splitIgnoreLogins(' hdad_bot ,\n nightbot \n')).toEqual(['hdad_bot', 'nightbot'])
  })

  it('空の要素は捨てる（末尾のカンマで空の名前を作らない）', () => {
    expect(splitIgnoreLogins('hdad_bot,,')).toEqual(['hdad_bot'])
  })

  it('何も入力していなければ空の一覧にする', () => {
    expect(splitIgnoreLogins('   ')).toEqual([])
  })
})

describe('joinIgnoreLogins', () => {
  it('一覧を入力欄に出せる文字にする', () => {
    expect(joinIgnoreLogins(['hdad_bot', 'nightbot'])).toBe('hdad_bot, nightbot')
  })

  it('空の一覧は空の入力欄にする', () => {
    expect(joinIgnoreLogins([])).toBe('')
  })

  it('入力欄に出した文字を読み直すと、元の一覧に戻る', () => {
    expect(splitIgnoreLogins(joinIgnoreLogins(['hdad_bot', 'nightbot']))).toEqual(['hdad_bot', 'nightbot'])
  })
})
