# 壁紙（`wallpaper/`）

ギャラリー（`wallpaper/`）で背景を選び、パラメータを調整して、表示されたURLをOBSにコピーします。

```
https://hdad.<サブドメイン>.workers.dev/wallpaper/<背景ID>/?<パラメータ>=<値>&...
```

- **パス**で背景の種類を、**クエリパラメータ**で色や速さを切り替えます
- 色は `#` なしの16進数（`ff0080` または `f08`）で指定します。`bg` には `transparent`（透過）も指定できます
- 省略したパラメータは既定値になります。不正な値や未対応のパラメータ名は、既定値には戻さず画面にエラーを表示します

| 背景ID | 内容 | パラメータ |
| --- | --- | --- |
| `aurora` | ぼけた色の霧がゆっくり漂う | `colors`（カンマ区切り2〜6色）, `bg`, `speed` |
| `clouds` | もこもこの雲がゆっくり横へ流れる | `color`, `bg`, `count`（雲の数）, `speed` |
| `contour` | 地形図の等高線がゆっくり形を変える | `color`, `bg`, `levels`（本数）, `scale`（模様の大きさ）, `speed` |
| `grid` | 地平線へ伸びる床のグリッドが手前へ流れる | `color`, `bg`, `size`（下端でのマスの幅px）, `speed` |
| `halftone` | 印刷の網点が波打つ | `color`, `bg`, `size`（点の間隔px）, `speed` |
| `hearts` | パステルカラーのハートが揺れながら昇る | `colors`（カンマ区切り1〜6色）, `bg`, `count`（ハートの数）, `speed` |
| `motes` | やわらかい光の粒が揺れながら昇る | `color`, `bg`, `count`（粒の数）, `speed` |
| `polka` | 水玉が波の伝わるように伸び縮みする | `colors`（カンマ区切り1〜6色）, `bg`, `size`（水玉の間隔px）, `speed` |
| `sparkles` | きらきらがあちこちでまたたく | `colors`（カンマ区切り1〜6色）, `bg`, `count`（きらきらの数）, `speed` |
| `stripes` | 斜めの帯がゆっくり流れる | `color`, `bg`, `size`（帯の周期px）, `angle`（傾き、度）, `speed` |
| `truchet` | タイルの曲線がつながり、少しずつ組み変わる | `color`, `bg`, `size`（タイルの一辺px）, `speed` |
| `waves` | 半透明の波が重なってゆらぐ | `color`, `bg`, `layers`（層の数）, `speed` |

例: `wallpaper/contour/?color=ffd166&bg=transparent&levels=20&speed=0.5`

## OBSでの設定

1. ソースの追加 > ブラウザ
2. URLにギャラリーでコピーしたURLを貼り、幅 1920・高さ 1080 にする
