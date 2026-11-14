// index.html 화면 코드 회귀 테스트 (의존성 없음)
//
//   실행:  node --test
//
// 화면 코드는 브라우저에서 도는데, 여기서는 index.html 에서 다음을 떼어 검사한다.
//  1) 강의 날짜 기본값이 기기 시간대와 무관하게 KST(Asia/Seoul) 기준 YYYY-MM-DD 인지
//  2) 생성 프롬프트가 마크다운 서식 기호를 금지하고, 없는 사실을 지어내지 않게 하는지
//  3) 폼 항목·양식 3종·접근 코드·최근 5건 보관이 요구대로 있는지
//  4) 비밀값이 화면 코드에 들어 있지 않은지

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const html = await readFile(path.join(root, 'index.html'), 'utf8');

// index.html 의 todayKST 함수 본문을 그대로 떼어 온다(코드가 바뀌면 여기서 실패해 알 수 있다).
function loadTodayKST() {
  const start = html.indexOf('function todayKST()');
  assert.ok(start >= 0, 'index.html 에 todayKST 함수가 있어야 한다');
  const end = html.indexOf('\n}', start);
  assert.ok(end > start, 'todayKST 함수 본문을 찾지 못했다');
  return html.slice(start, end + 2);
}

// 고정 시각을 돌려주는 Date 대역 — 인자 없는 new Date() 는 주어진 ISO 시각이 된다.
function dateAt(iso) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
  }
  FakeDate.now = () => fixed;
  return FakeDate;
}

function todayKSTAt(iso) {
  const source = loadTodayKST();
  const factory = new Function('Date', `${source}\nreturn todayKST;`);
  return factory(dateAt(iso))();
}

test('강의 날짜 기본값은 KST 기준 YYYY-MM-DD 다 (UTC 는 아직 전날)', () => {
  // 한국 11-15 00:00 = UTC 11-14 15:00
  assert.equal(todayKSTAt('2026-11-14T15:00:00Z'), '2026-11-15');
  // 한국 11-15 08:30 = UTC 11-14 23:30
  assert.equal(todayKSTAt('2026-11-14T23:30:00Z'), '2026-11-15');
  // 한국 11-14 23:59 = UTC 11-14 14:59 — 아직 14일
  assert.equal(todayKSTAt('2026-11-14T14:59:59Z'), '2026-11-14');
  // 월·연도 경계
  assert.equal(todayKSTAt('2026-12-31T15:00:00Z'), '2027-01-01');
  assert.equal(todayKSTAt('2027-01-31T15:00:00Z'), '2027-02-01');
});

test('날짜 입력 기본값에 UTC 기준 toISOString 계산이 남아 있지 않다', () => {
  assert.doesNotMatch(html, /new Date\(\)\.toISOString\(\)\.(split|slice)/);
  assert.match(html, /document\.getElementById\('date'\)\.value=todayKST\(\)/);
  assert.match(html, /timeZone:\s*'Asia\/Seoul'/);
});

test('생성 프롬프트가 마크다운 서식 기호를 금지한다', () => {
  const start = html.indexOf('function buildPrompt(meta)');
  assert.ok(start >= 0, 'index.html 에 buildPrompt 함수가 있어야 한다');
  const end = html.indexOf('\n}', start);
  const prompt = html.slice(start, end);

  assert.match(prompt, /마크다운 서식 기호/);
  assert.match(prompt, /절대 쓰지 마세요/);
  for (const token of ['**', '##', '#', '*', '_', '백틱', '~~', '>', '|']) {
    assert.ok(prompt.includes(token), `프롬프트 지침에 "${token}" 언급이 없다`);
  }
  assert.match(prompt, /지어내지 마세요/);
  assert.match(prompt, /\(확인 필요\)/);
  assert.match(prompt, /순수 일반 텍스트/);
  assert.ok(prompt.length < 6000, `프롬프트 생성 코드가 예상보다 길다: ${prompt.length}자`);
});

test('양식 3종(강의일지·결과보고서·메일 초안)이 화면과 프롬프트 지침에 모두 있다', () => {
  for (const format of ['journal', 'report', 'mail']) {
    assert.ok(html.includes(`data-format="${format}"`), `양식 카드 ${format} 이 없다`);
    assert.ok(html.includes(`${format}:`), `FORMATS/FORMAT_GUIDE 에 ${format} 이 없다`);
  }
  assert.match(html, /① 강의일지/);
  assert.match(html, /② 기관 제출용 결과보고서/);
  assert.match(html, /③ 후속 감사·자료 안내 메일 초안/);
  assert.match(html, /FORMAT_GUIDE/, '양식별 작성 지침이 있어야 한다');
  assert.match(html, /공문체/);
});

