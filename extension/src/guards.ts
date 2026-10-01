/**
 * サービスワーカー側（background.ts から読み込まれるファイル）で共有する小さな判定
 *
 * 注意: offscreen document 側（offscreen.ts から読み込まれるファイル）からは読み込まない。両方の入口から実行時に読み込むと、
 * ビルドで共有のファイルができて zip に入らない（extension/vite.config.ts）。offscreen document 側は、もともと
 * offscreen document が読み込む src/core/api.ts の isRecord を使う。
 */

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 失敗の理由を、ボタンの説明に出せる文にする */
export const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
