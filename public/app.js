const UI = {
  en: {
    skip: "Skip to the form text",
    clinic: "Sample Equine Clinic",
    heading: "Listen to your consent form",
    lede: "Pick a form and a language, then press Listen. You can follow along with the text below.",
    formLabel: "Consent form",
    langLabel: "Language",
    listen: "Listen",
    loading: "Preparing audio…",
    generating: "Generating audio for this version. This can take a few seconds the first time.",
    cached: "cached",
    generated: "generated",
    cachedNote: "Played from the saved recording of this version.",
    generatedNote: "Freshly generated and saved for the next person.",
    version: "Version",
    error: "Sorry, the audio could not be loaded.",
    footer: "Fictional sample forms for demonstration. Audio generated with ElevenLabs.",
  },
  de: {
    skip: "Zum Formulartext springen",
    clinic: "Beispiel-Pferdeklinik",
    heading: "Einverständniserklärung anhören",
    lede: "Wählen Sie ein Formular und eine Sprache und tippen Sie auf Anhören. Den Text können Sie unten mitlesen.",
    formLabel: "Formular",
    langLabel: "Sprache",
    listen: "Anhören",
    loading: "Audio wird vorbereitet…",
    generating: "Audio für diese Version wird erstellt. Beim ersten Mal kann das einige Sekunden dauern.",
    cached: "gespeichert",
    generated: "neu erstellt",
    cachedNote: "Aus der gespeicherten Aufnahme dieser Version abgespielt.",
    generatedNote: "Neu erstellt und für die nächste Person gespeichert.",
    version: "Version",
    error: "Das Audio konnte leider nicht geladen werden.",
    footer: "Fiktive Musterformulare zur Demonstration. Audio erstellt mit ElevenLabs.",
  },
};

const $ = (id) => document.getElementById(id);
const els = {
  select: $("form-select"),
  listen: $("listen"),
  audio: $("audio"),
  status: $("status"),
  title: $("consent-title"),
  version: $("consent-version"),
  body: $("consent-body"),
  article: $("consent"),
};

const state = { forms: [], lang: "en", formId: null, objectUrl: null, request: 0 };

function t(key) {
  return UI[state.lang][key] ?? UI.en[key];
}

function setStatus(text, { badge, error = false } = {}) {
  els.status.classList.toggle("error", error);
  els.status.replaceChildren();
  if (badge) {
    const span = document.createElement("span");
    span.className = "badge";
    span.textContent = badge;
    els.status.append(span);
  }
  els.status.append(document.createTextNode(text));
}

function applyUiLanguage() {
  document.documentElement.lang = state.lang;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const option of els.select.options) {
    const form = state.forms.find((f) => f.id === option.value);
    if (form) option.textContent = form.title[state.lang] ?? form.title.en ?? form.id;
  }
}

function renderBody(body) {
  const nodes = body.split(/\n{2,}|\n(?=## )/).flatMap((block, index) => {
    const out = [];
    for (const raw of block.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const el = document.createElement(line.startsWith("## ") ? "h3" : "p");
      el.textContent = line.replace(/^##\s+/, "");
      if (index === 0 && el.tagName === "P") el.className = "note";
      out.push(el);
    }
    return out;
  });
  els.body.replaceChildren(...nodes);
}

function resetAudio() {
  els.audio.pause();
  els.audio.hidden = true;
  els.audio.removeAttribute("src");
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = null;
}

async function loadForm() {
  const request = ++state.request;
  // Until the new form is on screen, Listen would play audio that does not match the text.
  els.listen.disabled = true;
  els.article.setAttribute("aria-busy", "true");
  resetAudio();
  setStatus("");
  try {
    const res = await fetch(`/api/forms/${encodeURIComponent(state.formId)}?lang=${state.lang}`);
    if (!res.ok) throw new Error(res.statusText);
    const form = await res.json();
    if (request !== state.request) return;
    els.article.lang = form.language;
    els.title.textContent = form.title;
    els.version.textContent = `${t("version")} ${form.version}`;
    renderBody(form.body);
    els.listen.disabled = false;
  } catch {
    if (request === state.request) setStatus(t("error"), { error: true });
  } finally {
    if (request === state.request) els.article.removeAttribute("aria-busy");
  }
}

async function listen() {
  const request = state.request;
  els.listen.disabled = true;
  els.listen.setAttribute("aria-busy", "true");
  setStatus(t("loading"));
  const slow = setTimeout(() => setStatus(t("generating")), 700);
  try {
    const res = await fetch(`/api/forms/${encodeURIComponent(state.formId)}/audio?lang=${state.lang}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.error?.message ?? res.statusText);
    }
    const hit = res.headers.get("X-Cache") === "HIT";
    const blob = await res.blob();
    if (request !== state.request) return; // user switched form or language meanwhile
    resetAudio();
    state.objectUrl = URL.createObjectURL(blob);
    els.audio.src = state.objectUrl;
    els.audio.hidden = false;
    setStatus(hit ? t("cachedNote") : t("generatedNote"), { badge: hit ? t("cached") : t("generated") });
    await els.audio.play().catch(() => {}); // autoplay may be blocked; controls are visible
  } catch (error) {
    if (request === state.request) setStatus(`${t("error")} ${error.message}`, { error: true });
  } finally {
    clearTimeout(slow);
    els.listen.removeAttribute("aria-busy");
    if (request === state.request) els.listen.disabled = false;
  }
}

async function init() {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "de" || saved === "en") state.lang = saved;
  } catch {}
  $(`lang-${state.lang}`).checked = true;

  const res = await fetch("/api/forms");
  const { forms } = await res.json();
  state.forms = forms;
  els.select.replaceChildren(
    ...forms.map((form) => {
      const option = document.createElement("option");
      option.value = form.id;
      return option;
    }),
  );
  state.formId = forms[0]?.id ?? null;
  els.select.disabled = forms.length === 0;
  applyUiLanguage();
  if (state.formId) await loadForm();

  els.select.addEventListener("change", () => {
    state.formId = els.select.value;
    loadForm();
  });
  for (const radio of document.querySelectorAll('input[name="lang"]')) {
    radio.addEventListener("change", () => {
      state.lang = radio.value;
      try {
        localStorage.setItem("lang", state.lang);
      } catch {}
      applyUiLanguage();
      loadForm();
    });
  }
  els.listen.addEventListener("click", listen);
}

init().catch(() => setStatus(UI.en.error, { error: true }));
