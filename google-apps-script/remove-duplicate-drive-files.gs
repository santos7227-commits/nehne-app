/**
 * Google Drive内の重複ファイルを検出し、削除(ゴミ箱へ移動)するスクリプト。
 *
 * Apps Scriptは1回の実行が長時間続けられない（数分で強制終了する）ため、
 * このスクリプトは「続きから自動的に再開する」仕組みになっている。
 * setup() を1回実行するだけで、あとは数分おきに自動的にバッチ処理を繰り返し、
 * 全ての処理が終わったら結果をメールで知らせる。
 *
 * 【使い方】
 * 1. https://script.google.com/ で新規プロジェクトを作成し、このファイルの内容を貼り付ける。
 * 2. 左側メニューの「サービス」から "Drive API" (Advanced Drive Service) を追加する。
 *    （Google Cloud Platform 側の個別有効化は、GCPがデフォルトプロジェクトの場合は不要）
 * 3. 必要であれば FOLDER_ID を対象フォルダのIDに設定する（空欄ならマイドライブ全体が対象）。
 * 4. DRY_RUN = true のまま、関数選択のプルダウンで setup を選び、実行する。
 *    - スキャンが自動的に数分おきに繰り返され、完了すると結果がメールで届く。
 *    - スキャン中に処理状況を見たい場合は checkStatus を実行するといつでも確認できる。
 * 5. メールで届いた結果（重複ファイル一覧が記録されたスプレッドシートへのリンク）を確認する。
 * 6. 内容に問題がなければ DRY_RUN = false に書き換えて、もう一度 setup を実行する。
 *    削除は完全削除ではなくゴミ箱への移動なので、誤りがあれば30日以内は復元できる。
 *    こちらも自動的に数分おきに処理が進み、終わったらメールで知らせる。
 *
 * 途中で止めたくなった場合は stopAutomation を実行する。
 */

// 対象フォルダのID。空文字にするとマイドライブ全体が対象になる。
const FOLDER_ID = '';

// true の間は削除を行わず、検出結果をスプレッドシートに記録するだけにする。
const DRY_RUN = true;

// 1回の実行で処理を続ける時間（Apps Scriptの実行時間上限に達しないよう余裕を持たせる）。
const BATCH_TIME_LIMIT_MS = 4 * 60 * 1000;

// 自動再実行の間隔（分）。
const TRIGGER_INTERVAL_MINUTES = 5;

const HANDLER_FUNCTION = 'processBatch';
const PROP = PropertiesService.getScriptProperties();

/**
 * 最初に1回だけ実行する関数。状態をリセットし、記録用スプレッドシートを作成して、
 * 自動再実行のトリガーを設定したうえで、最初のバッチ処理を開始する。
 */
function setup() {
  deleteAutomationTriggers();
  PROP.deleteAllProperties();

  const ss = SpreadsheetApp.create('重複ファイル削除ログ_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss'));
  const seenSheet = ss.getSheets()[0].setName('検出済み');
  seenSheet.appendRow(['key', 'fileId', 'fileName']);
  const dupSheet = ss.insertSheet('重複');
  dupSheet.appendRow(['重複ファイルID', '重複ファイル名', '残すファイルID', '残すファイル名', '処理済み']);

  PROP.setProperty('spreadsheetId', ss.getId());
  PROP.setProperty('phase', 'SCAN');
  PROP.setProperty('scannedCount', '0');

  ScriptApp.newTrigger(HANDLER_FUNCTION)
    .timeBased()
    .everyMinutes(TRIGGER_INTERVAL_MINUTES)
    .create();

  Logger.log('準備完了。結果はこちらのスプレッドシートに記録されます: %s', ss.getUrl());
  Logger.log('これから自動的にスキャンを開始します。%s分おきに自動実行されるので、そのままお待ちください。完了時にメールでお知らせします。', TRIGGER_INTERVAL_MINUTES);

  processBatch();
}

/** 自動再実行トリガーから呼ばれる本体。現在のフェーズに応じてバッチ処理を実行する。 */
function processBatch() {
  const phase = PROP.getProperty('phase');
  if (phase === 'SCAN') {
    scanBatch();
  } else if (phase === 'DELETE') {
    deleteBatch();
  } else {
    deleteAutomationTriggers();
  }
}

