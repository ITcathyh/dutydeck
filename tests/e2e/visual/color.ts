/**
 * 颜色断言的度量层。
 *
 * 视觉 e2e 唯一允许的输入是 `getComputedStyle` 返回的**真实渲染值**，不是源码里的
 * 类名字符串。类名对了但 CSS 没生效（token 没定义、被更高优先级覆盖、Tailwind 没
 * 生成那条规则）在类名断言里是绿的，在这里是红的——这正是要抓的那一类。
 *
 * 浏览器把 computed color 一律序列化成 `rgb(r, g, b)` 或 `rgba(r, g, b, a)`，
 * 所以只需要解析这两种形式；`color(srgb ...)` 只在作者显式写 color() 时出现，
 * 本项目 token 全是 hex/rgba，不会命中。
 */

export type Rgb = { r: number; g: number; b: number; a: number };
export type Hsl = { h: number; s: number; l: number };

/** 解析 computed style 的颜色串。透明（alpha 0）会原样返回，由调用方决定是否算失败。 */
export function parseRgb(value: string): Rgb {
  const nums = value.match(/[\d.]+/g);
  if (!nums || nums.length < 3) throw new Error(`无法解析颜色：${value}`);
  const [r, g, b, a] = nums.map(Number) as [number, number, number, number?];
  return { r, g, b, a: a ?? 1 };
}

/**
 * HSL 里的 H 是「这个颜色偏哪个方向」的唯一标量，也是「墨绿 vs 靛蓝」唯一能一句话
 * 说清的判据：teal #0f766e → H≈176，indigo #6366f1 → H≈239。用 RGB 三元组断言得
 * 写一堆区间，用 H 只需要一段。
 */
export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  const l = (max + min) / 2;
  if (delta === 0) return { h: 0, s: 0, l: l * 100 };
  const s = delta / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0));
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}

export const hslOf = (value: string): Hsl => rgbToHsl(parseRgb(value));

/** 色相是圆环，230–250 这类区间不跨 0，但保留通用实现以免以后断言红色（350–10）时踩坑。 */
export function hueWithin(hue: number, from: number, to: number): boolean {
  const h = ((hue % 360) + 360) % 360;
  return from <= to ? h >= from && h <= to : h >= from || h <= to;
}

/**
 * 灰阶「不带绿」的判据。
 *
 * dockmux 现在的中性色是 `#f5f7f6` / `#17201f` 这一族——G 通道恒比 B 高 1–2，
 * 于是整屏灰阶朝黄绿偏，肉眼读作「脏」。冷灰（botmux 的 `#0d1117`：G=17 < B=23）
 * 反过来 B ≥ G。所以判据就是 **B ≥ G**。
 *
 * 容差默认 0，不是疏忽：`--surface-canvas: #f5f7f6` 的 G-B 恰好等于 1，留 1 的
 * 容差会把要抓的那个缺陷整个放过去（实测：tolerance=1 时这条断言全绿）。这些值
 * 是从 token 直接解析出来的不透明色，没有抗锯齿或半透明合成的舍入需要吸收，
 * 所以严格判 B ≥ G。真中性灰（G == B）仍然通过。
 *
 * 只对低饱和度的中性色成立；品牌色、状态色本来就该有自己的色相，不适用。
 */
export function isNeutralNotGreenish(value: string, tolerance = 0): boolean {
  const { g, b } = parseRgb(value);
  return b >= g - tolerance;
}

/** 断言失败时把 rgb 与 hsl 一起打出来，省得再回浏览器手查。 */
export const describeColor = (value: string): string => {
  const { h, s, l } = hslOf(value);
  return `${value} (H=${h.toFixed(0)} S=${s.toFixed(0)}% L=${l.toFixed(0)}%)`;
};

/** 相对亮度 → 对比度，用于「浅色主题下侧栏必须是浅底」这类判据。 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const chan = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export const luminanceOf = (value: string): number => relativeLuminance(parseRgb(value));
