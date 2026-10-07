import {
  LEVEL_NAMES,
  LESSONS,
  WORD_DETAILS,
  buildCodexReportUrl,
  buildProblemPrompt,
  createDayStages,
  isCorrectSpelling,
  normalizeSpelling,
  shuffledLetters,
} from "./engine.js";

const HISTORY_KEY = "spellcraft-history-v1";
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

const dayDetails = {
  monday: { eyebrow: "Begin here", summary: "Learn and test five words", icon: "☾" },
  tuesday: { eyebrow: "Remember + learn", summary: "Test five, then learn five", icon: "✦" },
  wednesday: { eyebrow: "Build your memory", summary: "Test ten, then learn five", icon: "✧" },
  thursday: { eyebrow: "Strengthen", summary: "Reteach Wednesday's missed words", icon: "★" },
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
  if (muted && "speechSynthesis" in window) window.speechSynthesis.cancel();
});

reportButton.addEventListener("click", () => {
  stopActivity();
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

function updateSoundButton() {
  soundButton.innerHTML = `<span aria-hidden="true">${muted ? "🔇" : "🔊"}</span> Sound ${muted ? "off" : "on"}`;
  soundButton.setAttribute("aria-pressed", String(muted));
}

function createCurrentProblemReport() {
  return buildProblemPrompt({
    details: problemDetails.value,
    screen: app.querySelector("h1")?.textContent?.trim() || "SpellCraft",
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
        <p class="eyebrow">A little practice. Lasting recall.</p>
        <h1>Choose your day</h1>
        <p class="lede">Build each word step by step, then check what you remember.</p>
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
    if (window.confirm("Clear every saved SpellCraft score on this device?")) {
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

  if (stage.type === "needs-wednesday") {
    app.innerHTML = messageScreen({
      symbol: "☾",
      eyebrow: "Thursday review",
      title: "Wednesday comes first",
      body: "Complete both Wednesday word checks so SpellCraft knows which words need more practice.",
      action: "Choose another day",
    });
    app.querySelector("#primary-action").addEventListener("click", renderHome);
    focusMain();
    return;
  }

  if (stage.type === "mastery") {
    app.innerHTML = messageScreen({
      symbol: "★",
      eyebrow: "Thursday review",
      title: "Every word was remembered",
      body: "You spelled all fifteen words correctly on Wednesday. There are no words to reteach today.",
      action: "See my progress",
    });
    app.querySelector("#primary-action").addEventListener("click", renderHome);
    focusMain();
    return;
  }

  const isTeaching = stage.type === "teaching";
  const description = isTeaching
    ? `${stage.words.length} ${stage.words.length === 1 ? "word" : "words"} will move through five learning steps with memory checks woven in.`
    : `${stage.words.length} ${stage.words.length === 1 ? "word" : "words"}. Type every answer first; you will check your work only at the end.`;

  app.innerHTML = `
    <section class="center-shell">
      ${renderDayProgress()}
      <article class="book-card intro-card">
        <div class="orb" aria-hidden="true">${isTeaching ? "✦" : "✓"}</div>
        <p class="eyebrow">${capitalize(session.day)} · ${isTeaching ? "Teaching" : "No-feedback test"}</p>
        <h1>${escapeHtml(stage.title)}</h1>
        <p class="lede compact">${description}</p>
        ${isTeaching ? renderWordPreview(stage.words) : '<p class="promise"><span aria-hidden="true">◌</span> Answers stay private until the whole test is finished.</p>'}
        <button class="primary-button" id="primary-action" type="button">
          ${isTeaching ? "Begin teaching" : "Start word check"} <span aria-hidden="true">→</span>
        </button>
      </article>
    </section>
  `;

  app.querySelector("#primary-action").addEventListener("click", () => {
    if (isTeaching) startTeaching(stage);
    else startTest(stage);
  });
  focusMain();
}

function startTeaching(stage) {
  stage.runtimeTasks = stage.tasks.map((task) => ({ ...task }));
  session.taskIndex = 0;
  loadTeachingTask();
}

function loadTeachingTask() {
  stopActivity();
  const stage = currentStage();
  if (session.taskIndex >= stage.runtimeTasks.length) {
    advanceStage();
    return;
  }
  session.currentTask = stage.runtimeTasks[session.taskIndex];
  session.voiceFallback = false;
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
  if (task.level === 4 && !voiceSupported) session.voiceFallback = true;

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
  if (task.level >= 3 && shouldAnnounce && !muted) window.setTimeout(() => speakWord(task.word), 350);
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
              <span>${voiceSupported ? "Speak letters" : "Voice unavailable"}</span>
            </button>
            <p id="heard-text">${session.voiceFallback ? "Keyboard fallback is on." : "Tap the microphone, then spell the word aloud."}</p>
            ${voiceSupported ? '<button class="text-button" id="voice-fallback" type="button">Use keyboard instead</button>' : ""}
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
      addTile(button.dataset.addTile);
      renderTeachingTask();
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
    renderTeachingTask();
  });
  if (task.level === 4 && voiceSupported && !session.voiceFallback) {
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
  window.setTimeout(() => input.focus(), 50);
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
  window.setTimeout(() => {
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
  renderStageIntro();
}

function renderDayComplete() {
  const day = session.day;
  app.innerHTML = messageScreen({
    symbol: "✦",
    eyebrow: `${capitalize(day)} complete`,
    title: "Your spellbook is stronger",
    body: day === "wednesday" ? "Wednesday’s missed words are ready for Thursday’s targeted practice." : "Your results have been added to the progress graph on this device.",
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
      <span>${percent}% through this lesson</span>
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
  app.querySelector("[data-speak-word]")?.addEventListener("click", () => speakWord(word));
  if (includeSentence) {
    app.querySelector("[data-speak-sentence]")?.addEventListener("click", () => speakSentence(word));
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
    4: fallback ? "Voice input is unavailable, so use the letter tiles." : "Tap the microphone and say each letter in order.",
    5: "Listen, then type the whole word from memory.",
  };
  return instructions[level];
}

function startVoiceLetters() {
  stopRecognition();
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) return;
  recognition = new Recognition();
  recognition.lang = "en-US";
  recognition.interimResults = false;
  recognition.continuous = false;
  const button = app.querySelector("#mic-button");
  const heard = app.querySelector("#heard-text");
  if (button) button.classList.add("listening");
  if (heard) heard.textContent = "Listening… say the letters in order.";

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    const letters = parseSpokenLetters(transcript, session.currentTask.word);
    if (heard) heard.textContent = `I heard: “${transcript}”`;
    letters.forEach(addSpokenLetter);
    window.setTimeout(renderTeachingTask, 550);
  };
  recognition.onerror = () => {
    if (heard) heard.textContent = "I didn’t catch that. Tap the microphone and try again.";
    if (button) button.classList.remove("listening");
  };
  recognition.onend = () => button?.classList.remove("listening");
  recognition.start();
}

function parseSpokenLetters(transcript, word) {
  const clean = transcript.toLocaleLowerCase("en-US").trim();
  if (normalizeSpelling(clean) === normalizeSpelling(word)) return [...normalizeSpelling(word)];
  const names = {
    a: "a", ay: "a", b: "b", bee: "b", be: "b", c: "c", see: "c", sea: "c",
    d: "d", dee: "d", e: "e", f: "f", ef: "f", g: "g", gee: "g", h: "h", aitch: "h",
    i: "i", eye: "i", j: "j", jay: "j", k: "k", kay: "k", l: "l", el: "l", m: "m", em: "m",
    n: "n", en: "n", o: "o", oh: "o", p: "p", pea: "p", q: "q", cue: "q", r: "r", are: "r",
    s: "s", ess: "s", t: "t", tea: "t", u: "u", you: "u", v: "v", vee: "v", w: "w",
    x: "x", ex: "x", y: "y", why: "y", z: "z", zee: "z", zed: "z",
  };
  const tokens = clean.replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
  const result = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] === "double" && names[tokens[index + 1]]) {
      result.push(names[tokens[index + 1]], names[tokens[index + 1]]);
      index += 1;
    } else if (names[tokens[index]]) {
      result.push(names[tokens[index]]);
    } else if (tokens[index].length === 1) {
      result.push(tokens[index]);
    }
  }
  return result;
}

function addSpokenLetter(letter) {
  const available = session.letterTiles.find((tile) => !tile.used && tile.letter === letter);
  if (available) addTile(available.id);
}

function speakWord(word) {
  speak(word, 0.78);
}

function speakSentence(word) {
  const detail = WORD_DETAILS[word];
  if (detail) speak(detail.sentence, 0.82);
}

function speak(text, rate = 0.82) {
  if (muted || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = rate;
  utterance.pitch = 1.02;
  window.speechSynthesis.speak(utterance);
}

function stopActivity() {
  stopTimer();
  stopRecognition();
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
