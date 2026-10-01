# ROS2-Web-Sandbox: rclpy-compatible shim running on Pyodide.
# Talks to the in-browser virtual ROS 2 graph through the `_sandbox` JS module.
import sys, json, types, math, re, time as _time
from collections import deque
import _sandbox

_SPEC = json.loads(_sandbox.spec())

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _post(obj):
    _sandbox.post(json.dumps(obj))


def _now_ns():
    return int(_sandbox.now_ms() * 1_000_000)


_INT_RANGES = {
    'byte': (0, 255), 'char': (0, 255),
    'int8': (-128, 127), 'uint8': (0, 255),
    'int16': (-32768, 32767), 'uint16': (0, 65535),
    'int32': (-2147483648, 2147483647), 'uint32': (0, 4294967295),
    'int64': (-9223372036854775808, 9223372036854775807), 'uint64': (0, 18446744073709551615),
}
_FLOATS = ('float32', 'float64')


def _module(dotted):
    if dotted in sys.modules:
        return sys.modules[dotted]
    parent, _, leaf = dotted.rpartition('.')
    mod = types.ModuleType(dotted)
    mod.__path__ = []
    sys.modules[dotted] = mod
    if parent:
        setattr(_module(parent), leaf, mod)
    return mod


# --------------------------------------------------------------------------
# message classes
# --------------------------------------------------------------------------

_CLASSES = {}   # ros type string -> class


def _is_array(t):
    return t.endswith(']')


def _base(t):
    return t[:t.index('[')] if _is_array(t) else t


def _default(t, d=None):
    if _is_array(t):
        return [] if d is None else list(d)
    if d is not None:
        return d
    if t in _FLOATS:
        return 0.0
    if t in _INT_RANGES:
        return 0
    if t == 'bool':
        return False
    if t in ('string', 'wstring'):
        return ''
    return _CLASSES[t]()


def _check(name, t, value):
    if _is_array(t):
        if not isinstance(value, (list, tuple)):
            raise AssertionError(f"The '{name}' field must be a set or sequence and each value of type '{_pyname(_base(t))}'")
        return [_check(name, _base(t), v) for v in value]
    if t in _FLOATS:
        if not isinstance(value, float):
            raise AssertionError(f"The '{name}' field must be of type 'float'")
        return value
    if t in _INT_RANGES:
        if not isinstance(value, int):
            raise AssertionError(f"The '{name}' field must be of type 'int'")
        lo, hi = _INT_RANGES[t]
        if not (lo <= value <= hi):
            raise AssertionError(f"The '{name}' field must be an integer in [{lo}, {hi}]")
        return int(value)
    if t == 'bool':
        if not isinstance(value, bool):
            raise AssertionError(f"The '{name}' field must be of type 'bool'")
        return value
    if t in ('string', 'wstring'):
        if not isinstance(value, str):
            raise AssertionError(f"The '{name}' field must be of type 'str'")
        return value
    cls = _CLASSES[t]
    if not isinstance(value, cls):
        raise AssertionError(f"The '{name}' field must be a sub message of type '{cls.__name__}'")
    return value


def _pyname(t):
    if t in _FLOATS:
        return 'float'
    if t in _INT_RANGES:
        return 'int'
    if t == 'bool':
        return 'bool'
    if t in ('string', 'wstring'):
        return 'str'
    return t.split('/')[-1]


class _MsgBase:
    __slots__ = ()
    _fields = ()
    _ros_type = ''

    def __init__(self, **kwargs):
        names = [f[0] for f in self._fields]
        bad = [k for k in kwargs if k not in names]
        if bad:
            raise AssertionError('Invalid arguments passed to constructor: %s' % ', '.join(sorted(bad)))
        for (n, t, d) in self._fields:
            if n in kwargs:
                setattr(self, n, kwargs[n])
            else:
                object.__setattr__(self, '_' + n, _default(t, d))

    def __setattr__(self, key, value):
        for (n, t, d) in self._fields:
            if n == key:
                object.__setattr__(self, '_' + n, _check(n, t, value))
                return
        raise AttributeError(f"'{type(self).__name__}' object has no attribute '{key}'")

    def __getattr__(self, key):
        raise AttributeError(f"'{type(self).__name__}' object has no attribute '{key}'")

    def __repr__(self):
        parts = ', '.join(f'{n}={getattr(self, n)!r}' for (n, t, d) in self._fields)
        return f'{type(self).__module__}.{type(self).__name__}({parts})'

    def __eq__(self, other):
        return type(self) is type(other) and all(getattr(self, n) == getattr(other, n) for (n, t, d) in self._fields)

    @classmethod
    def get_fields_and_field_types(cls):
        return {n: (t.split('/msg/')[-1] if '/' in t else t) for (n, t, d) in cls._fields}


def _make_class(ros_type, fields, clsname, modname):
    slots = tuple('_' + f[0] for f in fields)
    flist = tuple((f[0], f[1], f[2] if len(f) > 2 else None) for f in fields)
    ns = {'__slots__': slots, '_fields': flist, '_ros_type': ros_type, '__module__': modname}
    for (n, t, d) in flist:
        def getter(self, _n='_' + n):
            return object.__getattribute__(self, _n)
        ns[n] = property(getter)
    cls = type(clsname, (_MsgBase,), ns)
    # property objects have no setter: route through __setattr__
    for (n, t, d) in flist:
        prop = ns[n]
        setattr(cls, n, property(prop.fget, lambda self, v, _n=n: _MsgBase.__setattr__(self, _n, v)))
    _CLASSES[ros_type] = cls
    return cls


def _to_dict(msg):
    out = {}
    for (n, t, d) in msg._fields:
        v = getattr(msg, n)
        if _is_array(t):
            b = _base(t)
            out[n] = [_to_dict(x) if b in _CLASSES else x for x in v]
        elif t in _CLASSES:
            out[n] = _to_dict(v)
        else:
            out[n] = v
    return out


