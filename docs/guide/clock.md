# 時計（`clock/`）

配信画面に重ねて使う時計です。時刻は配信PCのローカル時刻を表示します。背景は既定で透過です。
ギャラリー（`clock/`）で時計を選び、パラメータを調整して、表示されたURLをOBSにコピーします。

```
https://hdad.<サブドメイン>.workers.dev/clock/<時計ID>/?<パラメータ>=<値>&...
```

- 表示の有無を切り替えるパラメータは `true` / `false` で指定します（`1` や `yes` はエラーになります）
- 文字や文字盤はブラウザソースの幅・高さに収まる最大の大きさで中央に表示されます。大きさはOBS側でソースの幅・高さを変えて調整します

| 時計ID | 内容 | パラメータ |
| --- | --- | --- |
| `analog` | 現在時刻を針で表示する | `color`（針・目盛り・数字・縁の色）, `accent`（秒針の色）, `face`（文字盤の色、`transparent` で文字盤なし）, `bg`, `size`（収まる最大に対する倍率 0.1〜1）, `seconds`（秒針）, `smooth`（秒針をなめらかに動かす）, `numbers`（1〜12の数字） |
| `digital` | 現在時刻を数字で表示する | `color`（文字の色）, `outline`（縁取りの色、`transparent` で縁取りなし）, `bg`, `size`（収まる最大に対する倍率 0.1〜1）, `seconds`（秒）, `date`（日付）, `weekday`（曜日）, `hour12`（12時間制） |

例: `clock/digital/?color=ffd166&seconds=false&hour12=true`、`clock/analog/?accent=ffd166&smooth=false&numbers=false`

## OBSでの設定

1. ソースの追加 > ブラウザ
2. URLにギャラリーでコピーしたURLを貼り、幅 600・高さ 240 など時計を置きたい大きさにする
