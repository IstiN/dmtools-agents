# Анализ: issue #1406 → PR #1465 (reviewer pool)

**База анализа:** ветка `ai/gh-1406`, коммит `6253aa879` (+ WIP `d2dc530ee` — только +162 строк тестов в `test_reviewPool.js` и merge main с посторонним gh-1450; выводы валидны).
**Метод:** 3 параллельных исследования (требования / совместимость / issue-ссылки) + собственная верификация ключевых файлов.
**Файл-скретч для обсуждения — не коммитить (public repo, правило project-agnostic).**

---

## 1. Резюме

**Инфраструктура пула сделана добротно и близко к букве спеки — но пул не исполняется.** Из 8 пунктов rollout-чеклиста §10: 5 DONE, 2 PARTIAL, 1 MISSING. Ключевой пробел: **execution layer отсутствует** — никто не запускает specialist-ноги, не пишет candidate-файлы и не ставит PASS/pool маркеры, поэтому merge-gate (§7) навсегда сидит в fail-open ветке. Формально «Closes #1406» PR не оправдывает: чек-лист выполнен на инфраструктурном уровне, не end-to-end.

Обратная совместимость: **внутри репо — безопасно** (одно осознанное поведение-изменение: сломанное чтение комментариев теперь откладывает merge для всех). **Для downstream-репо — главный риск:** переименования/удаления instruction-файлов ломают чужие конфиги, пинящие старые pack-пути.

Замечание про issue-ссылки (твой вопрос): **в yaml/json — почти чисто** (все JSON-конфиги без единой ссылки; единственное исключение — имя нового шага в `quality.yml`). В js ссылки в комментариях — устоявшаяся норма репо (сотни на main), но есть **3 runtime/PR-видимых строки с `gh-1406`**, которые стоит обобщить.

---

## 2. Соответствие требованиям (§10 чеклист)

| # | Пункт чеклиста | Статус | Комментарий |
|---|---|---|---|
| 1 | File split `base|generalist|security`, обе ноги на base, freshness gate | ✅ DONE | 6 base-файлов, generalist 2, security 3; все 4 leg-конфига переподключены; `test_reviewPromptFreshness` (4 ноги × 6 base-файлов, role line «Senior Code Reviewer» без «& Security Expert»); снапшоты регенерированы; «contract last» соблюдён в cliPrompts |
| 2 | Skill-файлы: схема + резолв (factory+repo, same-name tuning, дефолты §2) | ✅ DONE (код) | `instructions/review/{base,security}.json` точно по спеке; `reviewPool.js` дефолты поле-в-поле; same-name tuning только `isEnabled/rounds/triggerPaths/options/model`, контракт-поля → hard error; minimal `{"name","lens"}` = полный reviewer. **Но:** ни одного runtime-вызова |
| 3 | `reviewPolicy` += `reviewers`, `promptAppend` (строгость сохранена) | ✅ DONE | known keys `{preset,severities,bounds,identity,verification}` → `+2`; unknown по-прежнему throw; `verification:'filter'` (gh-1403) не тронут |
| 4 | Security skill file + role-line rename | ✅ DONE | `security.json`: `isRequired:true`, `rounds:["first","hunks"]`, `triggerPaths:[]`, `mayRaise` вкл. BLOCKING; base role line без «Security Expert» |
| 5 | **Параллельное исполнение + candidate-файлы + census merge + fail-open** | ❌ **MISSING** | `postPRReviewComments.js` (единственный post-action review-ноги) изменён на 2 строки комментария. Ноль production-вызовов `resolvePool` / `reviewerShouldRun` / `mergeCandidateLists` / `buildPoolPacket` / builders маркеров. Диспетчера ног нет → runtime = одна generalist-нога, как на main |
| 6 | Фильтр-нога как точка слияния (dedup, weighted retention, drop visibility) | ⚠️ PARTIAL | `reviewPoolMerge.js` (306 строк, pure) реализует все три duty: dedup по path+line+claim-fingerprint, severity только вверх, reasonless drop `filterWeight:high` → keep+note, digest-видимость. **Но `reviewFilter.js` (нога gh-1403) не тронут** — merged кандидаты до фильтра не доходят |
| 7 | isRequired merge gate в gh-1370 lane | ⚠️ PARTIAL | Потребитель готов: `mergeGate.poolPhase` = phase 0 перед census, один round-trip комментариев, hold `dmtools:merge-hold` (reason `required-reviewer`), retry→needs-human по существующему клапану. Call sites (`mergeTrigger.js`, `retryMergeGithubPR.js`, `sm/mergeBot.js`) не изменены — им и не надо. **Но продюсер маркеров отсутствует** → gate мёртв: `applicable:false` всегда |
| 8 | Validator + docs + worked example | ✅ DONE | `scripts/validate-review-skills.js`: все 7 проверок §8 (проверил по хедеру и коду), exit 0/1, без npm-зависимостей; подключён в `quality.yml` рядом с module-size/nesting; example живёт во внешнем репо (как и велел §9), здесь только тестовые fixtures |

