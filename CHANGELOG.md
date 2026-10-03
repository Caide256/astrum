# Changelog

Each version has an English and a Russian section. The release description on
GitHub uses the same two sections, and the app shows the one of its language in
the update window. Mentions like `@everyone` always go in backticks: GitHub takes
a bare mention for a GitHub user and lists that user as a contributor of the release.

## 0.9.0

<details>
<summary>English</summary>

### New
- **Streams through Sunshine**, right from Astrum: your screen goes to viewers directly from your PC and is encoded by the video card, so the quality is limited only by your upload. Pick "Through Sunshine" in the share dialog.
  - Sunshine is downloaded on the first such stream (the official LizardByte build, about 38 MB, checked by its checksum), started with the stream and stopped with it.
  - It needs a public IP. The app checks the network itself and opens the ports on the router over UPnP. If the ports are forwarded by hand, there is "My IP is public, the ports are forwarded by hand" and an address for viewers (an IP or a domain).
  - Each viewer asks once, and you allow or decline in a card. Access can be taken back in the "Streams" tab.
  - Sunshine streams look and work like regular ones (tile, mini player, separate window), with a yellow dot instead of the red one.
  - The sound of the PC goes along, from the output device you pick. The monitor, the encoder and a bitrate cap per viewer are in the "Streams" tab.
  - With a gray IP the regular share through the call works as before.
- **Moonlight plays the stream sound.**
- **Media player** for videos and audio in chats: downloads when you press play, shows the progress, one volume for all players, only one plays at a time.
- **Streamer mode** is a full status with its own purple dot.
- **Background editor**: zoom and move the picture, with previews of the profile card and the call tile.
- Pictures can be dropped onto the avatar, the profile background and the server icon.
- A message with attachments can be edited: take files out or add new ones.
- A green dot on the tray icon while you are in a call.
- Settings:
  - "Underline spelling mistakes" (Russian and English, fixes on right click);
  - "Interface scale";
  - "Pictures on other people's backgrounds";
  - "Notifications from voice channel chats", off by default; mentions of you notify anyway.

### Changed
- The "Streams" tab: only how streams look for you (size "As the source" or smaller, frame rate, codec). The bitrate is set automatically. A list of connected Sunshine hosts.
- "Watch via Moonlight" in the person's menu is gone: a Sunshine stream is watched like any other.
- The member list is hidden in direct chats until you open it.
- "You are looking at older messages" and "Jump to the newest" are one button.
- A new pin icon, without a counter.
- The status list and the microphone hint are no longer see-through.

### Fixed
- Accepting an invite to a direct chat failed with "Can't join remote room because no servers are in the room" and the invite stayed. Now the inviter's server is asked; an invite to a room nobody is left in is declined or hidden.
- A chat left scrolled to the bottom opens at the bottom.
- Unread marks clear right after reading, and the open chat is not counted as unread.
- JPG avatars. Pictures that failed to load once are tried again instead of staying blank until a restart.

Sunshine (GPLv3, LizardByte) is not packed into Astrum: it is downloaded from its GitHub releases when needed.

</details>

<details>
<summary>Русский</summary>

### Новое
- **Стримы через Sunshine** прямо из Astrum: экран идёт зрителям напрямую с твоего компьютера, кодирует видеокарта, качество упирается только в исходящий канал. В окне демонстрации выбери «Через Sunshine».
  - Sunshine скачивается при первом таком стриме (официальная сборка LizardByte, около 38 МБ, сверяется по контрольной сумме), запускается вместе со стримом и вместе с ним останавливается.
  - Нужен белый IP. Программа сама проверяет сеть и открывает порты на роутере по UPnP. Если порты проброшены вручную, есть «У меня белый IP, порты проброшены вручную» и адрес для зрителей (IP или домен).
  - Каждый зритель спрашивает один раз, ты разрешаешь или отклоняешь в карточке. Доступ можно забрать во вкладке «Стримы».
  - Стримы через Sunshine выглядят и работают как обычные (плитка, мини-плеер, отдельное окно), только точка жёлтая, а не красная.
  - Звук компьютера идёт вместе с картинкой, с выбранного устройства вывода. Монитор, кодировщик и предел битрейта на зрителя во вкладке «Стримы».
  - С серым IP обычная демонстрация через звонок работает как раньше.
- **Moonlight играет звук стрима.**
- **Медиаплеер** для видео и аудио в чатах: скачивает по нажатию на «Воспроизвести» и показывает прогресс, одна громкость на все плееры, играет только один за раз.
- **Режим стримера** теперь полноценный статус со своей фиолетовой точкой.
- **Редактор фона**: картинку можно увеличить и сдвинуть, видно, как она ляжет в карточку профиля и в плитку звонка.
- Картинку можно перетащить прямо на аватарку, фон профиля и иконку сервера.
- Сообщение с вложениями можно редактировать: убрать файлы или добавить новые.
- Зелёная точка на иконке в трее, пока ты в звонке.
- Настройки:
  - «Подчёркивать ошибки» (русский и английский, исправления по правой кнопке);
  - «Масштаб интерфейса»;
  - «Картинки на фонах других»;
  - «Уведомления из чатов войсов», по умолчанию выключено; упоминания тебя приходят всё равно.

### Изменено
- Вкладка «Стримы»: только то, как стримы выглядят у тебя (размер «Как у источника» или меньше, частота, кодек). Битрейт выставляется сам. Список подключённых Sunshine.
- Пункта «Смотреть через Moonlight» в меню человека больше нет: стрим через Sunshine смотрится как любой другой.
- В личных чатах список участников скрыт, пока его не открыть.
- «Ты смотришь старые сообщения» и «К последним» теперь одна кнопка.
- Новая иконка закрепов, без счётчика.
- Список статусов и подсказка про микрофон больше не просвечивают.

### Исправлено
- Приглашение в личный чат не принималось с ошибкой «Can't join remote room because no servers are in the room» и продолжало висеть. Теперь спрашивается сервер пригласившего, а приглашение в комнату, где никого не осталось, отклоняется или прячется.
- Чат, пролистанный до конца, открывается внизу.
- Отметки непрочитанного снимаются сразу после прочтения, открытый чат не считается непрочитанным.
- Аватарки в JPG. Картинки, которые один раз не загрузились, загружаются снова, а не висят пустыми до перезапуска.

Sunshine (GPLv3, LizardByte) не упакован в Astrum: он скачивается с его релизов на GitHub, когда нужен.

</details>

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
