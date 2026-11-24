// Builds the published copy of the site in _site/: HTML (with its inline scripts and styles) and our own
// .js files are minified; data, images and vendored libraries are copied as they are. The readable
// source stays in the repository; .github/workflows/pages.yml runs this and publishes _site/.
// Local run:  npm i --no-save html-minifier-terser@7.2.0 terser@5.31.0 && node tools/build_site.mjs
import {minify as minHtml} from "html-minifier-terser";
import {minify as minJs} from "terser";
import fs from "node:fs/promises";
import path from "node:path";

const SRC = process.cwd(), OUT = path.join(SRC, "_site");
const SKIP = new Set([".git", ".github", "_site", "node_modules", "tools", "supabase"]);
const NOTICE = "© Cruz Roja Colombiana, Seccional Tolima. Todos los derechos reservados.";

async function* walk(dir){
  for (const e of await fs.readdir(dir, {withFileTypes:true})) {
    if (SKIP.has(e.name) || e.name.endsWith(".md")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p); else yield p;
  }
}

await fs.rm(OUT, {recursive:true, force:true});
let n = 0, before = 0, after = 0;
for await (const file of walk(SRC)) {
  const rel = path.relative(SRC, file), dest = path.join(OUT, rel);
  await fs.mkdir(path.dirname(dest), {recursive:true});
  const vendored = rel.startsWith("vendor" + path.sep) || rel.endsWith(".min.js");
  if (rel.endsWith(".html")) {
    const src = await fs.readFile(file, "utf8");
    const out = await minHtml(src, {collapseWhitespace:true, conservativeCollapse:true, removeComments:true,
      minifyCSS:true, minifyJS:{format:{comments:false, preamble:`/* ${NOTICE} */`}}, keepClosingSlash:true});
    await fs.writeFile(dest, out); before += src.length; after += out.length; n++;
  } else if (rel.endsWith(".js") && !vendored) {
    const src = await fs.readFile(file, "utf8");
    const out = (await minJs(src, {compress:true, mangle:true, format:{comments:false, preamble:`/* ${NOTICE} */`}})).code;
    await fs.writeFile(dest, out); before += src.length; after += out.length; n++;
  } else await fs.copyFile(file, dest);
}
console.log(`minified ${n} files: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB`);
