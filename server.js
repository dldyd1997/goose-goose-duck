// 구스구스덕 서버 v3
// 정적 파일 + 웹소켓 중계(방별 상태 공유) + QR 페이지 + 교사(방장) 인증
// - 방장만 게임 상태(g)를 올릴 수 있고, 방장이 나가면 방이 바로 종료돼요.
// - 강퇴는 즉시 처리되고, 강퇴된 사람도 바로 다시 들어올 수 있어요.
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));

const HOST_PASSWORD = process.env.HOST_PASSWORD || '1234';
if (!process.env.HOST_PASSWORD) console.log('주의: HOST_PASSWORD 환경변수가 없어 기본 비밀번호(1234)를 쓰고 있어요. Render에서 꼭 바꿔 주세요.');
const MAX_PER_ROOM = 25;
const GRACE_MS = Number(process.env.GRACE_MS) || 3000;      // 방장 연결이 갑자기 끊겼을 때 기다려 주는 시간
const PING_MS = Number(process.env.PING_MS) || 4000;        // 끊긴 연결을 찾는 주기(응답이 두 번 없으면 정리)
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const safeSend = (ws, obj) => { try { if (ws.readyState === 1) ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch {} };
// 메시지를 보낸 뒤 바로 연결을 끊어요. 상대가 응답하지 않아도 잠깐 뒤 강제로 닫아요.
const dropSocket = (ws, obj) => {
  try { if (obj) safeSend(ws, obj); ws.close(); } catch {}
  setTimeout(() => { try { ws.terminate(); } catch {} }, 400);
};

const app = express();
app.disable('x-powered-by');
const FILES = ['index.html', 'goose.png', 'map.jpg', 'mask.png', 'title.jpg'];
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:f', (req, res, next) => FILES.includes(req.params.f) ? res.sendFile(path.join(__dirname, req.params.f)) : next());
app.get('/healthz', (_req, res) => res.send('ok'));
app.get('/qr', async (req, res) => {
  try {
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
    const room = String(req.query.room || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 24);
    const url = `${proto}://${req.headers.host}/` + (room ? `?room=${room}` : '');
    const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 420 });
    res.type('html').send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>구스구스덕 QR</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#15171c;color:#fff;font-family:system-ui,sans-serif;text-align:center}
.q{background:#fff;padding:12px;border-radius:16px;width:min(80vw,420px)}.q svg{width:100%;height:auto;display:block}h1{margin:0;font-size:40px;color:#ffc83d}</style></head>
<body><h1>구스구스덕</h1><div class="q">${svg}</div><div>QR을 찍어서 입장하세요</div><small>${url}</small></body></html>`);
  } catch (e) { res.status(500).send('error'); }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32768 });
const rooms = new Map(); // name -> { peers: Map(id -> peer), hostId, g, gVer, dirty, urgent, last, closeAt, closeTimer }

function closeRoom(name) {
  const room = rooms.get(name);
  if (!room) return;
  clearTimeout(room.closeTimer);
  rooms.delete(name);
  for (const pe of room.peers.values()) { pe.gone = true; dropSocket(pe.ws, { t: 'closed' }); }
  room.peers.clear();
}

function removePeer(name, room, id) {
  if (!room.peers.delete(id)) return;
  room.dirty = room.urgent = true;
  if (room.peers.size === 0) { clearTimeout(room.closeTimer); rooms.delete(name); return; }
  if (room.hostId === id) {
    // 방장이 갑자기 끊기면 짧게 기다렸다가 돌아오지 않으면 방을 종료해요 (새로고침만 한 경우를 위해)
    room.hostId = null; room.g = null; room.gVer++;
    room.closeAt = Date.now() + GRACE_MS;
    clearTimeout(room.closeTimer);
    room.closeTimer = setTimeout(() => closeRoom(name), GRACE_MS);
  }
}

wss.on('connection', (ws, req) => {
  ws.on('error', () => {});
  let name, room, id, me;
  try {
    const u = new URL(req.url, 'http://x');
    name = (u.searchParams.get('room') || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'main';
    room = rooms.get(name);
    if (!room) rooms.set(name, (room = { peers: new Map(), hostId: null, g: null, gVer: 0, dirty: false, urgent: false, last: 0, closeAt: 0, closeTimer: null }));
    if (room.peers.size >= MAX_PER_ROOM) return dropSocket(ws, { t: 'full' });
    id = crypto.randomBytes(5).toString('hex');
    me = { ws, id, d: null, tokens: 80, last: Date.now(), fails: 0, gone: false, gSeen: -1, gs: '' };
    room.peers.set(id, me);
    room.dirty = room.urgent = true;
  } catch (e) { return dropSocket(ws); }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  safeSend(ws, { t: 'hello', id });

  ws.on('message', (raw) => {
    try {
      if (me.gone) return;
      const now = Date.now();
      me.tokens = Math.min(80, me.tokens + (now - me.last) / 12); me.last = now; // 초당 약 80회 제한
      if (me.tokens < 1) return;
      me.tokens -= 1;
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'p' && m.d && typeof m.d === 'object' && !Array.isArray(m.d)) {
        delete m.d.g;
        if (JSON.stringify(m.d).length > 2000) return;
        if (typeof m.d.n === 'string') m.d.n = m.d.n.slice(0, 16);
        const prev = me.d || {};
        // 공격·신고·투표 같은 변화는 바로 전달해서 지연을 줄여요
        if (m.d.ks !== prev.ks || m.d.rs !== prev.rs || m.d.v !== prev.v || m.d.ds !== prev.ds || m.d.bs !== prev.bs || m.d.xs !== prev.xs || m.d.vi !== prev.vi || !me.d) room.urgent = true;
        me.d = m.d; room.dirty = true;
      } else if (m.t === 'g') {
        // 게임 상태는 방장만 올릴 수 있어요
        if (room.hostId !== id || !m.g || typeof m.g !== 'object') return;
        const s = JSON.stringify(m.g);
        if (s.length > 24000 || s === me.gs) return;
        me.gs = s; room.g = m.g; room.gVer++; room.dirty = room.urgent = true;
      } else if (m.t === 'host') {
        if (me.fails >= 5) return safeSend(ws, { t: 'hostno' });
        if (typeof m.pw === 'string' && safeEq(m.pw, HOST_PASSWORD)) {
          if (room.hostId !== id) { room.hostId = id; room.g = null; room.gVer++; me.gs = ''; }
          room.dirty = room.urgent = true;
          if (room.closeTimer) { clearTimeout(room.closeTimer); room.closeTimer = null; room.closeAt = 0; }
        } else { me.fails++; safeSend(ws, { t: 'hostno' }); }
      } else if (m.t === 'kick') {
        if (room.hostId !== id || typeof m.id !== 'string' || m.id === id) return;
        const t = room.peers.get(m.id);
        if (!t) return;
        t.gone = true;
        removePeer(name, room, m.id);      // 목록에서 바로 지우고
        dropSocket(t.ws, { t: 'kicked' }); // 연결도 바로 끊어요 (다시 들어오는 건 막지 않아요)
      } else if (m.t === 'bye') {
        // 방장이 나가면 방을 바로 종료, 학생이 나가면 그 사람만 정리
        if (room.hostId === id) closeRoom(name); else { me.gone = true; removePeer(name, room, id); dropSocket(ws); }
      }
    } catch (e) { console.error('message error:', e); }
  });
  ws.on('close', () => { try { if (!me.gone) { me.gone = true; removePeer(name, room, id); } } catch (e) { console.error(e); } });
});

// 변경이 있는 방에만 전송: 보통 약 10Hz, 긴급 변화(공격·신고·투표·방장 상태)는 즉시
setInterval(() => {
  try {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.closeAt) room.dirty = true; // 종료 카운트다운 갱신
      if (!room.dirty) continue;
      if (!room.urgent && now - room.last < 100) continue;
      room.dirty = room.urgent = false; room.last = now;
      const p = [];
      for (const [pid, pe] of room.peers) if (pe.d) p.push({ id: pid, d: pe.d });
      const gc = room.closeAt ? Math.max(0, Math.ceil((room.closeAt - now) / 1000)) : 0;
      const base = { t: 'snap', p, h: room.hostId, gc };
      let lean = null, full = null;
      for (const pe of room.peers.values()) {
        const ws = pe.ws;
        if (ws.readyState !== 1) continue;
        if (ws.bufferedAmount > 3e6) { ws.terminate(); continue; } // 너무 느린 연결은 정리
        let msg;
        if (pe.gSeen !== room.gVer) { full = full || JSON.stringify({ ...base, g: room.g, gv: room.gVer }); msg = full; pe.gSeen = room.gVer; }
        else { lean = lean || JSON.stringify(base); msg = lean; }
        try { ws.send(msg); } catch {}
      }
    }
  } catch (e) { console.error('broadcast error:', e); }
}, 20);

// 끊긴 연결 빨리 정리 (응답 없는 연결은 두 번째 확인에서 종료)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, PING_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('구스구스덕 서버 실행 중: http://0.0.0:' + PORT));
process.on('SIGTERM', () => { for (const name of [...rooms.keys()]) closeRoom(name); setTimeout(() => process.exit(0), 500); });
