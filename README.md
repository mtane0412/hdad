# stream-assets

Twitch配信用の各種素材を置くリポジトリです。GitHub Pagesで公開し、OBSのブラウザソースからURLで読み込みます。

## 配信背景

トップページ（ギャラリー）で背景を選び、パラメータを調整して、表示されたURLをOBSにコピーします。

```
https://<ユーザー名>.github.io/stream-assets/backgrounds/<背景ID>/?<パラメータ>=<値>&...
```

- **パス**で背景の種類を、**クエリパラメータ**で色や速さを切り替えます
- 色は `#` なしの16進数（`ff0080` または `f08`）で指定します。`bg` には `transparent`（透過）も指定できます
- 省略したパラメータは既定値になります。不正な値や未対応のパラメータ名は、既定値には戻さず画面にエラーを表示します

| 背景ID | 内容 | パラメータ |
| --- | --- | --- |
| `aurora` | ぼけた色の霧がゆっくり漂う | `colors`（カンマ区切り2〜6色）, `bg`, `speed` |
| `contour` | 地形図の等高線がゆっくり形を変える | `color`, `bg`, `levels`（本数）, `scale`（模様の大きさ）, `speed` |
| `halftone` | 印刷の網点が波打つ | `color`, `bg`, `size`（点の間隔px）, `speed` |
| `motes` | やわらかい光の粒が揺れながら昇る | `color`, `bg`, `count`（粒の数）, `speed` |

例: `backgrounds/contour/?color=ffd166&bg=transparent&levels=20&speed=0.5`

### OBSでの設定

1. ソースの追加 > ブラウザ
2. URLにギャラリーでコピーしたURLを貼り、幅 1920・高さ 1080 にする

## 開発

```bash
npm install
npm run dev         # 開発サーバー
npm run lint        # Lint（警告ゼロ必須）
npm run type-check  # 型チェック
npm test            # テスト
npm run build       # dist/ へビルド
```

### 背景を追加する

1. `src/backgrounds/<id>.ts` に `defineBackground` で背景（パラメータのスキーマと描画関数）を定義する
2. `src/backgrounds/registry.ts` に登録する
3. 既存の `backgrounds/aurora/index.html` を `backgrounds/<id>/index.html` に複製し、`data-background` と `<title>` を `<id>` に変える

2と3の対応は `src/backgrounds/registry.test.ts` が検証します。ギャラリーの調整欄はスキーマから自動生成されます。

## デプロイ

`main` へのpushで `.github/workflows/deploy.yml` がLint・型チェック・テスト・ビルドを行い、GitHub Pagesへ公開します。
リポジトリの Settings > Pages > Source を「GitHub Actions」に設定してください。
