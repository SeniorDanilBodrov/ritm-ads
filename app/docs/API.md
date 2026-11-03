# API версии 0.1

Сервер отдает JSON и использует HttpOnly SameSite=Lax cookie `ritm_session`. В production cookie Secure. Денежные поля API — **целые копейки**; цены в пользовательской анкете — рубли, преобразование выполняет интерфейс.

| Метод и путь                                              | Назначение                                              |
| --------------------------------------------------------- | ------------------------------------------------------- |
| GET /api/health                                           | Доступность сервера и БД                                |
| GET /api/ready                                            | Версия схемы, агрегаты очередей и число операций сверки |
| GET /api/session                                          | Пользователь и доступность настроенных подключений      |
| POST /api/demo                                            | Создание изолированного демо с примерами                |
| POST /api/logout                                          | Отзыв текущей сессии                                    |
| GET /api/businesses                                       | Собственные бизнесы                                     |
| POST /api/businesses                                      | Создание пустого бизнеса по анкете                      |
| GET /api/workspace?businessId=UUID                        | Состояние, итоги, история, метаданные подключений       |
| POST /api/businesses/:id/command                          | Операция симулятора                                     |
| POST /api/businesses/:id/analyze                          | Python-анализ снимка, без изменения рекламных объектов  |
| GET /api/businesses/:id/export                            | CSV по направлениям текущего периода                    |
| POST /api/businesses/:id/reports                          | Поставить read-only отчёт Direct в долговечную очередь  |
| GET /api/businesses/:id/reports/:reportId/raw             | Скачать исходный TSV с метаданными и SHA-256 в JSON     |
| POST /api/businesses/:id/direct/dry-run                   | Проверить план и поставить команды в безопасную очередь |
| POST /api/businesses/:id/metrica/bind                     | Проверить доступ и привязать счетчик/цель Метрики       |
| POST /api/businesses/:id/connections/yandex/disconnect    | Отозвать токен и удалить локальное подключение          |
| GET /auth/google/start                                    | Начало Google OAuth                                     |
| GET /auth/google/callback                                 | Проверка OAuth и создание сессии                        |
| GET /auth/yandex/start?businessId=UUID                    | Открыть выдачу кода Яндекса для выбранного бизнеса      |
| POST /api/businesses/:id/yandex/oauth/complete            | Обмен одноразового кода и сохранение токена             |
| GET /api/businesses/:id/provider/clients                  | Повторить проверку доступных кабинетов Direct           |
| GET /api/businesses/:id/provider/campaigns?login=LOGIN    | Кампании принадлежащего подключению кабинета            |
| GET /api/businesses/:id/provider/report?login=LOGIN       | Отчет Директа на период; может вернуть pending          |
| GET /api/businesses/:id/provider/counters                 | Список счетчиков Метрики                                |
| GET /api/businesses/:id/provider/goals?counterId=ID       | Цели выбранного счетчика                                |
| GET /api/businesses/:id/provider/metrica-stats            | Визиты и достижения сохраненной цели за период          |
| PUT /api/businesses/:id/image-provider/openai             | Сохранить зашифрованный ключ OpenAI для этого бизнеса   |
| DELETE /api/businesses/:id/image-provider/openai          | Отключить новые генерации OpenAI                        |
| POST /api/businesses/:id/creative-images                  | Поставить генерацию изображения в очередь               |
| POST /api/businesses/:id/creative-images/:assetId/approve | Согласовать готовый визуал вручную                      |
| GET /api/businesses/:id/creative-images/:assetId/file     | Получить готовое изображение владельца бизнеса          |
| DELETE /api/businesses/:id/creative-images/:assetId       | Удалить завершённый несогласованный вариант             |

Любой POST требует `Origin`, совпадающий с `APP_ORIGIN`, и `X-Ritm-Request: 1`. Команды дополнительно требуют `Idempotency-Key: UUID`. При потере сетевого ответа клиент должен повторить ту же команду с тем же ключом. Стандартный UI не делает автоматических повторов; при неясном исходе сначала обновите страницу, чтобы увидеть фактическое состояние.

### Яндекс Метрика

