/**
 * JSON recovery for streamed LLM tool calls.
 * ===========================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The agent loop asks the model to reply with a single JSON object of the
 * shape `{ "thought", "tool", "params" }`. When responses are STREAMED token
 * by token and the model hits its output-token cap (or simply loses emission
 * coherence on a large `bulk_set_cell_ranges` payload), the raw text comes back
 * malformed: truncated mid-string, missing commas between array elements, or
 * with stray closing brackets appended. A naive `JSON.parse` throws and the
 * whole iteration is wasted on a re-prompt round-trip.
 *
 * These helpers attempt a CHEAP, deterministic, in-process repair before we
 * fall back to burning another LLM call. They are intentionally conservative:
 * every repair path only returns a value if the result both parses AND looks
 * like an agent tool call (`tool` string present, or a `params` object). If a
 * repair would produce something unrecognizable, it returns `null` so the
 * caller treats the response as a genuine parse failure.
 *
 * FAILURE MODES OBSERVED IN PRODUCTION (and which function handles each)
 * ---------------------------------------------------------------------
 *   1. Raw control chars inside string literals ("Bad control character in
 *      string literal") — Vairano 2026-06-02 iter 3.   → escapeControlCharsInStrings
 *   2. Truncated mid-object / mid-string (output cap)   → tryRecoverTruncatedAgentJson
 *   3. Excess trailing/middle closers "...}}}}}]}}"      → tryRecoverExcessClosers
 *      (DCF E2E iter 7: one extra `}` before the `]`).
 *   4. Missing commas "{...} {...}" inside arrays        → tryRecoverMissingCommas
 *
 * ENTRY POINT
 * -----------
 * Callers should use `tryRecoverTruncatedAgentJson(raw)`; it orchestrates the
 * other strategies internally. The others are exported for unit testing and
 * for advanced callers, but are not normally invoked directly.
 *
 * PURITY
 * ------
 * Every function here is pure (no I/O, no module state). This keeps them
 * trivially unit-testable and safe to call on a hot path.
 */

'use strict';

/**
 * Escape raw control characters (newline, tab, etc.) that appear UNescaped
 * inside JSON string literals. Streaming models sometimes emit a literal `\n`
 * byte inside a string instead of the two-character `\\n` escape, which is
 * invalid JSON. We walk the text tracking string/escape state and rewrite only
 * the bytes that sit inside a string literal — structural whitespace between
 * tokens is left untouched.
 *
 * @param {string} s - raw (possibly invalid) JSON text
 * @returns {string} text with in-string control chars escaped; safe to re-parse
 */
function escapeControlCharsInStrings(s) {
  let out = '';
  let inStr = false, escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) { out += c; escape = false; continue; }
      if (c === '\\') { out += c; escape = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else if (c === '\b') out += '\\b';
        else if (c === '\f') out += '\\f';
        else out += '\\u' + code.toString(16).padStart(4, '0');
        continue;
      }
      out += c;
    } else {
      if (c === '"') { out += c; inStr = true; continue; }
      out += c;
    }
  }
  return out;
}

/**
 * Top-level recovery for a streamed agent tool-call payload.
 *
 * Strategy (in order, cheapest first):
 *   1. If raw control chars are present, escape them and try a parse.
 *   2. Scan brackets/quotes to find the open/close balance:
 *      - balanced + excess closers → {@link tryRecoverExcessClosers}
 *      - balanced, no excess       → {@link tryRecoverMissingCommas}
 *      - unbalanced (truncated)    → synthesize the missing closing tokens
 *        (and a closing quote if truncation landed inside a string) and parse.
 *
 * Returns the parsed object ONLY if it looks like an agent tool call
 * (`typeof tool === 'string'` or a `params` field). Otherwise returns null so
 * the caller falls back to the normal parse-failure path.
 *
 * @param {string} raw - raw streamed text
 * @returns {object|null} recovered tool-call object, or null if unrecoverable
 */
