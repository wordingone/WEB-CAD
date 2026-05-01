/**
 * Numeric + NL formatting helpers shared across synth subcategories.
 */

export function num(n: number): string {
  // Strip trailing zeros: 5.000 -> "5"; preserve up to 4 decimal places.
  const rounded = Math.round(n * 1e4) / 1e4;
  return rounded.toString();
}

/**
 * Render a length value into one of several NL forms. Used to vary prompts
 * without changing the underlying parameter.
 */
export function lenForm(n: number, rng: { float: (a: number, b: number) => number; int: (a: number, b: number) => number }): string {
  const variants = [
    `${num(n)}m`,
    `${num(n)} meters`,
    `${num(n)} m`,
  ];
  return variants[rng.int(0, variants.length - 1)];
}

/**
 * Pick one of N templates uniformly via the rng.
 */
export function pickTemplate(templates: readonly string[], rng: { int: (a: number, b: number) => number }): string {
  return templates[rng.int(0, templates.length - 1)];
}

/**
 * Substitute {key} placeholders in a template with values from a dict.
 */
export function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`fill: missing var '${k}' for template "${template}"`);
    return String(vars[k]);
  });
}
