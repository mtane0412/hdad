/**
 * 拡張の manifest.json のテスト
 *
 * Chrome の拡張用 API は、権限が無いと例外を投げずに undefined になる（chrome.storage など）。型チェックでは気づけないので、
 * 拡張が使う API の権限がそろっていることを確かめる。
 * - tabCapture: 押されたタブのストリームIDを取る（background.ts）
 * - offscreen: 取り込んで送り続ける画面を作る（background.ts）
 * - storage: 映しているタブを chrome.storage.session に覚える（background.ts。無いと、映しているタブで押しても止められない）
 * - cookies: 配信者のセッションのクッキーを読む（background.ts。offscreen document からの WebSocket にはクッキーが付かないため）
 * - webNavigation: 映しているタブが映さないサイトへ移り始めたことを、新しいページが描かれる前に知る（background.ts）
 * - tabs: 映しているタブのURLの変化（history.pushState による画面遷移を含む）を知る（background.ts。無いと URL が渡されない）
 * - contextMenus: ボタンの右クリックに「このサイトを映さない」を出す（background.ts）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('manifest.json', () => {
  it('拡張が使う API の権限がそろっている', () => {
    const manifest: unknown = JSON.parse(readFileSync(resolve(import.meta.dirname, '../public/manifest.json'), 'utf8'))
    const permissions = typeof manifest === 'object' && manifest !== null && 'permissions' in manifest ? manifest.permissions : undefined

    expect(permissions).toEqual(expect.arrayContaining(['tabCapture', 'offscreen', 'storage', 'cookies', 'webNavigation', 'tabs', 'contextMenus']))
  })
})
