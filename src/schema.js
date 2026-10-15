/** Normalize this plugin's schemas without replacing the shared registry. */
function nodeSchema(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node
  const out = { ...node }
  if (typeof out.required === 'boolean') delete out.required
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, nodeSchema(value)]))
    const required = [...new Set([...(Array.isArray(node.required) ? node.required : []),
      ...Object.entries(node.properties).filter(([, value]) => value?.required === true).map(([key]) => key)])]
    if (required.length) out.required = required
  }
  if (node.items) out.items = nodeSchema(node.items)
  for (const key of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(node[key])) out[key] = node[key].map(nodeSchema)
  return out
}

export function parametersSchema(parameters = {}) {
  return nodeSchema(parameters.type === 'object' ? parameters : { type: 'object', properties: parameters })
}
