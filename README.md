# Snoser — Deploy to Render.com

## Подготовка

Убедись, что всё установлено локально:

```bash
cd snoser
npm install
```

## 1. Залить на GitHub

```bash
cd snoser
git init
git add .
git commit -m "init"
```

Создай репозиторий на GitHub, затем:

```bash
git remote add origin https://github.com/ТВОЙ_ЮЗЕР/ТВОЙ_РЕПО.git
git push -u origin main
```

## 2. Создать PostgreSQL на Render

1. Зайди в [Render Dashboard](https://dashboard.render.com)
2. Нажми **New +** → **PostgreSQL**
3. Заполни:
   - **Name**: `snoser-db`
   - **Plan**: Free
4. Нажми **Create Database**
5. После создания скопируй **Internal Database URL** (зелёная кнопка)

## 3. Создать Web Service на Render

1. В Render Dashboard нажми **New +** → **Web Service**
2. Выбери свой GitHub репозиторий
3. Заполни:
   - **Name**: `snoser`
   - **Root Directory**: `snoser`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: **Free**
4. Нажми **Advanced** и добавь переменные окружения:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | Internal Database URL из шага 2 |
| `SESSION_SECRET` | любая случайная строка (например `mysupersecret123`) |
| `SELF_URL` | оставь пустым — Render сам подставит |

5. Нажми **Create Web Service**

## 4. Чтобы сервер не выключался

**Keep-alive уже встроен** (`server.js:13-26`) — сервер пингует сам себя каждые 10 минут через `RENDER_EXTERNAL_URL`. Render автоматически заполняет эту переменную.

Для 100% безотказности:
- **Starter Plan** ($7/мес) → настройка **Sleep**: `No` / Disabled
- Или создай бесплатный cron на [cron-job.org](https://cron-job.org):
  - URL: `https://snoser.onrender.com`
  - Interval: Every 5 minutes
  - Это резервный пинг, если встроенный keep-alive не сработает

## 5. База данных не теряется

- На **Free** плане PostgreSQL данные **сохраняются** даже после перезапуска сервера
- Через 90 дней неактивности база может перейти в read-only режим
  - Решение: просто обнови её — или перейди на платный план $7/мес
- На **Starter** плане — без ограничений

## Итог

После деплоя:
- Админ: `admin` / `tim10080`
- Демо: `demo` / `user123`
- Ссылка: `https://snoser.onrender.com`

Статистика (атаки, пользователи) хранится в PostgreSQL и не пропадает при рестарте.