function scanBatch() {
  const startTime = Date.now();
  const ss = SpreadsheetApp.openById(PROP.getProperty('spreadsheetId'));
  const seenSheet = ss.getSheetByName('検出済み');
  const dupSheet = ss.getSheetByName('重複');

  const seen = new Map();
  const seenData = seenSheet.getDataRange().getValues();
  for (let i = 1; i < seenData.length; i++) {
    seen.set(seenData[i][0], { id: seenData[i][1], name: seenData[i][2] });
  }

  const token = PROP.getProperty('continuationToken');
  const it = token
    ? DriveApp.continueFileIterator(token)
    : (FOLDER_ID ? DriveApp.getFolderById(FOLDER_ID).getFiles() : DriveApp.getFiles());

  const newSeenRows = [];
  const newDupRows = [];
  let scanned = Number(PROP.getProperty('scannedCount') || 0);
  let finished = false;

  while (Date.now() - startTime < BATCH_TIME_LIMIT_MS) {
    if (!it.hasNext()) {
      finished = true;
      break;
    }
    const file = it.next();
    scanned++;
    const id = file.getId();

    let checksum;
    try {
      // Googleドキュメント/スプレッドシート等のネイティブ形式は md5Checksum を持たないためスキップする。
      checksum = Drive.Files.get(id, { fields: 'md5Checksum' }).md5Checksum;
    } catch (e) {
      continue;
    }
    if (!checksum) continue;

    const key = checksum + '_' + file.getSize();
    if (seen.has(key)) {
      const kept = seen.get(key);
      newDupRows.push([id, file.getName(), kept.id, kept.name, false]);
    } else {
      const entry = { id: id, name: file.getName() };
      seen.set(key, entry);
      newSeenRows.push([key, id, entry.name]);
    }
  }

  if (newSeenRows.length) {
    seenSheet.getRange(seenSheet.getLastRow() + 1, 1, newSeenRows.length, 3).setValues(newSeenRows);
  }
  if (newDupRows.length) {
    dupSheet.getRange(dupSheet.getLastRow() + 1, 1, newDupRows.length, 5).setValues(newDupRows);
  }
  PROP.setProperty('scannedCount', String(scanned));

  if (!finished) {
    PROP.setProperty('continuationToken', it.getContinuationToken());
    Logger.log('スキャン中... %s件処理済み。続きは自動的に処理されます。', scanned);
    return;
  }

  PROP.deleteProperty('continuationToken');
  const dupCount = countDuplicateRows(dupSheet);
  Logger.log('スキャン完了。処理済みファイル数: %s、検出された重複ファイル数: %s', scanned, dupCount);

  if (DRY_RUN) {
    finishAndNotify(ss, dupCount);
  } else {
    PROP.setProperty('phase', 'DELETE');
  }
}

function deleteBatch() {
  const startTime = Date.now();
  const ss = SpreadsheetApp.openById(PROP.getProperty('spreadsheetId'));
  const dupSheet = ss.getSheetByName('重複');
  const data = dupSheet.getDataRange().getValues();

  let remaining = false;
  for (let i = 1; i < data.length; i++) {
    const done = data[i][4];
    if (done === true || done === 'TRUE') continue;

    if (Date.now() - startTime > BATCH_TIME_LIMIT_MS) {
      remaining = true;
      break;
    }

    const dupId = data[i][0];
    try {
      DriveApp.getFileById(dupId).setTrashed(true);
    } catch (e) {
      // 既にゴミ箱に入っている等の場合は無視して次に進む。
    }
    dupSheet.getRange(i + 1, 5).setValue(true);
  }

  if (remaining) {
    Logger.log('削除処理を継続中です。続きは自動的に処理されます。');
    return;
  }

  const dupCount = countDuplicateRows(dupSheet);
  finishAndNotify(ss, dupCount);
}

function countDuplicateRows(dupSheet) {
  return Math.max(0, dupSheet.getLastRow() - 1);
}

function finishAndNotify(ss, dupCount) {
  PROP.setProperty('phase', 'DONE');
  deleteAutomationTriggers();

  const mode = DRY_RUN ? '確認のみ（まだ削除は行っていません）' : '削除完了（重複ファイルはゴミ箱へ移動済み）';
  const subject = '【重複ファイル削除スクリプト】処理が完了しました';
  const body = [
    '重複ファイルの処理が完了しました。',
    '',
    'モード: ' + mode,
    '検出された重複ファイル数: ' + dupCount + '件',
    '',
    '詳細はこちらのスプレッドシートをご確認ください:',
    ss.getUrl(),
    '',
    DRY_RUN
      ? '内容を確認し、問題なければコード内の DRY_RUN を false にして、もう一度 setup を実行してください。'
      : ''
  ].join('\n');

  const email = Session.getActiveUser().getEmail();
  if (email) {
    MailApp.sendEmail(email, subject, body);
  }
  Logger.log(body);
}

/** いつでも実行して、現在の進捗状況を確認できる。 */
function checkStatus() {
  const phase = PROP.getProperty('phase');
  if (!phase) {
    Logger.log('まだ setup が実行されていません。');
    return;
  }
  const scanned = PROP.getProperty('scannedCount') || '0';
  const ss = SpreadsheetApp.openById(PROP.getProperty('spreadsheetId'));
  const dupCount = countDuplicateRows(ss.getSheetByName('重複'));
  Logger.log('現在のフェーズ: %s / スキャン済みファイル数: %s / 検出された重複ファイル数: %s', phase, scanned, dupCount);
  Logger.log('詳細はこちら: %s', ss.getUrl());
}

/** 自動処理を途中で止めたい場合に実行する。 */
function stopAutomation() {
  deleteAutomationTriggers();
  Logger.log('自動再実行を停止しました。setup を実行すると最初からやり直せます。');
}

function deleteAutomationTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER_FUNCTION) {
      ScriptApp.deleteTrigger(t);
    }
  });
}
