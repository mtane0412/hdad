/**
 * 拡張が信頼する HDAD の置き場所（オリジン）の読み取り
 *
 * 拡張は、信頼する置き場所の /tab/ にだけストリームIDを渡す。パスだけで探すと、別のサイトの /tab/ が開いていたときに
 * そこへIDを渡してしまい、そのサイトが映したいタブの映像と音を取り込めてしまう（IDは受け取り先のタブで使えるため）。
 *
 * 置き場所はフォークした人ごとに違うので、拡張をビルドするときに環境変数 HDAD_ORIGINS で渡してもらう
 * （extension/vite.config.ts がここで読み、拡張に埋め込む）。カンマ区切りで複数書ける（デプロイ先と開発サーバーなど）。
 *
 * 注意: 指定が無い・読めないときは、どこでも信頼する形に黙って倒さず、ビルドを失敗させる（Fail-Fast）。
 */

/** 置き場所を渡す環境変数の名前 */
export const ORIGINS_ENV = 'HDAD_ORIGINS'

/** http を許すのは自分のPCの開発サーバーだけ（それ以外の http は途中で書き換えられうる） */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1'])

/** 置き場所1つを確かめる。https://ドメイン（http は localhost だけ）で、パスなどを含まないこと */
const parseOrigin = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${ORIGINS_ENV} の「${value}」を URL として読めません。https://hdad.example.workers.dev のように書いてください`)
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOSTNAMES.has(url.hostname))
  if (!secure || url.origin !== value) {
    throw new Error(`${ORIGINS_ENV} の「${value}」は置き場所として使えません。https://ドメイン（開発サーバーだけは http://localhost:ポート）までを書いてください`)
  }
  return url.origin
}

/**
 * HDAD_ORIGINS の値を読む。
 *
 * @throws 指定が無い・空・置き場所として読めない値を含む場合
 */
export const parseTrustedOrigins = (value: string | undefined): readonly string[] => {
  const entries = (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  if (entries.length === 0) {
    throw new Error(`${ORIGINS_ENV} に HDAD の置き場所を指定してください（例: ${ORIGINS_ENV}=https://hdad.example.workers.dev npm run build:extension）`)
  }
  return entries.map(parseOrigin)
}
