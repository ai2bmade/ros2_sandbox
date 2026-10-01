// Message type helpers shared by the CLI and the built-in JS nodes.
export let SPEC = {};

export async function loadSpec() {
  SPEC = await (await fetch('./msgs.json')).json();
  return SPEC;
}

const INTS = {
  byte: [0, 255], char: [0, 255], int8: [-128, 127], uint8: [0, 255], int16: [-32768, 32767], uint16: [0, 65535],
  int32: [-2147483648, 2147483647], uint32: [0, 4294967295], int64: [-9223372036854775808, 9223372036854775807], uint64: [0, 18446744073709551615],
};
const FLOATS = new Set(['float32', 'float64']);
const isArr = (t) => t.endsWith(']');
const base = (t) => (isArr(t) ? t.slice(0, t.indexOf('[')) : t);

// "geometry_msgs/Twist" -> "geometry_msgs/msg/Twist"
export function normalizeType(t, kind = 'msg') {
  if (!t) return t;
  const p = t.split('/');
  if (p.length === 2) return `${p[0]}/${kind}/${p[1]}`;
  return t;
}

export function isMsgType(t) { return !!(SPEC[t] && SPEC[t].fields); }
export function isSrvType(t) { return !!(SPEC[t] && SPEC[t].request); }

function fieldsOf(type) {
  if (type.endsWith('_Request')) return SPEC[type.slice(0, -8)].request;
  if (type.endsWith('_Response')) return SPEC[type.slice(0, -9)].response;
  return SPEC[type].fields;
}

export function defaultMsg(type) {
  const out = {};
  for (const [n, t, d] of fieldsOf(type)) out[n] = defaultVal(t, d);
  return out;
}

function defaultVal(t, d) {
  if (isArr(t)) return d ? [...d] : [];
  if (d !== undefined) return d;
  if (FLOATS.has(t) || INTS[t]) return 0;
  if (t === 'bool') return false;
  if (t === 'string') return '';
  return defaultMsg(t);
}

// Fill a message of `type` from a (YAML-parsed) partial object. Throws on unknown fields.
export function fillMsg(type, partial, path = '') {
  const msg = defaultMsg(type);
  if (partial == null) return msg;
  if (typeof partial !== 'object' || Array.isArray(partial)) {
    throw new Error(`Failed to populate field: expected a mapping for '${path || type}'`);
  }
  const fields = fieldsOf(type);
  for (const [k, v] of Object.entries(partial)) {
    const f = fields.find((x) => x[0] === k);
    if (!f) throw new Error(`Failed to populate field: '${typeLabel(type)}' object has no attribute '${k}'`);
    const t = f[1];
    if (isArr(t)) msg[k] = (v || []).map((x) => coerce(base(t), x, path + k));
    else msg[k] = coerce(t, v, path + k);
  }
  return msg;
}

function coerce(t, v, path) {
  if (FLOATS.has(t)) {
    const n = Number(v);
    if (typeof v === 'boolean' || Number.isNaN(n)) throw new Error(`Failed to populate field: '${path}' must be a number`);
    return n;
  }
  if (INTS[t]) {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`Failed to populate field: '${path}' must be an integer`);
    return n;
  }
  if (t === 'bool') return Boolean(v);
  if (t === 'string') return v == null ? '' : String(v);
  return fillMsg(t, v, path + '.');
}

function typeLabel(type) {
  const p = type.split('/');
  return p[p.length - 1];
}

function fmtScalar(t, v) {
  if (FLOATS.has(t)) {
    const n = Number(v);
    if (Number.isInteger(n)) return n.toFixed(1);
    return String(n);
  }
  if (t === 'bool') return v ? 'true' : 'false';
  if (t === 'string') {
    if (v === '' || /[:#{}\[\],&*!|>'"%@`]|^\s|\s$|^(true|false|null|yes|no|~|-?\d+(\.\d+)?)$/i.test(v)) {
      return "'" + String(v).replace(/'/g, "''") + "'";
    }
    return String(v);
  }
  return String(v);
}

// YAML rendering like `ros2 topic echo`
export function toYaml(type, msg, indent = '') {
  const lines = [];
  for (const [n, t] of fieldsOf(type)) {
    const v = msg[n];
    if (isArr(t)) {
      const b = base(t);
      if (!v || v.length === 0) lines.push(`${indent}${n}: []`);
      else if (SPEC[b]) {
        lines.push(`${indent}${n}:`);
        for (const item of v) {
          const sub = toYaml(b, item, indent + '  ').split('\n');
          sub[0] = indent + '- ' + sub[0].trimStart();
          lines.push(...sub);
        }
      } else {
        lines.push(`${indent}${n}:`);
        for (const item of v) lines.push(`${indent}- ${fmtScalar(b, item)}`);
      }
    } else if (SPEC[t]) {
      lines.push(`${indent}${n}:`);
      lines.push(toYaml(t, v, indent + '  '));
    } else {
      lines.push(`${indent}${n}: ${fmtScalar(t, v)}`);
    }
  }
  return lines.filter((l) => l !== '').join('\n');
}

// Python-style repr like rclpy: geometry_msgs.msg.Twist(linear=...)
export function reprMsg(type, msg) {
  let pkg, cls;
  if (type.endsWith('_Request') || type.endsWith('_Response')) {
    const p = type.split('/');
    pkg = `${p[0]}.srv`;
    cls = p[2];
  } else {
    const p = type.split('/');
    pkg = `${p[0]}.msg`;
    cls = p[2];
  }
  const parts = fieldsOf(type).map(([n, t]) => {
    const v = msg[n];
    if (isArr(t)) return `${n}=[${(v || []).map((x) => (SPEC[base(t)] ? reprMsg(base(t), x) : pyScalar(base(t), x))).join(', ')}]`;
    if (SPEC[t]) return `${n}=${reprMsg(t, v)}`;
    return `${n}=${pyScalar(t, v)}`;
  });
  return `${pkg}.${cls}(${parts.join(', ')})`;
}

function pyScalar(t, v) {
  if (FLOATS.has(t)) return fmtScalar(t, v);
  if (t === 'bool') return v ? 'True' : 'False';
  if (t === 'string') return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  return String(v);
}

export function interfaceText(type) {
  const spec = SPEC[type];
  if (!spec) return null;
  const fmt = (fields) => fields.map(([n, t, d]) => {
    const short = t.includes('/') ? t.split('/')[0] + '/' + t.split('/')[2] : t;
    return `${short} ${n}${d !== undefined && d !== null ? ' ' + d : ''}`;
  }).join('\n');
  if (spec.fields) return fmt(spec.fields);
  return `${fmt(spec.request)}\n---\n${fmt(spec.response)}`;
}

export function allTypes() { return Object.keys(SPEC); }
