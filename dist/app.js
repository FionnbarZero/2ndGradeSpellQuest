import {
  LEVEL_NAMES,
  LESSONS,
  WORD_DETAILS,
  buildCodexReportUrl,
  buildProblemPrompt,
  buildTeachingSequence,
  createDayStages,
  createThursdayReteachStages,
  formatSpellSparks,
  isCorrectSpelling,
  matchSpokenSpelling,
  normalizeSpelling,
  selectPreferredVoice,
  sentenceFeedback,
  shuffledLetters,
  spellingPrompt,
} from "./engine.js";
import { CURRENT_WEEK } from "./curriculum.js";

const HISTORY_KEY = "spellquest-history-v2";
const SOUND_KEY = "spellcraft-sound-v1";
const VOICE_KEY = "spellquest-voice-v1";
const RATE_KEY = "spellquest-speech-rate-v1";
const CHECKPOINT_KEY = "spellquest-session-v1";
const storageStatus = document.querySelector("#storage-status");
const storageWarnings = new Set();
let memoryHistory = [];
let damagedHistory = null;
let historyUnavailable = false;
let checkpoint = null;
let checkpointRejected = false;
let temporarySaveAvailable = true;
const app = document.querySelector("#app");
const homeButton = document.querySelector("#home-button");
const soundButton = document.querySelector("#sound-button");
const reportButton = document.querySelector("#report-problem-button");
const problemDialog = document.querySelector("#problem-dialog");
const problemForm = document.querySelector("#problem-form");
const problemDetails = document.querySelector("#problem-details");
const reportStatus = document.querySelector("#report-status");

let session = null;
let activeTimer = null;
let recognition = null;
let muted = readStorage("local", SOUND_KEY) === "muted";
let preferredVoice = null;
let selectedVoice = readStorage("local", VOICE_KEY) || "";
let speechRate = Number(readStorage("local", RATE_KEY));
if (![0.85, 1, 1.1].includes(speechRate)) speechRate = 1;
let magicAudioContext = null;
const pendingPrompts = new Set();
// Keep utterances alive until completion so browser speech callbacks remain reliable.
const activeUtterances = new Set();
let speechGeneration = 0;
let screenGeneration = 0;
let narrationFailed = false;

window.addEventListener("beforeunload", event => {
  if ((session && session.view !== "complete" || checkpoint) && !temporarySaveAvailable) {
    event.preventDefault();
    event.returnValue = "";
  }
});

function refreshPreferredVoice() {
  let voices = [];
  try { voices = Array.from(window.speechSynthesis?.getVoices() || []).filter(voice => /^en(?:[-_]|$)/i.test(voice.lang)); } catch { /* Voice lists may load later. */ }
  const chosen = voices.find(voice => voiceKey(voice) === selectedVoice);
  preferredVoice = chosen || selectPreferredVoice(voices);
  const select = document.querySelector("#voice-choice");
  select.innerHTML = `<option value="">Automatic (best available)</option>${voices.map(voice => `<option value="${escapeHtml(voiceKey(voice))}">${escapeHtml(voice.name)} · ${escapeHtml(voice.lang)}</option>`).join("")}`;
  select.value = chosen ? selectedVoice : "";
  select.disabled = !voices.length;
  document.querySelector("#voice-rate").value = String(speechRate);
  document.querySelector("#voice-preview").disabled = !("speechSynthesis" in window);
  document.querySelector("#voice-status").textContent = !("speechSynthesis" in window)
    ? "Speech is unavailable in this browser. Use Adult help in the lesson."
    : `${selectedVoice && !chosen ? "Your saved voice is unavailable here. " : ""}${preferredVoice ? `Using ${preferredVoice.name}.` : "Using the browser’s default voice while voices load."} Voice quality depends on your browser and installed voices.`;
}

function voiceKey(voice) { return `${voice.voiceURI || voice.name}|${voice.lang}`; }

refreshPreferredVoice();
if ("speechSynthesis" in window) {
  window.speechSynthesis.addEventListener("voiceschanged", refreshPreferredVoice);
}
document.querySelector("#voice-choice").addEventListener("change", event => {
  selectedVoice = event.target.value;
  writeStorage("local", VOICE_KEY, selectedVoice);
  stopSpeech();
  refreshPreferredVoice();
});
document.querySelector("#voice-rate").addEventListener("change", event => {
  const rate = Number(event.target.value);
  if (![0.85, 1, 1.1].includes(rate)) return;
  speechRate = rate;
  writeStorage("local", RATE_KEY, String(rate));
  stopSpeech();
});
document.querySelector("#voice-preview").addEventListener("click", () => {
  // Preview must not count as successfully hearing a test word.
  stopRecognition(true);
  stopSpeech();
  queueSpeech("Hello! Let’s practice spelling together.", speechRate, true);
});

const dayDetails = {
  monday: { eyebrow: "Learn", summary: "Learn and check four red words", icon: "☾" },
  tuesday: { eyebrow: "Use the words", summary: "Spell each word and write a sentence", icon: "✦" },
  wednesday: { eyebrow: "Use them again", summary: "Spell each word and write a new sentence", icon: "✧" },
  thursday: { eyebrow: "Remember", summary: "Delayed spelling check and targeted practice", icon: "★" },
};

homeButton.addEventListener("click", () => {
  if (session && session.view !== "complete" && !window.confirm("Leave this lesson? You can resume in this tab while it stays open. If temporary storage is unavailable, refreshing will lose unfinished work.")) return;
  saveCheckpoint();
  stopActivity();
  session = null;
  renderHome();
});

soundButton.addEventListener("click", () => {
  muted = !muted;
  writeStorage("local", SOUND_KEY, muted ? "muted" : "on");
  updateSoundButton();
  if (muted) {
    stopSpeech();
    if (magicAudioContext) void magicAudioContext.close();
    magicAudioContext = null;
  } else if (!problemDialog.open && !recognition) {
    const word = session?.view === "teaching" ? session.currentTask?.word
      : session?.view === "test" ? session.test.stage.words[session.test.index]
      : session?.view === "sentence" && session.sentencePractice.step === "spell"
        ? session.sentencePractice.stage.words[session.sentencePractice.index] : null;
    if (word) speakWord(word);
  }
});

reportButton.addEventListener("click", () => {
  stopRecognition(true);
  stopSpeech();
  reportStatus.textContent = "";
  problemDialog.showModal();
  window.setTimeout(() => problemDetails.focus(), 0);
});

document.querySelector("#problem-close").addEventListener("click", () => problemDialog.close());

problemDialog.addEventListener("click", (event) => {
  if (event.target === problemDialog) problemDialog.close();
});

problemForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!problemDetails.reportValidity()) return;
  const report = createCurrentProblemReport();
  problemDialog.close();
  window.location.href = buildCodexReportUrl(report);
});

document.querySelector("#copy-report").addEventListener("click", async () => {
  if (!problemDetails.reportValidity()) return;
  const copied = await copyText(createCurrentProblemReport());
  reportStatus.textContent = copied ? "Report copied. Paste it into a Codex chat and send it." : "Couldn’t copy automatically. Select the description and copy it manually.";
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.repeat || problemDialog.open) return;
  if (event.target.closest("input, textarea, select, button, a")) return;
  const advanceButton = app.querySelector(
    "#check-answer:not(:disabled), #continue-learning, #primary-action, #result-action, #ready-now",
  );
  if (!advanceButton) return;
  event.preventDefault();
  advanceButton.click();
});

function updateSoundButton() {
  soundButton.innerHTML = `<span aria-hidden="true">${muted ? "🔇" : "🔊"}</span> Sound ${muted ? "off" : "on"}`;
  soundButton.setAttribute("aria-pressed", String(muted));
}

function createCurrentProblemReport() {
  return buildProblemPrompt({
    details: problemDetails.value,
    screen: app.querySelector("h1")?.textContent?.trim() || "2nd Grade SpellQuest",
    pageUrl: window.location.href,
    userAgent: navigator.userAgent,
    reportedAt: new Date().toISOString(),
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}

function getHistory() {
  if (historyUnavailable || damagedHistory !== null) return memoryHistory;
  const raw = readStorage("local", HISTORY_KEY);
  if (raw === null) return memoryHistory;
  try {
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error("Invalid history");
    memoryHistory = entries.filter(validHistoryEntry);
    if (memoryHistory.length !== entries.length) throw new Error("Invalid entry");
  } catch {
    damagedHistory = raw;
    warnStorage("Some saved progress could not be read. The original data will be preserved before saving new results.");
  }
  return memoryHistory;
}

function saveHistory(history) {
  memoryHistory = history;
  // Access can recover during a lesson. Re-read before every write so earlier
  // scores that were temporarily inaccessible are never replaced by memory-only results.
  let raw;
  try { raw = localStorage.getItem(HISTORY_KEY); }
  catch {
    historyUnavailable = true;
    warnStorage("Progress could not be saved safely because earlier scores cannot be read. Keep this page open; new results remain here only.");
    return;
  }
  let existing = [];
  let damagedCurrent = false;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("Invalid history");
      existing = parsed.filter(validHistoryEntry);
      damagedCurrent = existing.length !== parsed.length;
    } catch { damagedCurrent = true; }
  }
  // Never overwrite a damaged record unless an exact recovery copy was saved.
  if (damagedHistory !== null) {
    if (!writeStorage("local", `${HISTORY_KEY}-recovery-${Date.now()}`, damagedHistory)) return;
    damagedHistory = null;
  }
  if (damagedCurrent && !writeStorage("local", `${HISTORY_KEY}-recovery-current-${Date.now()}`, raw)) return;
  const merged = new Map(existing.map(entry => [entry.id, entry]));
  history.forEach(entry => merged.set(entry.id, entry));
  memoryHistory = [...merged.values()];
  historyUnavailable = !writeStorage("local", HISTORY_KEY, JSON.stringify(memoryHistory));
}