def _from_dict(cls, data):
    m = cls()
    for (n, t, d) in cls._fields:
        if n not in data:
            continue
        v = data[n]
        if _is_array(t):
            b = _base(t)
            v = [_from_dict(_CLASSES[b], x) if b in _CLASSES else _coerce(b, x) for x in v]
        elif t in _CLASSES:
            v = _from_dict(_CLASSES[t], v)
        else:
            v = _coerce(t, v)
        object.__setattr__(m, '_' + n, v)
    return m


def _coerce(t, v):
    if t in _FLOATS:
        return float(v)
    if t in _INT_RANGES:
        return int(v)
    if t == 'bool':
        return bool(v)
    return v


class _SrvType:
    pass


def _install_types():
    for full, spec in _SPEC.items():
        pkg, kind, name = full.split('/')
        mod = _module(f'{pkg}.{kind}')
        if kind == 'msg':
            setattr(mod, name, _make_class(full, spec['fields'], name, f'{pkg}.msg'))
        else:
            req = _make_class(full + '_Request', spec['request'], name + '_Request', f'{pkg}.srv')
            res = _make_class(full + '_Response', spec['response'], name + '_Response', f'{pkg}.srv')
            srv = type(name, (_SrvType,), {'Request': req, 'Response': res, '_ros_type': full, '__module__': f'{pkg}.srv'})
            setattr(mod, name, srv)


_install_types()


def _type_name(t):
    return getattr(t, '_ros_type', None)


# --------------------------------------------------------------------------
# rclpy
# --------------------------------------------------------------------------

rclpy = _module('rclpy')
rclpy.__file__ = '/usr/lib/python3/dist-packages/rclpy/__init__.py'


class RCLError(RuntimeError):
    pass


RCLError.__module__ = 'rclpy._rclpy_pybind11'


class _Context:
    def __init__(self):
        self._ok = False
        self.overrides = {}
        self.node_remaps = {}

    def ok(self):
        return self._ok


_ctx = _Context()
_state = {'spun': False, 'had_callbacks': False, 'lid': 0}
_nodes = {}          # lid -> Node
_subs = {}           # lid -> Subscription
_services = {}       # lid -> Service
_pending_calls = {}  # call id -> (Client, Future)
_graph = {'topics': {}, 'services': {}, 'nodes': [], 'pubs': {}, 'subs': {}}


def _next_id():
    _state['lid'] += 1
    return _state['lid']


def _parse_ros_args(argv):
    overrides, remaps = {}, {}
    if not argv or '--ros-args' not in argv:
        return overrides, remaps
    i = argv.index('--ros-args') + 1
    while i < len(argv) and argv[i] != '--':
        a = argv[i]
        if a in ('-p', '--param') and i + 1 < len(argv):
            k, _, v = argv[i + 1].partition(':=')
            overrides[k] = _parse_value(v)
            i += 2
        elif a in ('-r', '--remap') and i + 1 < len(argv):
            k, _, v = argv[i + 1].partition(':=')
            remaps[k] = v
            i += 2
        else:
            i += 1
    return overrides, remaps


def _parse_value(v):
    s = v.strip()
    if s.lower() in ('true', 'false'):
        return s.lower() == 'true'
    try:
        return int(s)
    except ValueError:
        pass
    try:
        return float(s)
    except ValueError:
        pass
    if len(s) >= 2 and s[0] == s[-1] and s[0] in '\'"':
        return s[1:-1]
    return s


class _InitContextManager:
    def __enter__(self):
        return _ctx

    def __exit__(self, *exc):
        try_shutdown()
        return False


def init(*, args=None, context=None, domain_id=None, signal_handler_options=None):
    if _ctx._ok:
        raise RuntimeError('Context.init() must only be called once')
    _ctx.overrides, _ctx.node_remaps = _parse_ros_args(args if args is not None else sys.argv)
    _ctx._ok = True
    return _InitContextManager()


def ok(*, context=None):
    return _ctx._ok


def shutdown(*, context=None, uninstall_handlers=None):
    if not _ctx._ok:
        raise RuntimeError('Context must be initialized before it can be shutdown')
    _do_shutdown()


def try_shutdown(*, context=None, uninstall_handlers=None):
    if _ctx._ok:
        _do_shutdown()


def _do_shutdown():
    for n in list(_nodes.values()):
        n.destroy_node()
    _ctx._ok = False


rclpy.init = init
rclpy.ok = ok
rclpy.shutdown = shutdown
rclpy.try_shutdown = try_shutdown
rclpy.RCLError = RCLError


# ---- exceptions ----
exceptions = _module('rclpy.exceptions')


class InvalidNodeNameException(Exception):
    pass


class InvalidTopicNameException(Exception):
    pass


class InvalidServiceNameException(Exception):
    pass


class ParameterNotDeclaredException(Exception):
    def __init__(self, name):
        super().__init__(f"Invalid access to undeclared parameter(s): ['{name}']" if isinstance(name, str) else f'Invalid access to undeclared parameter(s): {name}')


class ParameterAlreadyDeclaredException(Exception):
    def __init__(self, name):
        super().__init__(f"Parameter(s) already declared: ['{name}']")


class InvalidParameterTypeException(Exception):
    pass


class NotInitializedException(Exception):
    pass


for _e in (InvalidNodeNameException, InvalidTopicNameException, InvalidServiceNameException,
           ParameterNotDeclaredException, ParameterAlreadyDeclaredException, InvalidParameterTypeException,
           NotInitializedException):
    _e.__module__ = 'rclpy.exceptions'
    setattr(exceptions, _e.__name__, _e)


class NotSupportedInSandbox(NotImplementedError):
    pass


NotSupportedInSandbox.__module__ = 'sandbox'


def _unsupported(what):
    raise NotSupportedInSandbox(f'{what} is not supported in this sandbox yet (planned for a later stage).')


# ---- time / duration ----
_time_mod = _module('rclpy.time')
_dur_mod = _module('rclpy.duration')


