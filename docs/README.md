# 開発者向けドキュメント

保守担当者と AI エージェントが、用語、現行の処理経路、設計判断の理由を確認するための入口。

| 資料 | 内容 |
| --- | --- |
| [README](../README.md) | ライブラリの利用方法とサンプル |
| [用語集](../CONTEXT.md) | 点、一致点、描画点、選択などの共通言語 |
| [現行アーキテクチャ](architecture.md) | 実装で確認したデータ・更新・描画経路と制約 |
| [データ契約](data-contract.md) | 固定する入力、点 ID、数値精度、問い合わせの責務 |
| [ADR-0001](adr/0001-fixed-input-exploration.md) | 座標計算済みの固定データを探索する責務の境界 |
| [ADR-0002](adr/0002-resident-data-and-filter-paths.md) | 全点常駐と SQL・GPU の役割分担 |
| [ADR-0003](adr/0003-selection-independent-of-drawing.md) | 表示条件から独立した選択集合 |
| [ADR-0004](adr/0004-overview-size-priority.md) | 俯瞰のサイズ優先とズームイン時の方式切り替え |
| [開発手順](development.md) | ビルド、確認範囲、計測とリリース |
| [ADR-0005（提案）](adr/0005-hover-targets.md) | 灰色を含む描画点と ID 指定のホバー対象 |
| [ADR-0006（提案）](adr/0006-initialization-failures.md) | 初期化失敗の reject 化と互換性 |
| [未対応事項](follow-ups.md) | 今後の変更方針と確認する場面 |
| [LOD ピラミッド提案](lod-pyramid-design.md) | 未導入の方式と、現行実装との差分 |

現行アーキテクチャは実装の説明、ADR は判断と理由を記録する。`accepted` の ADR-0001〜0004 は今回確認した現行方針、`proposed` の ADR-0005〜0006 は未実装の変更方針とする。提案書中の「採用」は提案内での選択を表し、その機能が実装済みであることを意味しない。

ADR は変更コストが大きく、理由を残す価値のあるトレードオフに絞る。用語の定義は `CONTEXT.md` に置き、API や実装手順を混ぜない。
