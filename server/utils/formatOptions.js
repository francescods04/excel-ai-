'use strict';

const COLOR_KEYS = new Set([
  'backgroundColor',
  'fontColor',
  'borderBottomColor',
  'borderTopColor',
  'fillColor'
]);

const NAMED_COLORS = Object.freeze({
  black: '#000000',
  blue: '#0000FF',
  green: '#008000',
  grey: '#808080',
  gray: '#808080',
  orange: '#FFA500',
  purple: '#800080',
  red: '#FF0000',
  white: '#FFFFFF',
  yellow: '#FFFF00'
});

const H_ALIGN = Object.freeze({
  left: 'Left',
  center: 'Center',
  centre: 'Center',
  middle: 'Center',
  right: 'Right'
});

const V_ALIGN = Object.freeze({
  top: 'Top',
  center: 'Center',
  centre: 'Center',
  middle: 'Center',
  bottom: 'Bottom'
});

function normalizeHexColor(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const named = NAMED_COLORS[raw.toLowerCase()];
  if (named) return named;
  const shortHex = raw.match(/^#?([0-9a-f]{3})$/i);
  if (shortHex) {
    return `#${shortHex[1].split('').map(ch => ch + ch).join('').toUpperCase()}`;
  }
  const longHex = raw.match(/^#?([0-9a-f]{6})$/i);
  if (longHex) return `#${longHex[1].toUpperCase()}`;
  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
  if (rgb) {
    const parts = rgb.slice(1, 4).map(Number);
    if (parts.every(n => Number.isFinite(n) && n >= 0 && n <= 255)) {
      return `#${parts.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
    }
  }
  return null;
}

function normalizeAlignment(value, map) {
  if (value == null) return null;
  const normalized = map[String(value).trim().toLowerCase()];
  return normalized || null;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function booleanValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return Boolean(value);
}

// Excel.js border style aliases: users (and the LLM) often pass bare strings
// like "thin", "Thin", "hairline", "medium", "thick" or "double" expecting them
// to map to the right line style. We accept these and convert to {style} so a
// `borders: {top: 'thin'}` payload doesn't get silently dropped.
const BORDER_STYLE_ALIASES = Object.freeze({
  thin: 'continuous',
  hair: 'continuous',
  hairline: 'continuous',
  medium: 'medium',
  thick: 'thick',
  double: 'double',
  dashed: 'dash',
  dash: 'dash',
  dotted: 'dot',
  dot: 'dot',
  none: 'none',
  continuous: 'continuous',
  solid: 'continuous'
});

function normalizeBorderSpec(value, dropped, path) {
  if (value == null) return null;
  // Shorthand string: "thin" / "Thin" / "medium" / "double" / "none"
  if (typeof value === 'string') {
    const key = value.trim().toLowerCase();
    if (key === '') return null;
    if (key in BORDER_STYLE_ALIASES) return { style: BORDER_STYLE_ALIASES[key] };
    // Unrecognised but non-empty string: pass through so the writer can try
    // (writer accepts arbitrary Excel.BorderLineStyle values).
    return { style: value };
  }
  if (typeof value !== 'object') return null;
  const out = {};
  if (value.style != null) {
    const s = String(value.style).trim().toLowerCase();
    out.style = s in BORDER_STYLE_ALIASES ? BORDER_STYLE_ALIASES[s] : value.style;
  }
  if (value.weight) out.weight = value.weight;
  if (value.color) {
    const color = normalizeHexColor(value.color);
    if (color) out.color = color;
    else dropped.push(`${path}.color`);
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeFormatOptions(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const input = { ...source };
  const dropped = [];

  if (input.bgColor && !input.backgroundColor) input.backgroundColor = input.bgColor;
  if (input.bg_color && !input.backgroundColor) input.backgroundColor = input.bg_color;
  if (input.fillColor && !input.backgroundColor) input.backgroundColor = input.fillColor;
  if (input.textColor && !input.fontColor) input.fontColor = input.textColor;
  if (input.font_color && !input.fontColor) input.fontColor = input.font_color;
  if (input.color && !input.fontColor) input.fontColor = input.color;
  if (input.align && !input.horizontalAlignment) input.horizontalAlignment = input.align;
  if (input.alignment && !input.horizontalAlignment) input.horizontalAlignment = input.alignment;
  if (input.verticalAlign && !input.verticalAlignment) input.verticalAlignment = input.verticalAlign;
  if (input.vertical_align && !input.verticalAlignment) input.verticalAlignment = input.vertical_align;
  if (input.borderStyles && !input.borders) input.borders = input.borderStyles;
  if (input.wrap && input.wrapText === undefined) input.wrapText = input.wrap;

  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (key === 'style_preset' || key === 'preset') continue;
    if (COLOR_KEYS.has(key)) {
      const targetKey = key === 'fillColor' ? 'backgroundColor' : key;
      const color = normalizeHexColor(value);
      if (color) out[targetKey] = color;
      else dropped.push(key);
      continue;
    }
    if (key === 'horizontalAlignment') {
      const alignment = normalizeAlignment(value, H_ALIGN);
      if (alignment) out.horizontalAlignment = alignment;
      else dropped.push(key);
      continue;
    }
    if (key === 'verticalAlignment') {
      const alignment = normalizeAlignment(value, V_ALIGN);
      if (alignment) out.verticalAlignment = alignment;
      else dropped.push(key);
      continue;
    }
    if (key === 'fontSize' || key === 'columnWidth' || key === 'rowHeight') {
      const n = finiteNumber(value);
      if (n != null) out[key] = n;
      else dropped.push(key);
      continue;
    }
    if (key === 'bold' || key === 'italic' || key === 'wrapText') {
      out[key] = booleanValue(value);
      continue;
    }
    if (key === 'fontName' || key === 'numberFormat') {
      const text = String(value).trim();
      if (text) out[key] = text;
      else dropped.push(key);
      continue;
    }
    if (key === 'borders' && value && typeof value === 'object') {
      const borders = {};
      for (const [edge, spec] of Object.entries(value)) {
        const normalized = normalizeBorderSpec(spec, dropped, `borders.${edge}`);
        if (normalized) borders[edge] = normalized;
      }
      if (Object.keys(borders).length > 0) out.borders = borders;
      continue;
    }
  }

  return { options: out, dropped };
}

module.exports = {
  normalizeFormatOptions,
  normalizeHexColor
};