test('입력 폼에 요구 항목이 모두 있다', () => {
  for (const id of ['date', 'org', 'field', 'fieldEtc', 'audience', 'memo', 'note']) {
    assert.match(html, new RegExp(`id="${id}"`), `입력 항목 ${id} 이 없다`);
  }
  // 교육 분야 선택지
  for (const label of ['AI 실무 교육', '인권교육', '개인정보보호법', '4대 법정의무교육', '기타']) {
    assert.ok(html.includes(`>${label}</option>`) || html.includes(`>${label} (`), `교육 분야 "${label}" 선택지가 없다`);
  }
  // 진행 방식
  for (const method of ['대면', 'Zoom 온라인', '혼합']) {
    assert.ok(html.includes(`data-value="${method}"`), `진행 방식 "${method}" 이 없다`);
  }
  // 필수 표시
  assert.match(html, /기관명 <span class="req">\*<\/span>/);
  assert.match(html, /강의 메모 · 핵심 내용/);
  assert.match(html, /서류 · 정산 메모/);
});

test('결과 영역은 편집 가능한 본문·전체 복사·드라이브 저장을 갖춘다', () => {
  assert.match(html, /<textarea class="result-editor" id="result-editor"/);
  assert.match(html, /onclick="copyResult\(\)"/);
  assert.match(html, /전체 복사/);
  assert.match(html, /onclick="saveToDrive\(\)"/);
  assert.match(html, /드라이브에 저장/);
  assert.match(html, /id="save-status"/);
  assert.match(html, /\/api\/save-drive/);
  // 저장 후 문서 링크·시트 링크를 보여 준다
  assert.match(html, /stored\.docUrl/);
  assert.match(html, /stored\.sheetUrl/);
  assert.match(html, /문서 열기/);
});

test('설정 패널에서 접근 코드를 받아 localStorage 에 저장하고 헤더로 보낸다', () => {
  assert.match(html, /id="set-code"/);
  assert.match(html, /type="password" id="set-code"/);
  assert.match(html, /const SETTINGS_KEY = 'ljSettings'/);
  assert.match(html, /localStorage\.setItem\(SETTINGS_KEY/);
  assert.match(html, /h\['x-app-code'\] = settings\.accessCode/);
  // 연결 상태 표시
  assert.match(html, /id="conn-dot"/);
  assert.match(html, /id="conn-text"/);
  assert.match(html, /function checkServer/);
  assert.match(html, /accessCodeRequired/);
});

test('최근 기록은 5건까지만 이 기기에 보관한다', () => {
  assert.match(html, /const HISTORY_LIMIT = 5/);
  assert.match(html, /slice\(0, HISTORY_LIMIT\)/);
  assert.match(html, /const HISTORY_KEY = 'ljHistory'/);
  assert.match(html, /최근 5건/);
});

test('탭 바가 헤더 높이에 맞춰 붙는다 (헤더에 가려지지 않음)', () => {
  assert.match(html, /position:sticky;top:var\(--header-h,100px\)/);
  assert.match(html, /function syncHeaderHeight\(\)/);
  assert.match(html, /setProperty\('--header-h'/);
});

test('비밀값이 화면 코드에 들어 있지 않다', () => {
  assert.doesNotMatch(html, /sk-ant-/);
  assert.doesNotMatch(html, /ANTHROPIC_API_KEY\s*=\s*['"][^'"]+/);
  assert.doesNotMatch(html, /GOOGLE_DRIVE_WEBHOOK_URL\s*[:=]\s*['"]https/);
  assert.doesNotMatch(html, /script\.google\.com\/macros/);
});

test('음성 메모는 지원 브라우저에서만 동작하고 없으면 안내한다', () => {
  assert.match(html, /SpeechRecognition/);
  assert.match(html, /lang = 'ko-KR'/);
  assert.match(html, /음성 입력을 쓸 수 없습니다/);
});

test('모바일·홈화면 앱 설정(manifest·아이콘·테마색)이 갖춰져 있다', async () => {
  assert.match(html, /<link rel="manifest" href="manifest.json"\/>/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /theme-color" content="#1f3f66"/);

  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.short_name, '강의일지');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.icons.length, 2);
  for (const icon of manifest.icons) {
    const info = await stat(path.join(root, icon.src));
    assert.ok(info.size > 0, `${icon.src} 파일이 비어 있다`);
  }
});

test('소속 브랜딩이 119복지인권연구소 · ONEBLOCKAI연구소 로 표시된다', () => {
  assert.match(html, /119복지인권연구소 · ONEBLOCKAI연구소/);
  assert.match(html, /이대영 강사 전용/);
});

test('서버 오류 응답을 화면에 그대로 붙이지 않고 안전하게 이스케이프한다', () => {
  assert.match(html, /function escapeHtml/);
  assert.match(html, /escapeHtml\(data\.docName/);
  assert.match(html, /escapeAttr\(stored\.docUrl\)/);
});
