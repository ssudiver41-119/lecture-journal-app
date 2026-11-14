// /api/save-drive — 완성된 강의일지 · 결과보고서 · 메일 초안을 구글 드라이브에 저장
//
// 하는 일
//   1) Origin/Referer 검증 — 허용된 오리진 외 호출 차단 (generate.js 와 같은 규칙)
//   2) 접근 코드 게이트 — APP_ACCESS_CODE 가 설정되면 x-app-code 헤더가 일치해야 통과
//   3) 입력 검증 — 날짜·기관명·양식·본문 길이 (본문은 서버에서 마크다운 기호를 한 번 더 정리)
//   4) 속도 제한 — IP당 분당 10회 / 일 100회 (메모리 카운터, 최선 노력형)
//   5) GOOGLE_DRIVE_WEBHOOK_URL(Apps Script 웹앱)로 전송 → 문서 + 누적 시트 행 생성
//   6) 웹훅 미설정 시 500 대신 '데모 모드' 안내 응답
//
// 환경변수
//   GOOGLE_DRIVE_WEBHOOK_URL  (필수, 미설정 시 데모 모드)
//   WEBHOOK_SHARED_SECRET     (권장, 설정 시 웹훅 URL 에 ?token=... 으로 전달)
//   APP_ACCESS_CODE           (권장, generate.js 와 같은 값)
//   APP_ALLOWED_ORIGINS       (선택, 쉼표 구분 추가 오리진)
//
// 주의: 웹훅 URL 은 서버에서만 쓰므로 브라우저에 노출되지 않는다. 본문은 로그에 남기지 않는다.

import { browserContext, getConfig, safeEqual, sanitizeText } from './generate.js';

const MAX_BODY_BYTES = 64 * 1024; // 64KB
const MAX_CONTENT_CHARS = 30000;
const WEBHOOK_TIMEOUT_MS = 20000;
const APP_VERSION = '1.0.0';

// 화면의 양식 선택과 1:1 로 맞춘 목록 (여기 없는 값은 거절)
export const FORMAT_LABELS = {
  journal: '강의일지',
  report: '결과보고서',
  mail: '메일초안'
};

// ── 속도 제한 ─────────────────────────────────────────
const rateBuckets = new Map();
const DAY_MS = 24 * 60 * 60 * 1000;

function limitFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clientIp(req) {
  const header = req && req.headers ? req.headers['x-forwarded-for'] || req.headers['X-Forwarded-For'] : '';
  const first = String(header || '').split(',')[0].trim();
  if (first) return first;
  if (req && req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function checkRateLimit(ip, now = Date.now()) {
  const perMinute = limitFromEnv('SAVE_RATE_LIMIT_PER_MIN', 10);
  const perDay = limitFromEnv('SAVE_RATE_LIMIT_PER_DAY', 100);

  const bucket = rateBuckets.get(ip) || { minuteStart: now, minuteCount: 0, dayStart: now, dayCount: 0 };
  if (now - bucket.minuteStart >= 60 * 1000) {
    bucket.minuteStart = now;
    bucket.minuteCount = 0;
  }
  if (now - bucket.dayStart >= DAY_MS) {
    bucket.dayStart = now;
    bucket.dayCount = 0;
  }

  if (bucket.minuteCount >= perMinute) {
    rateBuckets.set(ip, bucket);
    return { allowed: false, scope: 'minute', retryAfter: Math.max(1, Math.ceil((bucket.minuteStart + 60 * 1000 - now) / 1000)) };
  }
  if (bucket.dayCount >= perDay) {
    rateBuckets.set(ip, bucket);
    return { allowed: false, scope: 'day', retryAfter: Math.max(1, Math.ceil((bucket.dayStart + DAY_MS - now) / 1000)) };
  }

  bucket.minuteCount += 1;
  bucket.dayCount += 1;
  rateBuckets.set(ip, bucket);

  if (rateBuckets.size > 5000) {
    for (const [key, value] of rateBuckets) {
      if (now - value.dayStart >= DAY_MS) rateBuckets.delete(key);
    }
  }
  return { allowed: true };
}

/** 테스트용: 속도 제한 카운터 초기화 */
export function __resetRateLimits() {
  rateBuckets.clear();
}

// ── 응답 유틸 ─────────────────────────────────────────
function send(res, status, payload, extraHeaders = {}) {
  res.statusCode = status;
  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    Object.keys(extraHeaders).forEach((key) => res.setHeader(key, extraHeaders[key]));
  }
  const body = JSON.stringify(payload);
  if (typeof res.json === 'function') {
    res.json(payload);
    return body;
  }
  if (typeof res.end === 'function') res.end(body);
  else if (typeof res.send === 'function') res.send(body);
  return body;
}

/** Vercel: req.body 는 이미 파싱되어 있을 수 있고, 아니면 스트림에서 읽는다. */
async function readJsonBody(req) {
  const body = req && req.body;

  if (body !== undefined && body !== null && body !== '') {
    if (typeof body === 'object' && !Buffer.isBuffer(body)) return body;
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      const error = new Error('PAYLOAD_TOO_LARGE');
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      const error = new Error('INVALID_JSON');
      error.code = 'INVALID_JSON';
      throw error;
    }
  }

  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('PAYLOAD_TOO_LARGE');
      error.code = 'PAYLOAD_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    const error = new Error('INVALID_JSON');
    error.code = 'INVALID_JSON';
    throw error;
  }
}