**§9:** ✅ — корневого `.dmtools/review/` в репо не появилось, только `js/unit-tests/_fixtures/review-skills/{valid,broken}/`.

**Что из «недостающего» уже есть в pure-видe (готово к подключению):** семантика rounds/hunks — `triggerPathsHit` (пустой список = без ограничений, substring-матч), `roundsDecide` (`first` = до первого PASS; `hunks` = есть новые ханки И попали в triggerPaths; `all`; комбинации легальны), `reviewerShouldRun` — покрыто тестами, включая «нога с 429 не оставила PASS → `firstDone` остаётся false → пере-запуск» (completions, не attempts). Head-carried PASS: `hasCompletedOnHead` (sha-prefix ≥7 симв., machineAuthor allowlist, fail-closed). Материализация `pr_new_hunks.txt` **уже есть на main** (`js/common/prNewHunks.js`); frozen-code правило вписано в `security/lens.md`. Единственное реально отсутствующее звено — runtime, который считает `{firstDone, hasNewHunks, hunksHitTrigger}` на ногу и запускает/пропускает ноги.

### Инварианты

| Инвариант | Статус | Суть |
|---|---|---|
| 1. One census, one verdict (кандидаты, не вердикты) | ⚠️ **DEVIATES (latent)** | `base/output_rules.md` + `base/few_shots_format.md` учат **каждую** ногу писать полный verdict-shaped `pr_review.json` (recommendation + issueCounts). Candidates-only формат существует только в `reviewPoolMerge` (доки+тесты). Если в следующем PR просто «подключить» specialist-ноги как есть — они начнут выдавать вердикты, нарушая инвариант. Надо чинить **до** wiring-а |
| 2. Extend, never replace | ✅ DONE | `validateRepoTuning` + `POOL_TUNABLE_FIELDS`, hard errors, покрыто тестами |
| 3. Contract immutability | ✅ DONE | base-файлы factory, promptAppend только additive, переопределение lens отклоняется |
| 4. `first` считает completions | ⚠️ PARTIAL | Семантика в pure-коде корректна (`roundsDecide`, head-carried `hasCompletedOnHead`, machineAuthor allowlist fail-closed, «429 без PASS → пере- fires» — протестировано). В проде некому ставить маркеры |
| 5. Fail-open ≠ merge gate | ⚠️ PARTIAL | Gate-сторона полная и протестированная (legacy fail-open, non-required не гейтят, сломанный read fail-closed); availability-packet («X unavailable this round») есть, но не подключён |

---

## 3. Главная находка: пул инертен

Цепочка проверена независимо (я + оба агента):

- `resolvePool()` вызывают только `scripts/validate-review-skills.js` и юнит-тесты.
- `reviewPoolMerge.js` не требуется никем в проде. `reviewPoolMarkers.js` требуется только из `mergeGate.js` (чтение).
- Никто не вызывает `buildPassMarkerComment` / `buildPoolOutcomeMarkerComment` → **маркеры `dmtools:review-pass` / `dmtools:review-pool` никогда не появляются на PR**.
- Следствие: `requiredReviewerHoldState` всегда `{applicable:false}` → gate всегда пропускает. Система ведёт себя ровно как main.

**Это безопасно-инертно, но значит:** security-нога не запускается, weighted-фильтр не работает, merge-gate не защищает. Issue #1406 не закрыт end-to-end — как минимум пункты 5, 6, 7 чеклиста требуют второго PR (execution wiring + candidates-формат в промптах + подключение `reviewPoolMerge` к `reviewFilter`).

