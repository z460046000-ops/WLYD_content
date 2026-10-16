import defaultGlobal from '../rules/global.json' with { type: 'json' }
import defaultStyle from '../rules/style.json' with { type: 'json' }

const stageRules = {
  plan: ['evidence', 'facts', 'links', 'capability'],
  extract: ['evidence', 'facts', 'capability'],
  write: ['evidence', 'facts', 'links', 'capability'],
  'panorama-enrichment': ['evidence', 'links', 'capability', 'panorama'],
  'consistency-review': ['evidence', 'facts'],
  'relationship-repair': ['evidence', 'facts', 'links', 'capability'],
}

/** Send only this stage's shared rules. Every model request is independent. */
export function stageContext(common = {}, stage) {
  const keys = stageRules[stage]
  if (!keys) throw new Error(`未知提示词阶段：${stage}`)
  const { promptPolicy, ...context } = common
  const global = promptPolicy?.global || defaultGlobal
  const style = promptPolicy?.style || defaultStyle
  return { ...context,
    sharedRules: Object.fromEntries(keys.map(key => [key, global.sharedRules[key]])),
    ...(stage === 'write' ? { styleRules: style.principles } : {}),
    task: global.stageContracts[stage] }
}

/** A chapter contributes only its own questions or writing differences. */
export function chapterContext(rule = {}, node = {}, stage) {
  const policy = rule.contentPolicy || {}
  const contentPolicy = Object.fromEntries(['subjects', 'purposes', 'allowCandidate', 'requireKnownPurpose',
    'requiresPositiveEvidence'].filter(key => policy[key] !== undefined).map(key => [key, policy[key]]))
  if (stage === 'extract') return { extractQuestions: rule.extractQuestions || [], contentPolicy }
  if (stage === 'write') return { write: rule.write || [], contentPolicy,
    ...(rule.modes?.[node.mode] ? { selectedMode: rule.modes[node.mode] } : {}),
    ...(rule.frameworks?.[node.framework] ? { selectedFramework: rule.frameworks[node.framework] } : {}) }
  if (stage === 'panorama-enrichment') return { roleFocus: policy.roleFocus || rule.purpose || '',
    ...(rule.organization ? { organization: { strategy: rule.organization.strategy,
      guidance: rule.organization.guidance } } : {}) }
  throw new Error(`未知章节提示词阶段：${stage}`)
}
