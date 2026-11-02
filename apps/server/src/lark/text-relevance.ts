/**
 * 查询词与文本的相关度：英文 / 数字按整词、中文按整段加二字切分，
 * 文本（小写后）每包含一个词就加上该词的长度。0 表示一个词都没命中。
 */
export function relevance(query: string) {
  const words = query.toLowerCase().match(/[a-z0-9_]+|[\p{Script=Han}]+/gu) ?? [];
  const terms = [...new Set(words.flatMap(word => /\p{Script=Han}/u.test(word)
    ? [word, ...Array.from({ length: Math.max(0, word.length - 1) }, (_, i) => word.slice(i, i + 2))]
    : [word]))];
  return (text: string) => {
    if (!terms.length) return 0;
    const lowerText = text.toLowerCase();
    return terms.reduce((score, term) => score + (lowerText.includes(term) ? term.length : 0), 0);
  };
}
