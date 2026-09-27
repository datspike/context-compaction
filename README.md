# context-compaction

## Установка

Из каталога репозитория установите расширение как локальный пакет Pi:

```bash
pi install -l .
```

Расширение проверено на Pi `0.87.1`. Оно использует публичные extension hooks и не требует изменений в Pi core.
Расширение задаёт session-local окно контекста через публичный `pi.setModel()`, регистрирует `checkpoint_compact_continue` и команду `/context`. Pi `0.87.1` сам выполняет automatic compaction, обрабатывает его результат и продолжает agent run; extension не патчит Pi runtime и не отменяет native compaction.

## Режимы

```text
/context status
/context economy
/context long-once
/context long-chat
/context off
```

- Capability определяется только по валидному `contextWindow` точной runtime-пары `(provider, id)` из `ctx.modelRegistry`.
- `economy`: применяет `min(272000, declared capability)`. Для окна 272K native Pi с обычным reserve 16K начинает сжатие примерно на 256K.
- `long-once`: доступен только при росте над economy; применяет `min(372000, capability)` и после **успешного** native compact возвращает economy.
- `long-chat`: доступен по тому же контракту; применяет `min(600000, capability)` и сохраняется после compact и возобновления сессии.
- `off`: возвращает declared registry-окно и отключает только soft cap extension. Он не отключает native automatic compaction или overflow recovery Pi: public session-scoped API для этого отсутствует.

Расширение сохраняет текущий session thinking level при metadata-only `pi.setModel()`. Если модель не принимает окно, режим откатывается к economy и появляется уведомление.

Footer:

```text
ctx <tokens>/<window> <percent>% · compact@<threshold|off> · <mode>
```

Порог в footer — ожидаемая граница native Pi при стандартном reserve 16K; он не является отдельной перехватываемой policy extension.

## Checkpoint и native compaction

`checkpoint_compact_continue` создаёт `manual-pending`; `ctx.compact()` начинается только на `agent_settled`, когда `ctx.isIdle()`. Для ручного compact extension передаёт structured ledger как custom instructions.

После подтверждённого `session_compact` extension только отмечает успех. Follow-up для ручного checkpoint вызывается из `ctx.compact().onComplete`, когда Pi уже снял internal compaction lock; до него `sendUserMessage()` отклоняется. Перед вызовом проверяются branch/session, watermark последнего настоящего user message и состояние `pi-codex-goal`.

Контракт — **at-most-one send invocation**. Public `ExtensionAPI.sendUserMessage()` не возвращает квитанцию постановки в очередь: extension не может отличить принятую очередь от ошибки, которую Pi передаёт в runtime error handler. Поэтому audit фиксирует один вызов после снятия lock и не делает retry.

Automatic threshold, raw `/compact` и overflow принадлежат Pi. Extension только пишет audit и применяет rollback режима `long-once` после успешного `session_compact`; он не создаёт synthetic continuation и не ставит retry после `session_compact_failed`.

## Язык summaries

Расширение переиспользует native compaction и branch summarization Pi через публичные хуки `session_before_compact` и `session_before_tree`. Естественный текст summaries запрашивается на русском языке, а фиксированные заголовки нормализуются в русские названия без изменения путей, команд, идентификаторов, сообщений ошибок и machine-readable блоков.

Для обычного compact сохраняется native split-turn preparation и cumulative file tracking. Для `/tree` сохраняются `readFiles`, `modifiedFiles` и `usage`. Если пользовательская русская генерация недоступна или завершается ошибкой, обработчик возвращает `undefined`, и Pi использует штатный summarizer.

Публичный `SessionBeforeTreeEvent` не отдаёт настройку `branchSummary.reserveTokens`, поэтому extension использует native default `16384`. При нестандартном значении native может выбрать другой объём истории для `/tree`.

## Журнал сессии

Расширение добавляет append-only custom-записи:

- `context-compaction-mode` с именованным режимом;
- `context-compaction-audit` версии 2: correlation, origin, reason, phase, tokens, window, threshold, mode, source, `willRetry` и захваченный session/tree.

Audit не содержит summary, transcript, tool bodies, raw errors, auth/env, PID или пути. Старые `checkpoint-compact-session-threshold` только обнаруживаются, игнорируются и один раз показывают уведомление; они не переписываются.

## Проверка

```bash
# Команду запускайте из корня репозитория
npm run verify
```

`verify` использует runtime closure текущего `pi` и проверяет типы локальным TypeScript из `devDependencies`. Если launcher — shell wrapper, задайте `PI_RUNTIME_FINAL_CLI` равным фактическому final CLI; resolver намеренно не ищет другой `pi` на `PATH`.

## Для участников

Перед отправкой изменений запустите `npm run verify`. Не добавляйте `node_modules`, `.env`, локальные runtime-артефакты и временные файлы. Изменения поведения должны опираться на публичные API Pi; private runtime bridges и monkey-patching в проекте не принимаются.
