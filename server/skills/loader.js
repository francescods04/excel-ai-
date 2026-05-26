const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const SKILLS_DIR = path.join(__dirname, '..', '..', 'skills');

/* ---------- Skill cache ---------- */
const skillCache = new Map();
const SKILL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const lines = match[1].split('\n');
  const meta = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      meta[key] = val;
    }
  }
  return { meta, body: match[2].trim() };
}

function listSkills() {
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md'));
    return files.map(f => {
      const content = fs.readFileSync(path.join(SKILLS_DIR, f), 'utf-8');
      const { meta } = parseFrontMatter(content);
      return {
        name: meta.name || f.replace('.md', ''),
        description: meta.description || '',
        size: meta.size || '',
        file: f
      };
    });
  } catch (e) {
    logger.warn(`[Skills] Cannot list skills: ${e.message}`);
    return [];
  }
}

function readSkill(name) {
  if (typeof name !== 'string' || !name.trim()) {
    const available = listSkills().map(s => s.name).join(', ');
    return { error: `read_skill requires a non-empty "name" parameter. Available: ${available}` };
  }
  const cacheKey = name.trim().toLowerCase();
  const cached = skillCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SKILL_CACHE_TTL_MS) {
    return cached.data;
  }

  const skills = listSkills();
  const skill = skills.find(s => s.name.toLowerCase() === cacheKey);
  if (!skill) {
    return { error: `Skill "${name}" not found. Available: ${skills.map(s => s.name).join(', ')}` };
  }

  try {
    const content = fs.readFileSync(path.join(SKILLS_DIR, skill.file), 'utf-8');
    const { meta, body } = parseFrontMatter(content);
    const data = { name: meta.name, description: meta.description, size: meta.size, content: body };
    skillCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  } catch (e) {
    return { error: `Failed to read skill "${name}": ${e.message}` };
  }
}

function getAvailableSkillsForPrompt() {
  const skills = listSkills();
  if (skills.length === 0) return '';
  const lines = skills.map(s => `- ${s.name}: ${s.description} (${s.size})`);
  return '<available_skills>\n' + lines.join('\n') + '\n</available_skills>';
}

function clearSkillCache() {
  skillCache.clear();
}

module.exports = { listSkills, readSkill, getAvailableSkillsForPrompt, clearSkillCache };
