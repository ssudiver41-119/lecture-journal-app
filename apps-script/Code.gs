/**
 * 강의일지 저장 웹훅 (Google Apps Script)
 *
 * Vercel 함수(api/save-drive.js)가 이 웹앱으로 JSON 을 POST 하면,
 *   1) 내 드라이브에 `강의일지_아카이브` 폴더를 만들고(또는 지정 폴더 사용)
 *      `[YYYY-MM-DD] 기관명_강의일지` (또는 _결과보고서 / _메일초안) Google 문서를 생성
 *   2) `강의일지_누적현황` Google 스프레드시트에 1행 누적
 *   3) 생성된 문서/시트/폴더 링크를 JSON 으로 응답
 *
 * ── 설치 ────────────────────────────────────────────────
 *  1. https://script.google.com → 새 프로젝트
 *  2. 이 파일 내용 전체를 Code.gs 에 붙여넣고 저장
 *  3. 편집기에서 setupDrive 함수를 한 번 실행 → 권한 승인 + 폴더/시트 생성
 *  4. (권장) 프로젝트 설정 → 스크립트 속성에 아래 값 등록
 *       PARENT_FOLDER_ID : 저장할 상위 폴더 ID (비우면 내 드라이브 최상위)
 *       FOLDER_NAME      : 기본값 `강의일지_아카이브`
 *       SHEET_NAME       : 기본값 `강의일지_누적현황`
 *       SHEET_TAB        : 기본값 `누적현황`
 *       SHARED_TOKEN     : 웹훅 호출 시 함께 보낼 비밀 토큰 (권장)
 *  5. 배포 → 새 배포 → 유형 `웹 앱`
 *       실행 계정: 나
 *       액세스 권한: 모든 사용자
 *     → 배포 → 웹 앱 URL 복사
 *  6. Vercel 프로젝트 환경변수에
 *       GOOGLE_DRIVE_WEBHOOK_URL = <복사한 웹 앱 URL>
 *       WEBHOOK_SHARED_SECRET    = <SHARED_TOKEN 과 같은 값>   (토큰을 쓸 경우)
 *     를 넣고 Redeploy
 *
 * ── 주의 ────────────────────────────────────────────────
 *  · 코드를 수정하면 `배포 관리`에서 기존 배포를 편집해 새 버전으로 올려야 반영됩니다.
 *    (새 배포를 만들면 URL 이 바뀝니다.)
 *  · 액세스 권한을 `모든 사용자`로 두면 URL 을 아는 사람은 누구나 호출할 수 있으므로
 *    SHARED_TOKEN 을 꼭 설정하세요. (Vercel 은 서버에서만 이 URL 을 씁니다.)
 */

// ── 설정 ────────────────────────────────────────────────
var PROPS = PropertiesService.getScriptProperties();

var DEFAULTS = {
  FOLDER_NAME: '강의일지_아카이브',
  SHEET_NAME: '강의일지_누적현황',
  SHEET_TAB: '누적현황',
  DEFAULT_AFFILIATION: '119복지인권연구소 · ONEBLOCKAI연구소',
  TZ: 'Asia/Seoul'
};

var HEADERS = [
  '강의일자',
  '기관명',
  '교육분야',
  '진행방식',
  '대상·인원',
  '양식',
  '문서명',
  '문서링크',
  '저장일시'
];

var FORMAT_LABELS = {
  journal: '강의일지',
  report: '결과보고서',
  mail: '메일초안'
};

// ── 진입점 ──────────────────────────────────────────────

