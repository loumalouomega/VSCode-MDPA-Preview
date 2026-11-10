/**
 * Where view templates live on disk (roadmap item 65): JSON files in a `views`
 * folder under each directory `kratos.recipes.extraPaths` names (default
 * `.kratos/recipes`), so the recipe-preset scan, which lists only the files
 * directly in those directories, never reads them as recipes. `node:fs` only;
 * the format and the apply rule are in `src/parser/viewTemplate.ts`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { ViewTemplate, parseViewTemplate, templateFileName } from "./parser/viewTemplate";

export const VIEW_TEMPLATE_SUBDIR = "views";

export interface ViewTemplateProblem {
  file: string;
  message: string;
}

export function viewTemplateDirs(roots: string[], extraPaths: string[]): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    for (const dir of extraPaths) {
      dirs.push(path.join(path.isAbsolute(dir) ? dir : path.join(root, dir), VIEW_TEMPLATE_SUBDIR));
    }
  }
  return dirs;
}

export function discoverViewTemplates(
  roots: string[],
  extraPaths: string[]
): { templates: (ViewTemplate & { file: string })[]; problems: ViewTemplateProblem[] } {
  const templates: (ViewTemplate & { file: string })[] = [];
  const problems: ViewTemplateProblem[] = [];
  for (const dir of viewTemplateDirs(roots, extraPaths)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.toLowerCase().endsWith(".json")) continue;
      const file = path.join(dir, n);
      try {
        const parsed = parseViewTemplate(fs.readFileSync(file, "utf8"));
        if (parsed.template) templates.push({ ...parsed.template, file });
        else problems.push({ file, message: parsed.warnings.join(" ") });
      } catch (e) {
        problems.push({ file, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return { templates, problems };
}

/** Writes `template` into `dir`; refuses to replace a different template unless `overwrite`. */
export function writeViewTemplate(dir: string, template: ViewTemplate, overwrite = false): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, templateFileName(template.name));
  if (!overwrite && fs.existsSync(file)) throw new Error(`A template named "${template.name}" already exists in ${dir}.`);
  fs.writeFileSync(file, JSON.stringify(template, null, 2) + "\n");
  return file;
}
