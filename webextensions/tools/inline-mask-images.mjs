/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Chrome fetches CSS mask images in CORS mode, which the
# chrome-extension:// scheme does not satisfy, so masks referencing
# extension files render as nothing. This tool inlines every SVG
# referenced from a mask/mask-image declaration as a data: URI.
# Re-run after changing any masked icon:  node tools/inline-mask-images.mjs
*/
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const cssFiles = [];
function collect(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name != 'node_modules' && entry.name != '.git')
      collect(full);
    else if (entry.name.endsWith('.css'))
      cssFiles.push(full);
  }
}
for (const dir of ['sidebar', 'resources', 'options', 'background'])
  collect(path.join(root, dir));

function toDataUri(svgPath) {
  let svg = fs.readFileSync(svgPath, 'utf8');
  svg = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    // Chrome resolves the Firefox-only context-fill/context-stroke paints
    // to transparent, which makes the whole mask empty. Only the alpha
    // channel matters for masks, so force plain black.
    .replace(/\b(fill|stroke)="context-(?:fill|stroke)"/g, '$1="black"')
    .replace(/\b(fill|stroke)-opacity="context-(?:fill|stroke)-opacity"/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const encoded = encodeURIComponent(svg)
    .replace(/%20/g, ' ') // keep it somewhat readable; spaces are valid in quoted url()
    .replace(/%3D/g, '=')
    .replace(/%3A/g, ':')
    .replace(/%2F/g, '/');
  return `data:image/svg+xml,${encoded}`;
}

let totalReplaced = 0;
for (const cssFile of cssFiles) {
  const original = fs.readFileSync(cssFile, 'utf8');
  let replacedInFile = 0;
  const updated = original.split('\n').map(line => {
    if (!/(?:^|[^a-z-])(?:-webkit-)?mask(?:-image)?\s*:/.test(line))
      return line;
    return line.replace(/url\(\s*(["']?)([^"')]+\.svg)\1\s*\)/g, (whole, _quote, ref) => {
      if (ref.startsWith('data:'))
        return whole;
      const resolved = ref.startsWith('/') ?
        path.join(root, ref) :
        path.resolve(path.dirname(cssFile), ref);
      if (!fs.existsSync(resolved)) {
        console.warn(`MISSING: ${ref} referenced from ${cssFile}`);
        return whole;
      }
      replacedInFile++;
      return `url("${toDataUri(resolved)}")`;
    });
  }).join('\n');
  if (replacedInFile > 0) {
    fs.writeFileSync(cssFile, updated);
    console.log(`${path.relative(root, cssFile)}: ${replacedInFile} mask image(s) inlined`);
    totalReplaced += replacedInFile;
  }
}
console.log(`total: ${totalReplaced}`);
