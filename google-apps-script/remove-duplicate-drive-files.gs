/**
 * Google Drive内の重複ファイルを検出し、削除(ゴミ箱へ移動)するスクリプト。
 *
 * 【使い方】
 * 1. https://script.google.com/ で新規プロジェクトを作成し、このファイルの内容を貼り付ける。
 * 2. 左側メニューの「サービス」から "Drive API" (Advanced Drive Service) を追加する。
 *    さらに Google Cloud Platform 側のプロジェクトでも "Google Drive API" を有効化する。
 * 3. FOLDER_ID を対象フォルダのIDに設定する(未設定の場合はマイドライブ全体が対象になるため注意)。
 * 4. まず DRY_RUN = true のまま removeDuplicateFiles を実行し、実行ログ(表示 > ログ)で
 *    重複と判定されたファイル一覧を確認する。
 * 5. 内容に問題がなければ DRY_RUN = false にして再実行する。削除は完全削除ではなく
 *    ゴミ箱への移動なので、誤りがあれば30日以内はゴミ箱から復元できる。
 */

// 対象フォルダのID。空文字にするとマイドライブ全体が対象になる。
const FOLDER_ID = '';

// true の間は削除を行わず、検出結果をログに出力するだけにする。
const DRY_RUN = true;

function removeDuplicateFiles() {
  const files = FOLDER_ID
    ? DriveApp.getFolderById(FOLDER_ID).getFiles()
    : DriveApp.getFiles();

  // checksum+サイズ をキーにして、最初に見つかったファイルを「残す側」とする。
  const seen = new Map();
  const duplicates = [];
  let skipped = 0;

  while (files.hasNext()) {
    const file = files.next();
    const id = file.getId();

    let checksum;
    try {
      // Googleドキュメント/スプレッドシート等のネイティブ形式は md5Checksum を持たないためスキップする。
      checksum = Drive.Files.get(id, { fields: 'md5Checksum' }).md5Checksum;
    } catch (e) {
      skipped++;
      continue;
    }
    if (!checksum) {
      skipped++;
      continue;
    }

    const key = checksum + '_' + file.getSize();
    if (seen.has(key)) {
      duplicates.push({
        id: id,
        name: file.getName(),
        keptId: seen.get(key).id,
        keptName: seen.get(key).name
      });
    } else {
      seen.set(key, { id: id, name: file.getName() });
    }
  }

  Logger.log('検出された重複ファイル: %s件（判定対象外でスキップ: %s件）', duplicates.length, skipped);

  duplicates.forEach(function (d) {
    Logger.log('重複: "%s" (id=%s) ← 残す: "%s" (id=%s)', d.name, d.id, d.keptName, d.keptId);
    if (!DRY_RUN) {
      DriveApp.getFileById(d.id).setTrashed(true);
    }
  });

  if (DRY_RUN) {
    Logger.log('DRY_RUN=true のため削除は実行していません。内容を確認後、DRY_RUN=false にして再実行してください。');
  } else {
    Logger.log('上記の重複ファイルをゴミ箱に移動しました。');
  }
}