class Duration:
    def __init__(self, *, seconds=0, nanoseconds=0):
        self.nanoseconds = int(seconds * 1e9) + int(nanoseconds)

    def to_msg(self):
        return _CLASSES['builtin_interfaces/msg/Duration'](sec=self.nanoseconds // 10**9, nanosec=self.nanoseconds % 10**9)

    def __repr__(self):
        return f'Duration(nanoseconds={self.nanoseconds})'


class Time:
    def __init__(self, *, seconds=0, nanoseconds=0, clock_type=None):
        self.nanoseconds = int(seconds * 1e9) + int(nanoseconds)

    def seconds_nanoseconds(self):
        return (self.nanoseconds // 10**9, self.nanoseconds % 10**9)

    def to_msg(self):
        s, ns = self.seconds_nanoseconds()
        return _CLASSES['builtin_interfaces/msg/Time'](sec=s, nanosec=ns)

    @classmethod
    def from_msg(cls, msg, clock_type=None):
        return cls(seconds=msg.sec, nanoseconds=msg.nanosec)

    def __sub__(self, other):
        if isinstance(other, Time):
            return Duration(nanoseconds=self.nanoseconds - other.nanoseconds)
        return Time(nanoseconds=self.nanoseconds - other.nanoseconds)

    def __add__(self, other):
        return Time(nanoseconds=self.nanoseconds + other.nanoseconds)

    def __lt__(self, o): return self.nanoseconds < o.nanoseconds
    def __le__(self, o): return self.nanoseconds <= o.nanoseconds
    def __gt__(self, o): return self.nanoseconds > o.nanoseconds
    def __ge__(self, o): return self.nanoseconds >= o.nanoseconds
    def __eq__(self, o): return isinstance(o, Time) and self.nanoseconds == o.nanoseconds

    def __repr__(self):
        return f'Time(nanoseconds={self.nanoseconds}, clock_type=ROS_TIME)'


_time_mod.Time = Time
_dur_mod.Duration = Duration
rclpy.time = _time_mod
rclpy.duration = _dur_mod


class Clock:
    def now(self):
        return Time(nanoseconds=_now_ns())


_clock_mod = _module('rclpy.clock')
_clock_mod.Clock = Clock
_clock_mod.ROSClock = Clock


# ---- logging ----
_logging = _module('rclpy.logging')

_LEVELS = {'DEBUG': 10, 'INFO': 20, 'WARN': 30, 'ERROR': 40, 'FATAL': 50}
_COLORS = {'DEBUG': '\x1b[32m', 'INFO': '', 'WARN': '\x1b[33m', 'ERROR': '\x1b[31m', 'FATAL': '\x1b[31m'}


class LoggingSeverity:
    UNSET = 0
    DEBUG = 10
    INFO = 20
    WARN = 30
    ERROR = 40
    FATAL = 50


class RcutilsLogger:
    def __init__(self, name):
        self.name = name
        self._level = 20
        self._once = set()
        self._last = {}

    def get_child(self, name):
        return RcutilsLogger(f'{self.name}.{name}')

    def set_level(self, level):
        self._level = int(level)

    def get_effective_level(self):
        return self._level

    def _log(self, sev, msg, **kw):
        if _LEVELS[sev] < self._level:
            return False
        key = sys._getframe(2).f_lineno
        if kw.get('once'):
            if key in self._once:
                return False
            self._once.add(key)
        thr = kw.get('throttle_duration_sec')
        if thr:
            now = _sandbox.now_ms() / 1000.0
            if now - self._last.get(key, -1e9) < thr:
                return False
            self._last[key] = now
        t = _sandbox.now_ms() / 1000.0
        c = _COLORS[sev]
        sys.stderr.write(f'{c}[{sev}] [{t:.9f}] [{self.name}]: {msg}{chr(27) + "[0m" if c else ""}\n')
        return True

    def debug(self, msg, **kw): return self._log('DEBUG', msg, **kw)
    def info(self, msg, **kw): return self._log('INFO', msg, **kw)
    def warn(self, msg, **kw): return self._log('WARN', msg, **kw)
    def warning(self, msg, **kw): return self._log('WARN', msg, **kw)
    def error(self, msg, **kw): return self._log('ERROR', msg, **kw)
    def fatal(self, msg, **kw): return self._log('FATAL', msg, **kw)


_logging.get_logger = lambda name: RcutilsLogger(name)
_logging.LoggingSeverity = LoggingSeverity
_logging.set_logger_level = lambda name, level: None
rclpy.logging = _logging


# ---- QoS ----
qos = _module('rclpy.qos')


class _Enum:
    def __init__(self, name, value):
        self.name, self.value = name, value

    def __repr__(self):
        return self.name


class HistoryPolicy:
    SYSTEM_DEFAULT = _Enum('SYSTEM_DEFAULT', 0)
    KEEP_LAST = _Enum('KEEP_LAST', 1)
    KEEP_ALL = _Enum('KEEP_ALL', 2)


class ReliabilityPolicy:
    SYSTEM_DEFAULT = _Enum('SYSTEM_DEFAULT', 0)
    RELIABLE = _Enum('RELIABLE', 1)
    BEST_EFFORT = _Enum('BEST_EFFORT', 2)


class DurabilityPolicy:
    SYSTEM_DEFAULT = _Enum('SYSTEM_DEFAULT', 0)
    TRANSIENT_LOCAL = _Enum('TRANSIENT_LOCAL', 1)
    VOLATILE = _Enum('VOLATILE', 2)


class QoSProfile:
    def __init__(self, *, depth=None, history=None, reliability=None, durability=None, **kw):
        if depth is None and history is not HistoryPolicy.KEEP_ALL:
            raise ValueError('History policy is KEEP_LAST but no depth was specified')
        self.depth = depth if depth is not None else 1000
        self.history = history or HistoryPolicy.KEEP_LAST
        self.reliability = reliability or ReliabilityPolicy.RELIABLE
        self.durability = durability or DurabilityPolicy.VOLATILE

    def _wire(self):
        return {
            'depth': self.depth,
            'reliability': 'best_effort' if self.reliability is ReliabilityPolicy.BEST_EFFORT else 'reliable',
            'durability': 'transient_local' if self.durability is DurabilityPolicy.TRANSIENT_LOCAL else 'volatile',
        }

    def __repr__(self):
        return f'QoSProfile(history={self.history}, depth={self.depth}, reliability={self.reliability}, durability={self.durability})'


qos.QoSProfile = QoSProfile
qos.HistoryPolicy = qos.QoSHistoryPolicy = HistoryPolicy
qos.ReliabilityPolicy = qos.QoSReliabilityPolicy = ReliabilityPolicy
qos.DurabilityPolicy = qos.QoSDurabilityPolicy = DurabilityPolicy
qos.qos_profile_sensor_data = QoSProfile(depth=5, reliability=ReliabilityPolicy.BEST_EFFORT)
qos.qos_profile_system_default = QoSProfile(depth=10)
qos.qos_profile_services_default = QoSProfile(depth=10)
qos.qos_profile_parameters = QoSProfile(depth=1000)


class QoSPresetProfiles:
    SENSOR_DATA = qos.qos_profile_sensor_data
    SYSTEM_DEFAULT = qos.qos_profile_system_default
    SERVICES_DEFAULT = qos.qos_profile_services_default


qos.QoSPresetProfiles = QoSPresetProfiles
rclpy.qos = qos


def _qos(q):
    if isinstance(q, bool):
        raise TypeError('qos_profile must be a QoSProfile or an int (history depth)')
    if isinstance(q, int):
        return QoSProfile(depth=q)
    if isinstance(q, QoSProfile):
        return q
    raise TypeError('qos_profile must be a QoSProfile or an int (history depth)')


# ---- callback groups ----
cbg = _module('rclpy.callback_groups')


class CallbackGroup:
    pass


class MutuallyExclusiveCallbackGroup(CallbackGroup):
    pass


class ReentrantCallbackGroup(CallbackGroup):
    pass


cbg.CallbackGroup = CallbackGroup
cbg.MutuallyExclusiveCallbackGroup = MutuallyExclusiveCallbackGroup
cbg.ReentrantCallbackGroup = ReentrantCallbackGroup
rclpy.callback_groups = cbg


# ---- task / future ----
task = _module('rclpy.task')


class Future:
    def __init__(self):
        self._done = False
        self._result = None
        self._exception = None
        self._cancelled = False
        self._callbacks = []

    def done(self):
        return self._done or self._cancelled

    def cancelled(self):
        return self._cancelled

    def cancel(self):
        if not self._done:
            self._cancelled = True

    def result(self):
        if self._exception:
            raise self._exception
        return self._result

    def exception(self):
        return self._exception

    def set_result(self, result):
        self._result = result
        self._done = True
        for cb in self._callbacks:
            cb(self)

    def set_exception(self, exc):
        self._exception = exc
        self._done = True

    def add_done_callback(self, cb):
        if self._done:
            cb(self)
        else:
            self._callbacks.append(cb)

    def __await__(self):
        while not self.done():
            yield
        return self.result()


task.Future = Future
rclpy.task = task


# ---- parameters ----
param_mod = _module('rclpy.parameter')


class _ParamType:
    def __init__(self, name, value):
        self.name, self.value = name, value

    def __repr__(self):
        return f'<Type.{self.name}: {self.value}>'


class Parameter:
    class Type:
        NOT_SET = _ParamType('NOT_SET', 0)
        BOOL = _ParamType('BOOL', 1)
        INTEGER = _ParamType('INTEGER', 2)
        DOUBLE = _ParamType('DOUBLE', 3)
        STRING = _ParamType('STRING', 4)
        BYTE_ARRAY = _ParamType('BYTE_ARRAY', 5)
        BOOL_ARRAY = _ParamType('BOOL_ARRAY', 6)
        INTEGER_ARRAY = _ParamType('INTEGER_ARRAY', 7)
        DOUBLE_ARRAY = _ParamType('DOUBLE_ARRAY', 8)
        STRING_ARRAY = _ParamType('STRING_ARRAY', 9)

        @staticmethod
        def from_parameter_value(v):
            T = Parameter.Type
            if v is None:
                return T.NOT_SET
            if isinstance(v, bool):
                return T.BOOL
            if isinstance(v, int):
                return T.INTEGER
            if isinstance(v, float):
                return T.DOUBLE
            if isinstance(v, str):
                return T.STRING
            if isinstance(v, (list, tuple)):
                if all(isinstance(x, bool) for x in v) and v:
                    return T.BOOL_ARRAY
                if all(isinstance(x, int) and not isinstance(x, bool) for x in v) and v:
                    return T.INTEGER_ARRAY
                if all(isinstance(x, (int, float)) for x in v) and v:
                    return T.DOUBLE_ARRAY
                if all(isinstance(x, str) for x in v):
                    return T.STRING_ARRAY
            raise TypeError(f'The given value is not one of the allowed types \'{v}\'.')

    def __init__(self, name, type_=None, value=None):
        if type_ is not None and not isinstance(type_, _ParamType) and value is None:
            value, type_ = type_, None
        self._name = name
        self._value = value
        self._type = type_ if type_ is not None else Parameter.Type.from_parameter_value(value)

    @property
    def name(self):
        return self._name

    @property
    def value(self):
        return self._value

    @property
    def type_(self):
        return self._type

    def get_parameter_value(self):
        return ParameterValue(self._type, self._value)

    def __repr__(self):
        return f"Parameter(name='{self._name}', value={self._value!r})"


class ParameterValue:
    def __init__(self, ptype, value):
        T = Parameter.Type
        self.type = ptype.value
        self.bool_value = value if ptype is T.BOOL else False
        self.integer_value = value if ptype is T.INTEGER else 0
        self.double_value = value if ptype is T.DOUBLE else 0.0
        self.string_value = value if ptype is T.STRING else ''
        self.bool_array_value = list(value) if ptype is T.BOOL_ARRAY else []
        self.integer_array_value = list(value) if ptype is T.INTEGER_ARRAY else []
        self.double_array_value = list(value) if ptype is T.DOUBLE_ARRAY else []
        self.string_array_value = list(value) if ptype is T.STRING_ARRAY else []


param_mod.Parameter = Parameter
param_mod.ParameterValue = ParameterValue
rclpy.parameter = param_mod
rclpy.Parameter = Parameter


# ---- executors ----
executors = _module('rclpy.executors')


class ExternalShutdownException(Exception):
    pass


ExternalShutdownException.__module__ = 'rclpy.executors'
executors.ExternalShutdownException = ExternalShutdownException


def _pump(timeout_s):
    ms = 0 if timeout_s is None else max(0, int(timeout_s * 1000))
    raw = _sandbox.wait(ms)
    if _sandbox.interrupted():
        raise KeyboardInterrupt
    for m in json.loads(raw):
        _route(m)


def _route(m):
    t = m['t']
    if t == 'msg':
        sub = _subs.get(m['sid'])
        if sub is not None:
            sub._queue.append(m['data'])
    elif t == 'srv_req':
        srv = _services.get(m['sid'])
        if srv is not None:
            srv._queue.append((m['id'], m['data']))
    elif t == 'srv_resp':
        item = _pending_calls.get(m['id'])
        if item is not None:
            item[0]._responses.append((m['id'], m['data']))
    elif t == 'graph':
        _graph.update(m['graph'])
    elif t == 'param_set':
        node = _nodes.get(m['nid'])
        if node is not None:
            node._param_requests.append(m)
        else:
            _post({'t': 'param_resp', 'id': m['id'], 'ok': False, 'reason': 'node not found'})


class Executor:
    def __init__(self, *, context=None):
        self._nodes = []

    def add_node(self, node):
        if node not in self._nodes:
            self._nodes.append(node)
        return True

    def remove_node(self, node):
        if node in self._nodes:
            self._nodes.remove(node)

    def get_nodes(self):
        return list(self._nodes)

    def shutdown(self, timeout_sec=None):
        self._nodes = []
        return True

    def _ready(self):
        work = []
        now = _time.monotonic()
        for node in list(self._nodes):
            if node._destroyed:
                continue
            for tm in node._timers:
                if not tm._canceled and tm._next <= now:
                    work.append(('timer', tm))
            for sub in node._subscriptions:
                if sub._queue:
                    work.append(('sub', sub))
            for srv in node._services_list:
                if srv._queue:
                    work.append(('srv', srv))
            for cli in node._clients:
                if cli._responses:
                    work.append(('cli', cli))
            if node._param_requests:
                work.append(('param', node))
        return work

    def _next_timer(self):
        best = None
        for node in self._nodes:
            if node._destroyed:
                continue
            for tm in node._timers:
                if not tm._canceled and (best is None or tm._next < best):
                    best = tm._next
        return best

    def _execute(self, kind, obj):
        if kind == 'timer':
            now = _time.monotonic()
            obj._next += obj._period
            if obj._next < now:
                obj._next = now + obj._period
            obj._last_call = now
            obj.callback()
        elif kind == 'sub':
            data = obj._queue.popleft()
            msg = _from_dict(obj.msg_type, data) if obj.msg_type is not None else data
            obj.callback(msg)
        elif kind == 'srv':
            rid, data = obj._queue.popleft()
            req = _from_dict(obj.srv_type.Request, data)
            res = obj.callback(req, obj.srv_type.Response())
            if not isinstance(res, obj.srv_type.Response):
                raise TypeError(f"The service callback for '{obj.srv_name}' must return a {obj.srv_type.__name__}.Response object (did you forget 'return response'?)")
            _post({'t': 'srv_resp', 'id': rid, 'data': _to_dict(res)})
        elif kind == 'cli':
            rid, data = obj._responses.popleft()
            item = _pending_calls.pop(rid, None)
            if item is not None and not item[1].cancelled():
                item[1].set_result(_from_dict(obj.srv_type.Response, data))
        elif kind == 'param':
            req = obj._param_requests.popleft()
            v = req['value']
            if req.get('vtype') == 'DOUBLE':
                v = float(v)
            elif req.get('vtype') == 'INTEGER':
                v = int(v)
            res = obj._set_one(req['name'], v)
            _post({'t': 'param_resp', 'id': req['id'], 'ok': res.successful, 'reason': res.reason})

    def spin_once(self, timeout_sec=None):
        _state['spun'] = True
        deadline = None if timeout_sec is None or timeout_sec < 0 else _time.monotonic() + timeout_sec
        while True:
            if not _ctx._ok:
                return
            _pump(0)
            work = self._ready()
            if work:
                for kind, obj in work:
                    self._execute(kind, obj)
                return
            now = _time.monotonic()
            if deadline is not None and now >= deadline:
                return
            wait = 0.05
            nt = self._next_timer()
            if nt is not None:
                wait = min(wait, max(0.0, nt - now))
            if deadline is not None:
                wait = min(wait, max(0.0, deadline - now))
            _pump(wait)

    def spin(self):
        while _ctx._ok and any(not n._destroyed for n in self._nodes):
            self.spin_once(None)

    def spin_until_future_complete(self, future, timeout_sec=None):
        deadline = None if timeout_sec is None or timeout_sec < 0 else _time.monotonic() + timeout_sec
        while _ctx._ok and not future.done():
            if deadline is not None:
                rem = deadline - _time.monotonic()
                if rem <= 0:
                    return
                self.spin_once(rem)
            else:
                self.spin_once(None)


class SingleThreadedExecutor(Executor):
    pass


class MultiThreadedExecutor(Executor):
    def __init__(self, num_threads=None, *, context=None):
        super().__init__()


executors.Executor = Executor
executors.SingleThreadedExecutor = SingleThreadedExecutor
executors.MultiThreadedExecutor = MultiThreadedExecutor
rclpy.executors = executors

_global_executor = SingleThreadedExecutor()


def get_global_executor():
    return _global_executor


def _check_node(node):
    if not isinstance(node, Node):
        raise TypeError(f'Expected an rclpy Node, got {type(node).__name__}. Did you pass the class instead of an instance (e.g. MyNode instead of MyNode())?')


def spin(node, executor=None):
    _check_node(node)
    ex = executor or _global_executor
    ex.add_node(node)
    try:
        while _ctx._ok and not node._destroyed:
            ex.spin_once(None)
    finally:
        ex.remove_node(node)


def spin_once(node, *, executor=None, timeout_sec=None):
    _check_node(node)
    ex = executor or _global_executor
    ex.add_node(node)
    try:
        ex.spin_once(timeout_sec)
    finally:
        ex.remove_node(node)


def spin_until_future_complete(node, future, executor=None, timeout_sec=None):
    _check_node(node)
    ex = executor or _global_executor
    ex.add_node(node)
    try:
        ex.spin_until_future_complete(future, timeout_sec)
    finally:
        ex.remove_node(node)


rclpy.spin = spin
rclpy.spin_once = spin_once
rclpy.spin_until_future_complete = spin_until_future_complete
rclpy.get_global_executor = get_global_executor


# ---- entities ----
_NAME_RE = re.compile(r'^[A-Za-z_][A-Za-z0-9_]*$')
_TOPIC_RE = re.compile(r'^~?/?([A-Za-z_][A-Za-z0-9_]*)(/[A-Za-z_][A-Za-z0-9_]*)*$')


def _resolve(node, name, kind='topic'):
    if not isinstance(name, str) or not name or not _TOPIC_RE.match(name):
        exc = InvalidServiceNameException if kind == 'service' else InvalidTopicNameException
        raise exc(f"Invalid {kind} name '{name}': must contain only alphanumerics, '_' and '/', and must not start with a number")
    if name.startswith('~'):
        return node.get_fully_qualified_name() + '/' + name[1:].lstrip('/')
    if name.startswith('/'):
        return name
    ns = node.get_namespace().rstrip('/')
    return ns + '/' + name


class Publisher:
    def __init__(self, node, msg_type, topic, qos_profile):
        self._node = node
        self.msg_type = msg_type
        self.topic = topic
        self.qos_profile = qos_profile
        self._lid = _next_id()
        _post({'t': 'ep_add', 'lid': self._lid, 'nid': node._lid, 'kind': 'pub', 'name': topic,
               'type': msg_type._ros_type, 'qos': qos_profile._wire()})

    @property
    def topic_name(self):
        return self.topic

    def publish(self, msg):
        if not isinstance(msg, self.msg_type):
            raise TypeError(f'Expected {self.msg_type.__module__}.{self.msg_type.__name__}, got {type(msg).__module__}.{type(msg).__name__}')
        if self._node._destroyed:
            raise RuntimeError('cannot publish: the node has been destroyed')
        _post({'t': 'publish', 'lid': self._lid, 'data': _to_dict(msg)})

    def get_subscription_count(self):
        return _graph['subs'].get(self.topic, 0)

    def destroy(self):
        self._node.destroy_publisher(self)


class Subscription:
    def __init__(self, node, msg_type, topic, callback, qos_profile, raw=False):
        self._node = node
        self.msg_type = msg_type
        self.topic = topic
        self.callback = callback
        self.qos_profile = qos_profile
        self._queue = deque(maxlen=max(1, qos_profile.depth))
        self._lid = _next_id()
        _subs[self._lid] = self
        _post({'t': 'ep_add', 'lid': self._lid, 'nid': node._lid, 'kind': 'sub', 'name': topic,
               'type': msg_type._ros_type, 'qos': qos_profile._wire()})

    @property
    def topic_name(self):
        return self.topic

    def get_publisher_count(self):
        return _graph['pubs'].get(self.topic, 0)

    def destroy(self):
        self._node.destroy_subscription(self)


class Timer:
    def __init__(self, period, callback):
        self._period = float(period)
        self.callback = callback
        self._next = _time.monotonic() + self._period
        self._canceled = False
        self._last_call = None
        self._lid = _next_id()

    @property
    def timer_period_ns(self):
        return int(self._period * 1e9)

    def cancel(self):
        self._canceled = True

    def is_canceled(self):
        return self._canceled

    def reset(self):
        self._canceled = False
        self._next = _time.monotonic() + self._period

    def time_until_next_call(self):
        return None if self._canceled else int(max(0.0, self._next - _time.monotonic()) * 1e9)

    def destroy(self):
        self._canceled = True


class Service:
    def __init__(self, node, srv_type, srv_name, callback):
        self._node = node
        self.srv_type = srv_type
        self.srv_name = srv_name
        self.service_name = srv_name
        self.callback = callback
        self._queue = deque()
        self._lid = _next_id()
        _services[self._lid] = self
        _post({'t': 'ep_add', 'lid': self._lid, 'nid': node._lid, 'kind': 'srv', 'name': srv_name,
               'type': srv_type._ros_type, 'qos': {}})

    def destroy(self):
        self._node.destroy_service(self)


class Client:
    def __init__(self, node, srv_type, srv_name):
        self._node = node
        self.srv_type = srv_type
        self.srv_name = srv_name
        self.service_name = srv_name
        self._responses = deque()
        self._lid = _next_id()
        _post({'t': 'ep_add', 'lid': self._lid, 'nid': node._lid, 'kind': 'cli', 'name': srv_name,
               'type': srv_type._ros_type, 'qos': {}})

    def service_is_ready(self):
        _pump(0)
        return self.srv_name in _graph['services']

    def wait_for_service(self, timeout_sec=None):
        deadline = None if timeout_sec is None else _time.monotonic() + timeout_sec
        while _ctx._ok:
            _pump(0)
            if self.srv_name in _graph['services']:
                return True
            if deadline is not None and _time.monotonic() >= deadline:
                return False
            _pump(0.05)
        return False

    def call_async(self, request):
        if not isinstance(request, self.srv_type.Request):
            raise TypeError(f'Expected {self.srv_type.__name__}.Request, got {type(request).__name__}')
        fut = Future()
        cid = _next_id()
        _pending_calls[cid] = (self, fut)
        _post({'t': 'srv_call', 'lid': self._lid, 'id': cid, 'data': _to_dict(request)})
        return fut

    def call(self, request, timeout_sec=None):
        sys.stderr.write('\x1b[33m[sandbox] Note: in real ROS 2, Client.call() can block forever if nothing is spinning the node. '
                         'Prefer call_async() + rclpy.spin_until_future_complete().\x1b[0m\n')
        fut = self.call_async(request)
        deadline = None if timeout_sec is None else _time.monotonic() + timeout_sec
        while not fut.done():
            _pump(0.05)
            while self._responses:
                rid, data = self._responses.popleft()
                item = _pending_calls.pop(rid, None)
                if item is not None:
                    item[1].set_result(_from_dict(self.srv_type.Response, data))
            if deadline is not None and _time.monotonic() >= deadline:
                return None
        return fut.result()

    def remove_pending_request(self, future):
        for k, (c, f) in list(_pending_calls.items()):
            if f is future:
                del _pending_calls[k]

    def destroy(self):
        self._node.destroy_client(self)


def _check_msg_type(t, what='message'):
    if isinstance(t, type) and issubclass(t, _MsgBase):
        return
    if isinstance(t, _MsgBase):
        raise TypeError(f'Expected a {what} type (class), got an instance: use {type(t).__name__} instead of {type(t).__name__}()')
    raise TypeError(f"Expected a {what} type such as std_msgs.msg.String, got {t!r}")


class Node:
    def __init__(self, node_name, *, context=None, cli_args=None, namespace=None, use_global_arguments=True,
                 enable_rosout=True, start_parameter_services=True, parameter_overrides=None,
                 allow_undeclared_parameters=False, automatically_declare_parameters_from_overrides=False,
                 enable_logger_service=False):
        if not _ctx._ok:
            raise RCLError('failed to initialize rcl node: the given context is not valid, either rcl_init() '
                           'was not called or rcl_shutdown() was called., at ./src/rcl/node.c:186')
        node_name = _ctx.node_remaps.get('__node', node_name)
        if not isinstance(node_name, str) or not _NAME_RE.match(node_name):
            raise InvalidNodeNameException(
                f"Invalid node name: node name must not contain characters other than alphanumerics or '_':\n  '{node_name}'")
        ns = _ctx.node_remaps.get('__ns', namespace or '/')
        if not ns.startswith('/'):
            ns = '/' + ns
        self._name = node_name
        self._namespace = ns
        self._destroyed = False
        self._publishers = []
        self._subscriptions = []
        self._timers = []
        self._services_list = []
        self._clients = []
        self._param_requests = deque()
        self._parameters = {}
        self._param_callbacks = []
        self._allow_undeclared = allow_undeclared_parameters
        self._overrides = dict(_ctx.overrides)
        for p in (parameter_overrides or []):
            self._overrides[p.name] = p.value
        self._logger = RcutilsLogger(node_name if ns == '/' else ns.strip('/').replace('/', '.') + '.' + node_name)
        self._clock = Clock()
        self._lid = _next_id()
        _nodes[self._lid] = self
        _post({'t': 'node_add', 'lid': self._lid, 'name': node_name, 'ns': ns})
        self.declare_parameter('use_sim_time', False)
        if automatically_declare_parameters_from_overrides:
            for k, v in self._overrides.items():
                if k not in self._parameters:
                    self.declare_parameter(k, v)

    # --- identity ---
    def get_name(self):
        return self._name

    def get_namespace(self):
        return self._namespace

    def get_fully_qualified_name(self):
        return (self._namespace.rstrip('/') + '/' + self._name)

    def get_logger(self):
        return self._logger

    def get_clock(self):
        return self._clock

    @property
    def executor(self):
        return _global_executor

    # --- entities ---
    def create_publisher(self, msg_type, topic, qos_profile, *, callback_group=None, event_callbacks=None,
                         qos_overriding_options=None, publisher_class=None):
        _check_msg_type(msg_type)
        p = Publisher(self, msg_type, _resolve(self, topic), _qos(qos_profile))
        self._publishers.append(p)
        return p

    def create_subscription(self, msg_type, topic, callback, qos_profile, *, callback_group=None,
                            event_callbacks=None, qos_overriding_options=None, raw=False):
        _check_msg_type(msg_type)
        if not callable(callback):
            raise TypeError('callback must be callable (pass the function itself, e.g. self.listener_callback, without parentheses)')
        s = Subscription(self, msg_type, _resolve(self, topic), callback, _qos(qos_profile), raw)
        self._subscriptions.append(s)
        _state['had_callbacks'] = True
        return s

    def create_timer(self, timer_period_sec, callback, callback_group=None, clock=None, autostart=True):
        if not callable(callback):
            raise TypeError('callback must be callable (pass the function itself, e.g. self.timer_callback, without parentheses)')
        if timer_period_sec <= 0:
            raise ValueError('timer period must be > 0')
        t = Timer(timer_period_sec, callback)
        if not autostart:
            t._canceled = True
        self._timers.append(t)
        _state['had_callbacks'] = True
        return t

    def create_rate(self, frequency, clock=None):
        _unsupported('Node.create_rate()')

    def create_service(self, srv_type, srv_name, callback, *, qos_profile=None, callback_group=None):
        if not (isinstance(srv_type, type) and issubclass(srv_type, _SrvType)):
            raise TypeError(f'Expected a service type such as example_interfaces.srv.AddTwoInts, got {srv_type!r}')
        s = Service(self, srv_type, _resolve(self, srv_name, 'service'), callback)
        self._services_list.append(s)
        _state['had_callbacks'] = True
        return s

    def create_client(self, srv_type, srv_name, *, qos_profile=None, callback_group=None):
        if not (isinstance(srv_type, type) and issubclass(srv_type, _SrvType)):
            raise TypeError(f'Expected a service type such as example_interfaces.srv.AddTwoInts, got {srv_type!r}')
        c = Client(self, srv_type, _resolve(self, srv_name, 'service'))
        self._clients.append(c)
        return c

    def _remove_ep(self, lst, ent):
        if ent in lst:
            lst.remove(ent)
            _post({'t': 'ep_remove', 'lid': ent._lid})
            return True
        return False

    def destroy_publisher(self, p):
        return self._remove_ep(self._publishers, p)

    def destroy_subscription(self, s):
        _subs.pop(s._lid, None)
        return self._remove_ep(self._subscriptions, s)

    def destroy_service(self, s):
        _services.pop(s._lid, None)
        return self._remove_ep(self._services_list, s)

    def destroy_client(self, c):
        return self._remove_ep(self._clients, c)

    def destroy_timer(self, t):
        if t in self._timers:
            t.cancel()
            self._timers.remove(t)
            return True
        return False

    def destroy_node(self):
        if self._destroyed:
            return
        for s in self._subscriptions:
            _subs.pop(s._lid, None)
        for s in self._services_list:
            _services.pop(s._lid, None)
        self._destroyed = True
        _nodes.pop(self._lid, None)
        _post({'t': 'node_remove', 'lid': self._lid})

    # --- graph ---
    def count_publishers(self, topic_name):
        _pump(0)
        return _graph['pubs'].get(_resolve(self, topic_name), 0)

    def count_subscribers(self, topic_name):
        _pump(0)
        return _graph['subs'].get(_resolve(self, topic_name), 0)

    def get_topic_names_and_types(self, no_demangle=False):
        _pump(0)
        return [(k, list(v)) for k, v in sorted(_graph['topics'].items())]

    def get_service_names_and_types(self):
        _pump(0)
        return [(k, list(v)) for k, v in sorted(_graph['services'].items())]

    def get_node_names(self):
        _pump(0)
        return [n.rsplit('/', 1)[-1] for n in _graph['nodes']]

    def get_node_names_and_namespaces(self):
        _pump(0)
        out = []
        for n in _graph['nodes']:
            ns, _, name = n.rpartition('/')
            out.append((name, ns or '/'))
        return out

    # --- parameters ---
    def declare_parameter(self, name, value=None, descriptor=None, ignore_override=False):
        if name in self._parameters:
            raise ParameterAlreadyDeclaredException(name)
        if isinstance(value, _ParamType):
            value = None
        if not ignore_override and name in self._overrides:
            value = self._overrides[name]
        p = Parameter(name, value=value)
        self._parameters[name] = p
        self._mirror(p)
        return p

    def declare_parameters(self, namespace, parameters, ignore_override=False):
        out = []
        for item in parameters:
            name = item[0]
            value = item[1] if len(item) > 1 else None
            full = f'{namespace}.{name}' if namespace else name
            out.append(self.declare_parameter(full, value, None, ignore_override))
        return out

    def has_parameter(self, name):
        return name in self._parameters

    def get_parameter(self, name):
        if name not in self._parameters:
            if self._allow_undeclared:
                return Parameter(name, Parameter.Type.NOT_SET, None)
            raise ParameterNotDeclaredException(name)
        return self._parameters[name]

    def get_parameter_or(self, name, alternative_value=None):
        return self._parameters.get(name, alternative_value)

    def get_parameters(self, names):
        return [self.get_parameter(n) for n in names]

    def get_parameters_by_prefix(self, prefix):
        pre = prefix + '.' if prefix else ''
        return {k[len(pre):]: v for k, v in self._parameters.items() if k.startswith(pre)}

    def add_on_set_parameters_callback(self, callback):
        self._param_callbacks.insert(0, callback)

    def remove_on_set_parameters_callback(self, callback):
        if callback in self._param_callbacks:
            self._param_callbacks.remove(callback)

    def set_parameters(self, parameter_list):
        return [self._set_param(p) for p in parameter_list]

    def set_parameters_atomically(self, parameter_list):
        res = None
        for p in parameter_list:
            res = self._set_param(p)
            if not res.successful:
                return res
        return res or _CLASSES['rcl_interfaces/msg/SetParametersResult'](successful=True)

    def _set_one(self, name, value):
        return self._set_param(Parameter(name, value=value))

    def _set_param(self, p):
        R = _CLASSES['rcl_interfaces/msg/SetParametersResult']
        if p.name not in self._parameters and not self._allow_undeclared:
            return R(successful=False, reason='parameter not declared')
        old = self._parameters.get(p.name)
        if old is not None and old.type_ is not Parameter.Type.NOT_SET and old.type_ is not p.type_:
            return R(successful=False,
                     reason=f"Wrong parameter type, parameter {{{p.name}}} is of type {{{old.type_.name.lower()}}}, setting it to {{{p.type_.name.lower()}}} is not allowed.")
        for cb in self._param_callbacks:
            r = cb([p])
            if r is None or not getattr(r, 'successful', False):
                return R(successful=False, reason=getattr(r, 'reason', '') if r is not None else 'callback returned None')
        self._parameters[p.name] = p
        self._mirror(p)
        return R(successful=True, reason='')

    def _mirror(self, p):
        _post({'t': 'param', 'nid': self._lid, 'name': p.name, 'ptype': p.type_.name, 'value': p.value})

    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.destroy_node()


node_mod = _module('rclpy.node')
node_mod.Node = Node
rclpy.node = node_mod
rclpy.create_node = lambda name, **kw: Node(name, **kw)

# Actions / TF / launch: not in stage 1
_action = _module('rclpy.action')
_action.ActionServer = lambda *a, **k: _unsupported('rclpy.action.ActionServer')
_action.ActionClient = lambda *a, **k: _unsupported('rclpy.action.ActionClient')


# --------------------------------------------------------------------------
# sandbox runtime hooks
# --------------------------------------------------------------------------

def _sleep(seconds):
    if seconds < 0:
        raise ValueError('sleep length must be non-negative')
    if _sandbox.sleep(int(seconds * 1000)):
        _sandbox.interrupted()
        raise KeyboardInterrupt


_time.sleep = _sleep


def _cleanup():
    for n in list(_nodes.values()):
        n.destroy_node()
    _ctx._ok = False


def _filtered_tb(exc):
    import traceback
    tb = traceback.extract_tb(exc.__traceback__)
    keep = [f for f in tb if not (f.filename.startswith('<') or 'runpy' in f.filename or f.filename.endswith('ros_shim.py')
                                  or '/lib/python' in f.filename)]
    lines = ['Traceback (most recent call last):\n'] + traceback.format_list(keep)
    lines += traceback.format_exception_only(type(exc), exc)
    return ''.join(lines)


def _run_main(path, argv):
    import runpy
    sys.argv = list(argv)
    code = 0
    err = None
    try:
        runpy.run_path(path, run_name='__main__')
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    except BaseException as e:
        sys.stderr.write(_filtered_tb(e))
        code = 130 if isinstance(e, KeyboardInterrupt) else 1
        err = {'type': type(e).__name__, 'msg': str(e)}
    finally:
        info = {'spun': _state['spun'], 'had_callbacks': _state['had_callbacks']}
        _cleanup()
    sys.stdout.flush()
    sys.stderr.flush()
    _post({'t': 'exit', 'code': code, 'error': err, 'info': info})
    return code