---

## 4. Обратная совместимость

### 4.1 Внутри репо — SAFE, с одним живым флипом

| Область | Вердикт | Детали |
|---|---|---|
| `reviewPolicy.js` | ✅ SAFE | Только +2 known-ключа, все экспорты additive, ничего не удалено/переименовано. `verification` — семантика gh-1403 нетронута |
| Marker grammar | ✅ SAFE | Новые типы `dmtools:review-pass`/`-pool`; парсеры prefix-scoped, `reviewVerdicts.js` не менялся; `machineNotice` классифицирует их как machine-уведомления → census обсуждений их не увидит. Старые маркеры парсятся как раньше |
| `mergeGate` pool clause | ✅ no-op для legacy | `newestPoolOutcomeForHead → if (!outcome) return {applicable:false}` — PR без pool-маркеров проходят как раньше; empty allowlist → trust nothing (fail-closed против подделок) |
| Verdict gate / gh-1416 absorb | ✅ не тронуты | `mergeVerdictGate.js` вне PR; сall sites не менялись |
| Test harness | ✅ SAFE | `REAL_COMMON_MODULES` += `reviewPoolMarkers/reviewVerdicts/machineAuthor` — parity-fix CI (147 красных тестов были «module not found»), семантика тестов не менялась |
| Docs/snapshots | ✅ SAFE | Регенерированы генератором, idempotent (`git diff --exit-code` чистый) |