function validHistoryEntry(entry) {
  if (!entry || typeof entry !== "object" || !["monday", "tuesday", "wednesday", "thursday"].includes(entry.day)) return false;
  if (typeof entry.id !== "string" || typeof entry.completedAt !== "string" || !Number.isFinite(Date.parse(entry.completedAt))) return false;
  if (entry.kind === "practice") return ["tuesday", "wednesday"].includes(entry.day) && typeof entry.weekId === "string";
  return Number.isInteger(entry.total) && entry.total > 0 && Number.isInteger(entry.score) && entry.score >= 0 && entry.score <= entry.total &&
    Number.isFinite(entry.percent) && entry.percent >= 0 && entry.percent <= 100;
}

function warnStorage(message) {
  storageWarnings.add(message);
  storageStatus.hidden = false;
  storageStatus.textContent = [...storageWarnings].join(" ");
}

function readStorage(kind, key) {
  try { return (kind === "local" ? localStorage : sessionStorage).getItem(key); }
  catch {
    if (kind === "local") historyUnavailable = true;
    warnStorage(kind === "local" ? "Saved progress is unavailable. You can still play; new results may last only until this page closes." : "Temporary saving is unavailable. Keep this page open; refreshing may lose unfinished work.");
    return null;
  }
}

function writeStorage(kind, key, value) {
  try {
    const storage = kind === "local" ? localStorage : sessionStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    if (kind === "session") temporarySaveAvailable = true;
    return true;
  } catch {
    if (kind === "session") temporarySaveAvailable = false;
    warnStorage(kind === "local" ? "Progress could not be saved on this device. You can keep playing; new results remain in this page only." : "Temporary saving is unavailable. Keep this page open; refreshing may lose unfinished work.");
    return false;
  }
}

function upsertHistory(entry) {
  const history = getHistory().filter((item) => item.id !== entry.id);
  history.push(entry);
  saveHistory(history);
  return memoryHistory;
}

function saveCheckpoint() {
  if (!session || session.view === "complete") return;
  checkpoint = JSON.parse(JSON.stringify({ version: 1, weekId: CURRENT_WEEK.id, session }));
  writeStorage("session", CHECKPOINT_KEY, JSON.stringify(checkpoint));
}

function clearCheckpoint() {
  checkpoint = null;
  checkpointRejected = false;
  writeStorage("session", CHECKPOINT_KEY, null);
}

function readCheckpoint() {
  if (checkpointRejected) return null;
  if (checkpoint) return checkpoint;
  const raw = readStorage("session", CHECKPOINT_KEY);
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw);
    const s = saved.session;
    const views = ["intro", "teaching", "success", "correction", "reward", "charged", "sentence", "sentence-complete", "test", "self-score", "result"];
    if (saved.version !== 1 || saved.weekId !== CURRENT_WEEK.id || !s || !LESSONS[s.day] || !views.includes(s.view) ||
      !Array.isArray(s.stages) || !Number.isInteger(s.stageIndex) || s.stageIndex < 0 || s.stageIndex >= s.stages.length) throw new Error("Invalid checkpoint");
    const knownIds = new Set(["monday", "monday-immediate", "tuesday-practice", "wednesday-practice", "thursday-delayed", "thursday-reteach", "thursday-retest", "thursday-reteach-extra", "thursday-retest-extra"]);
    const stageIds = s.stages.map(stage => stage?.id).join(",");
    const allowedStages = {
      monday: ["monday,monday-immediate"], tuesday: ["tuesday-practice"], wednesday: ["wednesday-practice"],
      thursday: ["thursday-delayed", "thursday-delayed,thursday-reteach,thursday-retest", "thursday-delayed,thursday-reteach,thursday-retest,thursday-reteach-extra,thursday-retest-extra"],
    };
    if (typeof s.id !== "string" || !new RegExp(`^${s.day}-\\d+$`).test(s.id) || !allowedStages[s.day].includes(stageIds)) throw new Error("Invalid lesson identity");
    const baseStages = createDayStages(s.day);
    for (const stage of s.stages) {
      if (!stage || !knownIds.has(stage.id) || !["teaching", "test", "sentence-practice"].includes(stage.type) ||
        !Array.isArray(stage.words) || !stage.words.length || stage.words.some(w => !CURRENT_WEEK.spellingTargets.includes(w))) throw new Error("Invalid stage");
      if (new Set(stage.words).size !== stage.words.length) throw new Error("Duplicate words");
      const definition = baseStages.find(item => item.id === stage.id) || createThursdayReteachStages(stage.words).find(item => stage.id.replace(/-extra$/, "") === item.id);
      if (!definition || stage.type !== definition.type || stage.words.join(",") !== definition.words.join(",")) throw new Error("Invalid lesson definition");
      stage.title = definition.title;
      stage.testType = definition.testType;
      // Recreate immutable lesson definitions rather than trusting a stored copy.
      if (stage.type === "teaching") stage.tasks = buildTeachingSequence(stage.words);
      if (stage.runtimeTasks && (!Array.isArray(stage.runtimeTasks) || stage.runtimeTasks.length !== stage.tasks?.length || stage.runtimeTasks.some((t, i) => !t || t.word !== stage.tasks[i].word || t.targetLevel !== stage.tasks[i].targetLevel || t.isReview !== stage.tasks[i].isReview || ![0,1].includes(t.errorsAtLevel) || !Number.isInteger(t.level) || t.level < 1 || t.level > t.targetLevel))) throw new Error("Invalid tasks");
    }
    const stage = s.stages[s.stageIndex];
    const finiteCount = value => Number.isInteger(value) && value >= 0 && value <= 10000;
    const validResponses = responses => Array.isArray(responses) && responses.length <= stage.words.length && responses.every((r, i) => r && r.word === stage.words[i] && typeof r.answer === "string" && r.answer.trim().length > 0 && r.answer.length <= 80);
    if (!finiteCount(s.taskIndex)) throw new Error("Invalid task index");
    if (["teaching", "correction", "success", "reward", "charged"].includes(s.view)) {
      if (stage.type !== "teaching" || !Array.isArray(stage.runtimeTasks) || s.taskIndex > stage.runtimeTasks.length || !finiteCount(stage.sparksCollected) || !finiteCount(stage.sparksUsed)) throw new Error("Invalid teaching state");
      if (["reward", "charged"].includes(s.view) && s.taskIndex !== stage.runtimeTasks.length) throw new Error("Incomplete teaching");
      if (["teaching", "correction"].includes(s.view) && (!stage.runtimeTasks[s.taskIndex] || !Array.isArray(s.letterTiles) || s.letterTiles.some(t => !/^\d+-[a-z]$/.test(t.id) || !/^[a-z]$/.test(t.letter)) || !Array.isArray(s.builtTileIds) || s.builtTileIds.some(id => !s.letterTiles.some(t => t.id === id)))) throw new Error("Invalid tiles");
      if (["teaching", "correction"].includes(s.view) && (s.letterTiles.map(t=>t.letter).sort().join("") !== [...stage.runtimeTasks[s.taskIndex].word].sort().join("") || new Set(s.letterTiles.map(t=>t.id)).size !== s.letterTiles.length || new Set(s.builtTileIds).size !== s.builtTileIds.length || s.letterTiles.some(t=>t.used !== s.builtTileIds.includes(t.id)))) throw new Error("Inconsistent tiles");
    }
    if (["test", "self-score", "result"].includes(s.view)) {
      if (stage.type !== "test" || !s.test || !validResponses(s.test.responses) || !finiteCount(s.test.index) || s.test.index !== s.test.responses.length || s.test.index > stage.words.length || !finiteCount(s.test.selfScoreIndex) || s.test.selfScoreIndex > s.test.responses.length) throw new Error("Invalid test state");
      if (["self-score", "result"].includes(s.view) && s.test.index !== stage.words.length) throw new Error("Incomplete test");
      if (s.view === "result" && (!validHistoryEntry(s.result) || s.result.kind === "practice" || !validResponses(s.result.responses) || !Array.isArray(s.result.missedWords) || s.result.missedWords.some(w => !stage.words.includes(w)))) throw new Error("Invalid result");
      if (s.view === "result") {
        const correct = s.test.responses.filter(r=>isCorrectSpelling(r.answer,r.word)).length;
        const missed = s.test.responses.filter(r=>!isCorrectSpelling(r.answer,r.word)).map(r=>r.word);
        if (s.result.total !== stage.words.length || s.result.score !== correct || s.result.percent !== Math.round(correct / stage.words.length * 100) || s.result.testId !== stage.id || s.result.day !== s.day || s.result.weekId !== CURRENT_WEEK.id || JSON.stringify(s.result.responses) !== JSON.stringify(s.test.responses) || s.result.missedWords.join(",") !== missed.join(",")) throw new Error("Inconsistent result");
      }
    }
    if (["sentence", "sentence-complete"].includes(s.view)) {
      const p = s.sentencePractice;
      if (stage.type !== "sentence-practice" || !p || !finiteCount(p.index) || p.index > stage.words.length || !["spell", "sentence"].includes(p.step) || !Array.isArray(p.responses) || p.responses.length !== p.index || p.responses.some((r, i) => !r || r.word !== stage.words[i] || !isCorrectSpelling(r.spelling, r.word) || typeof r.sentence !== "string" || r.sentence.length > 240 || sentenceFeedback(r.sentence,r.word))) throw new Error("Invalid practice");
      if (s.view === "sentence-complete" && p.index !== stage.words.length) throw new Error("Incomplete practice");
      if (s.view === "sentence" && p.step === "sentence" && !isCorrectSpelling(p.spelling,stage.words[p.index])) throw new Error("Missing spelling");
    }
    checkpoint = saved;
  } catch {
    checkpointRejected = true;
    warnStorage("The interrupted lesson could not be restored. Your saved scores are unchanged; start a day again.");
    return null;
  }
  return checkpoint;
}

