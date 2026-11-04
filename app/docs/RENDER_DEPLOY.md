# Render и Neon

Эта конфигурация размещает React-интерфейс и Node.js API на Render, а данные —
в PostgreSQL Neon. Локальная файловая система Render не используется как
источник данных.

`render.yaml` разрешает создание выключенных объектов в Директе, но оставляет
модерацию, запуск показов, загрузку изображений и A/B-записи выключенными. Это
намеренно: каждый тип внешней записи включается отдельным флагом.

## 1. Подготовка

Нужны:

- репозиторий без `.env`, базы, выгрузок и API-ключей;
- проект Neon и две строки подключения: pooled для приложения, direct для
  миграций;
- OAuth-приложения Google и Яндекса;
- постоянный `TOKEN_ENCRYPTION_KEY`.

Создайте ключ локально:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Сохраните его в менеджере секретов. Замена ключа без миграции сделает
сохранённые OAuth- и Kie.ai-токены нечитаемыми.

## 2. База

В Render задайте pooled-строку как `DATABASE_URL`. Для миграции используйте
direct-строку без `-pooler`:

```powershell
$env:DATABASE_URL='<direct Neon URL>'
npm ci
npm run db:migrate:postgres
npm run db:verify:postgres
```

Миграцию запускают до деплоя новой версии приложения. Веб-процесс не меняет
схему при старте и завершится ошибкой, если версия БД не совпадает с версией
кода.

## 3. Web Service

1. В Render выберите **New → Blueprint** и подключите репозиторий.
2. Проверьте `APP_ORIGIN`. Он должен точно совпадать с публичным HTTPS-адресом,
   без завершающего `/`.
3. Добавьте секреты:

   ```text
   DATABASE_URL=<pooled Neon URL>
   TOKEN_ENCRYPTION_KEY=<32 байта в base64>
   GOOGLE_CLIENT_ID=<client id>
   GOOGLE_CLIENT_SECRET=<client secret>
   YANDEX_CLIENT_ID=<client id>
   YANDEX_CLIENT_SECRET=<client secret>
   REMOTE_AI_WORKER_TOKEN=<случайная строка длиной 32+>
   ```

4. В Google Auth Platform добавьте:

   ```text
   Authorized JavaScript origin: https://<домен>
   Authorized redirect URI:      https://<домен>/auth/google/callback
   ```

5. Для Яндекса используйте приложение типа, совместимого с
   `https://oauth.yandex.ru/verification_code`. Callback приложения здесь не
   подменяет этот URI.

После деплоя проверьте:

```sh
curl https://<домен>/api/health
curl https://<домен>/api/ready
```

`ready=true` означает, что приложение подключилось к ожидаемой версии схемы.
Это не разрешение на рекламные расходы.

## 4. Фоновый запуск через Neon Function

Render Free засыпает при простое, поэтому встроенный таймер не считается
always-on worker. В репозитории есть `neon/functions/autopilot-cron/index.ts`.
Функция принимает только подписанный schedule-trigger и вызывает защищённый
маршрут Render.

В Render и Neon Function задайте одну и ту же случайную строку длиной не менее
32 символов:

```text
Render: AUTOPILOT_WORKER_TOKEN
Neon Function: RITM_WORKER_TOKEN
```

В Neon Function также задайте:

```text
RITM_WORKER_URL=https://<домен>/api/internal/autopilot/tick
```

Production-конфигурация использует функцию `autopilotcron` и schedule-trigger
`ritm-autopilot-every-15-min` с выражением `*/15 * * * *`. Cron только будит
очереди. Он не обходит `LIVE_ADS_ENABLED`, `AUTOPILOT_ENABLED` и pilot-флаги.

Проверяйте не только наличие trigger, но и реальную доставку:

```sh
neon triggers list --branch main --output json
neon logs query --branch main --source function --since 30m
```

Проверка ручным `curl` с неверным токеном должна вернуть 401. Действующий токен
не печатайте в логи или переписку.

## 5. Флаги внешних записей

| Флаг                                | Что разрешает                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `LIVE_ADS_ENABLED`                  | Общий production-gate. Требует HTTPS, production и постоянный ключ шифрования                     |
| `DIRECT_WRITE_PILOT_ENABLED`        | Создание выключенной кампании, группы, фраз и объявлений                                          |
| `DIRECT_IMAGE_UPLOAD_PILOT_ENABLED` | Загрузку согласованного изображения в библиотеку Директа                                          |
| `DIRECT_MODERATION_PILOT_ENABLED`   | Отправку сверенных объявлений на модерацию                                                        |
| `DIRECT_RESUME_PILOT_ENABLED`       | Одноразовый запуск показов после всех проверок                                                    |
| `AUTOPILOT_ENABLED`                 | Budget Guard, остановку неэффективного направления и применение подготовленного перераспределения |
| `DIRECT_AB_VARIANT_PILOT_ENABLED`   | Создание варианта Б в сверенной выключенной группе                                                |
| `DIRECT_AB_DECISION_PILOT_ENABLED`  | Применение финального A/B-решения                                                                 |
| `DIRECT_ARCHIVE_PILOT_ENABLED`      | Отдельную необратимую архивацию                                                                   |

`render.yaml` не включает платный запуск. Меняйте флаги по одному и только после
прохождения соответствующего шага из [PRODUCTION_RUNBOOK.md](PRODUCTION_RUNBOOK.md).

## 6. Обновление и откат версии

Перед деплоем:

```sh
npm ci
npm run check
npm run production:preflight:strict
```

Если новая версия требует миграцию, сначала проверьте её на ветке Neon, затем
примените direct-подключением к production. Откат кода допустим только к версии,
которая понимает текущую схему.

Откат рекламного действия выполняется через журнал Ритма. Не повторяйте вручную
запрос, оставшийся в `needs_reconciliation`: сначала запустите read-only сверку.