// ── 입력 검증 ─────────────────────────────────────────
function text(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function validDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

export function validateEntry(raw) {
  const errors = {};
  const data = {
    date: text(raw.date, 10),
    org: text(raw.org, 80),
    field: text(raw.field, 40),
    fieldEtc: text(raw.fieldEtc, 40),
    method: text(raw.method, 20),
    audience: text(raw.audience, 60),
    format: text(raw.format, 20),
    note: text(raw.note, 500),
    lecturer: text(raw.lecturer, 40),
    affiliation: text(raw.affiliation, 60),
    content: sanitizeText(text(raw.content, MAX_CONTENT_CHARS + 1000))
  };

  if (!data.date) errors.date = '강의 날짜를 입력해주세요.';
  else if (!validDate(data.date)) errors.date = '날짜는 YYYY-MM-DD 형식이어야 합니다.';

  if (!data.org) errors.org = '기관명을 입력해주세요.';
  else if (data.org.length < 2) errors.org = '기관명을 2자 이상 입력해주세요.';

  if (!data.content) errors.content = '저장할 내용이 없습니다. 먼저 문서를 생성해 주세요.';
  else if (data.content.length > MAX_CONTENT_CHARS) errors.content = `내용이 너무 깁니다. ${MAX_CONTENT_CHARS}자 이내로 줄여 주세요.`;

  if (!data.format) errors.format = '저장할 양식을 선택해주세요.';
  else if (!FORMAT_LABELS[data.format]) errors.format = '양식 값이 올바르지 않습니다.';

  return { ok: Object.keys(errors).length === 0, errors, data };
}

// ── 웹훅 ─────────────────────────────────────────────
export function buildWebhookPayload(data, meta) {
  return {
    date: data.date,
    orgName: data.org,
    field: data.field === '기타' && data.fieldEtc ? data.fieldEtc : data.field,
    fieldCode: data.field,
    method: data.method,
    audience: data.audience,
    format: data.format,
    formatLabel: FORMAT_LABELS[data.format],
    content: data.content,
    note: data.note,
    lecturer: data.lecturer,
    affiliation: data.affiliation,
    savedAt: meta.savedAt,
    savedAtLabel: meta.savedAtLabel,
    source: 'lecture-journal-app',
    appVersion: APP_VERSION
  };
}

async function postToWebhook(url, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'User-Agent': `lecture-journal-app/${APP_VERSION}`
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: controller.signal
    });

    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    return { ok: response.ok, status: response.status, body: parsed, raw };
  } finally {
    clearTimeout(timer);
  }
}

function nowKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    savedAt: now.toISOString(),
    savedAtLabel: `${kst.getUTCFullYear()}-${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())} ${pad(kst.getUTCHours())}:${pad(kst.getUTCMinutes())} (KST)`
  };
}