function resumeLesson() {
  const saved = readCheckpoint();
  if (!saved) return;
  try {
    session = saved.session;
    const stage = currentStage();
    if (session.test) session.test.stage = stage;
    if (session.sentencePractice) session.sentencePractice.stage = stage;
    session.currentTask = stage.runtimeTasks?.[session.taskIndex] ?? null;
    switch (session.view) {
      case "intro": return renderStageIntro();
      case "teaching": case "correction":
        session.previewComplete = session.currentTask.level !== 2;
        session.announceTask = true;
        return renderTeachingTask();
      case "success": return loadTeachingTask();
      case "reward": return renderSparkReward();
      case "charged": return renderSparkReward(true);
      case "sentence": return renderSentencePractice();
      case "sentence-complete": return renderSentencePracticeComplete();
      case "test": return renderTestWord();
      case "self-score": return renderSelfScoring();
      case "result": return renderTestResult(session.result, getHistory());
    }
  } catch {
    session = null;
    checkpoint = null;
    checkpointRejected = true;
    warnStorage("The interrupted lesson could not be restored. Your saved scores are unchanged; start a day again.");
    renderHome();
  }
}

function renderHome() {
  stopActivity();
  const history = getHistory();
  const saved = readCheckpoint();
  app.innerHTML = `
    <section class="home-shell">
      <div class="hero-copy">
        <p class="eyebrow">Week of ${escapeHtml(CURRENT_WEEK.label)} · Four red words</p>
        <h1>Choose your day</h1>
        <p class="lede">Learn to spell <strong>${CURRENT_WEEK.spellingTargets.map(escapeHtml).join(", ")}</strong>, then use each word in your own sentences.</p>
      </div>

      ${saved ? `<section class="resume-card"><p>You have an unfinished ${capitalize(saved.session.day)} lesson in this tab.</p><button class="primary-button" id="resume-lesson" type="button">Resume lesson</button><p class="help-copy">Drafts stay in this tab temporarily. Finish before closing it.</p></section>` : ""}
      <p class="help-copy">This word list is updated by an adult, not automatically from the class slides. Week of ${escapeHtml(CURRENT_WEEK.label)}.</p>

      <div class="day-grid" aria-label="Choose a day">
        ${Object.entries(dayDetails)
          .map(
            ([day, detail], index) => `
              <button class="day-card day-${index + 1}" data-day="${day}" type="button">
                <span class="day-icon" aria-hidden="true">${detail.icon}</span>
                <span class="day-copy">
                  <small>${detail.eyebrow}</small>
                  <strong>${capitalize(day)}</strong>
                  <span>${detail.summary}</span>
                  ${history.some(entry => entry.weekId === CURRENT_WEEK.id && entry.day === day && entry.kind === "practice") ? '<small>Practice completed · see review status below</small>' : ""}
                </span>
                <span class="day-arrow" aria-hidden="true">→</span>
              </button>
            `,
          )
          .join("")}
      </div>

      <section class="progress-card">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Your spellbook</p>
            <h2>Progress over time</h2>
          </div>
          ${history.length ? '<button class="text-button" id="clear-progress" type="button">Clear progress</button>' : ""}
        </div>
        ${renderGraph(history)}
      </section>
    </section>
  `;

  app.querySelectorAll("[data-day]").forEach((button) => {
    button.addEventListener("click", () => startDay(button.dataset.day));
  });
  app.querySelector("#resume-lesson")?.addEventListener("click", resumeLesson);

  app.querySelector("#clear-progress")?.addEventListener("click", () => {
    if (window.confirm("Clear every saved SpellQuest score on this device?")) {
      if (!writeStorage("local", HISTORY_KEY, null)) return;
      memoryHistory = [];
      damagedHistory = null;
      historyUnavailable = false;
      renderHome();
    }
  });
  focusMain();
}

function startDay(day) {
  if (readCheckpoint() && !window.confirm("Start a new lesson instead? This replaces the unfinished lesson in this tab. Saved scores stay unchanged.")) return;
  clearCheckpoint();
  const stages = createDayStages(day, getHistory());
  session = { id: `${day}-${Date.now()}`, day, stages, stageIndex: 0, taskIndex: 0, currentTask: null };
  renderStageIntro();
}

function renderStageIntro() {
  stopActivity();
  const stage = currentStage();
  if (!stage) return renderDayComplete();
  session.view = "intro";

  const isTeaching = stage.type === "teaching";
  const isSentencePractice = stage.type === "sentence-practice";
  const description = isTeaching
    ? `${stage.words.length} ${stage.words.length === 1 ? "word" : "words"} will move through five learning steps with memory checks woven in.`
    : isSentencePractice
      ? `First spell each of the four red words. Then use each word in a sentence of your own.`
      : `${stage.words.length} ${stage.words.length === 1 ? "word" : "words"}. Type every answer first; you will check your work only at the end.`;
  const activityLabel = isTeaching ? "Teaching" : isSentencePractice ? "Spelling + sentences" : "No-feedback test";
  const actionLabel = isTeaching ? "Begin teaching" : isSentencePractice ? "Begin practice" : "Start word check";

  app.innerHTML = `
    <section class="center-shell">
      ${renderDayProgress()}
      <article class="book-card intro-card">
        <div class="orb" aria-hidden="true">${isTeaching ? "✦" : isSentencePractice ? "✎" : "✓"}</div>
        <p class="eyebrow">${capitalize(session.day)} · ${activityLabel}</p>
        <h1>${escapeHtml(stage.title)}</h1>
        <p class="lede compact">${description}</p>
        ${isTeaching || isSentencePractice ? renderWordPreview(stage.words) : '<p class="promise"><span aria-hidden="true">◌</span> Answers stay private until the whole test is finished.</p>'}
        <button class="primary-button" id="primary-action" type="button">
          ${actionLabel} <span aria-hidden="true">→</span>
        </button>
      </article>
    </section>
  `;

  app.querySelector("#primary-action").addEventListener("click", () => {
    if (isTeaching) startTeaching(stage);
    else if (isSentencePractice) startSentencePractice(stage);
    else startTest(stage);
  });
  focusMain();
}

function startTeaching(stage) {
  stage.runtimeTasks = stage.tasks.map((task) => ({ ...task }));
  stage.sparksCollected = 0;
  stage.sparksUsed = 0;
  session.taskIndex = 0;
  loadTeachingTask();
}

function loadTeachingTask() {
  stopActivity();
  const stage = currentStage();
  if (session.taskIndex >= stage.runtimeTasks.length) {
    renderSparkReward();
    return;
  }
  session.currentTask = stage.runtimeTasks[session.taskIndex];
  session.adultPromptReady = false;
  session.draft = "";
  session.voiceFallback = false;
  session.voiceStatus = "";
  session.announceTask = true;
  session.previewComplete = session.currentTask.level !== 2;
  prepareLetters();
  renderTeachingTask();
}

function prepareLetters() {
  const word = session.currentTask.word;
  session.letterTiles = shuffledLetters(word).map((letter, index) => ({
    id: `${index}-${letter}`,
    letter,
    used: false,
  }));
  session.builtTileIds = [];
}

