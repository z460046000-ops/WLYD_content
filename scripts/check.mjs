import { readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function files(dir) {
  if (dir instanceof URL) dir = fileURLToPath(dir)
  const rows = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(rows.map(row => row.isDirectory() ? files(path.join(dir, row.name))
    : /\.[cm]?js$/u.test(row.name) ? [path.join(dir, row.name)] : []))).flat()
}
const modules = [...await files(new URL('../src/', import.meta.url)), ...await files(new URL('../orchestration/', import.meta.url))]
for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status || 1)
}
process.stdout.write(`${modules.length} modules passed syntax checks\n`)