`POST /api/businesses/:id/metrica/bind` проверяет через Management API, что выбранные счётчик и цель доступны подключённому аккаунту, и сохраняет их в бизнесе. `GET /api/businesses/:id/metrica/setup` повторно читает выбранные объекты и возвращает безопасный код установки счётчика, точный вызов JavaScript-цели (только для цели типа `action`) и диагностику соответствия домена. Маршрут ничего не создаёт и не изменяет в Метрике. Код цели нужно вызывать только после подтверждённой отправки формы; показ страницы не считается обращением.

Удаление креатива также требует корректный Origin и пользовательскую сессию. Сервер отклоняет удаление генерации со статусом `pending/running` и любого уже согласованного ассета. SQLite хранит файл внутри `ASSET_STORAGE_PATH`; путь проверяется до операции. PostgreSQL-режим хранит JPEG в Neon и не зависит от диска Render. Опциональная очистка `CREATIVE_RETENTION_DAYS` относится к локальному хранилищу и выключена при значении `0`.

Тело `POST /api/businesses/:id/creative-images`:

```json
{
  "prompt": "Специалист готовит рабочее место перед приёмом клиента",
  "goal": "leads",
  "hook": "outcome",
  "audience": "Жители города, которым важны аккуратность и удобная запись",
  "style": "editorial",
  "format": "standard",
  "brandPlacement": "bottom-left"
}
```

`goal`: `leads | trust | offer`; `hook`: `outcome | human | perspective`; `style`: `editorial | local | detail`; `format`: `standard` (4:3), `square` (1:1), `wide` (16:9) или `vertical` (3:4); `brandPlacement`: `bottom-left | bottom-right | none`. `hook` задаёт визуальный крючок: результат, живой момент или сильный ракурс. Название берётся из профиля бизнеса на момент постановки задачи и наносится после генерации, поэтому модель не получает поручение рисовать буквы. Сервер дополняет prompt данными бизнеса, вызывает подключённый OpenAI или локальный FastSDCPU/OpenVINO API и готовит непрозрачный JPEG до 4 МБ. Ответ workspace показывает пользовательское описание, цель, крючок, формат, размеры, использованное название и статус, но не раскрывает ключ или внутреннее место хранения. Старые клиенты получают `hook=outcome` и сохраняют text-free поведение `brandPlacement=none`.

```json
{
  "action": "budget",
  "payload": { "budget": 4000000, "targetCpa": 45000 }
}
```

Поддерживаются `tick`, `toggle`, `campaign` (`id`), `budget`, `settings` (анкета), `analytics`, `generate`, `approve` (`id`), `launch`, `rollback` (`id`), `schedule` (`enabled: boolean`). На live-бизнесе локальная команда `settings` разрешена: она обновляет только анкету и не обращается к рекламной площадке. Все команды, способные изменить рекламу, бюджет, расписание или симулируемое состояние, отклоняются с 409 `live_gate`.

`schedule` включает/выключает фоновый анализ сохраненной статистики. `GET /api/workspace` возвращает последние пять собственных заданий в `jobs`: статус, число попыток и безопасное сообщение об ошибке. Поле `availableAt` — техническое время готовности/lease/завершения, зависит от статуса; не является точным обещанием времени выполнения. Отключение отменяет pending-задания. Running-задание может закончить вычисления, но его результат не будет сохранен после отключения. Фоновый анализ не получает статистику у провайдера и не исполняет рекламу.

Фактическая shadow-сверка реальной кампании возвращает в `source.metrica` общесайтовые итоги, а в `source.attributedMetrica` — несемплированный срез Метрики по точному ID кампании (`ym:s:lastsignDirectClickOrder`, attribution `lastsign`). `campaignGoalReaches` и `campaignCpaKopecks` остаются `null`, если такого среза нет или целей ноль. Семплированный либо некорректный ответ не сохраняется. Сверка всегда возвращает `executed=false`.

## План Direct и dry-run

### Одноразовая архивация созданной кампании

`POST /api/businesses/:id/direct/:changeId/archive` подготовлен как отдельный закрытый pilot endpoint. Для доступа одновременно нужны `DIRECT_ARCHIVE_PILOT_ENABLED=true`, `DIRECT_WRITE_PILOT_ENABLED=true`, production, допустимый origin и постоянный ключ шифрования. Запрос требует `Idempotency-Key: UUID` и JSON `{ "confirmCampaignId": 123, "confirmedNoFunds": true }`. ID должен совпасть с ID завершённого и сверенного исполнения. Флаг об отсутствии средств подтверждает владелец; сам сервис не выдаёт статистику расходов за доказательство нулевого остатка на кампании.

