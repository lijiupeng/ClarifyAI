/**
 * 验收标准的展示形态。
 *
 * 数据层仍然保留 `WHEN … THEN …`：它逼 AI 把「前置条件 / 可观测结果」写完整，
 * 也是软校验的判断依据。但这句话是给机器看的，不该原样糊到画布和规格文档里。
 * 展示层统一转成 `条件 → 结果`，读起来是句子而不是模板。
 */
export function naturalizeCriterion(raw: string): string {
  const text = raw.trim();
  if (!text) return '';

  const matched = /^when\s+([\s\S]+?)\s+then\s+([\s\S]+)$/i.exec(text);
  if (matched) return `${matched[1]!.trim()} → ${matched[2]!.trim()}`;

  // 不是标准句式时也不硬塞模板词，只把关键词换成中性符号
  return text
    .replace(/\bWHEN\b/gi, '')
    .replace(/\bTHEN\b/gi, '→')
    .replace(/\s+/g, ' ')
    .trim();
}
