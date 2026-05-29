const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const INSTRUCTIONS_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'user-instructions.md')
  : path.join(__dirname, '..', '..', 'docs', 'user-instructions.md');
const BACKUP_PATH = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'user-instructions.md.bak')
  : path.join(__dirname, '..', '..', 'docs', 'user-instructions.md.bak');

function loadInstructions() {
  try {
    if (!fs.existsSync(INSTRUCTIONS_PATH)) return '';
    return fs.readFileSync(INSTRUCTIONS_PATH, 'utf-8');
  } catch (e) {
    logger.warn(`[Instructions] Cannot load: ${e.message}`);
    return '';
  }
}

function updateInstructions({ find, replace, append }) {
  let content = loadInstructions();

  // Backup before modify
  try {
    fs.writeFileSync(BACKUP_PATH, content, 'utf-8');
  } catch (e) {
    logger.warn(`[Instructions] Backup failed: ${e.message}`);
  }

  if (find && replace !== undefined) {
    if (!content.includes(find)) {
      return { ok: false, error: `Text not found: "${find.slice(0, 80)}"` };
    }
    const newContent = content.split(find).join(replace);
    const occurrences = (content.split(find).length - 1);
    content = newContent;
    fs.writeFileSync(INSTRUCTIONS_PATH, content, 'utf-8');
    return { ok: true, operation: 'replace', occurrences, diff: { old: find, new: replace } };
  }

  if (append) {
    const separator = content.endsWith('\n') ? '' : '\n';
    content += separator + append + '\n';
    fs.writeFileSync(INSTRUCTIONS_PATH, content, 'utf-8');
    return { ok: true, operation: 'append', added: append };
  }

  return { ok: false, error: 'No operation specified. Provide find+replace or append.' };
}

function getInstructionsForPrompt() {
  const content = loadInstructions();
  if (!content) return '';
  return `USER PREFERENCES (persistent):\n${content}`;
}

module.exports = { loadInstructions, updateInstructions, getInstructionsForPrompt };
