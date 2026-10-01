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
npm install
npm run dev        # http://localhost:5173
```

## Coolify에 배포하기

1. 이 폴더를 GitHub 저장소로 올립니다 (비공개 저장소도 가능).
   ```bash
   git remote add origin https://github.com/<계정>/ros2-web-sandbox.git
   git push -u origin main
   ```
2. Coolify → 프로젝트 → **+ New** → **Application** → 저장소 선택
   (공개 저장소는 *Public Repository*, 비공개는 *Private Repository (with GitHub App)*)
3. **Build Pack: `Dockerfile`** 선택, **Ports Exposes: `80`**
4. **Domains** 칸에 반드시 **`https://`** 로 시작하는 주소를 넣습니다.
   - 임시 주소라면 Coolify가 만들어 준 `sslip.io` 주소의 `http://`를 `https://`로 바꿔서 저장
   - 가능하면 내 도메인의 서브도메인(예: `https://ros2.mydomain.com`, DNS A 레코드를 VPS IP로)을 쓰는 편이 인증서 발급이 안정적입니다
5. **Deploy**

### 배포 후 확인

- 페이지 상단 오른쪽이 **"Python 엔진 준비됨"** (초록 점)이면 성공입니다.
- 빨간 배너 *"crossOriginIsolated = false"* 가 보이면 Python 노드를 실행할 수 없는 상태입니다. 원인은 둘 중 하나입니다.
  1. **HTTPS가 아님** — 브라우저는 HTTP 페이지에서 `SharedArrayBuffer`를 막습니다. Domains를 `https://`로 바꾸세요.
  2. **헤더가 빠짐** — `curl -I https://<주소>/` 결과에 `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`가 있어야 합니다. (컨테이너 안의 nginx가 넣어 주므로 Coolify 쪽에서 따로 설정할 것은 없습니다.)

## 구조

```
public/py/ros_shim.py   rclpy 호환 모듈 (Pyodide 위에서 동작)
public/py-worker.js     Python 프로세스 1개 = Web Worker 1개
public/msgs.json        메시지/서비스 타입 정의
src/graph.js            가상 ROS 2 그래프 (노드·토픽·서비스 라우팅, QoS 호환성)
src/process.js          워커 관리, SharedArrayBuffer 메시지 채널
src/cli.js              ros2 명령
src/shell.js            터미널 (라인 편집, 자동완성, Ctrl+C)
src/turtlesim.js        turtlesim + teleop
src/hints.js            초보자 실수 힌트
nginx.conf / Dockerfile 배포 설정 (COOP/COEP 헤더 포함)
```
