// Friendly hints for common beginner mistakes. Printed in the terminal after the real ROS 2 style output.

const SUPPORTED = 'rclpy, std_msgs, geometry_msgs, turtlesim, std_srvs, example_interfaces, builtin_interfaces, rcl_interfaces';

export function hintsForExit(msg, proc) {
  const out = [];
  const err = msg.error;
  const info = msg.info || {};
  if (err) {
    const t = err.type, m = err.msg || '';
    if (t === 'AssertionError' && m.includes("of type 'float'")) {
      out.push("A float field needs a number with a decimal point. Example: msg.linear.x = 2  →  msg.linear.x = 2.0");
    } else if (t === 'AssertionError' && m.includes("of type 'str'")) {
      out.push("A string field needs a string. Example: msg.data = str(count)  or  msg.data = f'Hello {count}'");
    } else if (t === 'AssertionError' && m.includes("of type 'int'")) {
      out.push('An integer field needs an int. Example: msg.data = int(value)');
    } else if (t === 'AssertionError' && m.includes('Invalid arguments passed to constructor')) {
      out.push('That field does not exist in the message. Check the field names with `ros2 interface show <type>` in a terminal.');
    } else if (t === 'RCLError' && m.includes('context is not valid')) {
      out.push('Call rclpy.init() before creating a node.');
    } else if (m.includes('Context.init() must only be called once')) {
      out.push('Call rclpy.init() only once per program, even when you create several nodes.');
    } else if (m.includes('Context must be initialized before it can be shutdown')) {
      out.push('rclpy.shutdown() was called twice, or without rclpy.init().');
    } else if (t === 'ModuleNotFoundError') {
      out.push(`ROS 2 packages available in this sandbox: ${SUPPORTED}. If you are importing your own file, check its name.`);
    } else if (t === 'ImportError' && m.includes('cannot import name')) {
      out.push('That message/service type does not exist. See the available types with `ros2 interface list` in a terminal.');
    } else if (t === 'NotSupportedInSandbox') {
      out.push('This feature is not supported in this beginner sandbox. You can practice topics, services, parameters and timers.');
    } else if (t === 'TypeError' && m.includes("'qos_profile'")) {
      out.push("create_publisher / create_subscription need a QoS depth as the last argument. Example: self.create_publisher(String, 'chatter', 10)");
    } else if (t === 'TypeError' && m.includes("'callback'")) {
      out.push("Check the argument order: create_subscription(MsgType, 'topic', callback, 10).");
    } else if (t === 'NameError') {
      out.push('That name is not defined. Check your imports and variable names for typos.');
    } else if (t === 'IndentationError' || t === 'SyntaxError') {
      out.push('Python syntax error. Check indentation, brackets and colons (:) on the line shown.');
    } else if (t === 'KeyboardInterrupt') {
      out.push('Stopped with Ctrl+C. In real ROS 2 code, wrap rclpy.spin() in try / except KeyboardInterrupt to exit cleanly.');
    }
  } else if (msg.code === 0 && info.had_callbacks && !info.spun) {
    out.push('You created timers/subscriptions/services but never called rclpy.spin(), so no callback ran before the program ended. Add rclpy.spin(node) at the end.');
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
    if (ep.kind === 'sub') node.hint(`You subscribe to '${ep.name}', but the topic being published is '${similar.name}'. Check the topic name for typos.`);
    else node.hint(`You publish to '${ep.name}', but the subscriber is waiting on '${similar.name}'. Check the topic name for typos.`);
  }
  for (const ep of eps) {
    const node = graph.nodes.get(ep.nodeId);
    if (!node || !node.hint || ep.kind !== 'sub') continue;
    const pub = eps.find((o) => o.kind === 'pub' && o.name === ep.name && o.type !== ep.type);
    if (!pub) continue;
    const key = ep.id + '#type';
    if (warned.has(key)) continue;
    warned.add(key);
    node.hint(`Message types differ on '${ep.name}'. Publisher: ${pub.type}, subscriber: ${ep.type}. They must match for messages to arrive.`);
  }
}
