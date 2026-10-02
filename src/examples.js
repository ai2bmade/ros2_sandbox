// Starter files placed in a new workspace. Each runs unmodified on real ROS 2.
export const EXAMPLES = {
  'talker.py': `import rclpy
from rclpy.node import Node
from std_msgs.msg import String


class Talker(Node):
    def __init__(self):
        super().__init__('talker')
        self.publisher = self.create_publisher(String, 'chatter', 10)
        self.timer = self.create_timer(0.5, self.timer_callback)
        self.count = 0

    def timer_callback(self):
        msg = String()
        msg.data = f'Hello World: {self.count}'
        self.publisher.publish(msg)
        self.get_logger().info(f'Publishing: "{msg.data}"')
        self.count += 1


def main():
    rclpy.init()
    node = Talker()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`,
  'listener.py': `import rclpy
from rclpy.node import Node
from std_msgs.msg import String


class Listener(Node):
    def __init__(self):
        super().__init__('listener')
        self.subscription = self.create_subscription(String, 'chatter', self.listener_callback, 10)

    def listener_callback(self, msg):
        self.get_logger().info(f'I heard: "{msg.data}"')


def main():
    rclpy.init()
    node = Listener()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`,
  'turtle_circle.py': `# First, in another terminal: ros2 run turtlesim turtlesim_node
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist
from turtlesim.msg import Pose


class CircleDriver(Node):
    def __init__(self):
        super().__init__('circle_driver')
        self.cmd_pub = self.create_publisher(Twist, '/turtle1/cmd_vel', 10)
        self.pose_sub = self.create_subscription(Pose, '/turtle1/pose', self.on_pose, 10)
        self.timer = self.create_timer(0.1, self.drive)
        self.pose = None

    def on_pose(self, msg):
        self.pose = msg

    def drive(self):
        cmd = Twist()
        cmd.linear.x = 2.0
        cmd.angular.z = 1.0
        self.cmd_pub.publish(cmd)
        if self.pose is not None:
            self.get_logger().info(f'x={self.pose.x:.2f}, y={self.pose.y:.2f}', throttle_duration_sec=1.0)


def main():
    rclpy.init()
    node = CircleDriver()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`,
  'add_two_ints_server.py': `import rclpy
from rclpy.node import Node
from example_interfaces.srv import AddTwoInts


class AddTwoIntsServer(Node):
    def __init__(self):
        super().__init__('add_two_ints_server')
        self.srv = self.create_service(AddTwoInts, 'add_two_ints', self.add_two_ints_callback)

    def add_two_ints_callback(self, request, response):
        response.sum = request.a + request.b
        self.get_logger().info(f'Incoming request\\na: {request.a} b: {request.b}')
        return response


def main():
    rclpy.init()
    node = AddTwoIntsServer()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`,
  'add_two_ints_client.py': `import sys
import rclpy
from rclpy.node import Node
from example_interfaces.srv import AddTwoInts


class AddTwoIntsClient(Node):
    def __init__(self):
        super().__init__('add_two_ints_client')
        self.cli = self.create_client(AddTwoInts, 'add_two_ints')
        while not self.cli.wait_for_service(timeout_sec=1.0):
            self.get_logger().info('service not available, waiting again...')

    def send_request(self, a, b):
        req = AddTwoInts.Request()
        req.a = a
        req.b = b
        return self.cli.call_async(req)


def main():
    rclpy.init()
    node = AddTwoIntsClient()
    a = int(sys.argv[1]) if len(sys.argv) > 2 else 2
    b = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    future = node.send_request(a, b)
    rclpy.spin_until_future_complete(node, future)
    response = future.result()
    node.get_logger().info(f'Result of add_two_ints: {a} + {b} = {response.sum}')
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`,
  'param_node.py': `# Run: python3 param_node.py
# In another terminal: ros2 param set /param_node my_parameter earth
import rclpy
from rclpy.node import Node


class ParamNode(Node):
    def __init__(self):
        super().__init__('param_node')
        self.declare_parameter('my_parameter', 'world')
        self.timer = self.create_timer(1.0, self.timer_callback)

    def timer_callback(self):
        value = self.get_parameter('my_parameter').get_parameter_value().string_value
        self.get_logger().info(f'Hello {value}!')


def main():
    rclpy.init()
    node = ParamNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
`,
};