**🔴 Живой behavior flip (осознанный, но стоит проговорить):** `runGate` теперь читает комментарии **eagerly и fail-closed**. Раньше: сломанный `getComments` при чистом census → merge проходил (fail-open, тест это пинал). Теперь: любое исключение чтения → gate throws → `retryMergeGithubPR` ловит → `{held:true}` → **merge откладывается для ВСЕХ репо, независимо от пула** (причина — parity с #1319: «не классифицировать сломанное чтение как "нитей нет"»). При GitHub API-инцидентах merges будут копиться в retry; клапан needs-human (24h) есть. Тест `test_retryMergeGithubPR.js` это явно запинил («verdict gate fail-open, merge gate fail-closed») — решение осознанное, но это изменение поведения мерж-конвейера, не связанное строго с пулом.

**🟡 Латентный флип (после wiring-а, не сейчас):** factory ships `base` и `security` оба `isEnabled:true, isRequired:true`. Когда появится execution, дефолт для **каждого** потребителя станет: security-нога обязательна, merge гейтится. **Pool-wide kill switch отсутствует** — только per-reviewer `reviewPolicy.reviewers.<name>.isEnabled:false` (или одноимённый repo-файл). Репо с `verification:none` ногу фильтра не получит, но гейт по маркерам всё равно включится, как только ноги начнут ставиться.

**Мелочь:** `mergeGate.js` теперь жёстко требует `reviewPoolMarkers.js` (hoisted require — правило gh-823 соблюдено, pack-closure подхватит; deferred-require тест не краснеет).

### 4.2 Downstream-репо — ГЛАВНЫЙ РИСК совместимости

Удалены/перемещены (pack-раскладка меняется):
```
instructions/pr_review/output_rules.md          → удалён (расщеплён в base/input_context + base/output_rules)
instructions/pr_review/formatting_rules.md      → base/formatting_rules.md (R100)
instructions/pr_review/review_verdict_rules.md  → base/review_verdict_rules.md (R100)
instructions/pr_review/few_shots.md             → generalist/few_shots.md (R100)
instructions/pr_review/general_guidelines.md    → generalist/lens.md (R072, расщеплён)
instructions/pr_test_automation_review/{output_rules,formatting_rules}.md → удалены (замена: base/*)
```

- **Внутри репо — чисто:** я грепал ветку целиком (json/js/md/docs/snapshots) — ноль dangling-ссылок на старые пути; `.dmtools/runners/fa-review.json` (`pack:`-ссылка) и `#605`-якорь в `test_instructionRefs.js` обновлены.
- **Но downstream-репо**, у которых в собственных `.dmtools/config.js` / runner-конфигах зашиты старые пути (`cliPrompts: ['./agents/instructions/pr_review/general_guidelines.md']`, `pack:instructions/pr_review/review_verdict_rules.md`, ...) — **сломаются при бампе пакета**. Это класс краша #600/#605: unreachable file → pack build fail / пустой промпт.
- **Рекомендация (обсудить):** (а) оставить старые пути как stub-файлы-алиасы (одна строка «moved to …», + warning в лог), хотя бы на один релиз; и/или (б) явно перечислить breaking renames в release notes с миграционной инструкцией. Validator можно научить предупреждать о пиннинге удалённых путей — это детерминированная проверка, ему по рангу.

### 4.3 Прочее

- 4 корневых конфига (`pr_review.json`, `pr_test_automation_review.json`, `pr_story_…`, `pr_bug_…`) — имена/пути стабильны (CI ссылается по пути); изменились только `cliPrompts`-списки и одна description-строка схемы. ✅
- `pr_test_automation_review` мигрировал на base — дубль контракта устранён (как и требовал §1). ✅

---

## 5. Issue-ссылки в js/yaml (твой вопрос)

### Нормы репо (проверено на main)
- В **json-конфигах** и **yaml** ссылки почти не встречаются; в **js-комментариях** — сотни (`gh-823`, `gh-1351`, ...) — это устоявшийся стиль, я бы не трогал.
- `quality.yml` на main: gh-ссылки живут в **комментариях** шагов (`gh-1251`, `gh-1365`, ...), **ни одно имя шага ссылки не содержит**.

### Что принес PR

| Место | Что | Класс | Вердикт |
|---|---|---|---|
| Все JSON-конфиги (4 агента, `instructions/review/*.json`, `run_*.json`) | — | — | ✅ **0 ссылок, чисто** |
| `quality.yml:282` | `name: Review skill files (gh-1406 §8 — lens/contract CI gate)` | behavioral-lite | ⚠️ **первая в этом файле ссылка в `name:`** — ломает собственную норму файла. Ничего не грепает это имя (проверено), чисто косметика, но легко починить |
| `mergeGate.js:603` | строка hold-сообщения `(gh-1406: a failed required review leg never merges)` — **постится на PR** как текст хода | **behavioral** | 🔴 + тест `test_mergeGate.js:965` **требует** `gh-1406` в строке (`indexOf('gh-1406') !== -1`) — issue-id запинен как обязательное содержимое runtime-строки. Обобщить и строку, и тест |
| `reviewPoolMarkers.js:59,109,~167,~170` | prose постимых маркеров: «🤖 Reviewer pool (gh-1406): …», «🤖 Merge hold (gh-1406): …» | behavioral-lite | 🟡 Пока маркеры никто не постит — не проявится, но чинить дешевле сейчас (формат-грамматика уже «заморожена» тестами) |
| Новый js (reviewPool/reviewPolicy/reviewPoolMerge/validator) | десятки ссылок в комментариях (`gh-1406 §N`, `gh-957`, `gh-823`) | comment-only | ✅ норма репо |
| Тесты | suite names с `gh-1406` | test-id | ✅ норма |

**Важно: поведенческой логики на номерах issues нет.** Нет `if` по номерам, нет issue-номеров в маркер-грамматике/лейблах/гейт-именах (`HOLD_REASON='required-reviewer'`, `ESCALATION_LABEL='needs-human'` — все generic). Ссылки в комментариях — только документация. Это хороший результат; вопрос сводится к 3+1 строкам выше.

---

## 6. Качество реализации — заметки

- `base.json` `isRequired:true` — по букве спеки («factory: base + security `true`») ✅, но фактически это делает **обе** factory-ноги merge-блокирующими. В сочетании с «first counts completions» это значит: любой 429 базовой ноги = merge withhold → retry → needs-human. По доктрине gh-957 — правильно, но стоимость сбоя base-ноги вырастает; убедиться, что retry-with-backoff у ноги действительно появится в execution-PR (сейчас его нет).
- `reviewPolicy.js` ровно 800 строк (лимит сработал, коммент-блок ужали) — техдолг на будущее расширение.
- Crap-ratchet: `reviewPoolMerge` вынесен из loader'а как CRAP-split — ок; `reviewPool.js` 620 строк — до лимита далеко.
- WIP-дельта после `6253aa879`: +162 строки тестов (`test_reviewPool.js`) — без изменения прод-кода; в ветку влит main (gh-1450, посторонний фикс токенов). Анализ валиден.
- Состояние CI: red-loop rework в процессе (последний red `6253aa879`, `agent:rework` re-armed, WIP-коммит 13:48). До merge — ждать зелёной validation.

---

## 7. Рекомендации / что обсудить

1. **Scope-решение (главное):** принимать ли PR как «инфраструктурный этап» с явным re-scope (открыть follow-up issue на execution: п.5/6/7 чеклиста), или вернуть на доработку, т.к. issue заявляет «Closes #1406» при 1 MISSING + 2 PARTIAL. Я за re-scope: сделанное качество хорошее, а execution — отдельный большой кусок (диспетчер ног, candidates-формат, подключение фильтра, retry-механика).
2. **До execution-PR обязательно:** чинить инвариант-1 — specialist-промпты должны учить писать **candidates-файл**, а не verdict-shaped `pr_review.json`; иначе «подключение» молча нарушит «one census, one verdict».
3. **Downstream-пути:** решить — stub-алиасы на старых путях, или breaking-note в release notes + validator-warning о пиннинге удалённых путей.
4. **Pool-wide kill switch:** до включения execution решить, нужен ли явный выключатель (сейчас только per-reviewer). Минимум — задокументировать рецепт «выключить всех reviewers».
5. **Почистить issue-ссылки в runtime-строках:** `mergeGate.js:603` (+тест 965), `reviewPoolMarkers.js` prose ×4, step name в `quality.yml`. Мелочно, но дёшево сейчас и дорого потом (строки «замораживаются» тестами).
6. **Задокументировать fail-closed флип** чтения комментариев в PR description (это изменение мерж-конвейера для всех, формально не связанное с пулом).

---

## 8. Решение v1/v2 и ответы на вопросы (обсуждение с владельцем, 2026-11-12)

### 8.1 Схема v1/v2 — полные копии с пометкой (решение владельца, пересмотр)

**Решение: старые пути возвращаются с ПОЛНЫМ старым контентом + deprecation-баннер** (не banner-stub). Аргумент владельца принят: эти файлы читают AI-агенты (в т.ч. с file-scope правами) как промпт-материал — пустышка в файле = деградация чужого промпта и конфуз агента. Полная копия даёт pinner'у ровно то, что он имел до бампа: **нулевой behavior delta**.

**Состав v1-восстановлений:**
- R100-переименования (3 файла) — полная копия нового содержимого + баннер: `pr_review/{formatting_rules,review_verdict_rules,few_shots}.md`;
- расщеплённые/удалённые (3 файла) — восстановление **старого** контента из git-истории + баннер: `pr_review/{general_guidelines,output_rules}.md`, `pr_test_automation_review/{output_rules,formatting_rules}.md`. Старый контент самодостаточен (работал до сплита); устаревший ≠ сломанный, баннер направляет на новые пути.

**Цена варианта (выяснено при проверке CI):**
1. **md-similarity gate** (`agent-docs.yml`, `check --only similarity --baseline .crap-baseline.json`, baseline сейчас пуст `violations: []`): 100%-идентичные пары md создадут новые violations → gate краснеет. Решение — **пиннить новые пары в `.crap-baseline.json`** (та же ratchet-философия, что у JS-duplication baseline; на удалении v1 пины снимаются). Проверить в CI, что формат пина пар поддерживается — это шаг плана, не риск.
2. **Дрейф** (v1 заморожен, v2 живёт) — решается юнит-тестом «v1-копия == v2-оригинал byte-equal» для трёх R100-файлов; для двух расщеплённых sync не нужен (их преемники расходятся намеренно).
3. **test_instructionRefs** — добавить assertion «v1-файлы существуют» на период deprecation (не исчезнут молча).

Плюс без изменений: validator-warning при пиннинге v1-путей в `.dmtools/config.js`, таблица миграции в release notes, удаление v1 следующим мажором.

### 8.2 Чистка issue-упоминаний — ДА, тем же PR

1. `quality.yml:282` step name → `Review skill files (lens/contract CI gate)` (контекст в комментарии под ним уже есть).
2. `mergeGate.js:603` — убрать `(gh-1406: …)` из текста hold-строки; перепинить `test_mergeGate.js:965` (сейчас он буквально требует подстроку `gh-1406`).
3. `reviewPoolMarkers.js` prose ×4 — убрать `(gh-1406)` (маркеры ещё никем не постятся — нулевая цена сейчас, формати грамматика ещё не «заморожена» потребителями).
4. Ссылки в js-комментариях — оставить (норма репо, сотни на main).

### 8.3 Мержить и v2 в одном PR? — ДА, но двумя логическими кусками

- **В этом PR:** shims v1 (commit A, compat) + чистка упоминаний (commit B). Причина — автопубликация релиза сразу после merge (см. 8.1).
- **Отдельным PR (follow-up):** execution layer (ч.5/6/7 чеклиста §10) — диспетчер ног, candidates-формат в промптах (сначала чинить инвариант-1!), подключение `reviewPoolMerge` к `reviewFilter`, retry-механика ног. Это не влияет на совместимость (сейчас ничего не исполняется), поэтому никакой спешки.
- Итого: этот PR закрывает «инфра + совместимая миграция», follow-up — «пул начинает работать». Issue #1406 не закрывать первым PR (переформулировать на частичное + ссылка на follow-up issue).

### 8.4 `isRequired` — происхождение (аудит) и моё мнение

**Откуда поле** (`~/Documents/IstiN/audit/reviewer-pool-vision.md`, §schema + §Required-reviewer quorum):
- **Сценарий владельца («the 429 problem»):** base-ревью успешен, security умирает на provider 429 несколько раз подряд → без гейта PR смержится **вообще без security-ревью**.
- **Принцип дизайна:** «fail-open правилен для AVAILABILITY, но неправилен для MERGE GATING — поэтому два concern'а разделены полем `isRequired`».
- **«Merge rules are repo rules»** — поэтому поле per-reviewer конфиг: что гейтит merge именно ТВОЕГО merge — решение репо (factory: security `true`, остальные `false`).
- **Вторые роли маркеров:** PASS-маркер — ещё и счётчик семантики `first` («completions, не attempts»: для НЕ-required ревьювера без маркера «ничто другое не вернёт ногу»). Т.е. маркеры нужны в любом случае; `isRequired` решает лишь одно: «маркер ОТСУТСТВУЕТ в момент merge — hold или proceed?».

Live-test-и (`live-test-findings.md:56`, `live-test-2-results.md:80`) ссылаются на isRequired-gate как на готовый паттерн «merge lane withheld on red» — наследник gh-1370-lane, отдельной критики поля там нет.

**Моё мнение: поле нужно, но его форму стоит обсудить сейчас (пока ничего не исполняется — смена формы бесплатна).**

| Альтернатива | Последствие |
|---|---|
| Убрать поле, «все enabled гейтят» | Экспериментальный/advisory ревьювер (legal на trial) блокирует merge при каждой рядовой ошибке провайдера. 429 — рутина (в этой же сессии были 429-шторма). gh-957 превращает каждый hold в escalation к владельцу. Операционно больно |
| Убрать поле, «никто не гейтит» | §7 merge gate умирает целиком → возвращается исходный сценарий «смержилось без security-ревью». Теряется смысл требования |
| **Поле/политика остаётся (текущий A)** | Минимальный policy-бит: security гейтит, legal-on-trial — нет. Стоит один boolean |

**Легитимное зерно сомнения** — не «нужно ли», а «где жить»: per-reviewer boolean размазывает merge-политику по файлам, и contract immutability делает factory-required неизменяемым для репо («merge rules are repo rules» — а тут не repo rules). Изоморфная альтернатива **B**: убрать поле из skill-файлов, перенести в reviewPolicy: `reviewPolicy.required: ["base","security"]` (default-политика factory; репо владеет списком). Файлы остаются self-describing в остальном, immutability не страдает, гейт читает политику, валидатор проверяет `required ⊆ pool`. Цена B — правка спеки (§2 таблица, §7) и pool-outcome маркер, несущий required-флаги из политики; скилл-файл перестаёт сам отвечать «гейтю ли я».

**Рекомендация:** либо оставить A как есть (spec-совместимо, уже построено), либо перейти на B в execution-PR ДО включения пула — после включения миграция политики станет ломающей. Гибрид «requiredByDefault + opt-out» из прошлого обсуждения — подвариант B. Решение за тобой; технически оба эквивалентны против 429-сценария.

### 8.5 Обновлённый план действий

1. **Этот PR (до merge):** commit A — v1 shims + validator warnings + тесты на наличие shims; commit B — чистка gh-1406 из runtime-строк/step name. Переформулировать PR description (частичное закрытие #1406, ссылка на follow-up).
2. **Follow-up issue:** execution layer (диспетчер, candidates-формат с чинкой инварианта-1, filter-merge wiring, retry ног).
3. **Следующий мажор:** удалить v1 shims + deprecated-список из validator'а.

### 8.6 ВЫПОЛНЕНО (12.11, владелец выбрал вариант B + полные копии)

**Issue #1406 обновлён** (revision-заметка сверху + §2/§3/§7/§8/§10): per-reviewer `isRequired` удалён из схемы, merge gating = `reviewPolicy.required` (дефолт `['base','security']`, репо-владение, `[]` гейтит ничто).

**Код запушен в PR #1465** (два коммита поверх 43f4cd47e → `2c70d0158`):
- `30fe8166e` — вариант B: schema (`reviewPoolSchema.js`: −isRequired, +`DEFAULT_REQUIRED`/`validateRequiredList`, removed-field hint), `reviewPolicy.js` (+ключ `required`, +`requiredIsDefault`), `reviewPool.js` (policy-driven gate; явный неизвестный required → hard error §8/8; default-unloaded → warning, fail-soft сохранён; required-but-disabled → warning), factory skill-файлы без isRequired, чистка gh-1406 из PR-видимых строк (hold-линия mergeGate, prose маркеров, step name quality.yml; тест пинит ОТСУТСТВИЕ issue-id в runtime-строке), тесты/фикстуры/доки перегенерированы.
- `2c70d0158` — v1 shims: 7 путей восстановлены (3 — байт-копии v2 с баннером + sync-тест S3; 4 — старый контент из git-истории с баннером), hub `deprecated-v1.md` + якорь в `base/input_context.md` (пак-достижимость, R1–R4 зелёные), тест `test_deprecatedInstructionShims.js` (+run-файл, +run_all), validator: warning при пиннинге v1-путей (config + runners/*.json) + §8 check 8 belt.
- Полный node-харнесс на этой голове: 10767 passed / 4 failed — все 4 из shell-самотестов gh-1137/gh-1450 (`setup/dart.sh`, `gh-auth-refresh.sh`, `gh-token-keeper.sh`), pre-existing macOS-шум (голова семьи зелёная на ubuntu CI).
- PR-комментарий с описанием posted; issue обновлён до пуша.

**Хвост (за CI):** md-similarity gate (agent-docs) может отметить новые пары от байт-копий — violation-записи пинятся в `.crap-baseline.json` из лога гейта (формат `{gate:'similarity',file,line,message}`), снимаются при удалении v1. Проверка запланирована.

**Follow-up issue: [#1471](https://github.com/IstiN/dmtools-agents/issues/1471)** — execution layer (диспетчер ног, candidates-контракт с чинкой инварианта-1 как work item 1, aggregation point + reviewPoolMerge→reviewFilter wiring, PASS/pool-маркер продюсеры, retry required-ног) + зафиксированная семантика лейблов: лейблы ставятся один раз за раунд из merged census существующей машинерией — ревьюверы не постят, не лейблят, не голосуют; параллельные ноги = отдельные runs с одной точкой агрегации раунда. PR #1465 description переписан на «Partially closes #1406» со ссылкой на #1471.

---

## Приложение: источники

- Issue #1406 (полный текст, invariants §1–§5, чеклист §10) — GitHub API.
- PR #1465: 75 файлов, +4663/−371; head `6253aa879` (+WIP `d2dc530ee` = только тесты).
- Собственные верификации: diff-ы `pr_review.json` + 3 leg-конфигов, `quality.yml`, `mergeGate.js` (полный диф фаз гейта), `reviewPool.js` (дефолты, FACTORY_DIR/REPO_DIR), `security.json`/`base.json`, grep-ы dangling-путей, grep-ы кто-require-ит новые модули, `reviewFilter.js` (нетронут), CI-статус.
- Отчёты агентов: req-compliance (соответствие, 22.5k), compat-analysis (совместимость, 14k), issue-refs (инвентарь ссылок, 15k).
