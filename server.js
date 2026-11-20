// 구스구스덕 서버: 정적 파일 + 웹소켓 중계(방별 presence 공유) + QR 페이지
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const app = express();
app.disable('x-powered-by');
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
const MAX_PER_ROOM = 16;
const rooms = new Map(); // roomName -> { peers: Map(id -> {ws, d}), dirty }

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const name = (u.searchParams.get('room') || 'main').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'main';
  let room = rooms.get(name);
  if (!room) rooms.set(name, (room = { peers: new Map(), dirty: false }));
  if (room.peers.size >= MAX_PER_ROOM) { ws.send(JSON.stringify({ t: 'full' })); return ws.close(); }

  const id = crypto.randomBytes(5).toString('hex');
  const me = { ws, d: null, tokens: 40, last: Date.now() };
  room.peers.set(id, me);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.send(JSON.stringify({ t: 'hello', id }));

  ws.on('message', (raw) => {
    const now = Date.now();
    me.tokens = Math.min(40, me.tokens + (now - me.last) / 25); me.last = now; // 초당 약 40회 제한
    if (me.tokens < 1) return;
    me.tokens -= 1;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m && m.t === 'p' && m.d && typeof m.d === 'object' && !Array.isArray(m.d)) {
      if (JSON.stringify(m.d).length > 4096) return;
      if (typeof m.d.n === 'string') m.d.n = m.d.n.slice(0, 16);
      me.d = m.d; room.dirty = true;
    }
  });
  ws.on('close', () => {
    room.peers.delete(id); room.dirty = true;
    if (room.peers.size === 0) rooms.delete(name);
  });
});

// 변경이 있는 방에만 약 15Hz로 전체 스냅샷 전송
setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.dirty) continue;
    room.dirty = false;
    const p = [];
    for (const [id, pe] of room.peers) if (pe.d) p.push({ id, d: pe.d });
    const msg = JSON.stringify({ t: 'snap', p });
    for (const pe of room.peers.values()) if (pe.ws.readyState === 1) pe.ws.send(msg);
  }
}, 66);

// 끊긴 연결 정리(프록시 유휴 종료 방지용 ping 포함)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 20000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('구스구스덕 서버 실행 중: http://localhost:' + PORT));
