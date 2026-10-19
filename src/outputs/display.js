const text = value => value === undefined || value === null ? '' : String(value)
const list = value => Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
const auditLabels = new Set(['待确认内容', '待确认', '待用户确认', '待审初稿', '未验证', '来源待核验', '本段有待审事项'])
const referenceLine = /^(?:依据|据|来源依据)\s*[:：]\s*(?:\[来源\s*\d+\]\s*(?:[、,，;；]\s*)?)+[。.]?$/u
const stripFormatting = value => value.trim().replace(/^>\s*/u, '')
  .replace(/^\*\*([\s\S]*?)\*\*$/u, '$1').replace(/^__([\s\S]*?)__$/u, '$1')

/** Remove presentation scaffolding only; sentence-level conditions and identities stay intact. */
export function cleanDisplayText(value) {
  return text(value).replace(/\r\n?/gu, '\n').split('\n').map(line => {
    const trimmed = line.trim()
    const plain = stripFormatting(trimmed).trim()
    if (referenceLine.test(plain) || auditLabels.has(plain.replace(/[。.]$/u, ''))) return ''
    const badge = plain.match(/^[【\[]([^】\]]+)[】\]]([\s\S]*)$/u)
    if (badge) {
      const labels = badge[1].split(/[｜|；;、·]/u).map(part => part.trim())
      const kept = labels.filter(label => !auditLabels.has(label))
      if (kept.length !== labels.length) return `${kept.length ? `【${kept.join('｜')}】` : ''}${badge[2]}`.trim()
    }
    return line
  }).join('\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** Read identity before cleaning legacy labels so every output preserves the same qualifications. */
export function displayIdentity(block = {}) {
  const raw = text(block.text).replace(/\r\n?/gu, '\n')
  const legacyCandidate = /(?:^|\n)\s*(?:>\s*)?(?:\*\*|__)?(?:[【\[][^】\]\n]*(?:待确认内容|待确认)[^】\]\n]*[】\]]|(?:待确认内容|待确认)\s*(?:\*\*|__)?[。.]?\s*(?:$|\n))/u.test(raw)
  const legacyUnverified = /(?:^|\n)\s*(?:>\s*)?(?:\*\*|__)?[【\[]?(?:未验证|来源待核验)[】\]]?(?:\*\*|__)?[。.]?\s*(?:$|\n)/u.test(raw)
  const scenarioHypothesis = /(?:^|\n)\s*(?:>\s*)?(?:\*\*|__)?(?:[【\[][^】\]\n]*典型场景假设[^】\]\n]*[】\]]|典型场景假设(?:[：:\s]|$))/u.test(raw)
  return { candidate: block.supportMode === 'candidate' || block.verification === 'candidate'
    || block.capabilityStatus === 'proposed' || block.isHypothesis === true || legacyCandidate || scenarioHypothesis,
  unverified: block.verification === 'unverified' || legacyUnverified }
}

/** Keep business qualifications near the claim while review metadata moves to the appendix. */
export function displayBlockText(block = {}) {
  let body = cleanDisplayText(block.text)
  if (!body) return ''
  const qualifications = []
  if (block.capabilityStatus === 'planned' && !/规划|计划|拟(?:建设|接入|采用|提供|支持|引入)/u.test(body)) qualifications.push('相关能力处于规划阶段')
  if (block.capabilityStatus === 'pilot' && !/试点/u.test(body)) qualifications.push('相关能力仍在试点')
  if (block.capabilityStatus === 'unknown' && !/能力.{0,15}(?:待确认|需确认|尚需确认)/u.test(body)) qualifications.push('相关能力是否具备仍需确认')
  if (block.capabilityOwnership === 'third-party' && !/第三方/u.test(body)) qualifications.push('相关能力依赖第三方')
  if (block.capabilityOwnership === 'customer' && !/客户已有|客户现有/u.test(body)) qualifications.push('相关能力由客户现有系统提供')
  if (block.capabilityOwnership === 'unknown' && !/归属.{0,8}(?:待确认|需确认)/u.test(body)) qualifications.push('相关能力的归属仍需确认')
  const { candidate, unverified } = displayIdentity(block)
  if (candidate && !/^(?:【[^】]*(?:假设|建议|候选)[^】]*】|建议|拟|规划|计划|假设|典型场景假设|候选|可考虑)/u.test(body)) body = `建议方案：${body}`
  if (unverified && !/未验证|待核验|尚需核验|待确认|需确认|尚未.{0,5}(?:核验|验证)|假设/u.test(body)) qualifications.push('相关内容尚需核验')
  const missingConditions = [...new Set([...list(block.conditions), ...list(block.limitations)]
    .filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))].filter(value => !body.includes(value))
  return [...(qualifications.length ? [qualifications.join('；') + '。'] : []), body, ...missingConditions].join('\n')
}
