// Anthropic API list prices, used to show what the usage would have cost if billed per token.
// $ per million tokens: [input, output, cache read]. Cache writes are 1.25x input (5-minute TTL) or 2x input (1-hour TTL).
// Prices as of 2026-11; first match wins, so put more specific patterns first.
const PRICES = [
  [/(fable|mythos)-5-1|^(fable|mythos)$/, [10, 50, 0.25]],
  [/(fable|mythos)-5|mythos-preview/, [10, 50, 1]],
  [/opus-5-5|^opus$/, [4, 20, 0.2]],
  [/opus-(5|4-[5-9])/, [5, 25, 0.5]],
  [/opus-4|3-opus/, [15, 75, 1.5]],
  [/sonnet-5|^sonnet$/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5-5|^haiku$/, [0.1, 0.5, 0.01], [0.5, 2.5, 0.05]], // second tier: prompts over 100k tokens
  [/haiku-4-5/, [1, 5, 0.1]],
  [/3-5-haiku/, [0.8, 4, 0.08]],
  [/haiku/, [0.25, 1.25, 0.03]],
];

const norm = (m) => String(m || '').toLowerCase().replace(/^.*?claude-/, '').replace(/\[.*\]$/, '').replace(/[-@]\d{8}$/, '');

/** Dollar cost of one API response's `usage` block for `model`, or null if the model is unknown. */
export function costOf(model, u) {
  const id = norm(model);
  const row = PRICES.find(([re]) => re.test(id));
  if (!row) return null;
  const tin = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
  const [inP, outP, readP] = row[2] && tin + cr + cw > 100000 ? row[2] : row[1];
  const cw1h = Math.min(cw, u.cache_creation?.ephemeral_1h_input_tokens || 0);
  const usd = (tin * inP + (u.output_tokens || 0) * outP + cr * readP + (cw - cw1h) * inP * 1.25 + cw1h * inP * 2) / 1e6;
  return u.speed === 'fast' ? usd * 2 : usd;
}
