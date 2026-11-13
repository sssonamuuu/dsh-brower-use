import test from 'node:test'
import assert from 'node:assert/strict'
import { registerBrowserTools } from '../lib/tools.js'

const ALLOWED = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function checkSchema(node, path, violations) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} must be an object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) violations.push(`${path}.${key} is not in the DSH schema subset`)
  }
  if (Array.isArray(node.enum)) {
    if (node.enum.length === 0) violations.push(`${path}.enum must not be empty`)
    for (const value of node.enum) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) violations.push(`${path}.enum values must be scalars`)
    }
  }
  if (node.type !== undefined) {
    if (!TYPES.has(node.type)) violations.push(`${path}.type is unsupported: ${node.type}`)
    if (node.type === 'object') {
      if (node.properties !== undefined) {
        for (const [key, child] of Object.entries(node.properties)) checkSchema(child, `${path}.properties.${key}`, violations)
      }
      if (node.required !== undefined) {
        if (!Array.isArray(node.required)) violations.push(`${path}.required must be an array`)
        else for (const key of node.required) {
          if (!node.properties || !(key in node.properties)) violations.push(`${path}.required names missing property ${key}`)
        }
      }
      if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be boolean`)
      }
    }
    if (node.type === 'array' && node.items !== undefined) checkSchema(node.items, `${path}.items`, violations)
  }
}

test('all tool schemas stay within the DSH supported JSON Schema subset', () => {
  const definitions = new Map()
  registerBrowserTools(
    { tools: { register: (definition) => definitions.set(definition.name, definition) } },
    { bridge: null, getCwd: async () => '.', logger: null },
  )
  assert.equal(definitions.size, 13)
  const violations = []
  for (const [name, definition] of definitions) {
    checkSchema(definition.parameters, `${name}.parameters`, violations)
    checkSchema(definition.output.schema, `${name}.output.schema`, violations)
    assert.equal(typeof definition.execute, 'function', `${name}.execute`)
    assert.equal(typeof definition.output.render, 'function', `${name}.output.render`)
  }
  assert.deepEqual(violations, [])
})

test('tool parameter enums and required markers are coherent', () => {
  const definitions = new Map()
  registerBrowserTools(
    { tools: { register: (definition) => definitions.set(definition.name, definition) } },
    { bridge: null, getCwd: async () => '.', logger: null },
  )
  const tabs = definitions.get('browser_tabs')
  assert.deepEqual(tabs.parameters.properties.action.enum, ['list', 'activate', 'open', 'close', 'reload', 'back', 'forward'])
  assert.deepEqual(definitions.get('browser_type').parameters.required, ['value'])
  assert.deepEqual(definitions.get('browser_eval').parameters.required, ['expression'])
  assert.deepEqual(definitions.get('browser_wait').parameters.required, ['for'])
})
