/**
 * 読み上げのページの、OBSに貼るURLの組み立て
 *
 * 画面（speech-page.tsx）から分けてテストする（transcript/url.ts・side-super/url.ts と同じ扱い）。
 *
 * 読み上げの設定（話者・速度・音量など）はかつてこのURLのクエリに埋めていたが、それだと配信中に音量ひとつ
 * 変えるにもURLを貼り替えることになるため、Worker（KVの speech-settings）に移した（issue #86）。
 * そのぶん読み上げのページは Worker を呼ぶことになったので、サイドスーパーのオーバーレイや文字起こしの中継ページと
 * 同じく、オーバーレイ用キーを URL で受け取る。結果としてこのURLに入るのはキーだけである。
 */

/** 読み上げのページのパス（speech/reader/index.html として配信される） */
const READER_PATH = '/speech/reader/'

/**
 * OBSのブラウザソースに貼るURLを組み立てる。
 *
 * @param origin このサイトの起点（window.location.origin）
 * @param overlayKey オーバーレイ用キー
 */
export const speechUrl = (origin: string, overlayKey: string): string => `${origin}${READER_PATH}?key=${encodeURIComponent(overlayKey)}`
