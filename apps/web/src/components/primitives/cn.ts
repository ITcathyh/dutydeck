/** className 拼接。undefined / false / '' 一律丢弃，避免拼出多余空格影响测试里的字符串断言。 */
export const cn = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');
