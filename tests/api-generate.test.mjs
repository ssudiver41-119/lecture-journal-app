// api/generate.js 테스트 (의존성 없음)
//
//   실행:  node --test  (또는 npm test)
//
// 확인하는 것
//   - 상태 조회(GET) · 메서드 · CORS
//   - Origin 검증과 접근 코드 게이트
//   - 입력 검증(빈 프롬프트·길이·본문 크기)과 속도 제한
//   - Anthropic 호출(모델·max_tokens·thinking)과 오류 매핑
//   - 출력이 마크다운 기호 없는 순수 텍스트인지(시스템 지침 + 서버 후처리)

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../api/generate.js');
const handler = mod.default;
const { __resetRateLimits, sanitizeText, SYSTEM_PROMPT, getConfig } = mod;

const ORIGIN = 'https://lecture-journal-app.vercel.app';
const HOST = 'lecture-journal-app.vercel.app';

// ── 도우미 ────────────────────────────────────────────────
function mockReq({ method = 'POST', body, headers = {} } = {}) {
  return {
    method,
    body,
    headers: Object.fromEntries(Object.entries({ host: HOST, ...headers }).map(([k, v]) => [k.toLowerCase(), v])),
  };
}

function mockRes() {
  const res = { statusCode: null, headers: {}, payload: null, ended: false };
  res.setHeader = (key, value) => { res.headers[String(key).toLowerCase()] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.payload = payload; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

let fetchCalls = [];
const originalFetch = globalThis.fetch;
let ipCounter = 0;

function nextIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function jsonResponse(status, obj) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => obj,
  };
}

function stubFetch(impl) {
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : null });
    return impl(url, init);
  };
}

async function invoke({ method = 'POST', body = { prompt: '강의 메모입니다.' }, headers = {}, ip } = {}) {
  const req = mockReq({
    method,
    body,
    headers: { origin: ORIGIN, 'x-forwarded-for': ip || nextIp(), ...headers },
  });
  const res = mockRes();
  await handler(req, res);
  return res;
}

function completion(text, stopReason = 'end_turn') {
  return { content: [{ type: 'text', text }], stop_reason: stopReason };
}

