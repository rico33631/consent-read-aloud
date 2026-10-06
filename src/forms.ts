import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isLanguage, type Language } from "./config.js";

export interface ConsentForm {
  id: string;
  version: string;
  language: Language;
  title: string;
  /** Paragraphs separated by blank lines. Lines starting with "## " are section headings. */
  body: string;
}

export interface FormSummary {
  id: string;
  title: Partial<Record<Language, string>>;
  versions: Partial<Record<Language, string>>;
  languages: Language[];
}

function assertForm(value: unknown, file: string): asserts value is ConsentForm {
  const v = value as Record<string, unknown> | null;
  const ok =
    v !== null &&
    typeof v === "object" &&
    typeof v.id === "string" &&
    typeof v.version === "string" &&
    isLanguage(v.language) &&
    typeof v.title === "string" &&
    typeof v.body === "string";
  if (!ok) throw new Error(`Invalid consent form in ${file}`);
}

export class FormStore {
  private constructor(private readonly forms: ConsentForm[]) {}

  static async load(dir: string): Promise<FormStore> {
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    const forms: ConsentForm[] = [];
    for (const file of files) {
      const parsed: unknown = JSON.parse(await readFile(path.join(dir, file), "utf8"));
      assertForm(parsed, file);
      forms.push(parsed);
    }
    return new FormStore(forms);
  }

  list(): FormSummary[] {
    const byId = new Map<string, FormSummary>();
    for (const form of this.forms) {
      const summary = byId.get(form.id) ?? { id: form.id, title: {}, versions: {}, languages: [] };
      summary.title[form.language] = form.title;
      summary.versions[form.language] = form.version;
      summary.languages.push(form.language);
      byId.set(form.id, summary);
    }
    return [...byId.values()];
  }

  get(id: string, language: Language): ConsentForm | undefined {
    return this.forms.find((f) => f.id === id && f.language === language);
  }
}

/** The text that is actually spoken: title, then body with heading markers removed. */
export function toSpeechText(form: ConsentForm): string {
  const body = form.body
    .split("\n")
    .map((line) => line.replace(/^##\s+/, ""))
    .join("\n");
  return `${form.title}.\n\n${body}`.trim();
}