function renderTeachingTask(preserveFocus = false) {
  stopActivity();
  session.view = "teaching";
  const task = session.currentTask;
  if (task.level === 2 && !session.previewComplete) {
    renderMemoryPreview();
    return;
  }

  const shouldAnnounce = session.announceTask;
  session.announceTask = false;

  const isTileLevel = task.level <= 4;
  const voiceSupported = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  if (task.level === 4 && !voiceSupported) {
    session.voiceFallback = true;
    session.voiceStatus ||= "Voice spelling is not supported in this browser. Letter tiles are ready instead.";
  }

  app.innerHTML = `
    <section class="center-shell lesson-shell">
      ${renderTaskProgress()}
      <article class="book-card lesson-card">
        <div class="lesson-kicker">
          <span class="step-pill">Step ${task.level} of 5</span>
          ${task.isReview ? '<span class="review-pill">Memory check</span>' : ""}
        </div>
        <h1>${LEVEL_NAMES[task.level]}</h1>
        <p class="instruction">${levelInstruction(task.level, session.voiceFallback)}</p>
        ${renderListenButtons(task.word)}
        ${task.level === 1 ? `<div class="word-model" aria-label="The word is ${escapeHtml(task.word)}">${escapeHtml(task.word)}</div>` : ""}
        ${isTileLevel ? renderTileActivity(task, voiceSupported) : renderTypingActivity()}
        <div class="feedback-line" id="activity-status" aria-live="polite"></div>
      </article>
    </section>
  `;

  bindListenButtons(task.word);
  if (isTileLevel) bindTileActivity(task, voiceSupported);
  else bindTypingActivity();
  if (preserveFocus) saveCheckpoint();
  else focusMain(isTileLevel ? app : app.querySelector("#spelling-input"));
  if (shouldAnnounce) speakWord(task.word);
}

function renderMemoryPreview() {
  session.view = "teaching";
  let seconds = 5;
  app.innerHTML = `
    <section class="center-shell lesson-shell">
      ${renderTaskProgress()}
      <article class="book-card lesson-card memory-card">
        <span class="step-pill">Step 2 of 5</span>
        <p class="eyebrow">Remember this word</p>
        <div class="memory-word">${escapeHtml(session.currentTask.word)}</div>
        <div class="countdown" id="countdown" aria-live="polite"><span>${seconds}</span> seconds</div>
        <button class="secondary-button" id="ready-now" type="button">I’m ready</button>
      </article>
    </section>
  `;
  const finish = () => {
    stopTimer();
    session.previewComplete = true;
    prepareLetters();
    renderTeachingTask();
  };
  app.querySelector("#ready-now").addEventListener("click", finish);
  activeTimer = window.setInterval(() => {
    if (problemDialog.open) return;
    seconds -= 1;
    const countdown = app.querySelector("#countdown span");
    if (countdown) countdown.textContent = String(Math.max(0, seconds));
    if (seconds <= 0) finish();
  }, 1000);
  speakWord(session.currentTask.word);
  focusMain();
}

function renderTileActivity(task, voiceSupported) {
  const built = session.builtTileIds
    .map((id) => session.letterTiles.find((tile) => tile.id === id))
    .filter(Boolean);
  const answerSlots = Array.from({ length: normalizeSpelling(task.word).length }, (_, index) => {
    const tile = built[index];
    return tile
      ? `<button class="answer-tile filled" data-remove-tile="${tile.id}" type="button" aria-label="Remove ${tile.letter}">${tile.letter}</button>`
      : '<span class="answer-tile" aria-hidden="true"></span>';
  }).join("");

  const canClick = task.level !== 4 || session.voiceFallback;
  const voiceStatus =
    session.voiceStatus ||
    (session.voiceFallback
      ? "Letter tiles are ready. You can try the microphone again at any time."
      : "Tap the microphone, then say the word or spell each letter, like A, I, R.");
  const available = session.letterTiles
    .map(
      (tile) => `
        <button class="letter-tile" data-add-tile="${tile.id}" type="button"
          ${tile.used || !canClick ? "disabled" : ""} aria-label="Letter ${tile.letter}">
          ${tile.letter}
        </button>
      `,
    )
    .join("");

  return `
    <div class="answer-row" aria-label="Your spelling">${answerSlots}</div>
    <div class="tile-bank" aria-label="Scrambled letters">${available}</div>
    ${
      task.level === 4
        ? `
          <div class="voice-controls">
            <button class="mic-button" id="mic-button" type="button" ${voiceSupported ? "" : "disabled"}>
              <span aria-hidden="true">🎙</span>
              <span>${voiceSupported ? (session.voiceFallback ? "Try microphone again" : "Say word or letters") : "Voice unavailable"}</span>
            </button>
            <p id="heard-text" role="status">${escapeHtml(voiceStatus)}</p>
            <p class="help-copy">Ask an adult before using the microphone. Your browser may send your voice to its speech-recognition provider. SpellQuest does not save recordings. You can always choose letter tiles.</p>
            ${voiceSupported && !session.voiceFallback ? '<button class="text-button" id="voice-fallback" type="button">Use letter tiles instead</button>' : ""}
            ${
              window.location.protocol === "file:"
                ? '<p class="voice-environment-note"><strong>Microphone note:</strong> File previews can block speech recognition. Open SpellQuest from an HTTPS address or through the local server for reliable microphone access.</p>'
                : ""
            }
          </div>
        `
        : ""
    }
    <button class="primary-button check-button" id="check-answer" type="button" ${built.length === normalizeSpelling(task.word).length ? "" : "disabled"}>
      Check my spelling
    </button>
  `;
}

function bindTileActivity(task, voiceSupported) {
  app.querySelectorAll("[data-add-tile]").forEach((button) => {
    button.addEventListener("click", () => {
      const letter = session.letterTiles.find((tile) => tile.id === button.dataset.addTile)?.letter;
      addTile(button.dataset.addTile);
      renderTeachingTask(true);
      focusTile();
      if (letter) speakLetterSequence([letter]);
    });
  });
  app.querySelectorAll("[data-remove-tile]").forEach((button) => {
    button.addEventListener("click", () => {
      removeTile(button.dataset.removeTile);
      renderTeachingTask(true);
      focusTile(button.dataset.removeTile);
    });
  });
  app.querySelector("#check-answer")?.addEventListener("click", () => {
    const answer = session.builtTileIds
      .map((id) => session.letterTiles.find((tile) => tile.id === id)?.letter ?? "")
      .join("");
    checkTeachingAnswer(answer);
  });
  app.querySelector("#voice-fallback")?.addEventListener("click", () => {
    session.voiceFallback = true;
    session.voiceStatus = "Letter tiles are ready. You can try the microphone again at any time.";
    renderTeachingTask();
  });
  if (task.level === 4 && voiceSupported) {
    app.querySelector("#mic-button")?.addEventListener("click", startVoiceLetters);
  }
}

function focusTile(preferredId) {
  const generation = screenGeneration;
  window.setTimeout(() => {
    if (generation !== screenGeneration || problemDialog.open) return;
    const preferred = preferredId && [...app.querySelectorAll("[data-add-tile]")].find(button => button.dataset.addTile === preferredId && !button.disabled);
    const target = preferred || app.querySelector("[data-add-tile]:not(:disabled)") || app.querySelector("#check-answer");
    target?.focus({ preventScroll: true });
    const built = session.builtTileIds.map(id => session.letterTiles.find(tile => tile.id === id)?.letter).join(" ");
    app.querySelector("#activity-status").textContent = built ? `Your letters: ${built}.` : "Your answer is empty.";
  }, 0);
}

function renderTypingActivity() {
  return `
    <form class="typing-form" id="typing-form" autocomplete="off">
      <label for="spelling-input">Type the word you hear</label>
      <input id="spelling-input" name="spelling" type="text" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="80" value="${escapeHtml(session.draft || "")}" required />
      <button class="primary-button" type="submit">Check my spelling</button>
    </form>
  `;
}

function bindTypingActivity() {
  const form = app.querySelector("#typing-form");
  const input = app.querySelector("#spelling-input");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (input.value.trim()) checkTeachingAnswer(input.value);
  });
  bindLetterEcho(input);
  input.addEventListener("input", () => { session.draft = input.value; saveCheckpoint(); });
}

function bindLetterEcho(input) {
  input.addEventListener("input", (event) => {
    const letters = [...(event.data || "")]
      .map((letter) => letter.toLocaleLowerCase("en-US"))
      .filter((letter) => /^[a-z]$/.test(letter));
    if (letters.length) speakLetterSequence(letters);
  });
}

function addTile(id) {
  const tile = session.letterTiles.find((item) => item.id === id);
  if (!tile || tile.used) return;
  tile.used = true;
  session.builtTileIds.push(id);
}

function removeTile(id) {
  const tile = session.letterTiles.find((item) => item.id === id);
  if (!tile) return;
  tile.used = false;
  session.builtTileIds = session.builtTileIds.filter((tileId) => tileId !== id);
}

function checkTeachingAnswer(answer) {
  if (session.currentTask.level >= 3 && narrationFailed && !session.adultPromptReady) {
    showNarrationFailure();
    return;
  }
  stopActivity();
  session.draft = "";
  const task = session.currentTask;
  if (isCorrectSpelling(answer, task.word)) {
    playSpellSparkSound();
    currentStage().sparksCollected += 1;
    task.errorsAtLevel = 0;
    const isClimbingBack = task.level < task.targetLevel;
    if (isClimbingBack) task.level += 1;
    else session.taskIndex += 1;
    renderSuccess(isClimbingBack);
    return;
  }

  task.errorsAtLevel += 1;
  const firstError = task.errorsAtLevel === 1;
  if (!firstError) {
    task.errorsAtLevel = 0;
    task.level = Math.max(1, task.level - 1);
  }
  renderCorrection(firstError);
}

