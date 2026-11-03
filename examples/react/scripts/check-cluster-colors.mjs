import assert from 'node:assert/strict';
import { log } from 'node:console';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { DataLayer } from '../../../dist/data/data-layer.js';
import { ParquetReader } from '../../../dist/data/repository.js';
import {
  CLUSTER_COLOR_SQL,
  buildSingleColorSql,
  DEFAULT_POINT_COLOR,
  readClusterColors,
  replaceClusterColorTable,
} from '../src/utils/clusterColors.ts';

// ライブラリに既にある DuckDB-WASM を使い、ブラウザや追加インストールに依存しない。
const require = createRequire(new URL('../../../package.json', import.meta.url));
const wasmDirectory = dirname(require.resolve('@duckdb/duckdb-wasm'));
const duckdb = require(join(wasmDirectory, 'duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB(
  {
    mvp: {
      mainModule: join(wasmDirectory, 'duckdb-mvp.wasm'),
      mainWorker: join(wasmDirectory, 'duckdb-node-mvp.worker.cjs'),
    },
    // ブラウザ側と同じく、実行環境が対応する例外処理付きの同梱 WASM も選択可能にする。
    eh: {
      mainModule: join(wasmDirectory, 'duckdb-eh.wasm'),
      mainWorker: join(wasmDirectory, 'duckdb-node-eh.worker.cjs'),
    },
  },
  new duckdb.VoidLogger(),
  duckdb.NODE_RUNTIME
);
await db.instantiate();
db.open({ path: ':memory:' });
const connection = db.connect();
const executeSql = async (sql) => connection.query(sql);

/** JavaScript 側の期待値を、描画バッファと同じ符号付き 32 ビット整数で作る。 */
const packedColor = ([r, g, b]) => (255 << 24) | (r << 16) | (g << 8) | b;
const gray = packedColor([128, 128, 128]);

try {
  const parquet = readFileSync(
    new URL('../public/abcnews-embeddinggemma2-umap.parquet', import.meta.url)
  );
  const geojson = JSON.parse(
    readFileSync(new URL('../public/abcnews-clusters.geojson', import.meta.url), 'utf8')
  );
  db.registerFileBuffer('sample.parquet', new Uint8Array(parquet));
  connection.query("CREATE TABLE parquet_data AS SELECT * FROM read_parquet('sample.parquet')");

  // 同梱データの全点で ID の連続性と、ラベルの RGB との一致を確認する。
  const colors = readClusterColors(geojson.features);
  assert.equal(colors.length, 417, '同梱データの全クラスタに色がある');
  const expected = new Map(
    geojson.features.map(({ properties }) => [properties.cluster_id, packedColor(properties.color)])
  );
  await replaceClusterColorTable(executeSql, colors);
  const schema = connection.query('DESCRIBE cluster_color');
  assert.deepEqual(
    [...schema.getChild('column_name')],
    ['cluster_id', 'color'],
    '色表に ID と色を保持する'
  );
  assert.deepEqual(
    [...schema.getChild('column_type')],
    ['BIGINT', 'INTEGER'],
    'ARGB を整数列に保持する'
  );
  const storedColors = connection.query(
    'SELECT cluster_id, color FROM cluster_color ORDER BY cluster_id'
  );
  assert.equal(storedColors.numRows, 417, '色表に全クラスタを保持する');
  for (let i = 0; i < storedColors.numRows; i++) {
    assert.equal(
      storedColors.getChild('color').get(i),
      expected.get(Number(storedColors.getChild('cluster_id').get(i))),
      '保存した色が GeoJSON と一致する'
    );
  }
  const clusterSql = CLUSTER_COLOR_SQL;
  const points = connection.query(
    `SELECT rowid AS id, x, y, cluster_id, (5::FLOAT) AS size, (${clusterSql}) AS color FROM parquet_data ORDER BY rowid`
  );
  assert.equal(points.numRows, 1244184, '色の対応付けで点の件数を変えない');
  const ids = points.getChild('id');
  const clusters = points.getChild('cluster_id');
  const values = points.getChild('color');
  // 取得時の追加キャストなしで、GPU 用の数値バッファに適した型になることを確認する。
  for (const name of ['x', 'y', 'size']) {
    assert(
      points.getChild(name).data.every((chunk) => chunk.values instanceof Float32Array),
      `${name} が float32 で返る`
    );
  }
  assert(
    values.data.every((chunk) => chunk.values instanceof Int32Array),
    '色が 32 ビット整数で返る'
  );
  let noiseCount = 0;
  for (let i = 0; i < points.numRows; i++) {
    assert.equal(Number(ids.get(i)), i, '点 ID と描画バッファの順序を保つ');
    const clusterId = clusters.get(i);
    assert.equal(
      values.get(i),
      expected.get(clusterId) ?? gray,
      '点とラベルのクラスタ色が一致する'
    );
    if (clusterId === -1) noiseCount++;
  }
  assert.equal(noiseCount, 486484, 'ノイズの全点をグレーで表示する');

  // ラベル側に色がない実在クラスタにも、グレーを適用する。
  const withoutFirst = colors.filter(({ clusterId }) => clusterId !== 0);
  await replaceClusterColorTable(executeSql, withoutFirst);
  const missing = connection.query(
    `SELECT DISTINCT ${clusterSql} AS color FROM parquet_data WHERE cluster_id = 0`
  );
  assert.equal(missing.numRows, 1, '対応のないクラスタも一色になる');
  assert.equal(missing.getChild('color').get(0), gray, '対応色のない点をグレーにする');

  // 実際の取得結果を保持し、参照テーブルだけの変更には明示的な再取得が必要なことを確認する。
  await replaceClusterColorTable(executeSql, colors);
  const materialize = () =>
    connection.query(
      `SELECT DISTINCT ${clusterSql} AS color FROM parquet_data WHERE cluster_id = 0`
    );
  let materialized = materialize();
  const layer = new DataLayer({
    colorSql: clusterSql,
    onDataChanged: async () => {
      materialized = materialize();
    },
  });
  const replaced = colors.map((color) =>
    color.clusterId === 0 ? { clusterId: 0, rgb: [0, 255, 0] } : color
  );
  await replaceClusterColorTable(executeSql, replaced);
  const unchanged = await layer.updateOptions({ colorSql: clusterSql });
  assert.equal(unchanged.allPointsChanged, false, '同じ SQL 式だけでは再取得しない');
  assert.equal(
    materialized.getChild('color').get(0),
    expected.get(0),
    '保存済みの取得結果は自動で変わらない'
  );
  const refreshed = await layer.updateOptions({ colorSql: clusterSql, reloadPoints: true });
  assert.equal(refreshed.allPointsChanged, true, '参照テーブルの変更後に全点を再取得する');
  assert.equal(
    materialized.getChild('color').get(0),
    packedColor([0, 255, 0]),
    'SQL 式を変えずに差し替えた色が反映される'
  );
  assert.equal(
    (await layer.updateOptions({})).allPointsChanged,
    false,
    '再取得の指定を次回に持ち越さない'
  );

  // 単色と、色表が空の場合のサブクエリも、実データで SQL として実行する。
  const single = connection.query(
    `SELECT DISTINCT ${buildSingleColorSql(DEFAULT_POINT_COLOR)} AS color FROM parquet_data`
  );
  assert.equal(single.numRows, 1, '単色モードでは全点が同じ色になる');
  assert.equal(
    single.getChild('color').get(0),
    packedColor([59, 130, 246]),
    '単色の RGB を保持する'
  );
  await replaceClusterColorTable(executeSql, []);
  assert.equal(
    Number(
      connection.query('SELECT COUNT(*) AS count FROM cluster_color').getChild('count').get(0)
    ),
    0,
    '空の色表へ差し替えられる'
  );
  const empty = connection.query(`SELECT ${clusterSql} AS color FROM parquet_data LIMIT 1`);
  assert.equal(empty.getChild('color').get(0), gray, '空の色表ではグレーにする');

  // 実 DB の主キー制約で失敗させ、トランザクションが以前の色表を保つことを確認する。
  await replaceClusterColorTable(executeSql, colors);
  await assert.rejects(
    replaceClusterColorTable(executeSql, [...colors, colors[0]]),
    /duplicate|constraint|primary key/i,
    '主キーの重複を拒否する'
  );
  assert.equal(
    Number(
      connection.query('SELECT COUNT(*) AS count FROM cluster_color').getChild('count').get(0)
    ),
    417,
    '失敗しても以前の色表を保持する'
  );
  assert.equal(materialize().getChild('color').get(0), expected.get(0), '失敗前の色が参照できる');

  // 色表の重複は点を増やさず、矛盾した指定や不正な RGB は SQL の実行前に拒否する。
  assert.deepEqual(
    readClusterColors([...geojson.features, geojson.features[0]]),
    colors,
    '同色の重複をまとめる'
  );
  assert.deepEqual(
    readClusterColors([...geojson.features].reverse()),
    colors,
    'ラベルの順序で式を変えない'
  );
  const legacy = geojson.features.map((feature) => {
    const properties = { ...feature.properties };
    delete properties.cluster_id;
    return { ...feature, properties };
  });
  assert.deepEqual(readClusterColors(legacy), colors, '従来の cluster プロパティも対応付ける');
  const first = geojson.features[0];
  assert.throws(
    () =>
      readClusterColors([
        first,
        { ...first, properties: { ...first.properties, color: [0, 255, 0] } },
      ]),
    /conflicting colors/,
    '同じ ID の矛盾した色を拒否する'
  );
  assert.throws(
    () =>
      readClusterColors([{ ...first, properties: { ...first.properties, color: [256, 0, 0] } }]),
    /RGB/,
    '範囲外の RGB を拒否する'
  );
  assert.throws(() => buildSingleColorSql('invalid'), /hexadecimal/, '不正な単色指定を拒否する');

  // 実際の接続とリポジトリで、色表の更新が描画バッファへ反映されることを確認する。
  const reader = new ParquetReader();
  reader.conn = connection;
  let renderedPoints;
  const cachedLayer = new DataLayer({
    sizeSql: '5::FLOAT',
    colorSql: clusterSql,
    onDataChanged: async () => {
      renderedPoints = await cachedLayer.loadAllPoints();
    },
    onError: (error) => {
      throw new Error(error.message);
    },
  });
  cachedLayer.repository = reader;
  renderedPoints = await cachedLayer.loadAllPoints();
  const renderedColors = () =>
    new Uint32Array(
      renderedPoints.instanceData.buffer,
      renderedPoints.instanceData.byteOffset,
      renderedPoints.instanceData.length
    );

  await cachedLayer.updateOptions({ colorSql: buildSingleColorSql('#ff0000') });
  assert.equal(renderedColors()[2], packedColor([255, 0, 0]) >>> 0, '単色の描画色へ更新する');
  await cachedLayer.updateOptions({ sizeSql: '9::FLOAT' });
  assert.equal(renderedPoints.instanceData[3], 9, '指定した描画サイズへ更新する');

  // SQL 文字列が同じ参照テーブルの更新でも、描画色へ反映する。
  await cachedLayer.updateOptions({ colorSql: clusterSql });
  await replaceClusterColorTable(executeSql, replaced);
  await cachedLayer.updateOptions({ reloadPoints: true });
  const clusterZeroId = Number(
    connection
      .query('SELECT rowid FROM parquet_data WHERE cluster_id = 0 LIMIT 1')
      .getChildAt(0)
      .get(0)
  );
  assert.equal(
    renderedColors()[clusterZeroId * 4 + 2],
    packedColor([0, 255, 0]) >>> 0,
    '参照テーブルの変更を描画色に反映する'
  );

  log(
    `クラスタ色の実データ検証に成功しました: ${points.numRows.toLocaleString('ja-JP')} 点、${colors.length} クラスタ、${noiseCount.toLocaleString('ja-JP')} ノイズ点。`
  );
} finally {
  connection.close();
  db.dropFile('sample.parquet');
}

// ファイルを参照する目的地が、同梱サンプルであることを明示する。
log(`検証対象: ${fileURLToPath(new URL('../public/', import.meta.url))}`);
