/**
 * アイコンだけのボタンに渡す名前
 *
 * 形がコマンドを表しているボタン（足す・コピー・外す・読み直すなど）は文字を出さずアイコンだけにするが、
 * 名前そのものは要る。読み上げ（`aria-label`）とホバー（`title`）の両方へ同じ名前を渡すためのもので、
 * 2か所に同じ文字列を書き分けないよう1か所にまとめてある。
 *
 * 注意: アイコンでは何のことか分からないコマンド（保存する・送信するなど、取り返しが重いものを含む）は
 * 文字を残す。判断の経緯は docs/decisions/overlay-editor.md にある。
 */

/**
 * アイコンだけのボタンに、読み上げとホバーの両方で同じ名前を渡す。
 *
 * @param name そのボタンが何をするか（「URLをコピー」など）
 */
export const iconButtonName = (name: string): { 'aria-label': string; title: string } => ({ 'aria-label': name, title: name })