function renderSuccess(isClimbingBack) {
  session.view = "success";
  const task = session.currentTask;
  app.innerHTML = `
    <section class="center-shell">
      <article class="book-card feedback-card success-card">
        <div class="success-ring" aria-hidden="true">✓</div>
        <p class="eyebrow">${task.isReview ? "Memory strengthened" : "Spell complete"}</p>
        <h1>${escapeHtml(task.word)}</h1>
        <p>${isClimbingBack ? `Well done. Now return to ${LEVEL_NAMES[task.level].toLowerCase()}.` : successMessage()}</p>
        <div class="spark-earned" role="status">
          <span aria-hidden="true">✦</span>
          <strong>+1 Spell Spark</strong>
          <small>${formatSpellSparks(currentStage().sparksCollected)} collected</small>
        </div>
        <button class="primary-button" id="continue-learning" type="button">Continue <span aria-hidden="true">→</span></button>
      </article>
    </section>
  `;
  addSparkles();
  app.querySelector("#continue-learning").addEventListener("click", () => {
    if (isClimbingBack) {
      session.announceTask = true;
      session.previewComplete = session.currentTask.level !== 2;
      prepareLetters();
      renderTeachingTask();
    } else {
      loadTeachingTask();
    }
  });
  focusMain();
}

function renderSparkReward(charged = false) {
  stopActivity();
  session.view = charged ? "charged" : "reward";
  const stage = currentStage();
  const sparkCount = charged ? stage.sparksUsed : stage.sparksCollected;
  const sparkLabel = formatSpellSparks(sparkCount);

  app.innerHTML = `
    <section class="center-shell">
      ${renderDayProgress()}
      <article class="book-card reward-card ${charged ? "reward-charged" : ""}">
        <div class="${charged ? "charged-spellbook" : "spark-vessel"}" aria-hidden="true">
          ${charged ? "✦" : `<span>✦</span><strong>${sparkCount}</strong>`}
        </div>
        <p class="eyebrow">${charged ? "Spellbook charged" : "Teaching sequence complete"}</p>
        <h1>${charged ? "Your sparks became power" : "Use what you collected"}</h1>
        <p class="lede compact">
          ${
            charged
              ? `You turned ${sparkLabel} into a boost for the word check.`
              : `You earned ${sparkLabel} by spelling words correctly. Use them now to charge your spellbook.`
          }
        </p>
        <button class="primary-button" id="primary-action" type="button">
          ${charged ? "Begin word check" : `Use ${sparkLabel}`} <span aria-hidden="true">→</span>
        </button>
      </article>
    </section>
  `;

  if (charged) addSparkles();
  app.querySelector("#primary-action").addEventListener("click", () => {
    if (charged) {
      advanceStage();
      return;
    }
    stage.sparksUsed = sparkCount;
    stage.sparksCollected = 0;
    renderSparkReward(true);
  });
  focusMain();
}

function renderCorrection(firstError) {
  session.view = "correction";
  const task = session.currentTask;
  let seconds = 4;
  app.innerHTML = `
    <section class="center-shell">
      <article class="book-card feedback-card correction-card">
        <p class="eyebrow">Study the word</p>
        <h1>${escapeHtml(task.word)}</h1>
        <p>${firstError ? "Look closely. You’ll try this same step again." : task.level === 1 ? "Let’s practice this first step once more." : `Let’s practice one step back: ${LEVEL_NAMES[task.level].toLowerCase()}.`}</p>
        <div class="countdown" id="countdown" aria-live="polite"><span>${seconds}</span> seconds</div>
      </article>
    </section>
  `;
  activeTimer = window.setInterval(() => {
    if (problemDialog.open) return;
    seconds -= 1;
    const counter = app.querySelector("#countdown span");
    if (counter) counter.textContent = String(Math.max(0, seconds));
    if (seconds <= 0) {
      stopTimer();
      session.announceTask = true;
      session.previewComplete = task.level !== 2;
      prepareLetters();
      renderTeachingTask();
    }
  }, 1000);
  focusMain();
}

function startSentencePractice(stage) {
  session.sentencePractice = {
    stage,
    index: 0,
    step: "spell",
    responses: [],
  };
  renderSentencePractice();
}

