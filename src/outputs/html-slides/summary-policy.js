const list = value => Array.isArray(value) ? value : []
const strings = value => typeof value === 'string' ? [value] : list(value).filter(item => typeof item === 'string')
const clean = value => String(value ?? '').normalize('NFKC')
const clauses = value => String(value || '').match(/[^。！？；;\n]+[。！？；;]?/gu) || []
const claims = value => String(value || '').split(/[。！？；，,\n]/u).map(value => value.trim()).filter(Boolean)
const unique = values => [...new Set(values)]
const LIMITATION = /不(?:支持|提供|具备|允许|包含)|不能|无法|(?:尚未|暂未|还未|未)(?:上线|发布|开放|接入|实现|验证|集成|支持)|仅(?:支持|限|在|用于)|只(?:能|支持|用于|在)|(?:需|须|必须)[^。！？；]{0,48}(?:授权|审批|许可|配置|验证|同意)|(?:若|如果|只有)[^。！？；]{1,48}(?:才|可|能|时)|前提|依赖|取决于|试点|试运行|规划(?:中|阶段|建设|上线|接入|支持|实现|推出|提供)|(?:仍在|尚在|还在|处于)规划|计划(?:建设|接入|上线|实现|支持|推出|提供)|拟(?:建设|接入|上线|实现|支持|推出|提供)/u
const PREREQUISITE = /^(?:仅)?(?:在|当|待|经|若|如果|只有)[^。！？；]*(?:授权|审批|许可|配置|验证|同意|确认|验收|满足|完成)/u
const DEPENDENT_ACTION = /^(?:随后|然后)?(?:方可|才可|才能|则|即可|可|能够|允许|支持|开展|启用|开启|启动|进行|试点|不支持|不能|无法)/u
const STATE_QUALIFIER = /规划|计划|拟|预计|将|未来|后续|试点|试运行|尚未|暂未|还未|未|待/u
const COMPLETED = /(?:已(?:经)?|现已)(?:全面|正式|成熟|完成|实现|投入|稳定|大规模|成功)*(?:上线|发布|交付|落地|投产|商用|部署|开放|运行|推广)|全面(?:上线|覆盖|推广|商用)|成熟(?:商用|应用)|生产(?:可用|运行)/u
const PENDING = /(?:尚未|暂未|还未|未)(?:正式|全面|对外)?(?:上线|发布|开放|实现|接入)|试点|试运行|规划|计划(?:建设|接入|上线|实现|支持|推出|提供)|拟(?:建设|接入|上线|实现|支持|推出|提供)/u

function sourceTexts(source) {
  return [typeof source?.text === 'string' ? source.text : '', ...strings(source?.conditions), ...strings(source?.limitations)]
}

function proseCaveats(text) {
  const result = []
  for (const sentence of clauses(text)) {
    const parts = sentence.match(/[^，,]+[，,]?/gu) || []
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index].trim().replace(/[，,]$/u, '').trim()
      if (!LIMITATION.test(part) && !PREREQUISITE.test(part)) continue
      let end = index
      const bare = part.replace(/[。！？；;]+$/u, '')
      const dangling = PREREQUISITE.test(part) && (/(?:后|前|时|条件下|情况下)$/u.test(bare)
        || /^(?:若|如果|只有)/u.test(bare) && !/(?:才|则)[^。！？；]*(?:可|能)/u.test(bare))
      if (dangling) {
        while (end + 1 < parts.length && /^(?:并|且|同时)(?:完成|取得|获得|确认|配置|验证|通过)/u.test(parts[end + 1].trim())) end++
        if (end + 1 < parts.length && DEPENDENT_ACTION.test(parts[end + 1].trim())) end++
      }
      result.push(parts.slice(index, end + 1).join('').trim().replace(/[，,]$/u, '').trim())
      index = end
    }
  }
  return result
}

