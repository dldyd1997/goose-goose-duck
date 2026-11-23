// 구스구스덕 서버: 정적 파일 + 웹소켓 중계(방별 presence 공유) + QR 페이지 + 교사(방장) 인증
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

// 교사(방장) 비밀번호: Render의 Environment에 HOST_PASSWORD 로 설정하세요.
const HOST_PASSWORD = process.env.HOST_PASSWORD || '1234';
if (!process.env.HOST_PASSWORD) console.log('주의: HOST_PASSWORD 환경변수가 없어 기본 비밀번호(1234)를 쓰고 있어요. Render에서 꼭 바꿔 주세요.');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const app = express();
app.disable('x-powered-by');

// 저장소 맨 바깥에 있는 화면 파일만 내보냅니다 (server.js 등은 공개하지 않아요)
const FILES = ['index.html', 'goose.png', 'map.jpg', 'mask.png', 'title.jpg'];
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:f', (req, res, next) => FILES.includes(req.params.f) ? res.sendFile(path.join(__dirname, req.params.f)) : next());
app.get('/healthz', (_req, res) => res.send('ok'));

// /qr  또는  /qr?room=abc  → 현재 주소로 들어오는 QR 코드 페이지
app.get('/qr', async (req, res) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  const room = String(req.query.room || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
  const url = `${proto}://${req.headers.host}/` + (room ? `?room=${room}` : '');
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 420 });
  res.type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>구스구스덕 QR</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#15171c;color:#fff;font-family:system-ui,sans-serif;text-align:center}
.q{background:#fff;padding:12px;border-radius:16px;width:min(80vw,420px)}.q svg{width:100%;height:auto;display:block}h1{margin:0;font-size:40px;color:#ffc83d}</style></head>
<body><h1>구스구스덕</h1><div class="q">${svg}</div><div>QR을 찍어서 입장하세요</div><small>${url}</small></body></html>`);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8192 });
const MAX_PER_ROOM = 25;
const GRACE_MS = Number(process.env.GRACE_MS) || 8000; // 방장이 끊긴 뒤 이 시간 안에 돌아오지 않으면 방 종료
const BAN_MS = 120000; // 강퇴된 닉네임이 다시 들어오지 못하는 시간
const rooms = new Map(); // roomName -> { peers: Map(id -> {ws, d}), dirty, urgent, last, hostId, closeAt, closeTimer, ban }

function closeRoom(name) {
  const room = rooms.get(name);
  if (!room) return;
  clearTimeout(room.closeTimer);
  rooms.delete(name);
  for (const pe of room.peers.values()) {
    try { pe.ws.send(JSON.stringify({ t: 'closed' })); pe.ws.close(); } catch {}
  }
}

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const name = (u.searchParams.get('room') || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'main';
  let room = rooms.get(name);
  if (!room) rooms.set(name, (room = { peers: new Map(), dirty: false, urgent: false, last: 0, hostId: null, closeAt: 0, closeTimer: null, ban: new Map() }));
  if (room.peers.size >= MAX_PER_ROOM) { ws.send(JSON.stringify({ t: 'full' })); return ws.close(); }

  const id = crypto.randomBytes(5).toString('hex');
  const me = { ws, d: null, tokens: 60, last: Date.now(), fails: 0, gs: '' };
  room.peers.set(id, me);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ t: 'hello', id }));

  ws.on('message', (raw) => {
    const now = Date.now();
    me.tokens = Math.min(60, me.tokens + (now - me.last) / 16); me.last = now; // 초당 약 60회 제한
    if (me.tokens < 1) return;
    me.tokens -= 1;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m) return;
    if (m.t === 'p' && m.d && typeof m.d === 'object' && !Array.isArray(m.d)) {
      if (JSON.stringify(m.d).length > 4096) return;
      if (typeof m.d.n === 'string') m.d.n = m.d.n.slice(0, 16);
      const bn = room.ban.get(m.d.n);
      if (bn && bn > now) { ws.send(JSON.stringify({ t: 'kicked' })); return ws.close(); }
      const prev = me.d || {};
      const gs = m.d.g ? JSON.stringify(m.d.g) : '';
      // 공격·신고·투표·방장 상태 변화는 바로 전달(지연 최소화), 위치 같은 값은 묶어서 전달
      if (m.d.ks !== prev.ks || m.d.rs !== prev.rs || m.d.v !== prev.v || gs !== me.gs) room.urgent = true;
      me.gs = gs;
      me.d = m.d; room.dirty = true;
    } else if (m.t === 'host') {
      if (me.fails >= 5) return ws.send(JSON.stringify({ t: 'hostno' }));
      if (typeof m.pw === 'string' && safeEq(m.pw, HOST_PASSWORD)) {
        room.hostId = id; room.dirty = room.urgent = true;
        if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; room.closeAt = 0; }
      } else {
        me.fails++; ws.send(JSON.stringify({ t: 'hostno' }));
      }
    } else if (m.t === 'kick') {
      // 방장만 강퇴할 수 있어요
      if (room.hostId !== id || typeof m.id !== 'string' || m.id === id) return;
      const t = room.peers.get(m.id);
      if (!t) return;
      if (t.d && typeof t.d.n === 'string') room.ban.set(t.d.n, Date.now() + BAN_MS);
      try { t.ws.send(JSON.stringify({ t: 'kicked' })); t.ws.close(); } catch {}
    }
  });
  ws.on('close', () => {
    room.peers.delete(id); room.dirty = room.urgent = true;
    if (room.peers.size === 0) { clearTimeout(room.closeTimer); rooms.delete(name); return; }
    if (room.hostId === id) {
      // 방장이 나가면 잠깐(새로고침 등) 기다렸다가 돌아오지 않으면 방을 종료해요
      room.hostId = null;
      room.closeAt = Date.now() + GRACE_MS;
      clearTimeout(room.closeTimer);
      room.closeTimer = setTimeout(() => closeRoom(name), GRACE_MS);
    }
  });
});

// 변경이 있는 방에만 전송: 보통은 약 10Hz, 긴급 변화(공격·신고·투표 등)는 즉시
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.closeAt) room.dirty = true; // 종료 카운트다운 갱신
    if (!room.dirty) continue;
    if (!room.urgent && now - room.last < 100) continue;
    room.dirty = room.urgent = false; room.last = now;
    const p = [];
    for (const [id, pe] of room.peers) if (pe.d) p.push({ id, d: pe.d });
    const gc = room.closeAt ? Math.max(0, Math.ceil((room.closeAt - now) / 1000)) : 0;
    const msg = JSON.stringify({ t: 'snap', p, h: room.hostId, gc });
    for (const pe of room.peers.values()) if (pe.ws.readyState === 1) pe.ws.send(msg);
  }
}, 20);

// 끊긴 연결 정리(프록시 유휴 종료 방지용 ping 포함)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 20000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('구스구스덕 서버 실행 중: http://localhost:' + PORT));
