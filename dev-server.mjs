// 로컬 미리보기 서버 (저장소에 포함 — 배포와 무관한 개발용)
//
//   npm run dev        → http://localhost:4321
//
// 하는 일
//  · index.html / manifest.json / sw.js / icons 를 그대로 서빙
//  · /api/generate : ANTHROPIC_API_KEY 가 없으면 가짜 샘플 문서를 돌려준다(화면 확인용).
//                    키가 있으면 실제 api/generate.js 를 그대로 호출한다.
//  · /api/save-drive : 실제 핸들러를 그대로 호출한다(웹훅 미설정이면 데모 모드 응답).
//
// 실제 배포(Vercel)에서는 이 파일을 쓰지 않는다.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4321);

const { default: generateHandler } = await import('./api/generate.js');
const { default: saveDriveHandler } = await import('./api/save-drive.js');

const SAMPLE = [
  '강의일지',
  '119복지인권연구소 · ONEBLOCKAI연구소 / 이대영',
  '',
  '1. 강의 개요',
  '일시: 2026년 11월 15일 10:00~13:00 (3시간)',
  '기관: 구래종합사회복지관',
  '분야: AI 실무 교육',
  '대상: 사회복지사 30명',
  '진행 방식: 대면',
  '',
  '2. 강의 목표',
  '1) 생성형 AI의 기본 개념을 실무 언어로 이해한다.',
  '2) 민원 답변과 보도자료에 바로 쓰는 프롬프트를 만든다.',
  '3) 개인정보를 입력하지 않고 안전하게 활용하는 기준을 세운다.',
  '',
  '3. 진행 내용',
  '10:00~10:40 생성형 AI 개념과 사회복지 현장 활용 사례를 설명하였다.',
  '10:40~11:30 프롬프트 4원칙을 설명하고 민원 답변 실습을 진행하였다.',
  '11:30~12:20 보도자료 초안 만들기 실습을 조별로 진행하였다.',
  '12:20~13:00 질의응답과 개인정보 유의사항을 정리하였다.',
  '',
  '4. 주요 질의와 답변',
  '질문: 개인정보를 입력해도 되는지 문의가 있었다. 답변: 이름·연락처 등 식별 정보는 마스킹하고, 기관 승인 도구만 사용하도록 안내하였다.',
  '질문: 유료 결제를 누가 하는지 문의가 있었다. 답변: 확인 후 안내하기로 하였다(확인 필요).',
  '',
  '5. 현장 반응과 특이사항',
  '실습 참여도가 높았고, 원장님이 마지막에 감사 인사를 전하셨다.',
  '',
  '6. 개선점과 다음 강의에 반영할 점',
  '실습 시간을 20분 더 확보하면 좋겠다는 요청이 있었다.',
].join('\n');

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  req.body = rawBody || undefined;
  req.headers.host = req.headers.host || `localhost:${PORT}`;

  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };

  if (url.pathname === '/api/generate' && req.method === 'POST' && !process.env.ANTHROPIC_API_KEY) {
    return json(res, 200, { text: SAMPLE, truncated: false, mock: true });
  }

  if (url.pathname.startsWith('/api/')) {
    const handler = url.pathname === '/api/generate' ? generateHandler : url.pathname === '/api/save-drive' ? saveDriveHandler : null;
    if (!handler) return json(res, 404, { error: 'not found' });
    return handler(req, res);
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });

  const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
  const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  try {
    const data = await readFile(path.join(ROOT, safe));
    res.setHeader('Content-Type', MIME[path.extname(safe)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.listen(PORT, () => console.log(`lecture-journal-app local preview: http://localhost:${PORT}`));
