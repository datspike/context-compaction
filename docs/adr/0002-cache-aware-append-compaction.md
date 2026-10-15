# ADR-0002: Default-on append compact с неизменным system/tools envelope

- Статус: принят для default-on rollout на поддержанном `openai-responses`; остальные модели используют стандартный compact.
- Основание: владелец согласовал append-задачу, включённый кэш, детерминированный хвост, стандартный запасной путь и явно потребовал сохранность исходного system/tools envelope.

## Решение

Для русского режима добавить настройку `contextCompaction.appendCompaction`, по умолчанию `true`. Явное `false` остаётся opt-out. Публичные `context_with_system` и `before_provider_request` сохраняют один ограниченный снимок в памяти. История, system и объявления tools не переписываются; задача добавляется одним user message в конец.

Отдельный `modelRegistry.streamSimple` использует `cacheRetention: "short"`, исходный session cache key и `transport: "sse"`. Запрос не участвует в рабочем инструментальном цикле. `toolChoice: "none"` и задача запрещают действия, результат с tool calls не принимается. Нового compact-tool в envelope нет.

Первая поддержка ограничена `openai-responses` с mid-conversation system messages. Перед сетью `onPayload` проверяет неизменность исходных input prefix, tools, instructions и cache key и добавляет native Structured Outputs schema с обязательными `history`/`turnPrefix`. Schema не меняет input prefix. Любое расхождение выбирает существующий summarizer до отправки. Проверка требует реального эвала: одинаковый payload и одинаковый prefix ещё не гарантируют cache hit.

Граница сжатия принадлежит подготовке Pi. Свежий хвост не генерируется моделью и его `firstKeptEntryId` не меняется. Несопоставимая с исходным снимком подготовка, недоступный снимок или недостаток объявленного окна выбирают прежний путь. После ответа provenance guard отклоняет summary, если числовой факт найден только в неразрешённом хвосте; это fail-closed защита от смыслового дублирования, допускающая безопасный fallback.

После structured-ответа с ошибкой формата допускается одна repair-попытка. `invalid-result` и `request-failed` после неё переходят в стандартный русский compact с коротким warning; частичный append-результат не применяется. Успешный append и fallback показывают короткую строку с cache status, длительностью и стоимостью; для pre-send fallback явно указываются `cache not attempted` и `$0.0000`, а stale `context-changed`, отмена и устаревший результат уведомление не вызывают. Обычный штатный compact уведомление не вызывает. Отмена и смена ветки не повторяются. Успех сохраняет суммарный provider usage, включая repair, и число `repairAttempts`; отказ сохраняет доступный usage и число попыток в служебной записи без текста контекста. Английский compact и /tree не меняются.

Для диагностики `payload-mismatch` существующая запись `context-compaction-append` может содержать `payloadMismatch`: фиксированные имена несовпавших полей, индекс первого отличия input и размеры обеих сторон. Тексты, значения cache key, хеши и сами payload не сохраняются. Диагностика не разрешает отправку: существующий guard и стандартный fallback остаются неизменными.

## Границы

Не подразумевается поддержка 1M по одному pricing tier. Structured Outputs и fallback реализуются только для `openai-responses`; `pi-claude-provider` и общий capability-контракт отложены в Q13. Не меняются capability реестра, установленный Pi, глобальные настройки или основной checkout. Снимки не пишутся на диск. Не вводятся новые внутренние API Pi или копии provider pipeline.

## Проверка

Немодельные тесты provider payload/schema, хвоста, окна, repair, fallback, provenance, audit provider/model и notification format проходят. Clean judge batch дал ограниченный положительный сигнал качества на сохранённых continuation, но лабораторные `cacheRead=0` не блокируют rollout: cache reuse диагностируется по usage в рабочем Pi-сетапе. Append включён по умолчанию только для поддержанного `openai-responses`; остальные модели используют стандартный compact. Non-structured append остаётся отдельной будущей задачей Q13.
