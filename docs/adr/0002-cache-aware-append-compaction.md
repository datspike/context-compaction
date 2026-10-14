# ADR-0002: Opt-in append compact с неизменным system/tools envelope

- Статус: локальный кандидат сохранён opt-in; default-on отклонён по отрицательному cache verdict в функциональной приёмке.
- Основание: владелец согласовал append-задачу, включённый кэш, детерминированный хвост, стандартный запасной путь и явно потребовал сохранность исходного system/tools envelope.

## Решение

Для русского режима добавить настройку `contextCompaction.appendCompaction`, по умолчанию `false`. Публичные `context_with_system` и `before_provider_request` сохраняют один ограниченный снимок в памяти. История, system и объявления tools не переписываются; задача добавляется одним user message в конец.

Отдельный `modelRegistry.streamSimple` использует `cacheRetention: "short"`, исходный session cache key и `transport: "sse"`. Запрос не участвует в рабочем инструментальном цикле. `toolChoice: "none"` и задача запрещают действия, результат с tool calls не принимается. Нового compact-tool в envelope нет.

Первая поддержка ограничена `openai-responses` с mid-conversation system messages. Перед сетью `onPayload` проверяет неизменность исходных input prefix, tools, instructions и cache key и добавляет native Structured Outputs schema с обязательными `history`/`turnPrefix`. Schema не меняет input prefix. Любое расхождение выбирает существующий summarizer до отправки. Проверка требует реального эвала: одинаковый payload и одинаковый prefix ещё не гарантируют cache hit.

Граница сжатия принадлежит подготовке Pi. Свежий хвост не генерируется моделью и его `firstKeptEntryId` не меняется. Несопоставимая с исходным снимком подготовка, недоступный снимок или недостаток объявленного окна выбирают прежний путь. После ответа provenance guard отклоняет summary, если числовой факт найден только в неразрешённом хвосте; это fail-closed защита от смыслового дублирования, допускающая безопасный fallback.

После structured-ответа с ошибкой формата допускается одна repair-попытка. `invalid-result` и `request-failed` после неё переходят в стандартный русский compact с коротким warning; частичный append-результат не применяется. Отмена и смена ветки не повторяются. Успех сохраняет суммарный provider usage, включая repair; отказ сохраняет доступный usage в служебной записи без текста контекста. Английский compact и /tree не меняются.

## Границы

Не подразумевается поддержка 1M по одному pricing tier. Structured Outputs и fallback реализуются только для `openai-responses`; `pi-claude-provider` и общий capability-контракт отложены в Q13. Не меняются capability реестра, установленный Pi, глобальные настройки или основной checkout. Снимки не пишутся на диск. Не вводятся новые внутренние API Pi или копии provider pipeline.

## Проверка

Немодельные тесты provider payload/schema, хвоста, окна, repair, fallback и provenance regression fixture проходят. Переоценка сохранённых выходов и новая парная приёмка использовали marked receipts и Structured Outputs; однако на исправленном стенде C несколько раз штатно завершался с `stopReason=stop` и `toolCalls=0`, но с `cacheRead=0`, включая запуск после выравнивания Structured Outputs и запуск с явным уникальным `prompt_cache_key`. Это отрицательный результат по обязательному cache gate, а не доказательство ухудшения качества continuation: неполные пары не получили полноценный judge. Поэтому standalone остаётся основным путём, а append сохраняется только как opt-in для дальнейшего отдельного исследования транспорта кэша.