/** 웹훅 수신 (Vercel → Apps Script) */
function doPost(e) {
  try {
    var tokenError = checkToken_(e);
    if (tokenError) return json_({ ok: false, message: tokenError });

    var raw = e && e.postData && e.postData.contents;
    if (!raw) return json_({ ok: false, message: '요청 본문이 비어 있습니다.' });

    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return json_({ ok: false, message: 'JSON 형식이 아닙니다.' });
    }

    if (!payload || !payload.orgName) return json_({ ok: false, message: '기관명이 없습니다.' });
    if (!payload.content) return json_({ ok: false, message: '저장할 내용이 없습니다.' });

    var lock = LockService.getScriptLock();
    lock.waitLock(30000); // 동시 저장 시 폴더/시트 중복 생성을 막습니다.
    try {
      var folder = getFolder_();
      var sheetInfo = getSheet_(folder);
      var docFile = createDoc_(folder, payload);
      var docUrl = docFile.getUrl();
      appendRow_(sheetInfo.sheet, payload, docFile.getName(), docUrl);

      return json_({
        ok: true,
        result: {
          docName: docFile.getName(),
          docUrl: docUrl,
          sheetUrl: sheetInfo.url,
          folderUrl: folder.getUrl()
        }
      });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return json_({ ok: false, message: '저장 중 오류: ' + (err && err.message ? err.message : String(err)) });
  }
}

/** 연결 확인용 (브라우저에서 URL 을 열면 설정 상태를 보여 줍니다) */
function doGet(e) {
  return json_({
    ok: true,
    service: 'lecture-journal-webhook',
    message: '강의일지 저장 웹훅이 실행 중입니다. (POST 로 문서를 받습니다)',
    folder: prop_('FOLDER_NAME'),
    sheet: prop_('SHEET_NAME'),
    tokenRequired: Boolean(prop_('SHARED_TOKEN')),
    time: Utilities.formatDate(new Date(), DEFAULTS.TZ, 'yyyy-MM-dd HH:mm:ss')
  });
}

// ── 설정/유틸 ───────────────────────────────────────────

function prop_(key) {
  var value = PROPS.getProperty(key);
  if (value && String(value).trim()) return String(value).trim();
  return DEFAULTS[key] || '';
}