Перед записью сервер читает кампанию заново. `Campaigns.archive` вызывается только для `SUSPENDED`; `OFF/DRAFT` получает `failed_no_write/not_suspended`. После ответа выполняется повторное чтение `ARCHIVED`. Результат и факт попытки записи сохраняются в `direct_archive_actions`. Повтор с тем же ключом только возвращает запись журнала. Если ответ или проверка после отправки неопределённы, статус `needs_reconciliation` запрещает новую отправку; `POST /api/businesses/:id/direct/:changeId/archive/:actionId/inspect` лишь читает состояние. `GET /api/businesses/:id/direct/:changeId/archive` возвращает журнал. На локальном сервере gate закрыт, реальная кампания `715574939` остаётся `OFF/DRAFT` и не архивирована.

`GET /api/businesses/:id/direct/:changeId/moderation-readiness` читает бюджет, выключенное состояние кампании, точный состав и содержание объявлений, фразы и основные поля рекламодателя. Возвращает `technical_ready` либо причины блокировки без внешних записей. `GET /api/businesses/:id/direct/:changeId/moderation-actions` возвращает журнал. `POST /api/businesses/:id/direct/:changeId/moderate` закрыт по умолчанию: нужны `DIRECT_MODERATION_PILOT_ENABLED=true`, `DIRECT_WRITE_PILOT_ENABLED=true`, production, допустимый origin, постоянный ключ, `Idempotency-Key: UUID` и JSON `{ "advertiserConfirmed": true, "siteConfirmed": true }`. Сервер повторяет проверку, отправляет только сохранённые ID в `Ads.moderate`, затем читает статусы. Неопределённый результат не повторяется; `POST /api/businesses/:id/direct/:changeId/moderation/:actionId/inspect` выполняет только чтение. Эта операция не вызывает `Campaigns.resume` и не включает показы. Тестовую кампанию с вымышленным рекламодателем отправлять на модерацию нельзя.

`GET /api/businesses/:id/direct/:changeId/control-review` возвращает последнюю проверку готовности, а `POST` с `Idempotency-Key: UUID` повторно читает периодный бюджет, статусы, точные ID и содержание объявлений, фразы и свежий сохранённый отчёт. `technical_ready` означает только техническую готовность. `GET /api/businesses/:id/direct/:changeId/resume-actions` возвращает журнал запуска. `POST /api/businesses/:id/direct/:changeId/resume` закрыт по умолчанию и требует `DIRECT_RESUME_PILOT_ENABLED=true`, остальные pilot safeguards, `Idempotency-Key: UUID` и тело `{ "advertiserConfirmed": true, "siteConfirmed": true, "markingConfirmed": true, "spendConfirmed": true, "confirmCampaignId": 123, "confirmLimitKopecks": 300000 }`. После повторной проверки сервер записывает действие в журнал до единственного вызова `Campaigns.resume` и читает статус `ON`. Если исход неизвестен, повторный write запрещён; `POST /api/businesses/:id/direct/:changeId/resume/:actionId/inspect` только читает состояние. Неопределённость не блокирует отдельную аварийную остановку после завершения запроса запуска.

`GET /api/businesses/:id/direct/:changeId/budget-limit` возвращает последние операции лимита. `POST` закрыт флагом `DIRECT_BUDGET_PILOT_ENABLED=false` и остальными pilot safeguards; требует `Idempotency-Key: UUID` и тело `{ "proposedLimitKopecks": 250000, "confirmCampaignId": 123, "confirmPreviousLimitKopecks": 300000, "budgetConfirmed": true }`. Разрешено только уменьшение свежесверенного периодного лимита выключенной `TEXT_CAMPAIGN`. Намерение сохраняется до единственного `Campaigns.update`, а новый лимит подтверждается повторным чтением. Неопределённый ответ получает `needs_reconciliation` и не повторяется; `POST /api/businesses/:id/direct/:changeId/budget-limit/:actionId/inspect` выполняет только чтение.

### Предварительная регистрация A/B-гипотезы

