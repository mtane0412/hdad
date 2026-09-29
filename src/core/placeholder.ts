/**
 * 差し込み語の組み立て
 *
 * 文言の入力欄のカーソルの位置に差し込み語（`{user}`・`{summary}`・`{bgm}` など）を入れる。
 * トリガーの管理画面（src/admin/trigger-page.tsx）とチャットボットの画面（src/bot/bot-page.tsx）が、
 * placeholder-input.tsx を通して使う。DOMに触れない組み立てだけをここに分けてテストする。
 */
/**
 * 文言の入力欄に差し込み語を入れた結果。
 *
 * カーソルを動かすのは画面側（入力欄の要素を持っているのはそこだけ）なので、
 * ここでは入れ終わった文言と、その後ろのカーソルの位置を返すだけにする。
 */
export interface PlaceholderInsertion {
  value: string
  cursor: number
}

/**
 * 文言の入力欄のカーソルの位置に差し込み語を入れる。
 *
 * 手で打つと括弧や綴りを間違えやすく、間違いに気づくのは配信中に置き換わらなかったときになるため、
 * 画面のボタンから入れられるようにしている。範囲を選んでいればその範囲を置き換える（打ち込むのと同じ振る舞い）。
 *
 * @param selectionStart 入力欄の選択の始まり
 * @param selectionEnd 入力欄の選択の終わり（選んでいなければ始まりと同じ）
 */
export const insertPlaceholder = (value: string, placeholder: string, selectionStart: number, selectionEnd: number): PlaceholderInsertion => ({
  value: `${value.slice(0, selectionStart)}${placeholder}${value.slice(selectionEnd)}`,
  cursor: selectionStart + placeholder.length,
})
