# Changelog

Each version has an English and a Russian section. The release description on
GitHub uses the same two sections, and the app shows the one of its language in
the update window. Mentions like `@everyone` always go in backticks: GitHub takes
a bare mention for a GitHub user and lists that user as a contributor of the release.

## 0.8.1

<details>
<summary>English</summary>

- Release notes in the update window follow the app language: every release carries an English and a Russian section.
- A smaller installer: libraries already built into the app page are no longer packed a second time (about 50 MB less inside).
- CHANGELOG.md in the repository.

</details>

<details>
<summary>Русский</summary>

- Описание обновления в окне обновления на языке программы: в каждом релизе есть английская и русская часть.
- Установщик меньше: библиотеки, которые уже собраны в страницу программы, больше не пакуются второй раз (внутри примерно на 50 МБ меньше).
- В репозитории появился CHANGELOG.md.

</details>

## 0.8.0

<details>
<summary>English</summary>

### New
- **Moonlight**: a built-in GameStream client. Pair with Sunshine on a friend's PC by PIN and watch the stream with hardware decoding, as a tile in the call. "Watch via Moonlight" in the person's menu.
- **Soundboard**: short sounds of a server (up to 7 s and 1 MB, with a name and an emoji) played for everyone in the call, each at their own soundboard volume. A "Sounds" tab in server settings.
- **Profile banner**: the avatar color, an own color or a picture, with up to three emoji on top. Shown on the profile card and behind the avatar in calls.
- **Server profile**: an own name and picture for one server only.
- **Statuses** in a drop-down: Online, Away, Do not disturb, Streamer mode, Invisible. Do not disturb and Streamer mode silence notifications; Streamer mode also hides ids, domains and addresses.
- **`@everyone` and `@here`**, for roles allowed to use them.
- **Permissions** as a table of roles and rights, with new rights for `@everyone` and for sounds.
- **Search** in the chat header: finds parts of words, works in encrypted chats, results in a popup, the member list stays.
- **Unread**: a bar on top ("N new messages since 12:30", Mark as read), a mark on unread channels, voice channel chats count too. A chat reopens where you left it.
- A picture menu on right click: open, save as, copy.
- The channel list can be made wider or narrower. Everyone can reorder channels by dragging, or with Move up and Move down.
- Joining by address can be closed again.
- Settings: tab titles and better spacing, a live preview of the message look, switches for the stream mini player and its snapping to corners, "Hide ids and domains".

### Changed
- Direct chats are deleted from the right click menu.
- The microphone hint floats above the buttons and can be closed. "No sound from the microphone" appears only if nothing was heard since joining.
- The chat next to a call slides out smoothly; message tools float over the message.
- Names without the "(`@user:server`)" suffix.
- The image viewer zooms with the wheel only.

### Fixed
- Server icons and share tile buttons are centered.
- The pins button is always there, and the pins panel closes.
- Updating works even when a release lacks latest.yml.

### Security
- The window cannot be navigated away from the app, the main process answers only the app's own page, and the page has a strict Content Security Policy.
- The microphone, camera, notifications and clipboard are given to the app's page only; the embedded YouTube player is sandboxed.
- Link previews reach the public internet only: no localhost, no local network, every redirect checked.
- The sign-in token is encrypted with Windows DPAPI.
- Media links, video ids and file types from messages are checked; a message that fails to render no longer breaks the chat; soundboard packets play only the server's own sounds.
- Electron fuses: the exe cannot be run as Node.js or opened for a debugger.

### Performance
- Only changed messages are redrawn.

License: GPLv3 (the app includes moonlight-common-c).

</details>

<details>
<summary>Русский</summary>

### Новое
- **Moonlight**: встроенный клиент GameStream. Спаривается с Sunshine на компьютере друга по PIN и показывает его экран с аппаратным декодированием, в звонке отдельной плиткой. В меню человека пункт «Смотреть через Moonlight».
- **Звуковая панель**: короткие звуки сервера (до 7 секунд и 1 МБ, с названием и эмодзи) слышат все в звонке, каждый со своей громкостью панели. Вкладка «Звуки» в настройках сервера.
- **Баннер профиля**: цвет аватарки, свой цвет или картинка и до трёх эмодзи поверх. Виден в карточке профиля и за аватаркой в звонке.
- **Профиль на сервере**: своё имя и картинка только для одного сервера.
- **Статусы** в выпадающем списке: «В сети», «Отошёл», «Не беспокоить», «Режим стримера», «Невидимка». «Не беспокоить» и режим стримера глушат уведомления, режим стримера ещё и прячет id, домены и адреса.
- **`@everyone` и `@here`** для ролей, которым это разрешено.
- **Права** таблицей «роль × право», появились права на `@everyone` и на звуки.
- **Поиск** в шапке чата: находит куски слов, работает в зашифрованных чатах, результаты во всплывающем окне, список участников остаётся на месте.
- **Непрочитанное**: полоса сверху («N новых сообщений с 12:30», «Отметить прочитанным»), отметка у непрочитанных каналов, чаты голосовых каналов тоже учитываются. Чат открывается там, где его оставили.
- Меню картинки по правой кнопке: открыть, сохранить как, копировать.
- Колонку каналов можно сделать шире или уже. Каналы может переставлять каждый: перетаскиванием или пунктами «Переместить выше» и «Переместить ниже».
- Вход по адресу можно снова закрыть.
- Настройки: заголовки вкладок и нормальные отступы, живой пример вида сообщений, переключатели мини-плеера демонстрации и его примагничивания к углам, «Скрывать id и домены».

### Изменено
- Личный чат удаляется из меню по правой кнопке.
- Подсказка про микрофон всплывает над кнопками и закрывается крестиком. «От микрофона не слышно ни звука» появляется, только если с входа в звонок не было ни звука.
- Чат рядом со звонком выезжает плавно, кнопки действий всплывают поверх сообщения.
- Имена без приписки «(`@user:server`)».
- Просмотрщик картинок приближает только колесом.

### Исправлено
- Иконки серверов и кнопки на плитке демонстрации стоят по центру.
- Кнопка закрепов на месте всегда, панель закрепов закрывается.
- Обновление работает, даже если в релизе нет latest.yml.

### Безопасность
- Окно нельзя увести со страницы программы, главный процесс отвечает только своей странице, у страницы строгий Content Security Policy.
- Микрофон, камера, уведомления и буфер обмена даются только странице программы; встроенный плеер YouTube работает в песочнице.
- Превью ссылок ходят только в публичный интернет: никакого localhost и локальной сети, каждый редирект проверяется.
- Токен входа шифруется средствами Windows (DPAPI).
- Ссылки на медиа, id видео и типы файлов из сообщений проверяются; сообщение, которое не удалось отрисовать, больше не ломает чат; звуковая панель играет только звуки своего сервера.
- Fuses Electron: exe нельзя запустить как Node.js или открыть отладчиком.

### Скорость
- Перерисовываются только изменившиеся сообщения.

Лицензия: GPLv3 (программа включает moonlight-common-c).

</details>
