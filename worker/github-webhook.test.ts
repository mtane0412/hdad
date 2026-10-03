/**
 * GitHub の Webhook の読み解き（署名の検証と、出来事の種別への振り分け）のテスト
 *
 * 通信を持たない部分だけを確かめる。受け口を通した確認（配信中かどうか・再送・トリガーの実行）は github-routes.test.ts で行う。
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { githubAlertEventOf, verifyGithubSignature } from './github-webhook'

const SECRET = 'テスト用のGitHubのWebhookシークレット'

/** GitHub が付けるのと同じ形の署名（sha256= に続けて本文の HMAC-SHA256 を16進で） */
const signatureOf = (body: string, secret = SECRET): string => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

describe('verifyGithubSignature', () => {
  const body = JSON.stringify({ zen: 'Keep it logically awesome.' })

  it('同じ鍵で作った署名なら受け付ける', async () => {
    expect(await verifyGithubSignature({ body, signature: signatureOf(body), secret: SECRET })).toBe(true)
  })

  it('違う鍵で作った署名は受け付けない', async () => {
    expect(await verifyGithubSignature({ body, signature: signatureOf(body, '攻撃者が推測した鍵'), secret: SECRET })).toBe(false)
  })

  it('本文が1文字でも書き換えられていれば受け付けない', async () => {
    expect(await verifyGithubSignature({ body: `${body} `, signature: signatureOf(body), secret: SECRET })).toBe(false)
  })
})

describe('githubAlertEventOf', () => {
  /** 機能ブランチへコミットを1件 push したときの通知 */
  const push = {
    ref: 'refs/heads/feature/github-webhook',
    deleted: false,
    commits: [{ id: 'abc123', message: 'テストを先に書く' }],
    head_commit: { id: 'abc123', message: 'テストを先に書く' },
  }

  it('ブランチへのコミットの push は、コミットの push の出来事になる（main 以外のブランチも含む）', () => {
    expect(githubAlertEventOf('push', push)).toBe('github.push')
    expect(githubAlertEventOf('push', { ...push, ref: 'refs/heads/main' })).toBe('github.push')
  })

  it('タグの push は扱わない（コミットが進んだわけではないため）', () => {
    expect(githubAlertEventOf('push', { ...push, ref: 'refs/tags/v1.0.0' })).toBeNull()
  })

  it('ブランチの削除は扱わない', () => {
    expect(githubAlertEventOf('push', { ...push, deleted: true, commits: [], head_commit: null })).toBeNull()
  })

  it('新しいコミットを含まない push（既存のコミットからブランチを作っただけ）は扱わない', () => {
    // head_commit には既存のコミットが入るので、それで鳴らすと古いコミットのメッセージが配信に出てしまう
    expect(githubAlertEventOf('push', { ...push, commits: [] })).toBeNull()
  })

  it('PR が閉じられ、マージされていれば PR のマージの出来事になる', () => {
    expect(githubAlertEventOf('pull_request', { action: 'closed', pull_request: { merged: true } })).toBe('github.pull_request.merged')
  })

  it('マージせずに閉じた PR と、閉じる以外の PR の操作は扱わない', () => {
    expect(githubAlertEventOf('pull_request', { action: 'closed', pull_request: { merged: false } })).toBeNull()
    expect(githubAlertEventOf('pull_request', { action: 'opened', pull_request: { merged: false } })).toBeNull()
    expect(githubAlertEventOf('pull_request', { action: 'synchronize', pull_request: { merged: false } })).toBeNull()
  })

  it('扱わない種類の出来事は、黙って捨てずにエラーにする（Webhook の設定で選ぶ出来事の誤りに気付けるように）', () => {
    expect(() => githubAlertEventOf('issues', { action: 'opened' })).toThrowError(/issues/)
  })
})
