---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/**/*-page.tsx"
  - "src/**/*-card.tsx"
  - "src/**/*-section.tsx"
---

# ページUIの見た目（デザインの土台）

ページUI（`src/app/` のReactアプリ。`src/overlay/overlay-page.tsx` のようなアプリの中の管理画面を含む）の見た目は Linear の組み方に寄せる。OBSに載せるページ（`overlay/stage/`・`overlay/backstage/`・`speech/reader/` と、そこで描く素材）はReactもこのトークンも使わないので当てない。

- **色**: トークンは `src/app/app.css` だけが持つ。無彩色ではなく、ごくわずかな青（`oklch` の色相285）を全体で共有する。灰色の地（`--sidebar`）の上に本文のパネル（`--background`）を浮かせる（`Sidebar` の `variant="inset"`）。文字と背景の組み合わせは `src/app/theme.test.ts` がコントラスト比（文字 4.5:1・フォーカスの印 3:1）で確かめるので、トークンを足したら組み合わせもテストに足す
- **書体と大きさ**: 欧文は Inter、和文は OS の角ゴシック。本文は `text-sm`（13px）、補足は `text-xs`（12px）。ページの見出しだけ `text-heading`（15px）。それより下の見出し（h2〜h6）は大きさではなく太さ（`font-semibold`）で分ける（`text-base` 以上の大きさと `font-medium` は `eslint.config.js` が禁止する）
- **区画**: `Card` は箱ではなく、上の区切り線と見出しで区切る区画である（左右の余白を持たない）。中に入れた区画には線を引かない。画面の中央に1枚だけ置く箱（ログイン画面）だけ、`className` で枠と背景を足す
- **色の選び方**: 色は意味の名前のトークンからだけ取る（成功は `positive`、対応待ちは `attention`、失敗・削除は `destructive`、種類を見分けるだけの色は `tag-*`）。Tailwind の生の色（`text-amber-500`・`bg-white`）と、任意の値の文字の大きさ・色（`text-[10px]`・`bg-[#fff]`）は `eslint.config.js` が禁止する（`src/app/design-lint.test.ts` が確かめる。shadcn が生成した `src/components/ui/` は対象外）。どうしてもトークンに従わせない色（手書きのキャンバスの下地）は、理由を書いて `eslint-disable-next-line` する
- **データの見せ方**: 一覧の値は文で書かず、型の部品（`src/components/data/data-display.tsx`）で出す。状態は `StatusDot`（点＋短い語。点だけにしない）、打ち込んだ値そのもの（ログイン名・ファイル名・キーワード）は `Identifier`（等幅）、数は `Quantity`（無い値は 0 にせず「—」か言葉）、色の値は `ColorSwatch`、種類は `Tag`（shadcn の `Badge` は使わない。意見の札の種類は `src/opinions/kind-tag.tsx`）、集計の数は `StatTile`。項目を並べるページは、項目ごとの `Card` ではなく一覧で並べる
- **一覧の形**: 1件ずつ保存する項目と読むだけの項目は `DataTable`（`src/components/data/data-table.tsx`。1項目＝1行、区分の帯に件数）で並べる。編集できる項目は `DataTableRow` の `expand` で、行（名前から始まるボタン）を押すとその場で下に入力欄が開く形にし、開くのは1件ずつにする（チャンネルポイント・テキスト・視聴者。トリガーは項目ごとの枠を持つので自前で同じ形を組む）。閉じた行にも、保存していない書きかけがあることを出す。一覧ごと1回で保存する表（コマンド・自動モデレーションのルール・BGMの曲）と数を並べる表は、shadcn の `Table` の行に入力欄や値を並べる
- **保存のボタン**: `SaveBar`（`src/components/save-bar.tsx`）で、保存する範囲の末尾に置く。文言は「〜を保存する」（開いた行の中では「保存する」と見せ、`name` に項目の名前を含める）。未保存の変更があれば `unsaved` を渡して横に印を出す。押せなくするのは保存の最中だけ。1つのボタンでページ全体を保存するページ（トリガー・オーバーレイ）だけ `sticky` で下に貼り付ける
- **オン・オフ**: 押したその場で効く切り替え（文字起こしを始める・止める）は `Switch`、保存のボタンで保存するまで効かない欄は `Checkbox` にする
- **見本ページ**: 部品の全状態は `/design/`（`src/app/design-page.tsx`）に並べる。サイドバーには出さない（`pages.tsx` の `UNLISTED_PAGES`）。部品を足したり変えたりしたら見本にも足し、明暗の両方で目で確かめる

経緯（Linear・Cloudflare の実測値と、配色だけを差し替えても印象が変わらなかったこと）は `docs/decisions/design.md`。
