// api/save-drive.js 테스트 (의존성 없음)
//
//   실행:  node --test
//
// 확인하는 것
//   - Origin 검증 · 접근 코드 게이트 · 속도 제한
//   - 입력 검증(날짜·기관명·본문·양식)과 본문 크기 제한
//   - 웹훅 미설정 시 데모 모드, 설정 시 Apps Script 전송과 결과 전달
//   - 웹훅 거절·오류·연결 실패 처리, 마크다운 정리, 양식 라벨

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../api/save-drive.js');
const handler = mod.default;
const { __resetRateLimits, buildWebhookPayload, validateEntry, FORMAT_LABELS, config } = mod;

const ORIGIN = 'https://lecture-journal-app.vercel.app';
const HOST = 'lecture-journal-app.vercel.app';
const WEBHOOK = 'https://script.google.com/macros/s/AKfycbTEST/exec';

// ── 도우미 ────────────────────────────────────────────────
function mockReq({ method = 'POST', body, headers = {} } = {}) {
  return {
    method,
    body,
    headers: Object.fromEntries(Object.entries({ host: HOST, ...headers }).map(([k, v]) => [k.toLowerCase(), v])),
  };
}

function mockRes() {
  const res = { statusCode: null, headers: {}, payload: null, raw: '' };
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = value; };
  res.end = (chunk) => {
    res.raw += chunk || '';
    try { res.payload = JSON.parse(res.raw); } catch { res.payload = null; }
  };
  return res;
}

let fetchCalls = [];
const originalFetch = globalThis.fetch;
let ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function stubFetch(impl) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return impl(url, init);
  };
}

function textResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  };
}

function validBody(overrides = {}) {
  return {
    date: '2026-11-15',
    org: '구래종합사회복지관',
    field: 'AI 실무 교육',
    method: '대면',
    audience: '사회복지사 30명',
    format: 'journal',
    note: '강사료 세금계산서 발행',
    lecturer: '이대영',
    affiliation: '119복지인권연구소 · ONEBLOCKAI연구소',
    content: '강의일지\n1. 강의 개요\n- 일시: 2026-11-15 10:00~13:00\n2. 진행 내용\n- 생성형 AI 개념 설명',
    ...overrides,
  };
}

async function invoke({ method = 'POST', body = validBody(), headers = {}, ip } = {}) {
  const req = mockReq({
    method,
    body,
    headers: { origin: ORIGIN, 'x-forwarded-for': ip || nextIp(), ...headers },
  });
  const res = mockRes();
  await handler(req, res);
  return res;
}

beforeEach(() => {
  fetchCalls = [];
  __resetRateLimits();
  globalThis.fetch = originalFetch;
  delete process.env.APP_ACCESS_CODE;
  delete process.env.GOOGLE_DRIVE_WEBHOOK_URL;
  delete process.env.WEBHOOK_SHARED_SECRET;
  delete process.env.SAVE_RATE_LIMIT_PER_MIN;
  delete process.env.SAVE_RATE_LIMIT_PER_DAY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── 데모 모드 ────────────────────────────────────────────

test('웹훅이 설정되지 않으면 200 데모 안내를 주고 외부 호출은 하지 않는다', async () => {
  stubFetch(() => textResponse(200, { ok: true }));
  const res = await invoke();

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.mode, 'demo');
  assert.equal(res.payload.code, 'WEBHOOK_NOT_CONFIGURED');
  assert.match(res.payload.notice, /설정되지 않아/);
  assert.equal(res.payload.docName, '[2026-11-15] 구래종합사회복지관_강의일지');
  assert.equal(fetchCalls.length, 0);
  assert.equal(res.headers['cache-control'], 'no-store');
});

// ── 정상 저장 ────────────────────────────────────────────

test('웹훅이 설정되면 Apps Script 로 보내고 문서·시트 링크를 돌려준다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, {
    ok: true,
    result: {
      docName: '[2026-11-15] 구래종합사회복지관_강의일지',
      docUrl: 'https://docs.google.com/document/d/abc/edit',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/xyz/edit',
      folderUrl: 'https://drive.google.com/drive/folders/fdr',
    },
  }));

  const res = await invoke();

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.mode, 'live');
  assert.equal(res.payload.stored.docUrl, 'https://docs.google.com/document/d/abc/edit');
  assert.equal(res.payload.stored.sheetUrl, 'https://docs.google.com/spreadsheets/d/xyz/edit');
  assert.equal(res.payload.stored.folderUrl, 'https://drive.google.com/drive/folders/fdr');
  assert.match(res.payload.savedAtLabel, /^2026-\d{2}-\d{2} \d{2}:\d{2} \(KST\)$/);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, WEBHOOK);
  assert.equal(fetchCalls[0].init.method, 'POST');

  const sent = fetchCalls[0].body;
  assert.equal(sent.date, '2026-11-15');
  assert.equal(sent.orgName, '구래종합사회복지관');
  assert.equal(sent.field, 'AI 실무 교육');
  assert.equal(sent.format, 'journal');
  assert.equal(sent.formatLabel, '강의일지');
  assert.equal(sent.source, 'lecture-journal-app');
  assert.match(sent.content, /생성형 AI 개념 설명/);
});