function checkToken_(e) {
  var expected = prop_('SHARED_TOKEN');
  if (!expected) return '';
  var got = (e && e.parameter && e.parameter.token) || '';
  if (got !== expected) return '인증 토큰이 올바르지 않습니다.';
  return '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function text_(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 드라이브 파일명에 쓸 수 없는 문자 제거 */
function safeName_(value, maxLength) {
  var name = text_(value)
    .replace(/[\\/:*?"<>|#%{}$!'@`+=~^]/g, ' ')
    .replace(/\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLength && name.length > maxLength) name = name.slice(0, maxLength).trim();
  return name || '기관';
}

function formatLabel_(payload) {
  return FORMAT_LABELS[payload.format] || '강의일지';
}

/** KST 날짜 문자열 (yyyy-MM-dd) — payload.date 가 있으면 그대로 사용 */
function dateKST_(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(text_(value))) return text_(value);
  var date = value ? new Date(value) : new Date();
  if (isNaN(date.getTime())) date = new Date();
  return Utilities.formatDate(date, DEFAULTS.TZ, 'yyyy-MM-dd');
}

/** KST 일시 문자열 (yyyy-MM-dd HH:mm) */
function dateTimeKST_(value) {
  var date = value ? new Date(value) : new Date();
  if (isNaN(date.getTime())) date = new Date();
  return Utilities.formatDate(date, DEFAULTS.TZ, 'yyyy-MM-dd HH:mm');
}

function affiliation_(payload) {
  var value = text_(payload.affiliation).trim();
  return value || DEFAULTS.DEFAULT_AFFILIATION;
}

// ── 드라이브 ────────────────────────────────────────────

function getFolder_() {
  var folderName = prop_('FOLDER_NAME');
  var parentId = prop_('PARENT_FOLDER_ID');

  if (parentId) {
    var parent;
    try {
      parent = DriveApp.getFolderById(parentId);
    } catch (err) {
      throw new Error('PARENT_FOLDER_ID 폴더를 찾을 수 없습니다: ' + parentId);
    }
    var inParent = parent.getFoldersByName(folderName);
    if (inParent.hasNext()) return inParent.next();
    return parent.createFolder(folderName);
  }

  var all = DriveApp.getFoldersByName(folderName);
  if (all.hasNext()) return all.next();
  return DriveApp.createFolder(folderName);
}

function getSheet_(folder) {
  var sheetName = prop_('SHEET_NAME');
  var file = null;

  // 1) 같은 폴더에서 먼저 찾고, 2) 없으면 내 드라이브 전체에서 찾습니다.
  var inFolder = folder.getFilesByName(sheetName);
  while (inFolder.hasNext()) {
    var candidate = inFolder.next();
    if (candidate.getMimeType() === MimeType.GOOGLE_SHEETS) { file = candidate; break; }
  }
  if (!file) {
    var anywhere = DriveApp.getFilesByName(sheetName);
    while (anywhere.hasNext()) {
      var candidate2 = anywhere.next();
      if (candidate2.getMimeType() === MimeType.GOOGLE_SHEETS) { file = candidate2; break; }
    }
  }

  var spreadsheet;
  if (file) {
    spreadsheet = SpreadsheetApp.open(file);
  } else {
    spreadsheet = SpreadsheetApp.create(sheetName);
    DriveApp.getFileById(spreadsheet.getId()).moveTo(folder);
  }

  var sheet = spreadsheet.getSheetByName(prop_('SHEET_TAB')) || spreadsheet.getSheets()[0];
  if (sheet.getName() !== prop_('SHEET_TAB')) sheet.setName(prop_('SHEET_TAB'));
  ensureHeader_(sheet);

  return { sheet: sheet, url: spreadsheet.getUrl(), spreadsheet: spreadsheet };
}

function ensureHeader_(sheet) {
  var hasContent = sheet.getLastRow() > 0 && text_(sheet.getRange(1, 1).getValue()).trim() !== '';
  if (hasContent) {
    var width = Math.max(sheet.getLastColumn(), HEADERS.length);
    var current = sheet.getRange(1, 1, 1, width).getValues()[0];
    var same = HEADERS.every(function (h, i) { return text_(current[i]).trim() === h; });
    if (same) return;
  }

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  var header = sheet.getRange(1, 1, 1, HEADERS.length);
  header.setFontWeight('bold');
  header.setBackground('#1f3f66');
  header.setFontColor('#ffffff');
  header.setVerticalAlignment('middle');
  sheet.setFrozenRows(1);
  sheet.setRowHeight(1, 32);

  var widths = [110, 190, 130, 110, 170, 100, 300, 200, 150];
  widths.forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
}

function appendRow_(sheet, payload, docName, docUrl) {
  var row = [
    dateKST_(payload.date),
    text_(payload.orgName),
    text_(payload.field),
    text_(payload.method),
    text_(payload.audience),
    formatLabel_(payload),
    docName,
    docUrl,
    dateTimeKST_(payload.savedAt)
  ];

  sheet.appendRow(row);

  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 1, 1, HEADERS.length)
    .setVerticalAlignment('top')
    .setWrap(true);

  if (docUrl) {
    var cell = sheet.getRange(lastRow, HEADERS.length - 1);
    cell.setFormula('=HYPERLINK("' + docUrl + '","' + docName + '")');
  }
}

// ── 문서 생성 ───────────────────────────────────────────

function createDoc_(folder, payload) {
  var date = dateKST_(payload.date);
  var label = formatLabel_(payload);
  var title = '[' + date + '] ' + safeName_(payload.orgName, 40) + '_' + label;
  var doc = DocumentApp.create(title);

  var body = doc.getBody();

  var titlePara = body.appendParagraph(label);
  titlePara.setHeading(DocumentApp.ParagraphHeading.TITLE);
  titlePara.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  var subtitle = body.appendParagraph(affiliation_(payload) + (payload.lecturer ? ' · ' + text_(payload.lecturer) : ''));
  subtitle.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  subtitle.editAsText().setFontSize(10).setForegroundColor('#5b6b7c');

  body.appendHorizontalRule();

  var meta = body.appendParagraph('강의일자: ' + date + '    |    저장일시: ' + dateTimeKST_(payload.savedAt));
  meta.editAsText().setFontSize(9).setForegroundColor('#5b6b7c');

  var rows = [
    ['기관명', text_(payload.orgName)],
    ['교육 분야', text_(payload.field)],
    ['진행 방식', text_(payload.method)],
    ['대상·인원', text_(payload.audience)],
    ['강사', text_(payload.lecturer) + (payload.lecturer ? ' (' + affiliation_(payload) + ')' : affiliation_(payload))],
    ['서류·정산 메모', text_(payload.note)]
  ];

  var table = body.appendTable();
  rows.forEach(function (row) {
    var tr = table.appendTableRow();
    var labelCell = tr.appendTableCell(row[0]);
    var valueCell = tr.appendTableCell(row[1] || '-');
    labelCell.setBackgroundColor('#f1f5f9');
    labelCell.setWidth(110);
    valueCell.setWidth(360);
    try {
      labelCell.getChild(0).asParagraph().editAsText().setBold(true).setFontSize(10);
      valueCell.getChild(0).asParagraph().editAsText().setFontSize(10);
    } catch (err) { /* 무시 */ }
  });

  body.appendParagraph('');

  var contentHeading = body.appendParagraph(label === '메일초안' ? '메일 초안' : '문서 내용');
  contentHeading.setHeading(DocumentApp.ParagraphHeading.HEADING2);

  // 본문은 줄 단위로 나눠 문단으로 넣어 줄바꿈을 그대로 살립니다.
  var lines = text_(payload.content).replace(/\r\n?/g, '\n').split('\n');
  lines.forEach(function (line) {
    var para = body.appendParagraph(line);
    para.editAsText().setFontSize(10.5);
    para.setSpacingAfter(2);
  });

  body.appendParagraph('');

  var footer = body.appendParagraph(
    '본 문서는 강의일지 웹앱에서 자동 생성되었습니다. ' +
    '문서 내용은 강사(이대영)가 앱에서 확인·수정한 뒤 저장한 것입니다.'
  );
  footer.editAsText().setFontSize(8).setForegroundColor('#8a97a6');

  doc.saveAndClose();

  var file = DriveApp.getFileById(doc.getId());
  file.moveTo(folder);
  return file; // Document 객체는 닫혔으므로 파일로 돌려줍니다.
}

// ── 수동 점검용 ─────────────────────────────────────────

/** 편집기에서 한 번 실행하면 폴더/시트를 미리 만들어 두고 로그를 남깁니다. */
function setupDrive() {
  var folder = getFolder_();
  var info = getSheet_(folder);
  Logger.log('폴더: ' + folder.getName() + ' / ' + folder.getUrl());
  Logger.log('시트: ' + info.url);
  Logger.log('토큰 사용: ' + (prop_('SHARED_TOKEN') ? '예' : '아니오'));
}

/** 편집기에서 실행: 샘플 데이터로 문서·시트 생성이 되는지 확인합니다. */
function testWithSample() {
  var today = Utilities.formatDate(new Date(), DEFAULTS.TZ, 'yyyy-MM-dd');
  var sample = {
    date: today,
    orgName: '테스트종합사회복지관',
    field: 'AI 실무 교육',
    method: '대면',
    audience: '사회복지사 30명',
    format: 'journal',
    lecturer: '이대영',
    affiliation: DEFAULTS.DEFAULT_AFFILIATION,
    note: '강사료 세금계산서 발행, 결과보고서 5일 내 제출',
    content: '테스트 강의일지\n1. 강의 개요\n- 일시: ' + today + ' 10:00~13:00\n- 대상: 사회복지사 30명\n\n2. 진행 내용\n- 생성형 AI 개념 설명\n- 프롬프트 작성 실습\n\n3. 개선점\n- 실습 시간 확보 필요',
    savedAt: new Date().toISOString(),
    source: 'apps-script-test'
  };
  var folder = getFolder_();
  var sheetInfo = getSheet_(folder);
  var docFile = createDoc_(folder, sample);
  appendRow_(sheetInfo.sheet, sample, docFile.getName(), docFile.getUrl());
  Logger.log('문서: ' + docFile.getUrl());
  Logger.log('시트: ' + sheetInfo.url);
}
