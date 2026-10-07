import {
  LEVEL_NAMES,
  LESSONS,
  WORD_DETAILS,
  buildCodexReportUrl,
  buildProblemPrompt,
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
let muted = localStorage.getItem(SOUND_KEY) === "muted";
let preferredVoice = null;
let magicAudioContext = null;
const pendingPrompts = new Set();

function refreshPreferredVoice() {
  if (!("speechSynthesis" in window)) return;
  preferredVoice = selectPreferredVoice(window.speechSynthesis.getVoices());
}

if ("speechSynthesis" in window) {
  refreshPreferredVoice();
  window.speechSynthesis.addEventListener("voiceschanged", refreshPreferredVoice);
}

const dayDetails = {
  monday: { eyebrow: "Learn", summary: "Learn and check four red words", icon: "☾" },
  tuesday: { eyebrow: "Use the words", summary: "Spell each word and write a sentence", icon: "✦" },
  wednesday: { eyebrow: "Use them again", summary: "Spell each word and write a new sentence", icon: "✧" },
  thursday: { eyebrow: "Remember", summary: "Delayed spelling check and targeted practice", icon: "★" },
};

homeButton.addEventListener("click", () => {
  stopActivity();
  session = null;
  renderHome();
});

soundButton.addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem(SOUND_KEY, muted ? "muted" : "on");
  updateSoundButton();
  if (muted) {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (magicAudioContext) void magicAudioContext.close();
    magicAudioContext = null;
  }
});

reportButton.addEventListener("click", () => {
  stopRecognition();
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
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function renderHome() {
  stopActivity();
  const history = getHistory();
  app.innerHTML = `
    <section class="home-shell">
      <div class="hero-copy">
        <p class="eyebrow">Week of ${escapeHtml(CURRENT_WEEK.label)} · Four red words</p>
        <h1>Choose your day</h1>
        <p class="lede">Learn to spell <strong>${CURRENT_WEEK.spellingTargets.map(escapeHtml).join(", ")}</strong>, then use each word in your own sentences.</p>
      </div>

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

  app.querySelector("#clear-progress")?.addEventListener("click", () => {
    if (window.confirm("Clear every saved SpellQuest score on this device?")) {
      localStorage.removeItem(HISTORY_KEY);
      renderHome();
    }
  });
  focusMain();
}

function startDay(day) {
  const stages = createDayStages(day, getHistory());
  session = { id: `${day}-${Date.now()}`, day, stages, stageIndex: 0, taskIndex: 0, currentTask: null };
  renderStageIntro();
}

function renderStageIntro() {
  stopActivity();
  const stage = currentStage();
  if (!stage) return renderDayComplete();

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

function renderTeachingTask() {
  stopActivity();
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
  focusMain();
  if (shouldAnnounce && !muted) schedulePrompt(() => speakWord(task.word), 350);
}

function renderMemoryPreview() {
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
            <p id="heard-text">${escapeHtml(voiceStatus)}</p>
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
      renderTeachingTask();
      if (letter) speakLetterSequence([letter]);
    });
  });
  app.querySelectorAll("[data-remove-tile]").forEach((button) => {
    button.addEventListener("click", () => {
      removeTile(button.dataset.removeTile);
      renderTeachingTask();
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

function renderTypingActivity() {
  return `
    <form class="typing-form" id="typing-form" autocomplete="off">
      <label for="spelling-input">Type the word you hear</label>
      <input id="spelling-input" name="spelling" type="text" inputmode="text" autocomplete="off" autocapitalize="none" spellcheck="false" required />
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
  window.setTimeout(() => input.focus(), 50);
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
  stopActivity();
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
              : "Write a complete thought using the red word and other words. End with a period, question mark, or exclamation point."
          }
        </p>
        ${isSpelling ? renderListenButtons(word, false) : ""}
        <form class="typing-form sentence-form" id="sentence-practice-form" autocomplete="off">
          <label for="sentence-practice-input">${isSpelling ? "Type the word" : "Your sentence"}</label>
          ${
            isSpelling
              ? '<input id="sentence-practice-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required />'
              : '<textarea id="sentence-practice-input" rows="4" maxlength="240" spellcheck="true" required></textarea>'
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
    playSpellSparkSound();
    renderSentencePractice();
  });
  if (isSpelling) bindLetterEcho(input);
  schedulePrompt(() => {
    if (isSpelling) speakWord(word);
    input.focus();
  }, 250);
  focusMain();
}

