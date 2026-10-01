/**
 * ビルドのときに埋め込む値の型
 *
 * extension/vite.config.ts が、環境変数 HDAD_ORIGINS を確かめたうえで __HDAD_ORIGINS__ に埋め込む（src/origins.ts）。
 */
declare const __HDAD_ORIGINS__: readonly string[]
