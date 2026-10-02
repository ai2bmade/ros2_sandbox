# ROS2-Web-Sandbox (실험판)

설치 없이 브라우저에서 ROS 2를 연습하는 실습 플랫폼의 첫 실험 버전입니다.
에디터에서 `rclpy` 코드를 쓰고, 여러 터미널에서 `python3 talker.py`, `ros2 topic echo` 등을 실행하고,
turtlesim과 노드 그래프로 결과를 확인합니다. 서버는 정적 파일만 내려주고 모든 실행은 브라우저 안에서 이루어집니다.

## 지금 되는 것

- 에디터 + 파일 목록 (브라우저에 자동 저장), 예제 6개
- 터미널 최대 4개, 터미널마다 별도 Python 프로세스 (Pyodide / Web Worker)
- `rclpy`: Node, Publisher, Subscription, Timer, Service, Client(`call_async`, `wait_for_service`), Parameter, QoS, Logger, `Ctrl+C` → `KeyboardInterrupt`
- 메시지: std_msgs, geometry_msgs, turtlesim, std_srvs, example_interfaces, builtin_interfaces
- CLI: `ros2 node list/info`, `ros2 topic list/info/type/echo/hz/pub`, `ros2 service list/type/call`, `ros2 param list/get/set`, `ros2 interface list/show`, `ros2 run turtlesim turtlesim_node | turtle_teleop_key`
- turtlesim (spawn / kill / clear / reset / set_pen / teleport, 배경색 파라미터), 노드 그래프
- 초보자 실수 힌트 (float에 정수 대입, spin 누락, 토픽 이름 오타, 지원하지 않는 패키지 등)

아직 없는 것: 액션, TF, `/clock`, sim_bot, launch 파일, 패키지 구조 (PRD 2·3단계)

## 로컬에서 실행

```bash
npm install && (cd server && npm install)
npm run build
cd server && PORT=3000 DEV_LOGIN=1 ADMIN_EMAILS=me@example.com node index.js   # http://localhost:3000
```

- `DATABASE_URL`이 없으면 PGlite(내장 PostgreSQL)를 `server/.pglite`에 만들어 씁니다.
- `DEV_LOGIN=1`이면 `http://localhost:3000/api/auth/dev?email=...`로 Google 없이 로그인할 수 있습니다. 운영(`NODE_ENV=production`)에서는 꺼집니다.
- 프론트만 고칠 때는 서버를 3000번에 띄워 두고 `npm run dev`(5173번, `/api`는 3000번으로 프록시)를 씁니다.

## 로그인과 승인

- 로그인은 Google만 씁니다. 승인된(`approved`) 사용자만 실습 화면(`/`)에 들어갈 수 있습니다.
- 처음 로그인한 사람은 `/welcome/`에서 이용 신청을 하고, 관리자가 `/admin/`에서 승인합니다.
- 관리자는 이메일을 미리 승인 목록에 넣을 수도 있습니다(신청 없이 바로 이용).
- `ADMIN_EMAILS`에 적은 이메일은 로그인하면 자동으로 관리자가 됩니다.
- 로그인한 사용자의 파일은 서버(PostgreSQL)에 저장됩니다.

## Coolify에 배포하기

1. Coolify → 프로젝트 → **+ New** → **Application** → 이 저장소, **Build Pack: `Dockerfile`**, **Ports Exposes: `80`**
2. **Domains**: `https://`로 시작하는 주소 (예: `https://ros2.joshuajhchoi.cloud`)
3. 같은 프로젝트에 **+ New → Database → PostgreSQL**을 만들고 Start
4. 앱의 **Environment Variables**

   | 이름 | 값 |
   | --- | --- |
   | `DATABASE_URL` | PostgreSQL 화면의 *Postgres URL (internal)* |
   | `GOOGLE_CLIENT_ID` | Google Cloud → Google 인증 플랫폼 → 클라이언트 |
   | `GOOGLE_CLIENT_SECRET` | 같은 곳의 보안 비밀번호 |
   | `ADMIN_EMAILS` | 관리자 Gmail (여러 개는 쉼표로) |

5. Google OAuth 클라이언트의 승인된 리디렉션 URI: `https://<도메인>/api/auth/google/callback`
6. **Deploy**

### 배포 후 확인

- `curl -I https://<주소>/welcome/` 결과에 `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`가 있어야 합니다. 서버가 모든 응답에 넣어 줍니다.
- `https://<주소>/api/health`가 `{"ok":true}`면 DB 연결도 정상입니다.
- 실습 화면 오른쪽 위가 **"Python 엔진 준비됨"**(초록 점)이면 성공입니다.

## 구조

```
server/index.js         Node(Fastify) 서버: 정적 파일 + COOP/COEP 헤더 + API(로그인, 승인, 파일, 관리자)
server/db.js            PostgreSQL 연결과 테이블 생성 (users, sessions, files)
public/welcome/         첫 화면: 환영 + Google 로그인 + 이용 신청 + 승인 대기
public/admin/           관리자 화면: 신청 승인, 이메일 추가, 사용자 관리
public/privacy/         개인정보처리방침
public/py/ros_shim.py   rclpy 호환 모듈 (Pyodide 위에서 동작)
public/py-worker.js     Python 프로세스 1개 = Web Worker 1개
public/msgs.json        메시지/서비스 타입 정의
src/editor.js           에디터와 파일 저장 (서버 API로 자동 저장)
src/graph.js            가상 ROS 2 그래프 (노드·토픽·서비스 라우팅, QoS 호환성)
src/process.js          워커 관리, SharedArrayBuffer 메시지 채널
src/cli.js              ros2 명령
src/shell.js            터미널 (라인 편집, 자동완성, Ctrl+C, 중지 버튼)
src/turtlesim.js        turtlesim + teleop
src/hints.js            초보자 실수 힌트
Dockerfile              프론트 빌드 + Node 서버 실행
```