`POST /api/businesses/:id/direct/:changeId/ab-plan` принимает `Idempotency-Key: UUID` и `{ "hypothesis": "...", "variant": { "title": "...", "text": "..." }, "minDays": 14, "minImpressionsPerVariant": 1000 }`. Разрешается один неизменяемый план на сверенное исполнение с одним контрольным объявлением и тем же Яндекс-подключением. План нужно зафиксировать до начала периода; его срок не может превышать срок кампании. URL варианта Б берётся из контрольного объявления, основная метрика — CTR. Фиксация плана не создаёт объявление Б и не включает показы. Повтор того же payload и ключа возвращает исходный план; конфликт даёт 409. `GET /api/workspace` содержит `abPlans` с блокерами, доказательствами и состоянием вывода.

`POST /api/businesses/:id/direct/:changeId/ab-variant` закрыт флагом `DIRECT_AB_VARIANT_PILOT_ENABLED=false` и общими pilot safeguards. Он требует `Idempotency-Key: UUID` и `{ "confirmCampaignId": 123, "confirmControlAdId": "456", "variantConfirmed": true }`. Сервер повторно читает выключенную кампанию, точное контрольное объявление и группу, затем создаёт ровно один `ResponsiveAd` для единой кампании либо `TextAd` для текстовой. Новый ID и содержание читаются обратно; модерация и `Campaigns.resume` не вызываются. Неопределённый `Ads.add` не повторяется: `POST /api/businesses/:id/direct/:changeId/ab-variant/:actionId/inspect` только читает группу и сверяет точный вариант. `GET /api/businesses/:id/direct/:changeId/ab-actions` возвращает журнал.

`POST /api/businesses/:id/direct/ab-plans/:planId/report` требует `Idempotency-Key: UUID` и ставит в общую долговечную очередь read-only `AD_PERFORMANCE_REPORT`. Логин и два ID берутся только из принадлежащего бизнесу A/B-плана; произвольные ID клиент не передаёт. Снимок хранится отдельно от кампанийного отчёта и не используется как доказательство общего расхода. `abPlans[].evidence` содержит CTR, клики, показы, баланс и срок. До конца периода состояние только `collecting`; финальный результат требует минимальный срок, выборку на оба варианта и долю показов каждого варианта 40–60%. При непересекающихся 95% интервалах Уилсона возвращается победитель, иначе `inconclusive`.

`POST /api/businesses/:id/direct/ab-plans/:planId/decision` закрыт флагом `DIRECT_AB_DECISION_PILOT_ENABLED=false` и общими production safeguards. Запрос требует `Idempotency-Key: UUID` и точное подтверждение `{ "operation": "rollback_variant" | "apply_outcome", "confirmCampaignId": 123, "confirmTargetAdId": "456", "confirmed": true }`. До начала периода и до первого A/B-отчёта `rollback_variant` удаляет через `Ads.delete` только сверенный выключенный черновик варианта Б. После финального `control_wins` или `variant_wins` операция `apply_outcome` сама вычисляет проигравший ID и останавливает его через `Ads.suspend`. Намерение сохраняется до записи, результат читается обратно, неопределённый ответ никогда не повторяется автоматически. `GET /api/businesses/:id/direct/ab-plans/:planId/decisions` возвращает журнал, а `POST .../decisions/:actionId/inspect` выполняет только read-only сверку.

`POST /api/businesses/:id/direct/dry-run` работает только для обычного, не демонстрационного бизнеса. Он принимает логин кабинета, название кампании, URL, аудиторию, `regionIds`, бюджет и CPA в копейках, период, необязательные ID счетчика/цели, массив объявлений и ключевых фраз. Сервер валидирует лимиты полей и строит пять зависимых команд `campaigns.add → campaigns.suspend → adgroups.add → keywords.add → ads.add`. Для черновика Direct состояние `OFF/DRAFT` подтверждается чтением вместо невозможной остановки. Неизвестные удаленные ID представлены ссылками `$ref` и разрешаются последовательным исполнителем.

Сейчас endpoint всегда создает задание `mode=dry_run`. Worker проверяет полный пакет, сохраняет результат и сверку `expectedCommands/preparedCommands`, но выполняет **0 внешних запросов**. `GET /api/workspace` возвращает до 20 записей `directChanges` с командами, статусом, попытками и сверкой. Повтор того же запроса с тем же `Idempotency-Key` возвращает исходное задание; другой payload с тем же ключом дает 409. Lease — 60 секунд, повторы — через 5/10/20 секунд, максимум четыре попытки. Live-исполнитель и методы адаптера покрыты контрактными тестами, но сервер их не вызывает, пока production-gate закрыт.