function renderSentencePracticeComplete() {
  app.innerHTML = messageScreen({
    symbol: "✎",
    eyebrow: `${capitalize(session.day)} practice complete`,
    title: "Four words, four sentences",
    body: "You spelled every red word and used each one in a sentence.",
    action: `Finish ${capitalize(session.day)}`,
  });
  addSparkles();
  app.querySelector("#primary-action").addEventListener("click", advanceStage);
  focusMain();
}

function startTest(stage) {
  session.test = { stage, index: 0, responses: [], selfScoreIndex: 0 };
  renderTestWord();
}

function renderTestWord() {
  stopActivity();
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
          <input id="test-input" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required />
          <button class="primary-button" type="submit">Save and continue <span aria-hidden="true">→</span></button>
        </form>
        <p class="test-promise"><span aria-hidden="true">◌</span> No answers are marked yet.</p>
      </article>
    </section>
  `;
  bindListenButtons(word, false);
  const input = app.querySelector("#test-input");
  app.querySelector("#test-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    session.test.responses.push({ word, answer: input.value.trim() });
    session.test.index += 1;
    renderTestWord();
  });
  bindLetterEcho(input);
  schedulePrompt(() => {
    speakWord(word);
    input.focus();
  }, 300);
  focusMain();
}

function renderSelfScoring(shake = false) {
  stopActivity();
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
    id: `${Date.now()}-${stage.id}`,
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
  const history = [...getHistory(), entry];
  saveHistory(history);
  if (stage.id === "thursday-delayed" && missedWords.length) {
    session.stages.splice(session.stageIndex + 1, 0, ...createThursdayReteachStages(missedWords));
  }
  renderTestResult(entry, history);
}

function renderTestResult(entry, history) {
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
  const day = session.day;
  const completionMessages = {
    monday: "You learned all four red words and completed a spelling check.",
    tuesday: "You spelled all four red words and used each one in a sentence.",
    wednesday: "You practiced all four words again in new sentences.",
    thursday: "You completed the delayed spelling check and practiced any word that needed help.",
  };
  app.innerHTML = messageScreen({
    symbol: "✦",
    eyebrow: `${capitalize(day)} complete`,
    title: "Your spellbook is stronger",
    body: completionMessages[day],
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
  return `
    <div class="listen-row">
      <button class="listen-button" data-speak-word type="button"><span aria-hidden="true">🔊</span> Hear the word</button>
      ${includeSentence ? '<button class="sentence-button" data-speak-sentence type="button">Hear it in a sentence</button>' : ""}
    </div>
  `;
}

function bindListenButtons(word, includeSentence = true) {
  app.querySelector("[data-speak-word]")?.addEventListener("click", () => speakWord(word, true));
  if (includeSentence) {
    app.querySelector("[data-speak-sentence]")?.addEventListener("click", () => speakSentence(word, true));
  }
}

function renderWordPreview(words) {
  return `<div class="word-preview">${words.map((word) => `<span>${escapeHtml(word)}</span>`).join("")}</div>`;
}

function renderGraph(history, compact = false) {
  if (!history.length) {
    return `
      <div class="empty-graph">
        <div class="empty-stars" aria-hidden="true">✧ · ✦ · ✧</div>
        <p>Your test scores will appear here.</p>
      </div>
    `;
  }
  const width = compact ? 480 : 760;
  const height = compact ? 170 : 220;
  const padding = { left: 42, right: 18, top: 18, bottom: 34 };
  const usableWidth = width - padding.left - padding.right;
  const usableHeight = height - padding.top - padding.bottom;
  const points = history.map((entry, index) => {
    const x = padding.left + (history.length === 1 ? usableWidth / 2 : (index / (history.length - 1)) * usableWidth);
    const y = padding.top + usableHeight - (entry.percent / 100) * usableHeight;
    return { x, y, entry };
  });
  const polyline = points.map(({ x, y }) => `${x},${y}`).join(" ");
  return `
    <div class="graph-scroll" role="img" aria-label="Test scores: ${history.map((entry) => `${entry.percent} percent`).join(", ")}">
      <svg class="score-graph" viewBox="0 0 ${width} ${height}" aria-hidden="true">
        ${[0, 25, 50, 75, 100]
          .map((score) => {
            const y = padding.top + usableHeight - (score / 100) * usableHeight;
            return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" class="grid-line"/><text x="${padding.left - 8}" y="${y + 4}" text-anchor="end">${score}</text>`;
          })
          .join("")}
        ${points.length > 1 ? `<polyline points="${polyline}" class="score-line"/>` : ""}
        ${points
          .map(
            ({ x, y, entry }, index) => `
              <circle cx="${x}" cy="${y}" r="7" class="score-dot day-dot-${entry.day}"/>
              <text x="${x}" y="${height - 10}" text-anchor="middle">${index + 1}</text>
            `,
          )
          .join("")}
      </svg>
    </div>
    <div class="graph-legend"><span>Test attempt</span><strong>Latest: ${history.at(-1).score}/${history.at(-1).total} · ${history.at(-1).percent}%</strong></div>
  `;
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
  recognition = new Recognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.continuous = false;
  recognition.maxAlternatives = 10;
  const activeRecognition = recognition;
  const button = app.querySelector("#mic-button");
  const heard = app.querySelector("#heard-text");
  if (button) button.classList.add("listening");
  if (heard) heard.textContent = "Listening… say the word, or spell each letter like A, I, R.";

  recognition.onstart = () => {
    if (heard) heard.textContent = "Listening… say the word, or spell each letter like A, I, R.";
  };

  recognition.onresult = (event) => {
    const alternatives = Array.from(event.results[0], (result) => result.transcript);
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
    session.voiceStatus = "I heard your voice but could not match the letters. Try saying one letter at a time.";
    renderTeachingTask();
  };

  recognition.onerror = (event) => {
    if (event.error === "aborted") return;
    const blockingError = ["not-allowed", "service-not-allowed", "audio-capture"].includes(event.error);
    session.voiceFallback = blockingError;
    session.voiceStatus = speechRecognitionErrorMessage(event.error);
    renderTeachingTask();
  };
  recognition.onend = () => {
    button?.classList.remove("listening");
    if (recognition === activeRecognition) recognition = null;
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
  speak(prompt, 0.8, requested);
}

function speakSentence(word, requested = false) {
  const detail = WORD_DETAILS[word];
  if (detail) speak(detail.sentence, 0.86, requested);
}

function speak(text, rate = 0.9, requested = false) {
  if ((muted && !requested) || !("speechSynthesis" in window)) return;
  if (requested) stopRecognition();
  stopSpeech();
  queueSpeech(text, rate, requested);
}

function speakLetterSequence(letters) {
  for (const letter of letters) queueSpeech(letter.toLocaleLowerCase("en-US"), 0.76);
}

function queueSpeech(text, rate = 0.9, requested = false) {
  if ((muted && !requested) || recognition || problemDialog.open || !("speechSynthesis" in window)) return;
  if (!preferredVoice) refreshPreferredVoice();
  const utterance = new SpeechSynthesisUtterance(text);
  if (preferredVoice) utterance.voice = preferredVoice;
  utterance.lang = preferredVoice?.lang || "en-US";
  utterance.rate = rate;
  utterance.pitch = 1;
  utterance.volume = 1;
  window.speechSynthesis.speak(utterance);
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
  pendingPrompts.forEach((timer) => window.clearTimeout(timer));
  pendingPrompts.clear();
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function stopTimer() {
  if (activeTimer) window.clearInterval(activeTimer);
  activeTimer = null;
}

function stopRecognition() {
  if (!recognition) return;
  try {
    recognition.abort();
  } catch {
    // The recognizer may already be stopped.
  }
  recognition = null;
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

function focusMain() {
  window.scrollTo({ top: 0, behavior: "smooth" });
  window.setTimeout(() => app.focus({ preventScroll: true }), 0);
}

updateSoundButton();
renderHome();