test('WEBHOOK_SHARED_SECRET 이 있으면 토큰을 쿼리로 붙인다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  process.env.WEBHOOK_SHARED_SECRET = 's3cret value';
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls[0].url, `${WEBHOOK}?token=s3cret%20value`);
});

test('결과보고서·메일초안도 양식 라벨이 맞게 전달된다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  await invoke({ body: validBody({ format: 'report' }) });
  assert.equal(fetchCalls[0].body.formatLabel, '결과보고서');

  await invoke({ body: validBody({ format: 'mail' }) });
  assert.equal(fetchCalls[1].body.formatLabel, '메일초안');
});

test('교육 분야가 기타이면 직접 입력한 값이 문서·시트에 간다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  await invoke({ body: validBody({ field: '기타', fieldEtc: '노인학대예방교육' }) });
  assert.equal(fetchCalls[0].body.field, '노인학대예방교육');
  assert.equal(fetchCalls[0].body.fieldCode, '기타');
});

test('저장 전 본문의 마크다운 기호를 한 번 더 정리해 보낸다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  await invoke({ body: validBody({ content: '## 강의일지\n**기관**: 구래복지관\n- 개념 설명' }) });
  const sent = fetchCalls[0].body.content;
  assert.equal(sent.includes('##'), false);
  assert.equal(sent.includes('**'), false);
  assert.match(sent, /강의일지/);
  assert.match(sent, /· 개념 설명/);
});

// ── 인증 · Origin ────────────────────────────────────────

test('접근 코드가 설정되면 코드 없는 저장 요청은 401 이다', async () => {
  process.env.APP_ACCESS_CODE = 'lj-2026';
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  const res = await invoke();
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'access_code_required');
  assert.equal(fetchCalls.length, 0, '인증 실패 시 웹훅을 호출하지 않는다');
});

test('접근 코드가 맞으면 저장이 진행된다', async () => {
  process.env.APP_ACCESS_CODE = 'lj-2026';
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: { docUrl: 'https://docs.google.com/document/d/1/edit' } }));

  const res = await invoke({ headers: { 'x-app-code': 'lj-2026' } });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 1);
});

test('허용되지 않은 오리진은 403 이다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  const res = await invoke({ headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.code, 'FORBIDDEN_ORIGIN');
  assert.equal(fetchCalls.length, 0);
});

test('오리진이 없고 접근 코드도 없으면 직접 호출을 막는다(403)', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: true, result: {} }));

  const req = mockReq({ body: validBody(), headers: {} });
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(fetchCalls.length, 0);
});

test('GET 은 405 로 거절한다', async () => {
  const res = await invoke({ method: 'GET', body: undefined });
  assert.equal(res.statusCode, 405);
  assert.equal(res.payload.code, 'METHOD_NOT_ALLOWED');
  assert.equal(res.headers.allow, 'POST, OPTIONS');
});

test('OPTIONS 는 204 로 응답한다', async () => {
  const res = await invoke({ method: 'OPTIONS', body: undefined });
  assert.equal(res.statusCode, 204);
});

// ── 입력 검증 ────────────────────────────────────────────

test('기관명이 없으면 400 과 항목 오류를 준다', async () => {
  const res = await invoke({ body: validBody({ org: '  ' }) });
  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'VALIDATION_ERROR');
  assert.ok(res.payload.errors.org);
});