function tryRecoverTruncatedAgentJson(raw) {
  if (typeof raw !== 'string' || raw.length < 10) return null;
  let trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return null;
  // First fast path: escape any raw control chars inside string literals. This
  // is cheap, idempotent, and clears the most common streaming bug ("Bad
  // control character in string literal"). If the repaired string parses,
  // return immediately.
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(trimmed) || /\n|\r|\t/.test(trimmed)) {
    const escaped = escapeControlCharsInStrings(trimmed);
    if (escaped !== trimmed) {
      try {
        const parsed = JSON.parse(escaped);
        if (parsed && typeof parsed === 'object'
          && (typeof parsed.tool === 'string' || parsed.params)) return parsed;
      } catch (_) { trimmed = escaped; /* keep going with escaped form */ }
    }
  }
  const stack = [];
  let inString = false;
  let escape = false;
  // Track excess closers: when we pop with empty stack, the closer is unmatched.
  // LLM streaming occasionally appends trailing }] beyond the actual JSON object
  // (observed on DCF E2E iter 7: "...0.0\"}}}}}]}}" with one extra `}`).
  let excessClosers = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      if (stack.length === 0) excessClosers++;
      else stack.pop();
    }
  }
  if (stack.length === 0) {
    if (excessClosers > 0) {
      // Strip trailing closers greedily until parse succeeds.
      const recovered = tryRecoverExcessClosers(trimmed, excessClosers);
      if (recovered) return recovered;
    }
    // Brackets balanced but JSON.parse still failed → likely a missing-comma
    // syntax error inside the body. Try to repair adjacent }{ / ]{ / ]" etc.
    return tryRecoverMissingCommas(trimmed);
  }
  // Build the suffix to close. Walk the stack from outermost to innermost
  // and emit the matching closers in reverse. If the LAST open was a string
  // (i.e. the truncation happened inside a string literal), also emit a
  // closing quote so the trailing key/value stays valid.
  const openAtEnd = stack[stack.length - 1];
  let suffix = '';
  if (openAtEnd === '"' || (inString && stack.length > 0)) {
    suffix = '"';
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    suffix += stack[i] === '{' ? '}' : ']';
  }
  const candidate = trimmed + suffix;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object') return null;
    // Recognise the agent tool-call shape. If neither tool nor params is
    // present it's not actionable, so fall back to the normal parse-fail path.
    if (typeof parsed.tool !== 'string' && !parsed.params) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Strip excess `}` / `]` characters that have no matching opener. The extras
 * can sit at the tail OR in the middle of the JSON — observed on DCF E2E
 * iter 7: "...0.0\"}}}}}]}}" had one extra `}` BEFORE the `]`, leaving the
 * trailing 6 closers themselves balanced. Strategy:
 *   1) try trailing strip (cheap, handles append-extras)
 *   2) if parse still fails, use the error position to locate the offending
 *      closer and surgically remove it; retry up to `maxStrip` rounds.
 *
 * @param {string} raw - raw text with unmatched closers
 * @param {number} maxStrip - upper bound on repair attempts (clamped to 16)
 * @returns {object|null} recovered tool-call object, or null
 */
function tryRecoverExcessClosers(raw, maxStrip) {
  const cap = Math.min(maxStrip || 0, 16);
  // Strategy 1 — strip trailing closers/whitespace.
  let candidate = raw;
  for (let strips = 0; strips < cap; strips++) {
    const tailMatch = candidate.match(/[\s\}\]]+$/);
    if (!tailMatch) break;
    candidate = candidate.slice(0, candidate.length - 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object'
        && (typeof parsed.tool === 'string' || parsed.params)) {
        return parsed;
      }
    } catch { /* keep stripping */ }
  }
  // Strategy 2 — surgical removal at the parse-error position.
  candidate = raw;
  for (let strips = 0; strips < cap; strips++) {
    let pos = null;
    try {
      JSON.parse(candidate);
      // Already parses (shouldn't happen since caller saw a failure, but safe).
      break;
    } catch (e) {
      const m = String(e.message).match(/at position (\d+)/);
      if (!m) break;
      pos = Number(m[1]);
    }
    if (pos == null || pos >= candidate.length) break;
    const ch = candidate[pos];
    if (ch !== '}' && ch !== ']') break;
    // Drop the offending closer and retry parse.
    candidate = candidate.slice(0, pos) + candidate.slice(pos + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object'
        && (typeof parsed.tool === 'string' || parsed.params)) {
        return parsed;
      }
    } catch { /* keep cycling */ }
  }
  return null;
}

/**
 * Inject missing commas. LLMs occasionally emit "{...} {...}" or "...] [..."
 * inside arrays, dropping the comma. We add a comma between any
 * close-bracket/brace/quote followed (modulo whitespace) by an opening
 * brace/bracket/quote. Work inside string literals is skipped. Cheap,
 * idempotent, and safe to attempt as a last-resort repair before giving up.
 *
 * @param {string} raw - raw text with possible missing commas
 * @returns {object|null} recovered tool-call object, or null
 */
function tryRecoverMissingCommas(raw) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    out += ch;
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    let justClosedString = false;
    if (ch === '"') {
      if (inString) justClosedString = true;
      inString = !inString;
    }
    if (inString) continue;
    if (ch === '}' || ch === ']' || justClosedString) {
      let j = i + 1;
      while (j < raw.length && (raw[j] === ' ' || raw[j] === '\n' || raw[j] === '\r' || raw[j] === '\t')) j++;
      if (j < raw.length && (raw[j] === '{' || raw[j] === '[' || raw[j] === '"')) {
        out += ',';
      }
    }
  }
  try {
    const parsed = JSON.parse(out);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.tool !== 'string' && !parsed.params) return null;
    return parsed;
  } catch {
    return null;
  }
}

module.exports = {
  escapeControlCharsInStrings,
  tryRecoverTruncatedAgentJson,
  tryRecoverExcessClosers,
  tryRecoverMissingCommas
};
