# プロジェクト固有設定

Twitch配信用素材のリポジトリ。Vite（マルチページ）+ TypeScript + Canvas 2D。GitHub Pagesで公開する。

## 品質チェックコマンド

```bash
npm run lint        # ESLint（警告ゼロ必須）
npm run type-check  # tsc --noEmit
npm test            # Vitest
npm run build       # Viteビルド（dist/）
```

## 構成上の約束

- GitHub Pagesはパスごとに実ファイルが必要なため、背景は `backgrounds/<id>/index.html` と `src/backgrounds/registry.ts` の両方に登録する
- URLパラメータは `src/core/params.ts` のスキーマで宣言する。不正値は既定値に戻さずエラー表示する（Fail-Fast）
- 描画は経過時間だけから決まる形にする（フレーム間の状態を持たない）
