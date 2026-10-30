# 開発と検証

## 環境と起動

CI と devcontainer は Node.js 24 を使う。ルートと `examples/react` にそれぞれ `package-lock.json` があり、次の順序で依存関係を復元する。

```bash
npm ci
npm run build
cd examples/react
npm ci
npm run dev
```

サンプルは `http://localhost:3000`。ライブラリを変更した場合は、ルートで再度ビルドするか `npm run dev` で TypeScript の監視ビルドを起動する。サンプルの起動・静的ビルドは [React サンプルの README](../examples/react/README.md) を参照。

## CI と同じ検査

両方の依存関係をインストールした後、リポジトリのルートで実行する。

```bash
npm run build
node .github/scripts/check-package-files.mjs
npm run build --prefix examples/react
npm run lint:all
```

パッケージの検査は、生成された `dist/` の全ファイルが `npm pack` の対象に含まれることを確認する。エントリーポイントだけが含まれていても、その先の import が欠けると利用できないため、全生成物を対象にする。

`npm test` は現在 `true` を実行するだけで、描画や操作の挙動を検証しない。CI も同じコマンドを実行するため、CI の成功を挙動の自動検証済みという意味で使わない。Markdown のみを変更する PR は現在の CI の対象外。

## 手動確認と性能の記録

変更した経路に応じて、WebGPU が利用できるブラウザで確認する。フィルター、ブラシ、ホバー、ラベルに変更がある場合は、[用語集](../CONTEXT.md) の一致点・描画点・選択点を区別して期待結果を確認する。

性能を比較するときは、同じデータと設定で俯瞰とズームインを別々に記録する。データの点数・列・ファイルサイズ、端末、ブラウザ、キャンバス寸法、描画予算、操作と計測方法を添える。対応点数やフレームレートの保証を、新しい実測なしに追加しない。

```typescript
plot.setInstrumentation(true);
// 対象の操作と render() を実行してから確認する
console.log(plot.getFrameStats());
console.log(plot.getLastUpdatePlan());
```

`getFrameStats()` は診断用で、次の限界がある。

| 値 | 実際に測っているもの |
| --- | --- |
| `fps` | `GpuLayer.render()` の呼び出し間隔の平滑値。ブラウザの表示更新回数ではない |
| `processedCount` | 直近に compute を実行した際の走査件数。現行は全点数 |
| `drawnCount` | `visibleIndices` の非同期読み戻し。`grayed` の不一致点の描画件数は含まない |
| `cpuEncodeMs` | GPU レイヤー内の CPU 処理時間。後に実行するラベル描画を含まない |
| `gpuComputeMs` / `gpuIdleMs` | submit 後から `onSubmittedWorkDone()` 完了までの経過時間を、compute 有無で分けた値。シェーダー単体の GPU 時間ではない |

件数と GPU 時間は直近の取得値を保持する。`drawnCount` は間引いて取得するため遅れもあり、静止したフレームで値が 0 に戻るわけではない。

## リリース

通常の変更は `development` 向けの PR と CI で確認する。リリース時は [.github/workflows/release.yml](../.github/workflows/release.yml) の `workflow_dispatch` で version と必要な preid を選ぶ。このワークフローは `npm version` で更新コミットとタグを作り、対象ブランチとタグを push する。

`v*` タグの push により [.github/workflows/ci.yaml](../.github/workflows/ci.yaml) が動き、CI 成功後に npm と GitHub Packages へ公開する。公開ジョブでも `dist/` のパッケージ同梱を再確認する。

変更した API と互換性の影響をもとに version を選ぶ。提案段階の設計を文書に追加しただけで、その挙動を提供済みのリリースとして扱わない。