/** Preserve factual restrictions. Approval labels belong to the document review UI. */
export function presentationCaveats(source = {}) {
  const result = [], keys = new Set()
  const add = value => {
    const text = String(value || '').trim()
    const key = clean(text).replace(/\s/gu, '').replace(/[。；;]+$/u, '')
    if (key && !keys.has(key)) { keys.add(key); result.push(text) }
  }
  for (const condition of [...strings(source.conditions), ...strings(source.limitations)]) add(condition)
  for (const restriction of proseCaveats(source.text)) add(restriction)
  const body = result.join('；')
  if (source.capabilityStatus === 'pilot' && !/试点|试运行/u.test(body)) add('当前处于试点阶段')
  if (source.capabilityStatus === 'planned' && !/规划|计划|拟/u.test(body)) add('相关能力仍在规划中')
  if (source.isHypothesis === true) {
    if (!/假设/u.test(body)) add('假设方案，落地条件需核实')
  } else if (source.capabilityStatus === 'proposed' || source.supportMode === 'candidate' || source.verification === 'candidate') {
    if (!/建议方案|候选方案/u.test(body)) add('建议方案，落地条件需核实')
  }
  if (source.capabilityOwnership === 'third-party' && !/第三方/u.test(body)) add('相关能力由第三方提供')
  if (source.capabilityOwnership === 'customer' && !/客户(?:侧|已有|自身)/u.test(body)) add('相关能力由客户侧提供')
  if ((source.capabilityStatus === 'unknown' || source.capabilityOwnership === 'unknown' || source.verification === 'unverified')
    && !result.some(value => /需核实/u.test(value))) add('方案能力需核实')
  return result
}

function chineseNumber(raw) {
  const digits = { 零: 0, '〇': 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return String(Number(raw))
  if (raw.includes('点')) {
    const [whole, decimal] = raw.split('点')
    if (!decimal || [...decimal].some(char => digits[char] === undefined)) return raw
    return `${chineseNumber(whole)}.${[...decimal].map(char => digits[char]).join('')}`
  }
  if (!/[十百千万亿]/u.test(raw)) return [...raw].every(char => digits[char] !== undefined) ? [...raw].map(char => digits[char]).join('') : raw
  const units = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 }
  let total = 0, section = 0, number = 0
  for (const char of raw) {
    if (digits[char] !== undefined) { number = digits[char]; continue }
    const unit = units[char]
    if (!unit) return raw
    if (unit < 10000) section += (number || 1) * unit
    else { section = (section + number) * unit; total += section; section = 0 }
    number = 0
  }
  return String(total + section + number)
}

function numbers(value) {
  const text = clean(value), found = []
  const pattern = /百分之([零〇一二两三四五六七八九十百千万亿点\d.]+)|\d+(?:[.,]\d+)*(?:\s*(?:%|个百分点))?|[零〇一二两三四五六七八九十百千万亿]+(?=个|项|类|家|名|次|倍|年|月|日|元|天)/gu
  for (const match of text.matchAll(pattern)) {
    const raw = match[0], percent = !!match[1] || /%|个百分点/u.test(raw)
    const amount = match[1] || raw.replace(/\s|%|个百分点/gu, '').replace(/,(?=\d{3}(?:\D|$))/gu, '')
    const numeric = /^\d+(?:\.\d+)?$/u.test(amount) ? String(Number(amount)) : chineseNumber(amount)
    found.push({ raw, key: `${numeric}${percent ? raw.includes('个百分点') ? 'pp' : '%' : ''}` })
  }
  return found
}