function renderSentencePractice(feedback = "") {
  stopActivity();
  session.view = "sentence";
  const practice = session.sentencePractice;
  const { stage, index, step } = practice;
  if (index >= stage.words.length) {
    renderSentencePracticeComplete();
    return;
  }

  const word = stage.words[index];
  const isSpelling = step === "spell";
  app.innerHTML = `
    <section class="center-shell lesson-shell">
      ${renderTestProgress(index, stage.words.length, `${capitalize(session.day)} practice`)}
      <article class="book-card lesson-card sentence-practice-card">
        <p class="eyebrow">Word ${index + 1} of ${stage.words.length} · ${isSpelling ? "Spell" : "Write"}</p>
        <h1>${isSpelling ? `Spell <span class="target-word">${escapeHtml(word)}</span>.` : `Use <span class="target-word">${escapeHtml(word)}</span> in a sentence.`}</h1>
        <p class="instruction">
          ${
            isSpelling
              ? "Look at the red word, then type it carefully."
              : "Try to write a complete thought. End with punctuation. The game checks the red word and ending punctuation, not grammar or meaning. An adult can review your sentences at the end."
          }
        </p>
        ${isSpelling ? renderListenButtons(word, false) : ""}
        <form class="typing-form sentence-form" id="sentence-practice-form" autocomplete="off">
          <label for="sentence-practice-input">${isSpelling ? "Type the word" : "Your sentence"}</label>
          ${
            isSpelling
              ? `<input id="sentence-practice-input" type="text" maxlength="80" autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(practice.draft || "")}" required />`
              : `<textarea id="sentence-practice-input" rows="4" maxlength="240" spellcheck="true" required>${escapeHtml(practice.draft || "")}</textarea>`
          }
          <button class="primary-button" type="submit">
            ${isSpelling ? "Next: write a sentence" : index === stage.words.length - 1 ? "Finish practice" : "Next word"}
            <span aria-hidden="true">→</span>
          </button>
        </form>
        <p class="feedback-line visible" id="sentence-feedback" aria-live="assertive">${escapeHtml(feedback)}</p>
      </article>
    </section>
  `;

  if (isSpelling) bindListenButtons(word, false);
  const input = app.querySelector("#sentence-practice-input");
  input.addEventListener("input", () => { practice.draft = input.value; saveCheckpoint(); });
  app.querySelector("#sentence-practice-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const answer = input.value.trim();
    if (!answer) return;

    if (isSpelling) {
      if (!isCorrectSpelling(answer, word)) {
        app.querySelector("#sentence-feedback").textContent = `Try again. Copy the word carefully: ${word}.`;
        input.select();
        return;
      }
      practice.spelling = answer;
      practice.draft = "";
      practice.step = "sentence";
      renderSentencePractice();
      return;
    }

    const feedback = sentenceFeedback(answer, word);
    if (feedback) {
      app.querySelector("#sentence-feedback").textContent = feedback;
      input.focus();
      return;
    }

    practice.responses.push({ word, spelling: practice.spelling, sentence: answer });
    practice.index += 1;
    practice.step = "spell";
    practice.spelling = "";
    practice.draft = "";
    playSpellSparkSound();
    renderSentencePractice();
  });
  if (isSpelling) bindLetterEcho(input);
  // Queue within the action that opens the word, retaining browser user activation.
  if (isSpelling) speakWord(word);
  focusMain(input);
}

function renderSentencePracticeComplete() {
  session.view = "sentence-complete";
  const practice = session.sentencePractice;
  savePracticeCompletion();
  app.innerHTML = messageScreen({
    symbol: "✎",
    eyebrow: `${capitalize(session.day)} practice complete`,
    title: "Four words, four sentences",
    body: "You finished the word and punctuation checks. Grammar and meaning have not been checked by the game.",
    action: `Finish ${capitalize(session.day)}`,
  });
  app.querySelector(".book-card").insertAdjacentHTML("beforeend", `
    <details class="adult-review"><summary>Optional: review with an adult</summary>
      <p>Adult: read each sentence together. Does it make sense and use the red word correctly? Discuss improvements before checking the box. This is a self-reported review, not an automated assessment.</p>
      <ul>${practice.responses.map(response => `<li><strong>${escapeHtml(response.word)}</strong>: ${escapeHtml(response.sentence)}</li>`).join("")}</ul>
      <label><input id="adult-reviewed" type="checkbox" ${practice.adultReviewed ? "checked" : ""} /> An adult reviewed these sentences with me</label>
    </details><p class="help-copy">Sentence text is temporary and is not included in saved progress.</p>`);
  app.querySelector("#adult-reviewed").addEventListener("change", event => {
    practice.adultReviewed = event.target.checked;
    savePracticeCompletion();
    saveCheckpoint();
  });
  addSparkles();
  app.querySelector("#primary-action").addEventListener("click", advanceStage);
  focusMain();
}

function savePracticeCompletion() {
  upsertHistory({ id: `${session.id}-practice`, kind: "practice", day: session.day,
    weekId: CURRENT_WEEK.id, weekLabel: CURRENT_WEEK.label, completedAt: new Date().toISOString(),
    adultReviewed: Boolean(session.sentencePractice.adultReviewed) });
}

function startTest(stage) {
  session.test = { stage, index: 0, responses: [], selfScoreIndex: 0 };
  renderTestWord();
}

function renderTestWord() {
  stopActivity();
  session.view = "test";
  const { stage, index } = session.test;
  if (index >= stage.words.length) {
    renderSelfScoring();
    return;
  }
  const word = stage.words[index];
  app.innerHTML = `
    <section class="center-shell lesson-shell">
      ${renderTestProgress(index, stage.words.length)}
      <article class="book-card lesson-card test-card">
        <p class="eyebrow">No-feedback word check</p>
        <h1>Listen, then type.</h1>
        <p class="instruction">Your answer will be saved. You’ll check every spelling at the end.</p>
        ${renderListenButtons(word, false)}
        <form class="typing-form" id="test-form" autocomplete="off">
          <label for="test-input">Word ${index + 1} of ${stage.words.length}</label>
          <input id="test-input" type="text" maxlength="80" autocomplete="off" autocapitalize="none" spellcheck="false" value="${escapeHtml(session.test.draft || "")}" required />
          <button class="primary-button" type="submit">Save and continue <span aria-hidden="true">→</span></button>
        </form>
        <p class="test-promise"><span aria-hidden="true">◌</span> No answers are marked yet.</p>
      </article>
    </section>
  `;
  bindListenButtons(word, false);
  const input = app.querySelector("#test-input");
  input.addEventListener("input", () => { session.test.draft = input.value; saveCheckpoint(); });
  app.querySelector("#test-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    if (narrationFailed && !session.test.adultPromptReady) { showNarrationFailure(); return; }
    session.test.responses.push({ word, answer: input.value.trim() });
    session.test.index += 1;
    session.test.draft = "";
    session.test.adultPromptReady = false;
    renderTestWord();
  });
  bindLetterEcho(input);
  speakWord(word);
  focusMain(input);
}

function renderSelfScoring(shake = false) {
  stopActivity();
  session.view = "self-score";
  const test = session.test;
  if (test.selfScoreIndex >= test.responses.length) {
    finishTest();
    return;
  }
  const response = test.responses[test.selfScoreIndex];
  app.innerHTML = `
    <section class="center-shell lesson-shell">
      ${renderTestProgress(test.selfScoreIndex, test.responses.length, "Checking")}
      <article class="book-card self-score-card ${shake ? "shake" : ""}" id="self-score-card">
        <p class="eyebrow">Be your own teacher</p>
        <h1>Check your spelling</h1>
        <div class="comparison">
          <div>
            <span>Correct word</span>
            <strong>${escapeHtml(response.word)}</strong>
          </div>
          <div>
            <span>Your spelling</span>
            <strong>${escapeHtml(response.answer)}</strong>
          </div>
        </div>
        <p class="instruction">Do these spellings match?</p>
        <div class="rating-buttons">
          <button class="rating-button correct-choice" data-rating="true" type="button"><span aria-hidden="true">✓</span> Looks correct</button>
          <button class="rating-button practice-choice" data-rating="false" type="button"><span aria-hidden="true">↻</span> Needs practice</button>
        </div>
        <p class="feedback-line ${shake ? "visible" : ""}" id="rating-feedback" aria-live="assertive">
          ${shake ? "Take another look. That rating doesn’t match the spelling." : ""}
        </p>
      </article>
    </section>
  `;
  app.querySelectorAll("[data-rating]").forEach((button) => {
    button.addEventListener("click", () => {
      const childSaysCorrect = button.dataset.rating === "true";
      const actuallyCorrect = isCorrectSpelling(response.answer, response.word);
      if (childSaysCorrect !== actuallyCorrect) {
        renderSelfScoring(true);
        return;
      }
      response.selfRating = childSaysCorrect ? "correct" : "needs-practice";
      test.selfScoreIndex += 1;
      renderSelfScoring();
    });
  });
  focusMain();
}

function finishTest() {
  const { stage, responses } = session.test;
  const correct = responses.filter(({ word, answer }) => isCorrectSpelling(answer, word));
  const missedWords = responses
    .filter(({ word, answer }) => !isCorrectSpelling(answer, word))
    .map(({ word }) => word);
  const entry = {
    id: `${session.id}-${stage.id}`,
    kind: "test",
    weekId: CURRENT_WEEK.id,
    weekLabel: CURRENT_WEEK.label,
    sessionId: session.id,
    testId: stage.id,
    title: stage.title,
    day: session.day,
    testType: stage.testType,
    completedAt: new Date().toISOString(),
    score: correct.length,
    total: responses.length,
    percent: responses.length ? Math.round((correct.length / responses.length) * 100) : 0,
    responses,
    missedWords,
  };
  const history = upsertHistory(entry);
  session.result = entry;
  if (stage.id === "thursday-delayed" && missedWords.length && !session.stages.some(item => item.id === "thursday-reteach")) {
    session.stages.splice(session.stageIndex + 1, 0, ...createThursdayReteachStages(missedWords));
  }
  renderTestResult(entry, history);
}

function renderTestResult(entry, history) {
  session.view = "result";
  const finalStage = session.stageIndex === session.stages.length - 1;
  app.innerHTML = `
    <section class="center-shell results-shell">
      <article class="book-card results-card">
        <div class="score-medallion"><strong>${entry.score}/${entry.total}</strong><span>${entry.percent}%</span></div>
        <p class="eyebrow">Word check complete</p>
        <h1>${resultHeadline(entry.percent)}</h1>
        <p class="lede compact">You carefully checked every answer yourself.</p>
        ${
          entry.missedWords.length
            ? `<div class="practice-list"><span>Keep practicing</span><p>${entry.missedWords.map(escapeHtml).join(" · ")}</p></div>`
            : '<div class="practice-list mastered"><span>Every word matched</span><p>Your memory work is paying off.</p></div>'
        }
        ${entry.missedWords.length && entry.testType === "retest" ? `<p class="help-copy">These words still need practice. Finishing today does not mean they are mastered. ${entry.testId === "thursday-retest" ? "You can try one extra practice round, or ask an adult for help." : "You have finished the extra round. Ask an adult to practice these words with you; there is no endless retry loop."}</p>${entry.testId === "thursday-retest" ? '<button class="secondary-button" id="extra-practice" type="button">Try one extra practice round</button>' : ""}` : ""}
        <div class="mini-graph-wrap">
          <h2>Your progress</h2>
          ${renderGraph(history, true)}
        </div>
        <button class="primary-button" id="result-action" type="button">
          ${finalStage ? `Finish ${capitalize(session.day)}` : "Continue today’s lesson"} <span aria-hidden="true">→</span>
        </button>
      </article>
    </section>
  `;
  if (entry.percent === 100) addSparkles();
  app.querySelector("#result-action").addEventListener("click", () => {
    advanceStage();
  });
  app.querySelector("#extra-practice")?.addEventListener("click", () => {
    session.stages.splice(session.stageIndex + 1, 0, ...createThursdayReteachStages(entry.missedWords).map(stage => ({ ...stage, id: `${stage.id}-extra` })));
    advanceStage();
  });
  focusMain();
}

function advanceStage() {
  session.stageIndex += 1;
  session.taskIndex = 0;
  session.currentTask = null;
  session.test = null;
  session.sentencePractice = null;
  renderStageIntro();
}

function renderDayComplete() {
  session.view = "complete";
  clearCheckpoint();
  const day = session.day;
  const unresolved = unresolvedWords(getHistory());
  const completionMessages = {
    monday: "You learned all four red words and completed a spelling check.",
    tuesday: "You spelled all four red words and used each one in a sentence.",
    wednesday: "You practiced all four words again in new sentences.",
    thursday: unresolved.length ? `Practice finished. Still needs adult help: ${unresolved.join(", ")}. These words are not yet mastered.` : "You completed the delayed check. Every word matched in its latest spelling check this week.",
  };
  app.innerHTML = messageScreen({
    symbol: "✦",
    eyebrow: `${capitalize(day)} complete`,
    title: day === "thursday" && unresolved.length ? "Practice finished — keep learning" : "Your spellbook is stronger",
    body: escapeHtml(completionMessages[day]),
    action: "Return to days",
  });
  addSparkles();
  app.querySelector("#primary-action").addEventListener("click", renderHome);
  focusMain();
}

function renderDayProgress() {
  const total = session.stages.length;
  const active = Math.min(session.stageIndex + 1, total);
  return `
    <div class="day-progress" aria-label="Activity ${active} of ${total}">
      <span>${capitalize(session.day)}</span>
      <div class="progress-track"><i style="width:${(active / total) * 100}%"></i></div>
      <span>${active}/${total}</span>
    </div>
  `;
}

function renderTaskProgress() {
  const stage = currentStage();
  const complete = Math.min(session.taskIndex, stage.runtimeTasks.length);
  const percent = Math.round((complete / stage.runtimeTasks.length) * 100);
  const wordIndex = Math.max(0, stage.words.indexOf(session.currentTask.word));
  return `
    <div class="lesson-progress">
      <div class="gem-row" aria-label="Word ${wordIndex + 1} of ${stage.words.length}">
        ${stage.words.map((word, index) => `<span class="gem ${index < wordIndex ? "complete" : index === wordIndex ? "active" : ""}" title="${escapeHtml(word)}">◆</span>`).join("")}
      </div>
      <div class="lesson-status">
        <span>${percent}% through this lesson</span>
        <strong><span aria-hidden="true">✦</span> ${stage.sparksCollected}</strong>
      </div>
    </div>
  `;
}

function renderTestProgress(index, total, label = "Testing") {
  const complete = Math.min(index, total);
  return `
    <div class="test-progress">
      <span>${label}</span>
      <div class="progress-track"><i style="width:${(complete / total) * 100}%"></i></div>
      <span>${complete}/${total}</span>
    </div>
  `;
}

function renderListenButtons(word, includeSentence = true) {
  if (!("speechSynthesis" in window)) narrationFailed = true;
  return `
    <div class="listen-row">
      <button class="listen-button" data-speak-word type="button"><span aria-hidden="true">🔊</span> Hear the word</button>
      ${includeSentence ? '<button class="sentence-button" data-speak-sentence type="button">Hear it in a sentence</button>' : ""}
    </div>
    <p id="narration-status" class="help-copy" role="status" ${narrationFailed ? "" : "hidden"}>The voice is unavailable. Ask an adult to read the prompt below, or retry Hear the word. No answer will be marked just because audio failed.</p>
    <details class="adult-prompt"><summary>Adult help if you cannot hear the word</summary>
      <p>Adult only: keep this prompt out of the child's view and read it aloud. Do not spell the letters.</p>
      <p>${escapeHtml(spellingPrompt(word))}. ${escapeHtml(WORD_DETAILS[word]?.sentence || "")}</p>
      <button class="secondary-button" id="adult-prompt-read" type="button">An adult read the prompt aloud</button>
    </details>
  `;
}

function bindListenButtons(word, includeSentence = true) {
  app.querySelector("[data-speak-word]")?.addEventListener("click", () => speakWord(word, true));
  if (includeSentence) {
    app.querySelector("[data-speak-sentence]")?.addEventListener("click", () => speakSentence(word, true));
  }
  app.querySelector("#adult-prompt-read")?.addEventListener("click", () => {
    if (session?.test) session.test.adultPromptReady = true;
    if (session) session.adultPromptReady = true;
    const details = app.querySelector(".adult-prompt");
    if (details) details.open = false;
    const status = app.querySelector("#narration-status");
    if (status) { status.hidden = false; status.textContent = "An adult has read the prompt. You can continue."; }
    saveCheckpoint();
  });
}

function renderWordPreview(words) {
  return `<div class="word-preview">${words.map((word) => `<span>${escapeHtml(word)}</span>`).join("")}</div>`;
}

function unresolvedWords(history) {
  const latest = new Map();
  history.filter(entry => entry.weekId === CURRENT_WEEK.id && entry.kind !== "practice").forEach(entry => {
    if (Array.isArray(entry.responses)) entry.responses.forEach(response => {
      if (CURRENT_WEEK.spellingTargets.includes(response?.word) && typeof response.answer === "string") latest.set(response.word, isCorrectSpelling(response.answer, response.word));
    });
  });
  return [...latest].filter(([, correct]) => !correct).map(([word]) => word);
}

function renderGraph(history, compact = false) {
  if (!history.length) {
    return `
      <div class="empty-graph">
        <div class="empty-stars" aria-hidden="true">✧ · ✦ · ✧</div>
        <p>Your completed practice and spelling checks will appear here.</p>
      </div>
    `;
  }
  const limit = compact ? 4 : 12;
  const sections = [
    ["Daily practice", history.filter(entry => entry.kind === "practice")],
    ["Full spelling checks", history.filter(entry => entry.kind !== "practice" && entry.testType !== "retest")],
    ["Targeted retests — only previously missed words", history.filter(entry => entry.kind !== "practice" && entry.testType === "retest")],
  ];
  const unresolved = unresolvedWords(history);
  return `${unresolved.length ? `<p class="needs-help" role="status">This week, still needs practice: <strong>${unresolved.map(escapeHtml).join(", ")}</strong>. Ask an adult for help.</p>` : ""}
    <p class="help-copy">Full checks and smaller retests measure different word sets. They are shown separately, not as a single rising or falling score.</p>
    ${sections.filter(([, entries]) => entries.length).map(([title, entries]) => `
      <section class="history-section"><h3>${title}</h3>
      ${entries.length > limit ? `<p>Showing the latest ${limit} of ${entries.length} records. Older records remain saved.</p>` : ""}
      <ul class="history-list">${entries.slice(-limit).reverse().map(entry => `<li>
        <strong>${escapeHtml(capitalize(entry.day))} · ${escapeHtml(new Date(entry.completedAt).toLocaleDateString())}</strong>
        <span>Week: ${escapeHtml(entry.weekId || "not recorded in older score")}</span>
        ${entry.kind === "practice" ? `<span>Practice completed · ${entry.adultReviewed === true ? "Adult review reported" : "Sentences not adult-reviewed"}</span>` : `
          <span>${escapeHtml(entry.testType === "immediate" ? "Immediate check" : entry.testType === "delayed" ? "Delayed check" : entry.testType === "retest" ? "Targeted retest" : "Spelling check")}: ${entry.score}/${entry.total} (${entry.percent}%)</span>
          <span>Words: ${Array.isArray(entry.responses) ? entry.responses.filter(r => typeof r?.word === "string").map(r => escapeHtml(r.word)).join(", ") || "not recorded" : "not recorded"}</span>`}
      </li>`).join("")}</ul></section>`).join("")}`;
}

function messageScreen({ symbol, eyebrow, title, body, action }) {
  return `
    <section class="center-shell">
      <article class="book-card feedback-card">
        <div class="orb" aria-hidden="true">${symbol}</div>
        <p class="eyebrow">${eyebrow}</p>
        <h1>${title}</h1>
        <p class="lede compact">${body}</p>
        <button class="primary-button" id="primary-action" type="button">${action} <span aria-hidden="true">→</span></button>
      </article>
    </section>
  `;
}

function levelInstruction(level, fallback) {
  const instructions = {
    1: "Use the model to put the letters in order.",
    2: "Build the word you just studied.",
    3: "Listen, then arrange the letters without a model.",
    4: fallback ? "Voice input is unavailable, so use the letter tiles." : "Tap the microphone, then say the word or spell each letter in order.",
    5: "Listen, then type the whole word from memory.",
  };
  return instructions[level];
}

function startVoiceLetters() {
  if (recognition) {
    stopRecognition();
    session.voiceFallback = true;
    session.voiceStatus = "Microphone stopped. Use the tiles or try again.";
    renderTeachingTask();
    return;
  }
  stopRecognition();
  stopSpeech();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    session.voiceFallback = true;
    session.voiceStatus = "Voice spelling is not supported in this browser. Letter tiles are ready instead.";
    renderTeachingTask();
    return;
  }
  session.voiceFallback = false;
  try {
    recognition = new Recognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.maxAlternatives = 10;
  } catch {
    stopRecognition();
    session.voiceFallback = true;
    session.voiceStatus = "The microphone could not be set up. Use the letter tiles instead.";
    renderTeachingTask();
    return;
  }
  const activeRecognition = recognition;
  const activeSession = session;
  const activeTask = session.currentTask;
  const isCurrent = () => recognition === activeRecognition && session === activeSession && session.currentTask === activeTask;
  const button = app.querySelector("#mic-button");
  const heard = app.querySelector("#heard-text");
  if (button) button.classList.add("listening");
  if (button) button.setAttribute("aria-label", "Stop listening");
  if (heard) heard.textContent = "Listening… say the word, or spell each letter like A, I, R.";

  recognition.onstart = () => {
    if (!isCurrent()) return;
    if (heard) heard.textContent = "Listening… say the word, or spell each letter like A, I, R.";
  };

  recognition.onresult = (event) => {
    if (!isCurrent()) return;
    const alternatives = Array.from(event.results?.[0] || [], (result) => result.transcript);
    const match = matchSpokenSpelling(alternatives, session.currentTask.word);
    if (match) {
      session.letterTiles.forEach((tile) => {
        tile.used = false;
      });
      session.builtTileIds = [];
      match.letters.forEach(addSpokenLetter);
      session.voiceStatus = `I heard: “${match.transcript}”. All letters are in place.`;
    } else {
      const transcript = alternatives[0] ?? "";
      session.voiceStatus = `I heard: “${transcript}”. I did not get the whole word, so no tiles were moved. Try the word slowly or spell each letter.`;
    }
    renderTeachingTask();
    if (match) speakLetterSequence(match.letters);
  };

  recognition.onnomatch = () => {
    if (!isCurrent()) return;
    session.voiceFallback = true;
    session.voiceStatus = "I heard your voice but could not match the letters. Try saying one letter at a time.";
    renderTeachingTask();
  };

  recognition.onerror = (event) => {
    if (!isCurrent()) return;
    session.voiceFallback = true;
    session.voiceStatus = speechRecognitionErrorMessage(event.error);
    renderTeachingTask();
  };
  recognition.onend = () => {
    if (!isCurrent()) return;
    recognition = null;
    session.voiceFallback = true;
    session.voiceStatus = "Listening ended without a complete result. Use the letter tiles or try the microphone again.";
    renderTeachingTask();
  };
  try {
    recognition.start();
  } catch {
    session.voiceFallback = true;
    session.voiceStatus = "The microphone could not start. Letter tiles are ready while you check browser microphone permission.";
    renderTeachingTask();
  }
}

function speechRecognitionErrorMessage(error) {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return window.location.protocol === "file:"
      ? "This file preview cannot use speech recognition reliably. Open SpellQuest from an HTTPS address or through the local server. Letter tiles are ready for now."
      : "Microphone access is blocked. Allow microphone access for this site, then try again. Letter tiles are ready for now.";
  }
  if (error === "audio-capture") {
    return "No working microphone was found. Check the microphone connection and browser input setting, then try again.";
  }
  if (error === "network") {
    return "Speech recognition could not reach its service. Check the internet connection and try again.";
  }
  if (error === "no-speech") {
    return "I did not hear any letters. Move closer to the microphone and try again.";
  }
  if (error === "language-not-supported") {
    return "English speech recognition is unavailable in this browser. Letter tiles are ready instead.";
  }
  return "Voice spelling stopped unexpectedly. Try the microphone again or use the letter tiles.";
}

function addSpokenLetter(letter) {
  const available = session.letterTiles.find((tile) => !tile.used && tile.letter === letter);
  if (!available) return false;
  addTile(available.id);
  return true;
}

function speakWord(word, requested = false) {
  const example = WORD_DETAILS[word]?.sentence;
  const prompt = example ? `${spellingPrompt(word)}. ${example} The word is ${word}.` : `${spellingPrompt(word)}. ${word}.`;
  speak(prompt, speechRate, requested);
}

function speakSentence(word, requested = false) {
  const detail = WORD_DETAILS[word];
  if (detail) speak(detail.sentence, speechRate, requested);
}

function speak(text, rate = speechRate, requested = false) {
  if (muted && !requested) return;
  if (!("speechSynthesis" in window)) { showNarrationFailure(); return; }
  if (requested) stopRecognition(true);
  stopSpeech();
  queueSpeech(text, rate, requested, true);
}

function speakLetterSequence(letters) {
  for (const letter of letters) queueSpeech(letter.toLocaleLowerCase("en-US"), speechRate);
}

function queueSpeech(text, rate = speechRate, requested = false, isPrompt = false) {
  if ((muted && !requested) || recognition || problemDialog.open || !("speechSynthesis" in window)) return;
  if (!preferredVoice) refreshPreferredVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  if (preferredVoice) utterance.voice = preferredVoice;
  utterance.lang = preferredVoice?.lang || "en-US";
  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.volume = 1;
  const generation = speechGeneration;
  let startTimer = null;
  const clearStartTimer = () => {
    if (startTimer === null) return;
    window.clearTimeout(startTimer);
    pendingPrompts.delete(startTimer);
    startTimer = null;
  };
  if (isPrompt) {
    const status = app.querySelector("#narration-status");
    if (status) { status.hidden = false; status.textContent = "Starting the spoken word automatically…"; }
    startTimer = window.setTimeout(() => {
      pendingPrompts.delete(startTimer);
      startTimer = null;
      if (generation !== speechGeneration) return;
      showNarrationFailure();
      const status = app.querySelector("#narration-status");
      if (status) status.textContent = "The browser did not start the voice. Ask an adult to check device sound and open the game’s web address in Chrome or Safari, or use Adult help below. Your answer has not been marked.";
    }, 5000);
    pendingPrompts.add(startTimer);
  }
  activeUtterances.add(utterance);
  utterance.onstart = () => {
    clearStartTimer();
    if (!isPrompt || generation !== speechGeneration) return;
    const status = app.querySelector("#narration-status");
    if (status) { status.hidden = false; status.textContent = "Listen to the word. You can replay it with Hear the word."; }
  };
  utterance.onerror = (event) => {
    clearStartTimer();
    activeUtterances.delete(utterance);
    if (isPrompt && generation === speechGeneration && !["canceled", "interrupted"].includes(event.error)) showNarrationFailure();
  };
  utterance.onend = () => {
    clearStartTimer();
    activeUtterances.delete(utterance);
    if (!isPrompt || generation !== speechGeneration) return;
    narrationFailed = false;
    const status = app.querySelector("#narration-status");
    if (status) { status.hidden = false; status.textContent = "The prompt has finished playing. Tap Hear the word to hear it again."; }
  };
  try {
    if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  } catch {
    clearStartTimer();
    activeUtterances.delete(utterance);
    if (isPrompt) showNarrationFailure();
  }
}

function showNarrationFailure() {
  narrationFailed = true;
  const status = app.querySelector("#narration-status");
  if (status) {
    status.hidden = false;
    status.textContent = "The voice is unavailable. Retry Hear the word or ask an adult to open Adult help below and read the prompt. Your answer has not been marked.";
  }
}

function playSpellSparkSound() {
  if (muted) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  try {
    magicAudioContext ??= new AudioContextClass();
    if (magicAudioContext.state === "suspended") void magicAudioContext.resume();

    const start = magicAudioContext.currentTime + 0.015;
    const notes = [
      { frequency: 523.25, delay: 0, volume: 0.08 },
      { frequency: 659.25, delay: 0.09, volume: 0.075 },
      { frequency: 783.99, delay: 0.18, volume: 0.07 },
      { frequency: 1046.5, delay: 0.31, volume: 0.09 },
    ];

    for (const note of notes) {
      const toneStart = start + note.delay;
      const oscillator = magicAudioContext.createOscillator();
      const shimmer = magicAudioContext.createOscillator();
      const toneGain = magicAudioContext.createGain();
      const shimmerGain = magicAudioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, toneStart);
      shimmer.type = "sine";
      shimmer.frequency.setValueAtTime(note.frequency * 2, toneStart);

      toneGain.gain.setValueAtTime(0.0001, toneStart);
      toneGain.gain.exponentialRampToValueAtTime(note.volume, toneStart + 0.018);
      toneGain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.42);
      shimmerGain.gain.setValueAtTime(0.0001, toneStart);
      shimmerGain.gain.exponentialRampToValueAtTime(note.volume * 0.22, toneStart + 0.012);
      shimmerGain.gain.exponentialRampToValueAtTime(0.0001, toneStart + 0.24);

      oscillator.connect(toneGain).connect(magicAudioContext.destination);
      shimmer.connect(shimmerGain).connect(magicAudioContext.destination);
      oscillator.start(toneStart);
      shimmer.start(toneStart);
      oscillator.stop(toneStart + 0.44);
      shimmer.stop(toneStart + 0.26);
    }
  } catch {
    // A correct answer should still advance if audio is unavailable.
  }
}

function stopActivity() {
  screenGeneration += 1;
  stopTimer();
  stopRecognition();
  stopSpeech();
}

function schedulePrompt(callback, delay) {
  const timer = window.setTimeout(() => {
    pendingPrompts.delete(timer);
    if (!problemDialog.open && !recognition) callback();
  }, delay);
  pendingPrompts.add(timer);
}

function stopSpeech() {
  activeUtterances.clear();
  speechGeneration += 1;
  pendingPrompts.forEach((timer) => window.clearTimeout(timer));
  pendingPrompts.clear();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function stopTimer() {
  if (activeTimer) window.clearInterval(activeTimer);
  activeTimer = null;
}

function stopRecognition(recoverControls = false) {
  if (!recognition) return;
  const previous = recognition;
  recognition = null;
  previous.onstart = previous.onresult = previous.onnomatch = previous.onerror = previous.onend = null;
  try {
    previous.abort();
  } catch {
    // The recognizer may already be stopped.
  }
  if (recoverControls && session?.view === "teaching" && session.currentTask?.level === 4) {
    session.voiceFallback = true;
    session.voiceStatus = "Microphone stopped. Use the letter tiles or try again.";
    renderTeachingTask();
  }
}

function currentStage() {
  return session?.stages[session.stageIndex];
}

function resultHeadline(percent) {
  if (percent === 100) return "Every spell matched";
  if (percent >= 80) return "Strong remembering";
  if (percent >= 60) return "Your memory is growing";
  return "Practice makes words stick";
}

function successMessage() {
  const messages = ["Nicely remembered.", "That word is getting stronger.", "Careful work.", "You built it correctly."];
  return messages[Math.floor(Math.random() * messages.length)];
}

function addSparkles() {
  const template = document.querySelector("#sparkles-template");
  app.querySelector(".book-card")?.append(template.content.cloneNode(true));
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function focusMain(target = app) {
  saveCheckpoint();
  const generation = screenGeneration;
  window.scrollTo({ top: 0, behavior: "auto" });
  window.setTimeout(() => { if (generation === screenGeneration && !problemDialog.open) target.focus({ preventScroll: true }); }, 0);
}

updateSoundButton();
renderHome();