`POST /api/businesses/:id/connections/yandex/disconnect` сначала делает best-effort запрос `POST https://oauth.yandex.ru/revoke_token`, затем в любом случае удаляет зашифрованный токен и отменяет незавершенные задания отчетов. Ответ `revoked=false` означает, что внешний отзыв не подтвержден и доступ следует дополнительно удалить в Яндекс ID. Новые OAuth-токены запрашиваются как device-bound, чтобы Яндекс мог отозвать их программно.

После успешного обмена OAuth-кода токен сначала сохраняется зашифрованным, затем проверяется через `clients.get`. При временном таймауте подключение остается со статусом `pending`, а `GET /provider/clients` повторяет проверку без нового OAuth. При невосстановимой ошибке новое подключение удаляется либо восстанавливается прежняя запись. Метрика не зависит от наличия списка логинов Direct.

Access- и refresh-токены сохраняются одной AES-GCM записью и никогда не возвращаются клиенту. Если известный срок истекает менее чем через пять минут, сервер выполняет `grant_type=refresh_token` до обращения к Direct/Метрике. Ошибка авторизации Direct (`53`/`1002`) или HTTP 401 вызывает один принудительный refresh и один повтор только read-only операции. Одновременные запросы одного бизнеса используют один обмен; новый access/refresh token записывается сравнением с прежним ciphertext. `invalid_grant` не удаляет сохраненную запись, но ставит `validation=reauth_required`, блокирует чтение в UI и предлагает повторный OAuth. Стабильный `connectionId` отличает обычную ротацию от подключения другого аккаунта, поэтому ротация не отменяет ожидающий отчет.

`POST /api/businesses/:id/metrica/bind` принимает `{ "counterId": "123", "goalId": "456" }`, повторно читает доступные счетчики и цели у Метрики и только затем сохраняет выбор. Для статистики используются `ym:s:visits` и `ym:s:goal<ID>reaches` с `accuracy=full`. Создание счетчика или цели приложение не выполняет.

`GET /api/workspace` проверяет принадлежность business ID; внешний ID не используется как доказательство доступа. При ошибке возвращаются `error` и `code`; при Zod-валидации дополнительно `fields`. 401 означает отсутствие сессии, 403 — проверка доступа/Origin, 409 — конфликт состояния или недостаточный бюджет, 502 — ошибка внешней площадки.

`POST /api/businesses/:id/reports` принимает `{ "login": "...", "scenario": "normal" }` и требует `Idempotency-Key`. Для демо логин пустой; сценарии `revised` и `pending` доступны только демобизнесу. Ответ 202 содержит `jobId`. `GET /api/workspace` возвращает `reportJobs` и до десяти `reports`; клиент обновляет состояние кнопкой, но серверный worker работает без вкладки.

Отчёт 201/202 остаётся pending до указанного `retryAfter` и никогда не трактуется как нулевой расход. Ожидание ограничено 30 запросами, временные ошибки — тремя попытками. Снимок сохраняется атомарно только после проверки UTF-8, размера до 2 МиБ, всех шести колонок, периода, валюты RUB, НДС, дат и безопасных чисел; максимум 10 000 строк. В JSON-выгрузке есть `source`, `login`, период, валюта, `includeVat`, `receivedAt`, `requestId`, `sha256` и `rawTsv`.

`Cost` преобразуется в целые копейки. Одинаковый SHA-256 внутри одного scope повторно не сохраняется; исправленный снимок связывается с предыдущим и сравнивается по паре дата + campaign ID. Эти значения не смешиваются с обзором и не меняют рекламные объекты или бюджет.

`POST /api/businesses/:id/analyze` принимает `{}` и требует `Idempotency-Key: UUID`. Результат сохраняется в `state.analysis`, событие — в истории. Изменение снимка во время анализа дает 409 `stale_analysis`; повторять следует новым ключом после обновления данных. 429 — занят слот анализа, 503 — Python не настроен, 502 — ответ модели/процесса отклонен, 504 — таймаут. Поле `executed` всегда false. `analysis.stateVersion !== workspace.version` означает, что после сохранения результата были другие изменения. Реклама, расход и общий лимит этим endpoint не меняются.