beforeEach(() => {
  fetchCalls = [];
  __resetRateLimits();
  globalThis.fetch = originalFetch;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  delete process.env.APP_ACCESS_CODE;
  delete process.env.APP_ALLOWED_ORIGINS;
  delete process.env.APP_MODEL;
  delete process.env.APP_MAX_TOKENS;
  delete process.env.RATE_LIMIT_PER_MIN;
  delete process.env.RATE_LIMIT_PER_DAY;
  delete process.env.RATE_LIMIT_GLOBAL_PER_DAY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── 상태 조회 · 메서드 ────────────────────────────────────

test('GET 은 서버 준비 상태를 알려 주되 키·코드 값은 노출하지 않는다', async () => {
  const res = await invoke({ method: 'GET', body: undefined });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.service, 'lecture-journal-app');
  assert.equal(res.payload.ready, true);
  assert.equal(res.payload.accessCodeRequired, false);
  assert.equal(res.payload.apiKey, undefined);
  assert.equal(fetchCalls.length, 0);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('접근 코드가 설정되어 있으면 상태 조회에 accessCodeRequired=true 가 나온다', async () => {
  process.env.APP_ACCESS_CODE = 'secret-code';
  const res = await invoke({ method: 'GET', body: undefined });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.accessCodeRequired, true);
});

test('허용되지 않은 오리진의 GET 은 403 이다', async () => {
  const res = await invoke({ method: 'GET', body: undefined, headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.statusCode, 403);
});

test('OPTIONS 는 204 로 응답하고 CORS 헤더를 준다', async () => {
  const req = mockReq({ method: 'OPTIONS', body: undefined, headers: { origin: ORIGIN } });
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  assert.match(String(res.headers['access-control-allow-methods']), /POST/);
});

test('PUT 등 다른 메서드는 405 를 준다', async () => {
  const res = await invoke({ method: 'PUT' });
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, POST, OPTIONS');
});

// ── 정상 생성 ────────────────────────────────────────────

test('정상 요청이면 200 과 정리된 텍스트를 돌려준다', async () => {
  stubFetch(() => jsonResponse(200, completion('강의일지\n1. 강의 개요\n- 일시: 2026-11-15')));
  const res = await invoke();

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.truncated, false);
  assert.match(res.payload.text, /강의일지/);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(fetchCalls[0].init.headers['x-api-key'], 'test-key');
  assert.equal(fetchCalls[0].body.model, 'claude-sonnet-5-5');
  assert.equal(fetchCalls[0].body.thinking.type, 'between_tools');
  assert.equal(fetchCalls[0].body.max_tokens, 3000);
});

test('시스템 지침이 마크다운 기호를 금지하고 사실 창작을 막는다', () => {
  assert.match(SYSTEM_PROMPT, /순수 일반 텍스트/);
  assert.match(SYSTEM_PROMPT, /마크다운 서식 기호/);
  assert.match(SYSTEM_PROMPT, /절대 쓰지 않는다/);
  for (const token of ['**', '##', '#', '*', '_', '백틱', '~~', '>', '|']) {
    assert.ok(SYSTEM_PROMPT.includes(token), `시스템 지침에 "${token}" 언급이 없다`);
  }
  assert.match(SYSTEM_PROMPT, /지어내지 않는다/);
  assert.match(SYSTEM_PROMPT, /확인 필요/);
});

test('모델이 마크다운을 섞어 보내도 응답은 순수 텍스트로 정리된다', async () => {
  const markdown = [
    '## 강의일지',
    '',
    '**기관명**: 구래종합사회복지관',
    '',
    '- 개념 설명',
    '- 프롬프트 실습',
    '',
    '```',
    '코드 블록',
    '```',
    '',
    '| 항목 | 값 |',
    '| --- | --- |',
    '| 인원 | 30명 |',
    '',
    '~~취소~~ `백틱`',
    '---',
  ].join('\n');

  stubFetch(() => jsonResponse(200, completion(markdown)));
  const res = await invoke();
  const text = res.payload.text;

  assert.equal(res.statusCode, 200);
  for (const bad of ['**', '##', '```', '~~', '`', '\n- ', '| ---']) {
    assert.equal(text.includes(bad), false, `마크다운 기호가 남아 있다: ${bad}`);
  }
  assert.match(text, /강의일지/);
  assert.match(text, /· 개념 설명/);
  assert.match(text, /항목 \/ 값/);
  assert.match(text, /인원 \/ 30명/);
});

test('sanitizeText 는 일반 문장·숫자·가운뎃점을 건드리지 않는다', () => {
  const plain = '1. 강의 개요\n- 일시: 2026-11-15 10:00~13:00\n2. 인원 30명 (사회복지사)\n* 강조 아님';
  const out = sanitizeText(plain);
  assert.match(out, /2026-11-15 10:00~13:00/);
  assert.match(out, /30명 \(사회복지사\)/);
  assert.equal(out.includes('**'), false);
  assert.equal(sanitizeText(''), '');
});

test('응답이 max_tokens 로 잘리면 truncated=true 를 준다', async () => {
  stubFetch(() => jsonResponse(200, completion('긴 문서…', 'max_tokens')));
  const res = await invoke();
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.truncated, true);
});

test('클라이언트가 보낸 max_tokens 는 서버 설정값을 넘지 못하고, 작은 값은 인정한다', async () => {
  stubFetch(() => jsonResponse(200, completion('ok')));

  await invoke({ body: { prompt: '메모', maxTokens: 99999 } });
  assert.equal(fetchCalls[0].body.max_tokens, 3000, '서버 기본 상한을 넘겨 과금을 늘릴 수 없다');

  await invoke({ body: { prompt: '메모', maxTokens: 600 } });
  assert.equal(fetchCalls[1].body.max_tokens, 600);

  await invoke({ body: { prompt: '메모', maxTokens: 10 } });
  assert.equal(fetchCalls[2].body.max_tokens, 256, '너무 작은 값은 최소값으로 올린다');
});

// ── 접근 코드 · Origin ───────────────────────────────────

test('접근 코드가 설정되면 코드 없는 요청은 401 이다', async () => {
  process.env.APP_ACCESS_CODE = 'lj-2026';
  stubFetch(() => jsonResponse(200, completion('ok')));

  const res = await invoke();
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.code, 'access_code_required');
  assert.equal(fetchCalls.length, 0, '인증 실패 시 AI 를 호출하지 않는다');
});

test('접근 코드가 맞으면 통과한다', async () => {
  process.env.APP_ACCESS_CODE = 'lj-2026';
  stubFetch(() => jsonResponse(200, completion('ok')));

  const res = await invoke({ headers: { 'x-app-code': 'lj-2026' } });
  assert.equal(res.statusCode, 200);
  assert.equal(fetchCalls.length, 1);
});

test('다른 오리진에서 온 요청은 접근 코드가 있어도 403 이다', async () => {
  process.env.APP_ACCESS_CODE = 'lj-2026';
  stubFetch(() => jsonResponse(200, completion('ok')));

  const res = await invoke({ headers: { origin: 'https://evil.example.com', 'x-app-code': 'lj-2026' } });
  assert.equal(res.statusCode, 403);
  assert.equal(fetchCalls.length, 0);
});

test('오리진·리퍼러가 없고 접근 코드도 없으면 직접 호출을 막는다(403)', async () => {
  stubFetch(() => jsonResponse(200, completion('ok')));
  const req = mockReq({ body: { prompt: '메모' }, headers: {} });
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(fetchCalls.length, 0);
});

