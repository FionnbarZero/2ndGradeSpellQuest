# 2nd Grade SpellQuest

2nd Grade SpellQuest is a browser-based spelling and sentence-writing tutor driven by the class's weekly focus. It combines scaffolded letter activities, sentence practice, delayed tests, child-led self-scoring, targeted Thursday reteaching, and separate local records for daily practice, full tests, and targeted retests.

## Current curriculum

The week of October 5–9 comes from the classroom deck **26-27 G2 Weekly Focus**.

- **Red words used in this spelling game:** air, means, years, here
- **General Academic reading targets saved for a future reading game:** eager, explained, soldiers, message, change

The source identifiers and both word groups are stored in `dist/curriculum.js`. They are bundled into the static game so the child does not need access to the private Google Slides deck.

## Weekly sequence

- **Monday:** Teach all four red words with the five-step spelling sequence, then complete an immediate word check.
- **Tuesday:** Spell each red word from a visible prompt, then use it in a sentence.
- **Wednesday:** Spell each red word again, then use it in a new sentence.
- **Thursday:** Complete a delayed spelling test of all four words. Any missed word is retaught and retested that day.

## Learning sequence

Each new word progresses through:

1. Visible unscramble
2. Five-second memory unscramble
3. Independent unscramble
4. Voice-controlled unscramble
5. Typed spelling
6. Delayed-feedback test and self-scoring

Previously practiced words are interleaved at Level 5 while the four words are learned (29 teaching tasks on Monday). Two errors at a level move the word back one level. Test results and daily completion are stored only in the current browser. Sentence text is never included in permanent progress records. Temporary lesson checkpoints and sentence drafts use sessionStorage to survive refreshes in the same tab. Browser tab/session restoration may retain this temporary data; it is not an encrypted vault. Finishing a day clears its checkpoint.

If storage is blocked or full, the game warns and continues in memory. Malformed saved history is preserved in a recovery key before any replacement; if that backup fails, it is left untouched. Closing the page while storage is unavailable loses unsaved work.

Sentence checks only establish that the red word, another distinct word, and ending punctuation are present. They do not evaluate grammar or meaning. An optional adult review shows the temporary sentences and records a self-reported review flag without storing sentence text.

If the first Thursday retest still has missed words, the learner may choose one extra targeted practice/retest round. Remaining words stay marked as needing practice, with an adult-help recommendation. Completion is not the same as mastery. Scores from older versions are retained and labeled with an unknown curriculum week rather than guessed.

Every correct teaching answer earns a visible Spell Spark with a short magical chime. The running total stays beside the lesson progress, and the learner uses the collected sparks to charge the spellbook at the end of the teaching sequence before beginning the word check. The chime follows the app's Sound on/off control.

## Run locally

```sh
npm run serve
```

Then open <http://localhost:4173>.

## Test

```sh
npm test
```

The app has no runtime package dependencies. Fonts are requested from Google Fonts. Voice input uses the browser's Speech Recognition API when available and provides a clearly labeled letter-tile fallback when it is not. Browser speech recognition may send microphone audio to the browser provider; SpellQuest does not store recordings. The microphone screen explains this and recommends asking an adult first. No microphone permission is requested until the learner presses the microphone button.

For microphone spelling, open the game from an HTTPS address or run `npm run serve` and use the localhost URL. Opening `dist/index.html` directly as a `file://` page can prevent Chrome from granting reliable microphone access. The voice step distinguishes permission, microphone, network, and no-speech failures and always keeps letter tiles available.

Every screen includes a **Report a problem** button. It prepares a privacy-conscious diagnostic prompt and opens a new repository-aware Codex chat using the documented `codex://` deep-link scheme. The reporter reviews and sends the message; reports are never submitted silently. A clipboard fallback is included for devices without the Codex desktop app.

Audio prompts say “Spell [word],” followed by the context sentence. Each lowercase letter is spoken as the learner places a tile or types. With Sound on, each spelling screen queues its prompt directly in the action that opens it (no artificial timer or extra Hear click), including resumed lessons and memory previews. Turning Sound on during a spelling activity also reads the current word immediately. Actual sound onset still depends on the browser and voice provider. Sound off intentionally suppresses automatic narration; Hear the word remains an explicit replay. Prompts and letters use normal speed by default. Voice settings provide a preview, a saved voice choice, and slower/normal/faster speeds. Automatic selection prefers Chrome's Google US English voice when available, then premium/enhanced/natural US voices before standard system voices. If a saved voice is unavailable, the app explains the fallback and restores the choice when the voice list loads. On computer keyboards, Enter submits typed spelling and advances eligible instruction, feedback, and result screens.

This is browser text-to-speech, not a guaranteed Google AI voice or a paid Google Cloud integration. A paused speech engine is resumed before queuing audio. Missing/failed narration, including no start event within five seconds, displays a recovery message and an adult-only prompt to read aloud, with the child looking away. A detected narration failure does not score a test answer until narration succeeds or an adult confirms reading the prompt. Run the local web preview rather than opening the HTML file directly: JavaScript module loading requires an HTTP(S) origin. A browser reporting that a prompt was queued is not proof of audible playback.

## Updating a curriculum week

There is no automatic Google Slides synchronization. An adult must verify the class source, update `CURRENT_WEEK.id` (ISO start date), label, source identifiers and both target lists in `dist/curriculum.js`, and add matching spoken example sentences to `WORD_DETAILS` in `dist/engine.js`. Keep the four-red-word weekly format. Update the curriculum regression expectations in `test/engine.test.mjs`, run `npm test` and `npm run build`, then preview all four days before an authorized release. Reading targets stay separate from spelling targets. A new week does not overwrite older scores, and checkpoints from another week are not resumed.

## Release and verification boundaries

Production configuration is `wrangler.jsonc`: Worker `meghangames-2ndspellcraft`, hostname `2ndspellcraft.meghangames.com`. Never deploy this app to `spellcraft.meghangames.com` (the fifth-grade game). `.openai/hosting.json` is historical preview metadata, not the production destination.

Automated tests use isolated storage, timer, DOM and audio doubles; they do not establish real microphone accuracy or voice quality. Before declaring voice verified, an adult should test the four words and letter sequences on the actual Chrome/Safari/iPad devices, including denied permission and failed narration. Do not collect a child's real responses for automated tests. Local tests must use a separate localhost origin from the live game.
