/**
 * Deploy to Cloudflare ボタン向けのデプロイ設定の整合性テスト
 *
 * Deploy to Cloudflare ボタン（README のボタン）は、リポジトリの wrangler.jsonc からリソース（KV・R2・D1）を、
 * .dev.vars.example からシークレットを読み取り、押した人に入力を求める。そのとき package.json の
 * cloudflare.bindings に書いた説明が入力欄に添えられるため、説明の書き漏れは押した人が値の意味を知る手がかりを失う。
 * そこで「wrangler.jsonc のバインディング」「.dev.vars.example のシークレット」「package.json の説明」の
 * 3つが過不足なく対応していることを、このテストで確認する。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rootDir = resolve(import.meta.dirname, '../..')

const packageJson: {
  scripts: Record<string, string>
  cloudflare?: { bindings?: Record<string, { description?: string }> }
} = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'))
/** package.json の cloudflare.bindings（バインディング名・シークレット名 → 説明） */
const bindingDescriptions = packageJson.cloudflare?.bindings ?? {}
const scripts = packageJson.scripts

/**
 * JSONCのコメント（`/* *\/` と `//`）を取り除く。
 * 文字列の中の `/*` をコメントの始まりと誤解すると `"/api/*"` のような値を壊してしまうため、
 * 文字列の内側かどうかを見ながら1文字ずつ進める。
 */
function stripJsonComments(source: string): string {
  let result = ''
  let inString = false
  let index = 0
  while (index < source.length) {
    const char = source[index] ?? ''
    if (inString) {
      // 文字列の中ではエスケープされた次の1文字ごと写し取る
      if (char === '\\') {
        result += char + (source[index + 1] ?? '')
        index += 2
        continue
      }
      if (char === '"') inString = false
      result += char
      index += 1
      continue
    }
    if (char === '"') {
      inString = true
      result += char
      index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end === -1) throw new Error('wrangler.jsonc のブロックコメントが閉じていません')
      index = end + 2
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index + 2)
      index = end === -1 ? source.length : end
      continue
    }
    result += char
    index += 1
  }
  return result
}

/** wrangler.jsonc を読む。仕様コメント（JSONCのコメント）を落としてから解析する */
function readWranglerConfig(): {
  kv_namespaces?: { binding: string }[]
  r2_buckets?: { binding: string }[]
  d1_databases?: { binding: string }[]
} {
  const source = readFileSync(resolve(rootDir, 'wrangler.jsonc'), 'utf8')
  return JSON.parse(stripJsonComments(source))
}

/** .dev.vars.example に並ぶシークレットの名前（コメント行と空行を除く） */
function readSecretNames(): string[] {
  return readFileSync(resolve(rootDir, '.dev.vars.example'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.split('=')[0] ?? '')
}

describe('Deploy to Cloudflare ボタン向けのデプロイ設定', () => {
  it('wrangler.jsonc のリソースのバインディング名に説明が書かれている', () => {
    const config = readWranglerConfig()
    const bindingNames = [
      ...(config.kv_namespaces ?? []),
      ...(config.r2_buckets ?? []),
      ...(config.d1_databases ?? []),
    ].map((binding) => binding.binding)

    expect(bindingNames.length).toBeGreaterThan(0)
    for (const name of bindingNames) {
      expect(bindingDescriptions[name]?.description).toBeTruthy()
    }
  })

  it('.dev.vars.example のシークレットに説明が書かれている', () => {
    const secretNames = readSecretNames()

    expect(secretNames.length).toBeGreaterThan(0)
    for (const name of secretNames) {
      expect(bindingDescriptions[name]?.description).toBeTruthy()
    }
  })

  it('package.json の説明に、wrangler.jsonc にも .dev.vars.example にも無い名前が混ざっていない', () => {
    const config = readWranglerConfig()
    const known = new Set([
      ...[
        ...(config.kv_namespaces ?? []),
        ...(config.r2_buckets ?? []),
        ...(config.d1_databases ?? []),
      ].map((binding) => binding.binding),
      ...readSecretNames(),
    ])

    expect(Object.keys(bindingDescriptions).sort()).toEqual([...known].sort())
  })

  it('deploy スクリプトが、デプロイに続けてD1のマイグレーションまで適用する', () => {
    // Deploy to Cloudflare ボタンは package.json の deploy スクリプトをデプロイのコマンドとして使うため、
    // マイグレーションの適用が抜けていると、押した人のデータベースにテーブルが作られない
    expect(scripts.deploy).toContain('wrangler deploy')
    const deploySteps = `${scripts.deploy} ${scripts['db:migrations:apply'] ?? ''}`
    expect(deploySteps).toContain('d1 migrations apply DB --remote')
  })
})
