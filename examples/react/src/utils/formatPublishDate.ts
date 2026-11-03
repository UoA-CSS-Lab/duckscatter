/** 公開日を文字列のまま整形し、実行環境のタイムゾーンによる日付のずれを避ける。 */
export function formatPublishDate(value: unknown): string {
  const date = String(value);
  if (!/^\d{8}$/.test(date)) return date;
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}