test('APP_ALLOWED_ORIGINS 에 등록한 오리진은 허용된다', async () => {
  process.env.APP_ALLOWED_ORIGINS = 'https://journal.example.com';
  stubFetch(() => jsonResponse(200, completion('ok')));

  const res = await invoke({ headers: { origin: 'https://journal.example.com' } });
  assert.equal(res.statusCode, 200);
});

// ── 입력 검증 ────────────────────────────────────────────

test('프롬프트가 비면 400 이다', async () => {
  const empty = await invoke({ body: { prompt: '   ' } });
  assert.equal(empty.statusCode, 400);

  const missing = await invoke({ body: {} });
  assert.equal(missing.statusCode, 400);
  assert.equal(fetchCalls.length, 0);
});

test('프롬프트가 상한을 넘으면 413 이다', async () => {
  const cfg = getConfig();
  const res = await invoke({ body: { prompt: '가'.repeat(cfg.maxPromptChars + 1) } });
  assert.equal(res.statusCode, 413);
  assert.match(res.payload.error, /이내/);
});

test('본문 크기가 상한을 넘으면 413 이다', async () => {
  const res = await invoke({
    body: { prompt: '메모' },
    headers: { 'content-length': String(1024 * 1024) },
  });
  assert.equal(res.statusCode, 413);
});

test('JSON 이 아닌 본문은 400 이다', async () => {
  const req = mockReq({ body: '{이건 JSON 아님', headers: { origin: ORIGIN } });
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /형식/);
});

test('API 키가 없으면 503 이다', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  stubFetch(() => jsonResponse(200, completion('ok')));
  const res = await invoke();
  assert.equal(res.statusCode, 503);
  assert.equal(fetchCalls.length, 0);
});

// ── 속도 제한 ────────────────────────────────────────────

test('분당 생성 횟수를 넘으면 429 와 Retry-After 를 준다', async () => {
  process.env.RATE_LIMIT_PER_MIN = '2';
  stubFetch(() => jsonResponse(200, completion('ok')));
  const ip = '192.0.2.44';

  assert.equal((await invoke({ ip })).statusCode, 200);
  assert.equal((await invoke({ ip })).statusCode, 200);
  const third = await invoke({ ip });
  assert.equal(third.statusCode, 429);
  assert.ok(Number(third.headers['retry-after']) >= 1);
  assert.equal(fetchCalls.length, 2);
});

test('IP 가 다르면 한도를 따로 센다', async () => {
  process.env.RATE_LIMIT_PER_MIN = '1';
  stubFetch(() => jsonResponse(200, completion('ok')));
  assert.equal((await invoke({ ip: '192.0.2.71' })).statusCode, 200);
  assert.equal((await invoke({ ip: '192.0.2.72' })).statusCode, 200);
  assert.equal((await invoke({ ip: '192.0.2.71' })).statusCode, 429);
});

// ── 업스트림 오류 ────────────────────────────────────────

test('업스트림 429 는 429 로, 500 은 502 로 바꿔 알려 준다', async () => {
  stubFetch(() => jsonResponse(429, { error: { message: 'rate limited' } }));
  const busy = await invoke();
  assert.equal(busy.statusCode, 429);

  stubFetch(() => jsonResponse(500, { error: { message: 'boom' } }));
  const broken = await invoke();
  assert.equal(broken.statusCode, 502);
  assert.doesNotMatch(String(broken.payload.error), /boom|claude/i, '업스트림 상세는 노출하지 않는다');
});

test('업스트림 401 은 500(관리자 문의)으로 안내한다', async () => {
  stubFetch(() => jsonResponse(401, { error: { message: 'invalid api key' } }));
  const res = await invoke();
  assert.equal(res.statusCode, 500);
  assert.match(res.payload.error, /관리자/);
  assert.doesNotMatch(String(res.payload.error), /api key/i);
});

test('연결 실패는 502, 타임아웃은 504 로 안내한다', async () => {
  stubFetch(() => { throw new Error('ECONNREFUSED'); });
  assert.equal((await invoke()).statusCode, 502);

  stubFetch(() => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  assert.equal((await invoke()).statusCode, 504);
});

test('빈 응답이면 502 다', async () => {
  stubFetch(() => jsonResponse(200, { content: [], stop_reason: 'end_turn' }));
  const res = await invoke();
  assert.equal(res.statusCode, 502);
  assert.match(res.payload.error, /비어/);
});

test('마크다운만 있던 응답도 정리 후 비면 502 로 처리한다', async () => {
  stubFetch(() => jsonResponse(200, completion('---\n***')));
  const res = await invoke();
  assert.equal(res.statusCode, 502);
});
