# 구스구스덕 (QR 입장 멀티플레이)

QR 코드로 접속해서 즐기는 구스구스덕 스타일 마피아 게임입니다. 로그인 없이 닉네임만 정하면 입장할 수 있어요.

## 내 컴퓨터에서 실행
```
npm install
npm start
```
브라우저에서 http://localhost:3000 을 열고, 탭이나 기기를 3개 이상 열어 테스트하세요.

## GitHub → Render 배포
1. 이 폴더 전체를 GitHub 저장소에 올립니다. (`node_modules`는 올리지 않아요)
2. https://render.com 에서 **New → Web Service** 를 누르고 저장소를 연결합니다.
3. 설정값 (render.yaml이 있으면 자동으로 채워집니다)
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Plan: Free
4. 배포가 끝나면 `https://이름.onrender.com` 주소가 생깁니다.
5. **`https://이름.onrender.com/qr`** 을 열면 입장용 QR 코드가 나옵니다. 화면에 띄워 두고 다들 찍게 하세요.

## 방 나누기
- 기본 방은 `main` 하나입니다.
- 여러 팀이 동시에 하려면 `https://이름.onrender.com/?room=팀1` 처럼 방 이름을 붙이세요.
- QR도 `https://이름.onrender.com/qr?room=팀1` 로 방마다 만들 수 있어요. 한 방 최대 16명입니다.

## 알아둘 점
- Render 무료 플랜은 15분쯤 아무도 없으면 서버가 잠들어요. 다시 열면 30초~1분 걸리니, 행사 전에 미리 한 번 접속해 두세요.
- 서버는 사람들의 위치와 상태를 서로 전달만 하고, 게임 진행(역할 배정, 공격, 투표 판정)은 방장 기기에서 계산합니다. 방장이 나가면 게임은 대기실로 돌아가요.
- 역할 정보가 모든 기기로 전달되기 때문에 개발자 도구로 보면 오리를 알 수 있어요. 친구끼리 하는 파티용입니다.
- 코드를 고칠 때는 `public/index.html` 의 `<script>` 부분을 수정하면 됩니다. 지도는 `public/map.jpg`(그림)와 `public/mask.png`(걸을 수 있는 곳, 흰색)입니다.
