# AIthena for Learn45

AIthena is a learning agent built as a PWA, a prototype for Zentral Hack 2026 (CoreTeam AG challenge). The learner says what they want to learn. The agent plans short lessons for it: videos, podcasts, exercises and conversations with the AI. It remembers what the learner can already do and suggests the next step.

- Also runs without AI, with prepared content.
- With AI (Anthropic, OpenAI or Qwen), learners can add their own areas and get new lessons, which the server checks before showing them.
- Progress is stored on disk per learner and survives a restart.
- Lessons give experience points, levels and badges, with no points lost for breaks or mistakes.
- All data is synthetic.

The learners are often not very familiar with computers. That is why every view has one clear main action with a big button, the texts are simple and large, and technical terms (DCC, progress, rules, learning records) only appear in the settings.

The app is in English only: the interface, the lessons, the AI's replies and the narration.

**Contents:** [Getting started](#getting-started) · [The app](#the-app) · [Progress and rewards](#progress-and-rewards) · [Sign-in and DCC](#sign-in-and-dcc) · [Adding areas](#adding-areas) · [Next topic and format](#choosing-the-next-topic-and-format) · [Lesson types](#lesson-types) · [In the lesson window](#in-the-lesson-window) · [Generating videos and podcasts](#generating-videos-and-podcasts) · [How the agent decides](#how-the-agent-decides) · [Workspace per learner](#workspace-per-learner) · [Privacy](#privacy) · [Structure](#structure) · [Limitations](#limitations)

## Getting started

Requirement: Node.js 22.9 or newer.

```bash
npm install
npm run build     # builds the frontend
npm start         # http://localhost:8787
```

For development with hot reload:

```bash
npm run dev       # frontend http://localhost:5173, API on 8787
```

Tests and type checking:

```bash
npm test
npm run typecheck
```

### Connecting an AI (optional)

Without a key, everything runs with prepared content. Prepared replies and hints are labelled “Prepared” in the app.

For real AI replies, copy `backend/.env.example` to `backend/.env` and fill it in. With Anthropic (Messages API):

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-haiku-5-5          # chat, hints, judging
ANTHROPIC_PLANNER_MODEL=claude-opus-5-5   # planning, new areas, lessons
```

Or with OpenAI (Responses API; a plain chat completions endpoint is not enough):

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-6-luna                   # chat, hints, judging
OPENAI_PLANNER_MODEL=gpt-6-sol            # planning, new areas, lessons
OPENAI_REASONING_EFFORT=low
OPENAI_PLANNER_REASONING_EFFORT=low
```

Without `OPENAI_PLANNER_MODEL` the app uses `OPENAI_MODEL`. Both reasoning efforts default to `low`.

Or with Qwen, free and without a key (OpenAI-compatible chat completions):

```dotenv
MODEL_PROVIDER=qwen
MODEL_TIMEOUT_MS=30000
```

With all `QWEN_*` values empty, the app uses the free OVHcloud endpoint (Qwen2.5-VL-72B-Instruct) that the owl chat uses. That endpoint does not support tool calls, so the planner agent falls back to the rules. A local Ollama (`QWEN_BASE_URL=http://localhost:11434/v1`, `QWEN_MODEL=qwen2.5:7b`) supports them. Free models are slower, so set a longer timeout.

The key stays in the backend. The browser never talks to a model directly. If the model does not answer within 8 seconds, the app uses the prepared reply and labels it. If a plan fails, the rules take over. What is sent to the model is described under [Privacy](#privacy).

### More settings

All in `backend/.env`, all optional:

| Variable | Default | What for |
|---|---|---|
| `PORT` | `8787` | server port |
| `ACCESS_USERS` | empty (no login) | login for a public instance, `name:password` separated by commas (see [Going online](#going-online)) |
| `MODEL_TIMEOUT_MS` | `8000` | waiting time per model call, then prepared content |
| `PLANNER_TOTAL_MS`, `PLANNER_CALL_MS` | `45000`, `20000` | time limits of the planner agent: whole run and per call |
| `LEARNER_DIR` | `backend/var/learners` | folder of the learner workspaces |
| `VIDEO_SPEECH_PROVIDER` | `local` | `local` (macOS `say` and `ffmpeg`) or `elevenlabs` |
| `VIDEO_LOCAL_VOICE`, `VIDEO_LOCAL_SECOND_VOICE` | `Samantha`, `Daniel` | local English voices; the second one for podcasts |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_SECOND_VOICE_ID`, `ELEVENLABS_MODEL_ID` | model `eleven_multilingual_v2` | speech with ElevenLabs, on any platform |
| `FFMPEG_PATH` | `ffmpeg` on the search path | for local speech |
| `VIDEO_CACHE_DIR`, `VIDEO_SPEECH_CACHE_DIR`, `PODCAST_CACHE_DIR` | under `backend/var/` | where generated videos, speech and podcasts are stored |

The bundled lessons run without a speech service. You only need one for new videos and podcasts.

### Going online

`railway.json` describes running on Railway: `npm run build`, then `npm start`, with `/api/health` as the health check. One server delivers the API and the interface.

- **Login.** Without a login, anyone with the link can use the app, at the cost of your model key. So set `ACCESS_USERS`, for example `owner:long-secret,jury:other-secret`. The browser then asks for a name and password. Only `/api/health` stays open. Anyone with their own entry keeps access when another entry is removed.
- **Storage.** Railway's file system is wiped on every deploy. Attach a volume, for example at `/data`, and set `LEARNER_DIR=/data/learners`, `VIDEO_CACHE_DIR=/data/videos`, `VIDEO_SPEECH_CACHE_DIR=/data/video-speech` and `PODCAST_CACHE_DIR=/data/podcasts`.
- **Speech.** `local` needs macOS. For new videos and podcasts, set `VIDEO_SPEECH_PROVIDER=elevenlabs` with the ElevenLabs keys.
- **Revoking access.** Delete the entry from `ACCESS_USERS`; Railway restarts, and the old password no longer works.

## The app

**Home page.** “What would you like to learn?” lists the areas (Digital competence, Mathematics, Science, Own topics) with their topics, for example “Communication and collaboration”. Tapping a topic opens it; if it is not there yet, it gets added. At the top are XP, level, the daily and weekly goal and “Keep learning” with the topic worked on last, at the bottom the badges.

**A topic** is a climb over mountains. Every finished lesson is a step, six steps lead to a summit, then the next mountain begins (`frontend/src/path/mountains.ts`). The steps are in the order in which they were finished (`frontend/src/path/order.ts`). The sixth step is the summit test (see below). Afterwards the mountain is listed under “Mountains climbed” and is named after the criterion its lessons practised most; the next mountain starts empty. Below the steps is “What would you like to learn next?” with the choice of topic and format (see [Choosing the next topic and format](#choosing-the-next-topic-and-format)).

**Learning map.** “See everything as a map” shows everything as a mind map with the learner in the middle. It starts empty and grows with every area and every lesson. Planned lessons are faded. Tapping a node opens the side panel with the lesson, the agent's suggestion and its reasoning.

**Appearance.** Light, dark or following the system.

**Settings.** “My account” at the top right opens them, with four tabs:

- **General**: appearance, disconnecting the AI for the demo, signing out.
- **Profile**: DCC profile (read only), progress from learning, personal goal (mission) per area.
- **Learning**: learning records, cheat sheet, the agent's notes on preferences, learning history, observations.
- **Agent**: the agent's decisions and the planner agent's runs.

## Progress and rewards

Finished lessons give experience points (XP): 40 XP for finishing a lesson for the first time and up to 60 XP for learning goals reached. Every format counts the same; hints and learning speed do not change the points. When a lesson is repeated, only the improvement over the best previous result for that lesson counts. Every 200 XP the overall level and the level in that topic go up. These game levels are independent of the DCC profile.

The home page shows XP, topic levels, four badges to earn, a daily goal (one lesson) and a weekly goal (learn on three days). Day and week follow the Swiss calendar (`Europe/Zurich`, the week starts on Monday). Reviews count as a learning day but only give extra XP for an improvement. There is no loss of points for breaks or mistakes. When you finish, the XP earned, new levels and new badges appear.

Everything is derived from the stored learning events. Existing learners get their earlier progress automatically and keep it after restarts and signing in again. The points calculation is in `shared/src/rewards.ts`; the server delivers it in `SessionView.rewards` and as `reward` when a lesson is finished.

## Sign-in and DCC

A name is enough to sign in. The DCC profile is optional. It only sets the levels of the prepared Digital competence areas. Two ways:

1. **Load a result**: a JSON file in the format below. Three examples are in `frontend/public/dcc-examples/` and can be downloaded on the sign-in page.
2. **Enter levels**: per area Foundation, Intermediate, Advanced or “not assessed”.

```json
{
  "type": "dcc-result",
  "version": 1,
  "synthetic": true,
  "assessedOn": "2026-09-14",
  "areas": [
    { "area": "1", "name": "Information and data literacy", "level": "Grundstufe" },
    { "area": "2", "name": "Communication and collaboration", "level": "Mittelstufe" },
    { "area": "3", "name": "Digital content creation", "level": "Grundstufe" },
    { "area": "4", "name": "Safety", "level": "Mittelstufe" },
    { "area": "5", "name": "Problem solving", "level": null }
  ]
}
```

In the file, the levels keep their DCC codes: `Grundstufe` (Foundation), `Mittelstufe` (Intermediate) and `Fortgeschritten` (Advanced). The app shows them in English.

The DCC is the only source of levels. Learning in the app never changes the DCC profile. A missing value means “not assessed”, not “low”.

## Adding areas

After signing in, the map is empty. From the home page you can add:

- **A prepared area**: from `data/skills.json`, with checked sources and prepared lessons: the five DigComp areas, Mathematics or Science. This also works without AI, several at once too.
- **Your own topic**, for example “pass the Security+ exam”, only with AI. The learner gives the topic and their prior knowledge. The agent plans the area: a name, 3 to 6 criteria with rules of thumb, three mission suggestions, the matching lesson types and 2 to 5 sources. The server checks the draft. Of the sources, only addresses that answer when the area is created are kept (404 and 410 are dropped). Only a valid draft goes on the map. The first lesson is created when the learner chooses a topic and format.

After choosing a topic and format, the lesson opens directly. A personal goal (mission) can optionally be set under “My account”; without one, the agent uses the area's default goal.

Your own areas have no prepared lessons; the AI creates every lesson. When nothing is left open in the area, there is a “New lesson in …” button.

## Choosing the next topic and format

An open topic (and the side panel on the learning map) offers three short topic suggestions under “What would you like to learn next?”, one of them recommended, plus “Suggest something else”. On the map they appear as possible branches. The suggestions aim first at the criterion missed last, then at due reviews, then at criteria that are not yet “I can do it”. The mission and preferences are taken into account.

First you choose the topic, then one of the formats the topic plan names as suitable: Video, With the AI, Check a text or Check a website; with AI, Podcast is always included. Tapping a format starts the lesson; if a topic has only one format, it starts straight away. For generated lessons there are also formats for which the area has no prepared example yet.

**Summit test.** Once five steps of a mountain are done, “What would you like to learn next?” only offers the summit test. It tests up to three criteria that the mountain's five lessons practised most, each with its own task on a new example. The learner chooses the format as usual. Technically it is a mixed review (`reviewOf`), marked with `provenance.exam`. Even with gaps, the mountain counts as climbed afterwards; whatever was missing, the next mountain suggests first. Without AI, the sixth step is an ordinary prepared lesson. There is no celebration at the summit yet.

The suggestions are only previews. They create neither lesson files nor permanent nodes. Only starting the lesson creates exactly the chosen lesson in the chosen format, or uses a matching existing one. No follow-up lesson is created automatically after a lesson is finished either.

The format chosen last is saved and preselected next time if it is available, also after a server restart. Choosing a topic other than the recommended one is noted neutrally as “chose a different direction”.

Without AI, only prepared lessons are available, sometimes fewer than three. Your own topic requests need an AI connection and must fit the area's learning goals; for other goals you can add a new area. If topic planning fails, three rule-based suggestions remain. If the validator rejects the generated lesson, the AI gets the errors and a second attempt. If that fails too or the model does not answer, the choice stays available for a new attempt.

API:

| Call | What it does |
|---|---|
| `POST /api/sessions/:id/tracks/:track/topics` | delivers and saves the previews |
| `POST /api/sessions/:id/topics/custom` | checks your own topic request |
| `POST /api/sessions/:id/topics/choose` | creates the chosen lesson |

Outdated or duplicate choices are rejected.

## Lesson types

| Type | Example | Judging |
|---|---|---|
| Video | “Why does an AI invent details?” | questions along the way, rule |
| Podcast | conversation between Mira and Jonas | questions afterwards, rule |
| Check a text | compare an AI summary with the note | rule |
| Check a website | phishing email and fake login page | rule |
| With the AI | tutor, role play, writing a brief for the AI | model, otherwise keywords |

Solutions stay in the backend. The browser gets the lessons without solutions.

### Video

Seven prepared video lessons are included, with narration, animated scenes, timed subtitles and questions. Rebuild their English narration with `npm run videos:build -- --all` and `npm run video:build` (see [Rebuilding prepared videos](#rebuilding-prepared-videos)); until then they play as storyboards. The derivative (Mathematics → Derivative) has a specially checked animation; the others use reusable scene templates.

Play, pause, rewind, sound and subtitles work in the lesson window. Questions pause the video the first time it reaches them. After that, playback and seeking stay free; open questions stay visible and are answered before finishing. If the video cannot be loaded, you can switch to the storyboard. The videos are animations that the browser plays with sound, not MP4 files. For this the app uses its own versioned copy of animlib from OwlYouNeed in `packages/animlib`; the other repository is neither needed nor changed.

For your own topics and generated lessons, the AI delivers structured scenes and captions, not executable animation code. When the lesson is first opened, the server generates speech and animation, shows the progress and saves the result. Question pauses, subtitles, seeking and judging work the same way.

### Podcast

Anyone who chooses a topic under “What would you like to learn next?” can learn it as a podcast (with AI, for every topic). The AI writes a short conversation between Mira and Jonas about exactly this topic, only from the area's criterion, rule of thumb and sources, plus two to three questions about it. The server checks the length (6 to 16 turns, at most 3000 characters), both voices and the questions as for videos.

The conversation is voiced the first time it is opened. The transcript can be read along; clicking a turn jumps to that point. Then come the questions. If voicing fails, the conversation stays readable and the questions still work. The planner agent never chooses podcasts on its own, only the learner does.

### In the lesson window

The header and the finishing action stay visible. Detailed task hints, sources and the final answer overview can be opened when needed.

- **Video**: questions appear next to the player, below it on narrow screens, also in the storyboard. Playback and rewinding stay available during a question.
- **Answers**: clicking an answer shows checked feedback with an explanation right away, without an extra check button. Right answers get green feedback with a short star effect, mistakes a friendly explanation and the right answer. The chosen attempt is then locked; only after a connection error can it be sent again. The original attempt is judged, not the solution shown afterwards.
- **Podcasts and Check a text** show one question or one sentence at a time, with a progress indicator.
- **Check a website** leads through the email, the website and the verdict; choosing a verdict checks it right away. Marks give visible feedback without judging them as right too early.
- **With the AI** shows the number of your own turns. New messages only scroll the conversation.
- Animations respect the system setting for reduced motion.

`POST /api/sessions/:id/nodes/:node/answer-feedback` checks a single video or podcast answer (`type: quiz`, `questionIndex`, `option`) or a text sentence (`type: mark-evidence`, `itemId`, `mark`). It changes neither the result nor the XP; both are only created when the lesson is finished. The endpoints for content and starting a lesson still contain no solutions.

## Generating videos and podcasts

New content needs a text model (see [Connecting an AI](#connecting-an-ai-optional)). The speech service only provides the voice and does not replace the text model. Without a text model, new topics stay locked; the bundled lessons can still be played.

There are two ways to get speech:

- **Local** (default, macOS only): `say` with the voices Samantha and Daniel, plus `ffmpeg` on the search path or at `FFMPEG_PATH`.
- **ElevenLabs** (any platform):

  ```dotenv
  VIDEO_SPEECH_PROVIDER=elevenlabs
  ELEVENLABS_API_KEY=...
  ELEVENLABS_VOICE_ID=...
  ELEVENLABS_SECOND_VOICE_ID=...       # second voice for podcasts
  ELEVENLABS_MODEL_ID=eleven_multilingual_v2
  ```

The length of each generated speech passage sets the subtitles and the animation.

### Rebuilding prepared videos

```bash
npm run videos:build -- --all        # all prepared videos
npm run videos:build -- info-v1      # a single one
npm run build
```

Videos that are already up to date are skipped without a speech call. `--force` rebuilds and takes existing speech from the cache. The derivative animation is kept; only `--replace-custom` replaces it with the general templates.

The derivative has its own command. Its script is in `data/videos/derivative.json`, the scenes in `scripts/video/derivative-scenes.ts`:

```bash
npm run video:build                  # with new speech
npm run video:build -- --visuals-only  # only the visuals, without a speech service
npm run build
```

### Where the files are

| What | Where |
|---|---|
| finished catalogue videos (WAV and manifest) | `frontend/public/videos/<lesson-id>/` |
| newly generated videos | `backend/var/videos/<content-hash>/` |
| finished speech passages | `backend/var/video-speech/` |
| voiced podcasts | `backend/var/podcasts/<hash>/` |

Changes to the lesson content result in a new version. Question solutions and the random order of answers are not part of the speech cache. Finished speech is reused: when opened again, when opened at the same time and after a restart. The same podcast turns with the same voices are only voiced once.

### Paid calls

A failed or unclearly finished speech call is not repeated automatically. Finished passages are kept. After checking the error, `npm run videos:build -- <lesson-id> --retry-failed` starts a targeted new attempt. A manifest is only published once all scenes are voiced, compiled and checked as renderable. It contains no solutions. Keys stay local; the app only contains finished audio files.

`npm test` also checks scene and audio length, renderability, question pauses, seeking, replaying and the handover to the learning history. `npm run typecheck` also checks the video generator.

## How the agent decides

With AI, the agent works like a teacher, following the “teach” skill from mattpocock/skills. For each area it knows the mission, writes learning records with evidence and creates short lessons that fit the learner. Rules check every step and step in when the AI is missing or fails.

> **Two flows.** The current interface always uses the [topic choice](#choosing-the-next-topic-and-format): the learner chooses, the agent creates. Learning records, progress and reviews work there as described below. The rules R0 to R8 and the planner agent (A1), which plans on its own after every lesson, only apply to older API clients as long as they have never requested the topic choice.

### Rules

The rules answer immediately. With AI, the planner agent then plans, and the rules check its plan. Without AI, the rules apply alone, labelled “Plan by rules”.

| Rule | When | What |
|---|---|---|
| R8 Area chosen | an area was just added or a new lesson requested | the entry lesson or the new lesson in this area |
| R3 Start from the DCC profile | nothing learned yet | first areas at Foundation level, then not assessed ones (short entry lesson), then higher levels, then areas without DCC |
| R0 Continue on the path | after every lesson | the next lesson in the area, aimed at what was missing |
| R1 Repeated difficulty | the same criterion missed twice | new node “Clear it up with the AI: …” plus an alternative for practising alone |
| R2 Not challenged enough | the last two lessons in the area solved without help | new node with a lesson one level higher |
| R7 Area finished | area done | on to the next area; if nothing is left open or the map is empty: add an area |
| A1 Agent plan | after every lesson, when the planner agent runs | the agent's plan, checked by the rules, tags “AI” and “Rule” |

In your own areas without a running agent, the rules take a valid lesson the agent has already created. If there is none, they choose the goal themselves: the criterion missed last, otherwise one without evidence. Due reviews are mixed in. After two smooth lessons it goes one level higher.

### The planner agent (A1)

After every lesson the app immediately shows the rules' suggestion, marked as “provisional”. The agent starts in the background; the frontend checks back every 1.5 seconds. When its plan is ready and valid, it replaces the provisional suggestion.

The agent works in a loop with tools, with Anthropic, OpenAI or Qwen: at most 6 steps, 45 seconds in total and 20 seconds per call.

| Tool | What it does |
|---|---|
| `get_learner_state(trackId)` | mission, DCC level of this area only, active learning records, last 5 results, due reviews, map of the area |
| `list_pool_lessons(trackId, criterion?)` | prepared and already generated lessons |
| `generate_lesson({type, trackId, criterion, level, contextHint, reviewOf?})` | creates and checks a lesson; errors come back, a second attempt is allowed |
| `add_to_map(lessonId, parentNodeId)` | new node, at most 2 per run |
| `write_learning_record({...})` | learning record; the server checks the evidence |
| `update_reference(trackId, entry)` | cheat sheet, only for what was shown without help |
| `note_preference(text)` | preference in `notes.md` |
| `recommend({nodeId, alternativeNodeId, reason, basedOn})` | ends the loop |

The system prompt contains the principles from “teach”: zone of proximal development, one thing per lesson, knowledge light and practice demanding, every lesson tied to the mission, retrieval, spacing and interleaving, no knowledge of its own outside the sources.

Before A1 applies, the rules check (`backend/src/guard.ts`):

- The node exists and is reachable.
- There is a reachable alternative as soon as a node other than the recommendation is reachable. With only one area and one new node it stays empty.
- The reason cites at least one learning record (`LR-…`) or one event (`ev-…`), and all cited ids exist.

If a check fails, the rules' plan applies. The same goes if the model fails, time runs out or both attempts at a lesson are invalid. The reason is shown in the settings under Agent → “Planner agent runs”. If the learner has already started a lesson in the meantime, the app discards the plan.

Limits: 1 run per finished lesson, at most 10 generated lessons per session.

**AI first, prepared lessons as a fallback:**

- With AI, every prepared area starts with an entry lesson based on the DCC level. The agent creates the further lessons.
- The agent may only attach a prepared lesson once generation has failed or the limit of 10 is reached.
- If the rules' provisional plan puts a prepared lesson on the map, that node disappears again as soon as the agent's plan applies, unless the agent chose it itself.
- If the agent fails, the rules bring this area's prepared lessons onto the map and plan with them.
- Without AI, the map shows the whole plan of prepared lessons for every prepared area.

Anyone who starts the alternative (“Something else instead”) instead of the recommendation declines it. This is recorded in the history, and the agent plans again afterwards.

### Generated lessons

The agent does not invent new lesson types; it only fills the existing ones. Every generated lesson goes through the same validator as the files in `data/lessons/` (`backend/src/validate.ts`):

- Schema per type, at most 5 minutes.
- Check a text: at least one made-up sentence with a criterion of the area.
- Check a website: only made-up brands and `.example` addresses. Verdict and warning signs match.
- Questions: the answers to a question differ by at most 2 words, so the right one does not stand out by its length. The server puts the right answer in a different place in each question; if it is in the same place everywhere, the validator rejects it.
- Videos only with the reusable templates “steps” and “url-parts”.
- One primary source from `data/resources/<trackId>.md`, for your own areas from the area's sources.
- For your own areas, only the lesson types the area names.

Invalid lessons are discarded and logged. In the app, generated lessons carry the labels “Made by the AI” and “Invented example”.

`data/resources/<trackId>.md` lists checked sources, for example BACS, S-U-P-E-R.ch, “eBanking – but secure!” and DigComp 2.2. Every link was opened on 24 October 2026. Whatever could not be checked is listed under `## Gaps`.

### Learning records, progress and reviews

A learning record is an insight with evidence, not a log. Covered is not learned. There are four kinds:

| Kind | Evidence the server requires |
|---|---|
| `demonstrated` | in all cited events the criterion is met alone, without a hint and at the first check |
| `misconception` | an event with the criterion missed and a later one in which it is met without a hint |
| `prior-knowledge` | an event in this area |
| `mission-shift` | a mission change confirmed by the learner (`mi-…`) |

Records have `status: active` or `superseded by LR-n`. The rules write `demonstrated` and `misconception` themselves, even without AI. The agent can write more.

Progress per criterion comes only from the learning records and is shown separately from the DCC under “Learning progress (from learning, not DCC)”:

- “still open”: no record.
- “practising”: a misconception was corrected, or it was missed again after “I can do it”.
- “I can do it”: shown without help.

Help within a lesson (a hint after checking) is noted. An observation like “Missed Dates and deadlines 2×” only counts as resolved once the criterion was solved without help.

### Quick reviews

Due reviews are at the very top of the home page, before “Keep learning” and new lessons. Criteria missed last come first, then those with the most mistakes and the oldest due questions. Reviews can also be opened in the topic and in the header. A round contains at most five questions; remaining and cancelled questions stay due.

After a lesson is finished, the checked criteria go into a permanent review plan. The first question comes after one day. Questions answered correctly come back after 3, 7, 14, 30 and then every 60 days. A wrong answer resets the interval to 10 minutes. After a successful review, the build-up starts again at one day, then 3, 7 and so on. Mistakes in normal lessons also shorten the interval. New sign-ins do not reset the due dates.

Reviews only contain short questions, no videos, podcasts or repeated explanations. Existing quiz questions come only from lessons already finished. For text checks, only the necessary note with one statement is shown; for further criteria there is a choice about the rule of thumb already learned. Answers are shuffled, and solutions stay in the backend until the answer is submitted. After a mistake, a short correction appears. A repeated attempt to send counts only once. The answers change neither the DCC nor XP nor the number of finished lessons; progress takes the last retrieval into account.

For each criterion, all matching questions from all finished lessons rotate, regardless of whether they were originally answered right or wrong. Questions not yet reviewed come first, then those not answered for the longest time. Video and podcast questions, supported and made-up text statements and warning signs from website checks are included. Lessons finished several times do not create duplicate questions. Newly finished lessons are added to the rotation. Only a validly submitted answer moves the rotation on; opening, cancelling and resending the same answer do not use up another question. The rotation is independent of streaks and mistakes; after a mistake the criterion comes back after 10 minutes, with the next question in the rotation.

Due dates, mistake counters, question rotation and open questions are kept in `state.json`. Existing queues, including reviews marked as done earlier, are taken over when opened. The home page updates due questions after one minute at the latest and when you return to the browser window. The agent can still include due criteria in additional exercises (`reviewOf`).

API: `POST /api/sessions/:id/reviews/:review/start` opens a due question without the solution; `POST /api/sessions/:id/reviews/:review/answer` takes `{ challengeId, option }`, judges it and schedules the next date. `SessionView.reviews` contains the prioritised due and the upcoming reviews. Internal questions and solutions are excluded from the public session.

## Workspace per learner

Each learner has a folder under `backend/var/learners/<learnerId>/` (not in git). Every file is first written as a temp file and then renamed.

```
profile.json                       name, created at, DCC records (date, source)
state.json                         map, events, recommendations, observations, reviews, agent runs
tracks/<trackId>.json              own areas: criteria, mission suggestions, sources, lesson types, topic, prior knowledge
missions/<trackId>.md              mission per area
learning-records/0001-<slug>.md    learning records with frontmatter (track, criterion, kind, status, evidence)
lessons/0001-<slug>.json           generated lessons with provenance (model, time, basedOn, source)
reference/<trackId>.md             cheat sheet per area
notes.md                           preferences, for example “likes short lessons”
```

- **Signing in with a known name** (case does not matter): “Continue” carries on with the existing learner, “Start over” creates a new one. Nothing is deleted.
- **New DCC result**: it is added as a new record if it differs from the last one. Learning records stay. Areas without a finished lesson get a new plan.
- **Mission**: a personal goal can optionally be set under “My account”, with three suggestions or in your own words. Without one, the default goal applies. Changing a saved goal needs a confirmation and is recorded as `mission-shift`.

## Privacy

- The model never gets the learner's name or id.
- The agent only gets the DCC level of the area it is planning, never the whole profile. It only sees nodes of other areas as ids, without titles.
- Sent to the AI: the exercise, the learner's answers, the mission and the preferences from `notes.md`, and for your own area also the topic and prior knowledge. The app says so at the mission, in the settings and when creating an area.
- Your own areas belong only to the learner who created them. Other sessions cannot access them.
- No tool and no code changes DCC levels. Learning, transfer and DCC stay separate.
- Keys are only in `backend/.env`, never in the frontend or in the repo.

Every recommendation says in one sentence why it helps now. The side panel also shows what the agent saw, its suggestion, what it is based on and the rule.

## Structure

```
shared/            shared types and points calculation (rewards.ts)
backend/           Express API, agent, judging, model connection
  src/app.ts         HTTP API
  src/content.ts     load and check content from data/
  src/sessions.ts    sign-in, lessons, missions
  src/nextTopics.ts  “What would you like to learn next?”: topic suggestions and the chosen lesson
  src/agent.ts       plan from the DCC, rules R0 to R8, new nodes
  src/planner.ts     planner agent (A1): tools, loop, fallback
  src/guard.ts       the rules' check of the agent's plan
  src/tracks.ts      a learner's areas: prepared and own
  src/designer.ts    plan your own area with the AI, check the draft and sources
  src/ownlessons.ts  lessons for your own areas: entry lesson and goal by rules
  src/generator.ts   generate lessons, shuffle questions
  src/validate.ts    validator for all lessons
  src/resources.ts   checked sources per area
  src/records.ts     learning records, evidence, progress, reviews, cheat sheet
  src/workspace.ts   folder per learner on disk
  src/dcc.ts         check the DCC file and input
  src/judge.ts       judging by rules
  src/services.ts    chat, hints, judging with a model or fallback
  src/owlChat.ts     the owl chat
  src/provider.ts    Anthropic, OpenAI, Qwen, mock or none; tools for the agent
  src/video/         voice, compile and store videos
  src/podcast/       voice and store podcasts
  test/              tests with a mock model
data/              areas, criteria, mission suggestions, lessons (JSON), sources (resources/*.md), video scripts
frontend/          React PWA: sign-in, home page with rewards, mountains, learning map, lessons
packages/animlib/  animation library for the videos (copy from OwlYouNeed)
scripts/           build videos
```

New prepared lessons go into `data/lessons/` as JSON. At startup the backend checks all files with the same validator as generated lessons. Invalid ones are discarded and logged.

## Limitations

- No real login: a name and a DCC result are enough. Anyone who knows the name can continue.
- Your own areas only with AI. The AI suggests their sources. Only whether the address answers is checked, not the content. The app says so for every lesson and in the area.
- At most 8 own areas. Areas cannot be removed yet.
- No learning with other people. The modes are “Alone” and “With the AI”. The “Wisdom/Community” part of “teach” comes with that mode.
- Generated videos use reusable animations, not freely invented animation programs.
- Local speech only on macOS. On other systems you need ElevenLabs for new videos and podcasts.
- Storage is one folder per learner, without a database and without locks for several servers.
- A new DCC result only replans areas in which nothing is done yet.
- The validator's list of real brands is not complete. The main protection is the `.example` addresses.