function englishGroups(value) {
  return [...clean(value).matchAll(/[A-Za-z][A-Za-z\d]*(?:[._+/#-][A-Za-z\d]+)*(?:\s+[A-Za-z][A-Za-z\d]*(?:[._+/#-][A-Za-z\d]+)*)*/gu)]
    .map(match => ({ raw: match[0], key: match[0].replace(/\s/gu, '').toLowerCase(), parts: match[0].toLowerCase().split(/\s+/u) }))
}

function negativeTargets(value) {
  const targets = []
  for (const match of String(value || '').matchAll(/(?:不支持|尚不支持|暂不支持|不能|无法|不具备|不提供|不允许|尚未实现|未实现|未接入|尚未支持|未支持)([^。！？；\n，,]+)/gu)) {
    const target = match[1].trim().replace(/(?:功能|能力)$/u, '')
    if (target && [...target].length <= 32) targets.push(target)
  }
  return unique(targets)
}

const SAFEGUARDS = [
  { label: '授权', token: /授权/u, bypass: /(?:无需|不需(?:要)?|不必|免于|免除|绕过|跳过)[^，,。！？；\n]{0,12}授权/u },
  { label: '审批', token: /审批/u, bypass: /(?:无需|不需(?:要)?|不必|免于|免除|绕过|跳过)[^，,。！？；\n]{0,12}审批/u },
  { label: '人工审核', token: /人审|人工(?:审核|复核|审批|确认)/u,
    bypass: /(?:无需|不需(?:要)?|不必|免于|免除|绕过|跳过)[^，,。！？；\n]{0,12}(?:人审|人工(?:审核|复核|审批|确认))/u }
]

function affirmativeBypass(text, rule) {
  return claims(text).some(claim => {
    const match = rule.bypass.exec(claim)
    return match && !/(?:不应|不可|不能|不得|禁止|避免|切勿|不允许)[^，,。！？；\n]{0,6}$/u.test(claim.slice(0, match.index))
  })
}

function reversedSafeguards(text, sources) {
  const restrictions = sources.flatMap(source => [...strings(source.conditions), ...strings(source.limitations),
    ...claims(source.text).filter(claim => /仅|只有|需|须|必须|前提|才|(?:授权|审批|审核|复核|确认)(?:后|时)|(?:经|通过)[^，,。！？；\n]*(?:授权|审批|审核|复核|确认)/u.test(claim))])
  return SAFEGUARDS.filter(rule => affirmativeBypass(text, rule) && restrictions.some(restriction => rule.token.test(restriction) && !affirmativeBypass(restriction, rule)))
    .map(rule => `概括绕过了原文要求的${rule.label}条件`)
}

function contentBigrams(text) {
  const body = clean(text).replace(/(?:本)?(?:平台|系统|产品|方案)|能力|功能|模块|组件|支持|提供|具备|实现|能够|可以|统一|集中|智能|自动|业务|相关|进行|通过/gu, '')
  const grams = new Set()
  for (const run of body.match(/[\p{Script=Han}]+/gu) || []) {
    const chars = [...run]
    for (let index = 0; index + 1 < chars.length; index++) grams.add(chars[index] + chars[index + 1])
  }
  return grams
}

function unrelatedCapabilities(text, original) {
  const allowed = contentBigrams(original), issues = []
  if (allowed.size < 3) return issues
  for (const claim of claims(text)) {
    const match = /(?:支持|提供|具备|能够|可以|实现)(.+)/u.exec(claim)
    if (!match || /(?:不|未|不能|无法|尚不|暂不)\s*$/u.test(claim.slice(0, match.index))) continue
    const grams = contentBigrams(match[1])
    if (grams.size >= 3 && ![...grams].some(gram => allowed.has(gram))) {
      issues.push('概括新增的能力动作或对象与绑定原文没有明显关联')
    }
  }
  return issues
}

/** Heuristics catch obvious additions/reversals; they do not prove complete semantic equivalence. */
export function validateSummaryText(text, sources) {
  if (typeof text !== 'string' || !text.trim()) return ['概括文本为空']
  const selected = list(sources)
  if (!selected.length) return ['概括文本缺少绑定来源']
  const original = selected.flatMap(sourceTexts).join('\n'), issues = []
  const allowedNumbers = new Set(numbers(original).map(item => item.key))
  for (const item of numbers(text)) if (!allowedNumbers.has(item.key)) issues.push(`概括引入来源未包含的数字：${item.raw}`)
  const allowedNames = new Set(englishGroups(original).flatMap(group => [group.key, ...group.parts]))
  for (const group of englishGroups(text)) if (!allowedNames.has(group.key) && group.parts.some(part => !allowedNames.has(part))) {
    issues.push(`概括引入来源未包含的英文名称：${group.raw}`)
  }
  issues.push(...reversedSafeguards(text, selected), ...unrelatedCapabilities(text, original))
  const pending = selected.some(source => ['planned', 'pilot', 'proposed'].includes(source.capabilityStatus)
    || source.isHypothesis === true || source.supportMode === 'candidate' || source.verification === 'candidate') || PENDING.test(original)
  const existingCompleted = claims(original).filter(clause => COMPLETED.test(clause) && !STATE_QUALIFIER.test(clause))
    .map(clause => clean(clause).replace(/\s/gu, ''))
  if (pending && claims(text).some(clause => COMPLETED.test(clause) && !STATE_QUALIFIER.test(clause)
    && !existingCompleted.some(originalClaim => originalClaim.includes(clean(clause).replace(/\s/gu, ''))))) {
    issues.push('概括将未上线、规划或试点能力提升为已完成或全面可用')
  }
  for (const target of negativeTargets(original)) {
    let position = text.indexOf(target)
    while (position !== -1) {
      const prefix = text.slice(Math.max(0, position - 20), position).split(/[，,。！？；\n]/u).at(-1)
      if (/(?:支持|可以|可|能够|具备|实现|提供)\s*$/u.test(prefix)
        && !/(?:不|未|不能|无法|尚不|暂不)[^，,。！？；\n]{0,12}$/u.test(prefix)) {
        issues.push(`概括反转了原文的否定能力限制：${target}`); break
      }
      position = text.indexOf(target, position + target.length)
    }
  }
  return unique(issues)
}
