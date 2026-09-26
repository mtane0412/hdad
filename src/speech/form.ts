/**
 * 読み上げの設定の入力欄の値の変換
 *
 * 画面（speech-page.tsx）は入力欄の文字をそのまま持ち、保存するときにここで設定の値へ直す
 * （src/admin/form.ts と同じ分け方）。
 *
 * 注意: ここは変換だけを行い、値の範囲は見ない。範囲の検証は Worker（worker/speech-config.ts）だけが持ち、
 * 画面とWorkerで二重に持たない（issue #86）。そのため空欄は 0 に丸めず NaN のまま渡し、
 * Worker に「数で指定してください」と理由を返させる。
 */

/** 読み上げない人を入力欄に出すときの区切り。読みやすいようカンマのうしろに空白を置く */
const IGNORE_SEPARATOR = ', '

/** 入力欄の文字を数にする。空欄や数として読めない文字は NaN（Workerが理由を返す） */
export const numberOf = (raw: string): number => (raw.trim() === '' ? Number.NaN : Number(raw))

/**
 * 読み上げない人の入力欄の文字を、ログイン名の一覧にする。
 *
 * カンマで区切り、まわりの空白と改行を落とす。空の要素は捨てる（末尾のカンマで空の名前を作らないため）。
 * ログイン名として正しいかどうかは Worker が確かめる。
 */
export const splitIgnoreLogins = (raw: string): string[] =>
  raw
    .split(',')
    .map((login) => login.trim())
    .filter((login) => login !== '')

/** 読み上げない人の一覧を、入力欄に出す文字にする */
export const joinIgnoreLogins = (logins: readonly string[]): string => logins.join(IGNORE_SEPARATOR)
