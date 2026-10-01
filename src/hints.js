// Friendly hints for common beginner mistakes. Printed in the terminal after the real ROS 2 style output.

const SUPPORTED = 'rclpy, std_msgs, geometry_msgs, turtlesim, std_srvs, example_interfaces, builtin_interfaces, rcl_interfaces';

export function hintsForExit(msg, proc) {
  const out = [];
  const err = msg.error;
  const info = msg.info || {};
  if (err) {
    const t = err.type, m = err.msg || '';
    if (t === 'AssertionError' && m.includes("of type 'float'")) {
      out.push("float 필드에는 소수점이 있는 숫자를 넣어야 합니다. 예: msg.linear.x = 2  →  msg.linear.x = 2.0");
    } else if (t === 'AssertionError' && m.includes("of type 'str'")) {
      out.push("string 필드에는 문자열을 넣어야 합니다. 예: msg.data = str(count)  또는  msg.data = f'Hello {count}'");
    } else if (t === 'AssertionError' && m.includes("of type 'int'")) {
      out.push('정수 필드에는 int 값을 넣어야 합니다. 예: msg.data = int(value)');
    } else if (t === 'AssertionError' && m.includes('Invalid arguments passed to constructor')) {
      out.push('메시지에 없는 필드 이름을 썼습니다. 터미널에서 `ros2 interface show <타입>`으로 필드 이름을 확인하세요.');
    } else if (t === 'RCLError' && m.includes('context is not valid')) {
      out.push('노드를 만들기 전에 rclpy.init()을 먼저 호출해야 합니다.');
    } else if (m.includes('Context.init() must only be called once')) {
      out.push('rclpy.init()은 프로그램에서 한 번만 호출합니다. 노드를 여러 개 만들 때도 init은 한 번이면 됩니다.');
    } else if (m.includes('Context must be initialized before it can be shutdown')) {
      out.push('rclpy.shutdown()이 두 번 호출되었거나, init 없이 호출되었습니다.');
    } else if (t === 'ModuleNotFoundError') {
      out.push(`이 샌드박스에서 사용할 수 있는 ROS 2 패키지: ${SUPPORTED}. 내가 만든 파일을 import한다면 파일 이름을 확인하세요.`);
    } else if (t === 'ImportError' && m.includes('cannot import name')) {
      out.push('해당 메시지/서비스 타입이 없습니다. 터미널에서 `ros2 interface list`로 사용 가능한 타입을 확인하세요.');
    } else if (t === 'NotSupportedInSandbox') {
      out.push('이 기능은 다음 단계에서 지원할 예정입니다. 지금은 토픽, 서비스, 파라미터, 타이머를 연습할 수 있습니다.');
    } else if (t === 'TypeError' && m.includes("'qos_profile'")) {
      out.push("create_publisher / create_subscription의 마지막 인자로 QoS 깊이를 넣어야 합니다. 예: self.create_publisher(String, 'chatter', 10)");
    } else if (t === 'TypeError' && m.includes("'callback'")) {
      out.push("create_subscription(메시지타입, '토픽', 콜백함수, 10) 순서로 인자를 넣었는지 확인하세요.");
    } else if (t === 'NameError') {
      out.push('정의되지 않은 이름입니다. import 문이나 변수 이름의 오타를 확인하세요.');
    } else if (t === 'IndentationError' || t === 'SyntaxError') {
      out.push('파이썬 문법 오류입니다. 표시된 줄의 들여쓰기, 괄호, 콜론(:)을 확인하세요.');
    } else if (t === 'KeyboardInterrupt') {
      out.push('Ctrl+C로 종료했습니다. 실제 ROS 2 코드에서는 rclpy.spin()을 try / except KeyboardInterrupt로 감싸서 깔끔하게 종료합니다.');
    }
  } else if (msg.code === 0 && info.had_callbacks && !info.spun) {
    out.push('타이머·구독·서비스를 만들었지만 rclpy.spin()을 호출하지 않아서 콜백이 한 번도 실행되지 않고 프로그램이 끝났습니다. 마지막에 rclpy.spin(node)를 추가하세요.');
  }
  return out;
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// Called on graph changes: detects topic-name typos between publishers and subscriptions.
const warned = new Set();
export function checkTopicTypos(graph) {
  const eps = [...graph.endpoints.values()].filter((e) => e.kind === 'pub' || e.kind === 'sub');
  for (const ep of eps) {
    const node = graph.nodes.get(ep.nodeId);
    if (!node || !node.hint) continue;
    const opposite = ep.kind === 'pub' ? 'sub' : 'pub';
    if (eps.some((o) => o.kind === opposite && o.name === ep.name)) continue;
    const similar = eps.find((o) => o.kind === opposite && o.name !== ep.name && editDistance(o.name, ep.name) <= 2 && !graph.nodes.get(o.nodeId)?.hidden);
    if (!similar) continue;
    const key = ep.id + '>' + similar.name;
    if (warned.has(key)) continue;
    warned.add(key);
    if (ep.kind === 'sub') node.hint(`'${ep.name}'를 구독하고 있는데, 발행되고 있는 토픽은 '${similar.name}'입니다. 토픽 이름에 오타가 없는지 확인하세요.`);
    else node.hint(`'${ep.name}'로 발행하고 있는데, 구독하는 쪽은 '${similar.name}'를 기다리고 있습니다. 토픽 이름에 오타가 없는지 확인하세요.`);
  }
  for (const ep of eps) {
    const node = graph.nodes.get(ep.nodeId);
    if (!node || !node.hint || ep.kind !== 'sub') continue;
    const pub = eps.find((o) => o.kind === 'pub' && o.name === ep.name && o.type !== ep.type);
    if (!pub) continue;
    const key = ep.id + '#type';
    if (warned.has(key)) continue;
    warned.add(key);
    node.hint(`'${ep.name}' 토픽의 메시지 타입이 다릅니다. 발행: ${pub.type}, 구독: ${ep.type}. 타입이 같아야 메시지가 전달됩니다.`);
  }
}
