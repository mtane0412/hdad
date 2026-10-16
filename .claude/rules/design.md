---
paths:
  - "src/app/**"
  - "src/components/**"
  - "src/**/*-page.tsx"
  - "src/**/*-card.tsx"
  - "src/**/*-section.tsx"
---

# ページUIの見た目（デザインの土台）

ページUI（`src/app/` のアプリ）の見た目は Linear の組み方に寄せる。OBSに載せるページ（素材）には当てない。

- **色**: トークンは `src/app/app.css` だけが持つ。無彩色ではなく、ごくわずかな青（`oklch` の色相285）を全体で共有する。灰色の地（`--sidebar`）の上に本文のパネル（`--background`）を浮かせる（`Sidebar` の `variant="inset"`）。文字と背景の組み合わせは `src/app/theme.test.ts` がコントラスト比（文字 4.5:1・フォーカスの印 3:1）で確かめるので、トークンを足したら組み合わせもテストに足す
- **書体と大きさ**: 欧文は Inter、和文は OS の角ゴシック。本文は `text-sm`（13px）、補足は `text-xs`（12px）。ページの見出しだけ `text-heading`（15px）。それより下の見出しは大きさではなく太さ（`font-semibold`）で分ける
- **区画**: `Card` は箱ではなく、上の区切り線と見出しで区切る区画である（左右の余白を持たない）。中に入れた区画には線を引かない。画面の中央に1枚だけ置く箱（ログイン画面）だけ、`className` で枠と背景を足す

経緯（Linear・Cloudflare の実測値と、配色だけを差し替えても印象が変わらなかったこと）は `docs/decisions/design.md`。