// ── 핸들러 ────────────────────────────────────────────
export default async function handler(req, res) {
  const cfg = getConfig();
  const method = String((req && req.method) || 'POST').toUpperCase();

  if (method === 'OPTIONS') {
    return send(res, 204, {});
  }
  if (method !== 'POST') {
    return send(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 처리합니다.' }, { Allow: 'POST, OPTIONS' });
  }

  // 1) Origin / Referer 검증
  const context = browserContext(req, cfg);
  if (context === 'blocked') {
    console.warn('[api/save-drive] blocked:origin', clientIp(req));
    return send(res, 403, { ok: false, code: 'FORBIDDEN_ORIGIN', message: '허용되지 않은 경로에서의 요청입니다.' });
  }

  // 2) 접근 코드 게이트
  const provided = String(
    (req && req.headers && (req.headers['x-app-code'] || req.headers['X-App-Code'])) ||
      String((req && req.headers && (req.headers.authorization || req.headers.Authorization)) || '').replace(/^Bearer\s+/i, '') ||
      ''
  ).trim();

  if (cfg.accessCode) {
    if (!safeEqual(provided, cfg.accessCode)) {
      console.warn('[api/save-drive] blocked:access-code', clientIp(req));
      return send(res, 401, { ok: false, code: 'access_code_required', message: '접근 코드가 필요합니다. 앱 설정에서 입력해 주세요.' });
    }
  } else if (context === 'none') {
    console.warn('[api/save-drive] blocked:no-origin', clientIp(req));
    return send(res, 403, { ok: false, code: 'FORBIDDEN_ORIGIN', message: '허용되지 않은 경로에서의 요청입니다.' });
  }

  // 3) 속도 제한
  const ip = clientIp(req);
  const limit = checkRateLimit(ip);
  if (!limit.allowed) {
    return send(
      res,
      429,
      {
        ok: false,
        code: 'RATE_LIMITED',
        message: limit.scope === 'minute' ? '잠시 후 다시 저장해 주세요.' : '오늘 저장 가능한 횟수를 넘었습니다.',
        scope: limit.scope,
        retryAfter: limit.retryAfter
      },
      { 'Retry-After': String(limit.retryAfter) }
    );
  }

  // 4) 본문 · 입력 검증
  let raw;
  try {
    raw = await readJsonBody(req);
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      return send(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE', message: '저장할 내용이 너무 큽니다. 내용을 줄여 다시 시도해 주세요.' });
    }
    return send(res, 400, { ok: false, code: 'INVALID_JSON', message: '요청 형식을 확인해 주세요.' });
  }

  const { ok, errors, data } = validateEntry(raw);
  if (!ok) {
    return send(res, 400, { ok: false, code: 'VALIDATION_ERROR', message: '저장할 내용을 확인해 주세요.', errors });
  }

  const meta = nowKST();
  const webhookUrl = String(process.env.GOOGLE_DRIVE_WEBHOOK_URL || '').trim();

  // 5) 웹훅 미설정 → 데모 모드 (명확한 안내)
  if (!webhookUrl) {
    return send(res, 200, {
      ok: true,
      mode: 'demo',
      code: 'WEBHOOK_NOT_CONFIGURED',
      docName: `[${data.date}] ${data.org}_${FORMAT_LABELS[data.format]}`,
      notice:
        '구글 드라이브 연동(GOOGLE_DRIVE_WEBHOOK_URL)이 아직 설정되지 않아 파일이 저장되지 않았습니다. ' +
        '아래 문서를 복사해 두시고, 관리자에게 연동 설정을 요청해 주세요. (README 의 배포 안내 참고)'
    });
  }

  // 6) Apps Script 웹앱으로 전송
  const payload = buildWebhookPayload(data, meta);
  let target = webhookUrl;
  const secret = String(process.env.WEBHOOK_SHARED_SECRET || '').trim();
  if (secret) {
    target += (target.includes('?') ? '&' : '?') + `token=${encodeURIComponent(secret)}`;
  }

  try {
    const result = await postToWebhook(target, payload);

    if (!result.ok) {
      console.error('[api/save-drive] webhook http error', result.status);
      return send(res, 502, {
        ok: false,
        code: 'WEBHOOK_ERROR',
        message: '구글 드라이브 저장 단계에서 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.'
      });
    }

    if (result.body && result.body.ok === false) {
      return send(res, 502, {
        ok: false,
        code: 'WEBHOOK_REJECTED',
        message: result.body.message || '구글 드라이브 저장이 거절되었습니다. 설정을 확인해 주세요.'
      });
    }

    const stored = (result.body && result.body.result) || {};
    return send(res, 200, {
      ok: true,
      mode: 'live',
      docName: stored.docName || `[${data.date}] ${data.org}_${FORMAT_LABELS[data.format]}`,
      savedAtLabel: meta.savedAtLabel,
      stored: {
        docUrl: stored.docUrl || null,
        sheetUrl: stored.sheetUrl || null,
        folderUrl: stored.folderUrl || null
      }
    });
  } catch (err) {
    const timedOut = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    console.error('[api/save-drive] webhook failed', timedOut ? 'timeout' : (err && err.message));
    return send(res, 504, {
      ok: false,
      code: timedOut ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_UNREACHABLE',
      message: '구글 드라이브 저장 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
    });
  }
}

export const config = { MAX_BODY_BYTES, MAX_CONTENT_CHARS, WEBHOOK_TIMEOUT_MS, APP_VERSION };