test('날짜 형식이 틀리거나 없는 날짜면 400 이다', async () => {
  const bad = await invoke({ body: validBody({ date: '2026/11/15' }) });
  assert.equal(bad.statusCode, 400);
  assert.ok(bad.payload.errors.date);

  const impossible = await invoke({ body: validBody({ date: '2026-02-31' }) });
  assert.equal(impossible.statusCode, 400);
  assert.ok(impossible.payload.errors.date);
});

test('본문이 비면 400 이다', async () => {
  const res = await invoke({ body: validBody({ content: '   ' }) });
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.errors.content, /내용이 없습니다/);
});

test('양식 값이 목록에 없으면 400 이다', async () => {
  const res = await invoke({ body: validBody({ format: 'essay' }) });
  assert.equal(res.statusCode, 400);
  assert.ok(res.payload.errors.format);
});

test('본문이 3만자를 넘으면 400 이다', async () => {
  const res = await invoke({ body: validBody({ content: '가'.repeat(config.MAX_CONTENT_CHARS + 10) }) });
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.errors.content, /3만|30000|이내/);
});

test('요청 본문이 너무 크면 413 이다', async () => {
  const huge = JSON.stringify(validBody({ content: 'x'.repeat(80 * 1024) }));
  assert.ok(Buffer.byteLength(huge, 'utf8') > config.MAX_BODY_BYTES);
  const res = await invoke({ body: huge });
  assert.equal(res.statusCode, 413);
  assert.equal(res.payload.code, 'PAYLOAD_TOO_LARGE');
});

test('validateEntry 는 정상 입력을 통과시킨다', () => {
  const { ok, errors, data } = validateEntry(validBody());
  assert.equal(ok, true);
  assert.deepEqual(errors, {});
  assert.equal(data.format, 'journal');
  assert.equal(data.org, '구래종합사회복지관');
});

test('buildWebhookPayload 는 양식 라벨과 저장 시각을 담는다', () => {
  const { data } = validateEntry(validBody({ format: 'mail' }));
  const payload = buildWebhookPayload(data, { savedAt: '2026-11-15T01:30:00.000Z', savedAtLabel: '2026-11-15 10:30 (KST)' });
  assert.equal(payload.formatLabel, FORMAT_LABELS.mail);
  assert.equal(payload.savedAtLabel, '2026-11-15 10:30 (KST)');
  assert.equal(payload.source, 'lecture-journal-app');
  assert.equal(payload.affiliation, '119복지인권연구소 · ONEBLOCKAI연구소');
});

// ── 웹훅 실패 ────────────────────────────────────────────

test('Apps Script 가 500 을 주면 502 WEBHOOK_ERROR 다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(500, { ok: false }));

  const res = await invoke();
  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.code, 'WEBHOOK_ERROR');
});

test('Apps Script 가 ok:false 를 주면 502 WEBHOOK_REJECTED 로 이유를 전달한다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, { ok: false, message: '인증 토큰이 올바르지 않습니다.' }));

  const res = await invoke();
  assert.equal(res.statusCode, 502);
  assert.equal(res.payload.code, 'WEBHOOK_REJECTED');
  assert.match(res.payload.message, /인증 토큰/);
});

test('웹훅 연결 실패는 504 WEBHOOK_UNREACHABLE 이다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => { throw new Error('ECONNREFUSED'); });

  const res = await invoke();
  assert.equal(res.statusCode, 504);
  assert.equal(res.payload.code, 'WEBHOOK_UNREACHABLE');
});

test('웹훅이 HTML 을 돌려줘도 저장 실패로 보지 않고 통과시킨다', async () => {
  process.env.GOOGLE_DRIVE_WEBHOOK_URL = WEBHOOK;
  stubFetch(() => textResponse(200, '<html>ok</html>'));

  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.mode, 'live');
  assert.equal(res.payload.stored.docUrl, null);
  assert.equal(res.payload.docName, '[2026-11-15] 구래종합사회복지관_강의일지');
});

// ── 속도 제한 ────────────────────────────────────────────

test('저장 요청이 분당 한도를 넘으면 429 를 준다', async () => {
  process.env.SAVE_RATE_LIMIT_PER_MIN = '2';
  const ip = '203.0.113.200';

  assert.equal((await invoke({ ip })).statusCode, 200);
  assert.equal((await invoke({ ip })).statusCode, 200);
  const third = await invoke({ ip });
  assert.equal(third.statusCode, 429);
  assert.equal(third.payload.code, 'RATE_LIMITED');
  assert.ok(Number(third.headers['retry-after']) >= 1);
});
