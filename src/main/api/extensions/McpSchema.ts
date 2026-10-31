import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

// The pinned SDK registers these ajv-formats names; unknown formats otherwise log server text and silently pass.
const formats = new Set(['date', 'time', 'date-time', 'iso-time', 'iso-date-time', 'duration', 'uri', 'uri-reference',
  'uri-template', 'url', 'email', 'hostname', 'ipv4', 'ipv6', 'regex', 'uuid', 'json-pointer', 'json-pointer-uri-fragment',
  'relative-json-pointer', 'byte', 'int32', 'int64', 'float', 'double', 'password', 'binary']);

export function assertMcpJsonBound(value: unknown, maxBytes = 256 * 1024) {
  let nodes = 0;
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 16_384 || depth > 32) throw new Error('MCP_VALUE_LIMIT');
    if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
    else if (item && typeof item === 'object') for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized) > maxBytes) throw new Error('MCP_VALUE_LIMIT');
}

export function compileMcpSchema(schema: Record<string, unknown>) {
  assertMcpJsonBound(schema, 64 * 1024);
  const inspect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      // No remote resolution or potentially unbounded regular-expression work in Electron Main.
      if ((key === '$ref' && typeof child === 'string' && !child.startsWith('#'))
        || key === '$dynamicRef' || key === '$async' || key === 'patternProperties' || (key === 'pattern' && typeof child === 'string')
        || (key === 'format' && typeof child === 'string' && !formats.has(child))) throw new Error('MCP_SCHEMA_UNSUPPORTED');
      inspect(child);
    }
  };
  inspect(schema);
  try {
    const validate = new AjvJsonSchemaValidator().getValidator(schema);
    return (value: unknown) => {
      assertMcpJsonBound(value);
      if (!validate(value).valid) throw new Error('MCP_SCHEMA_VALIDATION_FAILED');
    };
  } catch { throw new Error('MCP_SCHEMA_UNSUPPORTED'); }
}
