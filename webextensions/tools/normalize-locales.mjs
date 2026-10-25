#!/usr/bin/env node
// Makes upstream's _locales/*/messages.json acceptable to Chrome:
//  - message names may contain only [a-zA-Z0-9_@], so other characters
//    (upstream uses "-" in some names) become "_"; code referring to such a
//    name must use the renamed one;
//  - every $NAME$ used in a message must be declared in its placeholders
//    (Firefox tolerates undeclared ones): the declaration is taken from the
//    same message in "en" if it has one, otherwise $1, $2, ... in order of
//    appearance;
//  - files are re-serialized with JSON.stringify(), 2-space indent.
// Idempotent. Run after taking upstream's locale files:
//   node tools/normalize-locales.mjs [path/to/_locales]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const localesDir = process.argv[2] ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '_locales');

function normalizeName(name) {
  return name.replace(/[^a-zA-Z0-9_@]/g, '_');
}

function readMessages(locale) {
  const file = path.join(localesDir, locale, 'messages.json');
  const messages = {};
  for (const [name, value] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
    messages[normalizeName(name)] = value;
  }
  return { file, messages };
}

function declarePlaceholders(name, value, referenceMessages) {
  if (typeof value?.message != 'string')
    return value;
  const used = [...new Set(Array.from(value.message.matchAll(/\$([a-zA-Z0-9_@]+)\$/g), match => match[1]))];
  const declared = new Set(Object.keys(value.placeholders || {}).map(key => key.toLowerCase()));
  const missing = used.filter(placeholder => !declared.has(placeholder.toLowerCase()));
  if (missing.length == 0)
    return value;
  const reference = referenceMessages?.[name]?.placeholders || {};
  const placeholders = { ...(value.placeholders || {}) };
  for (const placeholder of missing) {
    const referenceKey = Object.keys(reference).find(key => key.toLowerCase() == placeholder.toLowerCase());
    placeholders[placeholder] = referenceKey ?
      reference[referenceKey] :
      { content: `$${used.indexOf(placeholder) + 1}` };
  }
  return { ...value, placeholders };
}

const locales = fs.readdirSync(localesDir).filter(entry =>
  fs.existsSync(path.join(localesDir, entry, 'messages.json')));
const reference = locales.includes('en') ? readMessages('en').messages : null;

for (const locale of locales) {
  const { file, messages } = readMessages(locale);
  const normalized = {};
  for (const [name, value] of Object.entries(messages)) {
    normalized[name] = declarePlaceholders(name, value, reference);
  }
  const output = `${JSON.stringify(normalized, null, 2)}\n`;
  if (output != fs.readFileSync(file, 'utf8')) {
    fs.writeFileSync(file, output);
    console.log(`normalized ${path.relative(process.cwd(), file)}`);
  }
}
