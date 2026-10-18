# Changelog

Each version has an English and a Russian section. The release description on
GitHub uses the same two sections, and the app shows the one of its language in
the update window. Mentions like `@everyone` always go in backticks: GitHub takes
a bare mention for a GitHub user and lists that user as a contributor of the release.

## 0.9.9

<details>
<summary>English</summary>

- **Back to the call after a restart.** After an update the app goes back into the call it was in by itself; after a restart of the computer or a quit, a bar at the top offers "Reconnect", as in Discord. Leaving a call on purpose forgets it.
- **Code blocks look better:** long lines wrap instead of scrolling sideways, the copy button sits in the corner and shows on hover instead of taking a line of its own, the language is a small label next to it.
- **Sunshine streams keep their frame rate:** "Fix the frame rate" (on by default) in the stream settings keeps Sunshine from halving the frame rate on a still picture: viewers get a steady 60 frames (or the monitor's rate if it is lower).
- **Bitrate of Sunshine streams:** the automatic one is as in Moonlight now (20 Mbit/s for 1080p at 60 frames, about 40 for 1440p, 80 for 4K, no discount for HEVC and AV1), and it can be set by hand from 5 to 150 Mbit/s in Settings, Streams.
- A stream popped out into a window of its own is not shown in the mini player at the same time; once that window closes, the mini player shows it again.
- **Servers can be put in your own order** by dragging them in the bar on the left. The order follows your account to other devices.

</details>

<details>
<summary>Русский</summary>

- **Возврат в звонок после перезапуска.** После обновления приложение само возвращается в звонок, в котором было. После перезагрузки компьютера или выхода сверху появляется плашка «Подключиться», как в Discord. Если выйти из звонка самому, он забывается.
- **Код-блоки выглядят лучше:** длинные строки переносятся, а не уезжают вбок. Кнопка копирования сидит в углу и появляется при наведении, а не занимает отдельную строку. Язык подписан маленькой меткой рядом с ней.
- **Стримы через Sunshine держат частоту кадров.** Галка «Фиксировать частоту кадров» (по умолчанию включена) в настройках стрима не даёт Sunshine снижать частоту вдвое на неподвижной картинке: зрители получают ровные 60 кадров (или частоту экрана, если она ниже).
- **Битрейт стримов через Sunshine.** Авто теперь как в Moonlight: 20 Мбит/с для 1080p при 60 кадрах, около 40 для 1440p, 80 для 4K, без скидки для HEVC и AV1. А в Настройках, Стримы его можно выставить вручную от 5 до 150 Мбит/с.
- Стрим, вынесенный в отдельное окно, не показывается одновременно в мини-плеере. Когда окно закрыто, мини-плеер снова его показывает.
- **Серверы можно расставить в своём порядке** перетаскиванием в панели слева. Порядок переезжает с аккаунтом на другие устройства.

</details>

## 0.9.8

<details>
<summary>English</summary>

- **Calls in direct messages.** A phone button in the header of a direct chat calls the person: their app rings (a card with the caller, Accept and Decline, a ringtone, a system notification while the window is in the background) until they answer, decline, or 40 seconds pass. The caller hears the line ringing and sees "Calling", "The call was declined" or "No answer" with "Call again". A call already going on in a chat shows a phone mark in the list of direct chats and "Join the call" in its header. Do not disturb and muted people ring without a sound. The call itself is the same as in a voice channel: cameras, screen and Sunshine streams, the soundboard.
- **The steps of joining a Sunshine stream now really show.** The tile of such a stream holds its (still empty) picture from the first moment, and the steps were drawn only when there was no picture: now they lie over it until the first frame arrives.
- **The sound of Sunshine streams:** a viewer whose network loses sound frames tells the streamer, and for a minute each frame goes out twice, so a single lost frame is there after all instead of a click; silence goes out as tiny packets; the reserve grows up to 300 ms on a network that holds sound back behind bursts of the picture, and shrinks again when it is calm. The stream log now notes lost frames, dropouts and the reserve every ten seconds when something went wrong.
- **Starting a Sunshine stream no longer fails the first time.** Opening the share dialog warms Sunshine up; a start with other settings replaced that warm-up, and the warm-up, dying, stopped the new start too.
- Hotkeys work with other keys held: the microphone on the right Alt also toggles with Shift held. When another binding asks for exactly the keys held (Ctrl+M and Ctrl+Shift+M), that one wins.
- **The soundboard can be turned off** in Voice and video: altogether (sounds of others are not heard, no button), or only its button (sounds of others are heard, none of your own are played).
- The volume of a narrow video no longer makes its buttons jump: the slider opens upward over the picture.

</details>

<details>
<summary>Русский</summary>

- **Звонки в личных сообщениях.** Кнопка с трубкой в шапке лички звонит человеку. У него звонит, пока он не ответит, не отклонит или не пройдут 40 секунд. Он видит карточку со звонящим, кнопки «Принять» и «Отклонить», слышит мелодию, а если окно в фоне, получает системное уведомление. Звонящий слышит гудки и видит «Звоню», «Звонок отклонён» или «Нет ответа» с кнопкой «Позвонить ещё раз». Если в чате уже идёт звонок, в списке личек у него значок трубки, а в шапке кнопка «Присоединиться к звонку». В режиме «Не беспокоить» и от заглушённых людей звонок приходит без звука. Сам звонок такой же, как в голосовом канале: камеры, демонстрация экрана и Sunshine, звуковая панель.
- **Этапы подключения к стриму Sunshine теперь правда видно.** Плитка такого стрима с первой секунды держит его (ещё пустую) картинку, а этапы рисовались только когда картинки не было. Теперь они лежат поверх неё до первого кадра.
- **Звук стримов через Sunshine.**
  - Если у зрителя теряются звуковые кадры, он сообщает стримеру, и минуту каждый кадр уходит дважды: одиночная потеря восстанавливается, а не щёлкает.
  - Тишина уходит крошечными пакетами.
  - Если сеть придерживает звук за пачками картинки, запас растёт до 300 мс, а в спокойной сети снова ужимается.
  - Если что-то пошло не так, в лог стримов раз в десять секунд пишутся потерянные кадры, провалы и запас.
- **Стрим через Sunshine больше не падает с первого раза.** Окно демонстрации заранее прогревает Sunshine. Старт с другими настройками заменял этот прогрев, а прогрев, умирая, гасил и новый старт.
- Горячие клавиши срабатывают при зажатых других клавишах: микрофон на правом Alt переключается и с зажатым Shift. Если другая привязка просит ровно то, что зажато (Ctrl+M и Ctrl+Shift+M), срабатывает она.
- **Звуковую панель можно выключить** в «Голос и видео»: полностью (звуков других не слышно, кнопки нет) или только кнопку (звуки других слышно, свои не проиграть).
- Громкость узкого видео больше не дёргает его кнопки: ползунок открывается вверх, поверх картинки.

</details>

## 0.9.7

<details>
<summary>English</summary>

- **Joining a stream through Sunshine shows its steps:** preparing the connection, the streamer's answer, the direct connection, starting the stream, the first picture. Done steps are ticked, the current one turns, and under the list stands what is happening right now (waiting for the streamer to let you in, pairing, the stage of the stream). A small tile shows the current step and the progress bar.
- **Chats no longer jump.** Scrolling up to older messages kept the view where it was only some of the time, and older messages loaded while scrolling counted as new ones: the bar said there were new messages when there were none, and the "new" line popped up in the middle of history.
- **The sound of Sunshine streams is smooth.** It goes straight to the audio thread instead of through the page, which also decodes the picture; the reserve holds itself by playing a fraction of a percent faster or slower instead of skipping, grows after a dropout and shrinks again when calm; breaks fade instead of clicking.
- Messages not sent today show their date: "yesterday at 14:05", or the date with the time. The full date is on hover.
- **Copying a picture to the clipboard works again** (Electron 44 changed the clipboard).
- **"Mirror the camera" in the camera settings.** Your own camera used to look mirrored to you and not to the others; now your tile shows exactly what is sent, mirrored for everyone when the setting is on.
- **After the connection drops and comes back, streams through Sunshine go on.** The streamer announces the stream again (the others had lost it while the streamer still saw it running), and a viewer joins it again by itself instead of being left with an empty tile. Join and leave sounds of the reconnect itself are not played.
- The switch for backgrounds is about calls now: off, call tiles of others show neither pictures nor emoji. Profiles always show backgrounds as their owners made them.
- The controls of a narrow (upright) video no longer stick out of it: the seek bar goes above the buttons.
- An autostart while the app already runs leaves it in the tray.

</details>

<details>
<summary>Русский</summary>

- **Подключение к стриму через Sunshine показывает этапы:** подготовка соединения, ответ стримера, прямое подключение, запуск стрима, первый кадр. Пройденные отмечены галочкой, текущий крутится, а под списком написано, что происходит прямо сейчас: ждём разрешения стримера, спаривание, этап запуска. На маленькой плитке видно текущий этап и полосу прогресса.
- **Чаты больше не прыгают.** При прокрутке вверх к старым сообщениям лента держалась на месте только иногда. А подгруженные старые сообщения считались новыми: полоса писала про новые сообщения, которых нет, и посреди истории вылезала линия «Новые».
- **Звук стримов через Sunshine идёт ровно.** Он теперь идёт сразу в аудиопоток, а не через страницу, которая ещё и декодирует картинку. Запас держится сам: воспроизведение идёт на доли процента быстрее или медленнее, вместо того чтобы перескакивать. После провала запас растёт, в спокойные моменты снова ужимается, обрывы затухают вместо щелчков.
- У сообщений, отправленных не сегодня, есть дата: «вчера в 14:05» или дата со временем. Полная дата при наведении.
- **Копирование картинки в буфер обмена снова работает** (в Electron 44 поменялся буфер обмена).
- **«Отзеркалить камеру» в настройках камеры.** Раньше ты видел свою камеру зеркально, а остальные нет. Теперь на твоей плитке ровно то, что уходит другим: с настройкой зеркально у всех, без неё ни у кого.
- **После того как связь пропала и вернулась, стримы через Sunshine продолжаются.** Стример заново объявляет стрим: остальные его теряли, хотя у стримера он висел как живой. Зритель сам подключается к нему снова, а не остаётся с пустой плиткой. Звуки входа и выхода от самого переподключения не играют.
- Переключатель фонов теперь про звонки: выключен, и на плитках других в звонке нет ни картинок, ни смайлов. В профилях фоны видны всегда, как их сделали владельцы.
- Кнопки узкого (вертикального) видео больше не вылезают за его край: полоса перемотки уходит над кнопками.
- Автозапуск, когда приложение уже работает, оставляет его в трее.

</details>

## 0.9.6

<details>
<summary>English</summary>

- **A viewer who joins while the streamer's Sunshine is still warming up gets the stream.** Sunshine keeps one launch waiting for its client at a time and quietly ignores the next: a viewer who came in during the warm-up (a quarter of a minute after the start on a slow computer) got the warm-up's keys, and the stream failed at the RTSP handshake. The streamer now lets viewers in once the warm-up is done, and a viewer whose start fails at the RTSP handshake tries again by itself (after 1.5, 3 and 6 seconds): this also covers two viewers joining at the same moment.
- An accepted pairing is not sent to Sunshine a second time.

</details>

<details>
<summary>Русский</summary>

- **Зритель, зашедший, пока Sunshine стримера ещё прогревается, получает стрим.** Sunshine держит только один запуск, ждущий своего клиента, а следующий молча игнорирует. Зритель, пришедший во время прогрева (на медленном компе это секунд 15 после старта), получал ключи прогрева, и стрим падал на RTSP. Теперь стример пускает зрителей после прогрева, а зритель, у которого старт упал на RTSP, сам пробует ещё раз (через 1.5, 3 и 6 секунд): это же спасает, когда два зрителя заходят одновременно.
- Подтверждённое спаривание больше не отправляется в Sunshine второй раз.

</details>

## 0.9.5

<details>
<summary>English</summary>

- **Streams through Sunshine connect when one side's provider shows some STUN servers another outside port.** One provider gives the traffic to Cloudflare a port of its own while the router keeps the socket's port for everyone else, and only the first port went to the other side. Now each side offers every outside address the servers saw, together with its own port on the outside IP, and the one that kept the port comes first.
- When the stream tunnel cannot take the port set by hand, it waits a few seconds for the last one to let go, and the stream log says why it did not start.

</details>

<details>
<summary>Русский</summary>

- **Стримы через Sunshine подключаются, когда провайдер одной из сторон показывает части STUN-серверов другой внешний порт.** У одного провайдера трафик к Cloudflare получает свой порт, а роутер для всех остальных сохраняет порт сокета, и другой стороне уходил только первый порт. Теперь каждая сторона отдаёт все внешние адреса, которые увидели серверы, и свой порт на внешнем IP, а первым идёт тот, где порт сохранился.
- Если туннель стрима не может занять порт, заданный вручную, он несколько секунд ждёт, пока прошлый его отпустит, а в логе стримов видно, почему туннель не запустился.

</details>

## 0.9.4

<details>
<summary>English</summary>

- **Streams through Sunshine connect where both sides sit behind two routers.** The streamer used to knock on the viewer's router before the viewer had sent anything; some routers then move the viewer to another outside port, and nothing got through either way for the whole minute. Now the streamer first opens its own routers with packets that die a few hops out, and the viewer knocks first.
- The NAT check asks more STUN servers at different addresses and waits for two answers: Google's server does not answer from some networks, and with one answer the NAT type was a guess. The stream log shows what each server saw.
- The stream log tells packets that came from an unknown address or did not open apart from silence.

</details>

<details>
<summary>Русский</summary>

- **Стримы через Sunshine подключаются, когда у обоих по два роутера.** Раньше стример стучался в роутер зрителя до того, как зритель сам что-то отправил. Некоторые роутеры после этого переводят зрителя на другой внешний порт, и целую минуту ничего не проходило ни в одну сторону. Теперь стример сначала открывает свои роутеры пакетами, которые умирают через несколько хопов, а первым стучится зритель.
- Проверка NAT спрашивает больше STUN-серверов на разных адресах и ждёт два ответа: сервер Google из некоторых сетей не отвечает, а по одному ответу тип NAT был догадкой. В логе стримов видно, что увидел каждый сервер.
- В логе стримов теперь видно пакеты, которые пришли с незнакомого адреса или не открылись, а не только тишину.

</details>

## 0.9.3

<details>
<summary>English</summary>

- **A log of streams through Sunshine** for finding out why a stream does not connect: the candidates of both sides, which addresses probes came from and which answered, the path, pairing, the stages and errors of the stream. It is in the profile folder (logs/streams.log); "Open the log folder" in the "Streams" tab. It has IP addresses in it: send it only to whoever helps.
- scripts/astrum-diag.ps1 in the repository: one command gathers a network report (the NAT, routers, VPN and zapret, the firewall) together with the stream log.

</details>

<details>
<summary>Русский</summary>

- **Лог стримов через Sunshine,** чтобы разобраться, почему стрим не подключается: кандидаты обеих сторон, с каких адресов пришли пробы и какие ответили, путь, спаривание, стадии и ошибки стрима. Лежит в папке профиля (logs/streams.log), кнопка «Открыть папку с логом» во вкладке «Стримы». В нём есть IP-адреса: отправляй только тому, кто помогает.
- В репозитории scripts/astrum-diag.ps1: одной командой собирает отчёт о сети (NAT, роутеры, VPN и zapret, файрвол) вместе с логом стримов.

</details>

## 0.9.2

<details>
<summary>English</summary>

### Streams through Sunshine
- **Several streams at once.** Each watched stream has its own tunnel and decoder; watching one no longer stops another.
- **Streaming and watching at the same time.** Every Sunshine start picks free ports of its own, so two people can stream and watch each other at once (before, both used the same ports and it worked only now and then).
- **More reliable connections.** The outside address of the tunnel is kept alive while waiting for a viewer (routers forgot it after half a minute or so, and later viewers could not get through), the tunnel's port is taken from 20000-29999 (away from ranges routers often pass to a server, such as 50000-60000 for LiveKit), punching starts faster and tries longer.
- **Faster joining.** Joining a stream again takes about 3 seconds: fewer steps, a quicker network check, and the streamer's desktop is started right after the stream starts (Sunshine re-checks every encoder on the first launch, seconds long). The share dialog starts Sunshine ahead while you pick the monitor, so starting a stream is quick too.
- **"The client is not authorized. Certificate verification failed."** fixed: Sunshine cannot pair a certificate it already knows a second time. The app now makes a new identity and pairs it by itself.
- The error message after a failed connection says what NAT each side is behind and names the usual culprits: zapret with Game Filter on, a VPN in TUN mode, the firewall.

### Profile background
- The background picture is framed like an avatar is cropped: the picture moves under a window of the place's shape, the wheel or the slider enlarges it. The profile card and the call tile are framed apart; the picture is the same.

### Other
- Push-to-talk works with Shift, Alt or Ctrl held down (sprinting and the like in games).
- Started with Windows into the tray, the app no longer opens its window when it was maximized last time.
- The soundboard panel is no longer see-through.

</details>

<details>
<summary>Русский</summary>

### Стримы через Sunshine
- **Несколько стримов сразу.** У каждого стрима свой туннель и свой декодер; второй стрим больше не выключает первый.
- **Стримить и смотреть одновременно.** Sunshine при каждом запуске берёт свободные порты, так что двое могут стримить и смотреть друг друга одновременно (раньше у всех были одни и те же порты, и это работало через раз).
- **Надёжнее подключение.** Внешний адрес туннеля поддерживается, пока ждём зрителя (роутеры забывали его примерно через полминуты, и зрители, пришедшие позже, не могли пробиться). Порт туннеля берётся из 20000-29999, подальше от диапазонов, которые часто пробрасывают на сервер (например, 50000-60000 под LiveKit). Пробивка начинается быстрее и длится дольше.
- **Быстрее вход.** Повторный вход в стрим занимает около 3 секунд: меньше шагов, быстрее проверка сети, а рабочий стол стримера запускается сразу после старта стрима (при первом запуске Sunshine заново проверяет все кодировщики, это секунды). Окно демонстрации заранее поднимает Sunshine, пока выбираешь монитор, поэтому сам стрим тоже запускается быстро.
- **Исправлено «The client is not authorized. Certificate verification failed.»:** Sunshine не умеет второй раз спарить уже знакомый сертификат. Программа теперь сама делает новую личность и спаривается заново.
- В ошибке после неудачного подключения видно, какой NAT у каждой стороны, и названы частые виновники: zapret с включённым Game Filter, VPN в режиме TUN, файрвол.

### Фон профиля
- Картинка фона кадрируется так же, как аватарка: картинка двигается под окном нужной формы, колесо или ползунок приближают. Карточка профиля и плитка в звонке настраиваются отдельно, картинка одна.

### Прочее
- Рация работает с зажатым Shift, Alt или Ctrl (бег и прочее в играх).
- При запуске с Windows в трей окно больше не открывается, если в прошлый раз оно было развёрнуто.
- Панель звуков больше не просвечивает.

</details>

## 0.9.1

<details>
<summary>English</summary>

### Streams through Sunshine
- **No port forwarding and no public IP needed.** The two computers connect directly through an encrypted tunnel (X25519 and AES-256-GCM) that punches through NAT by itself, as games and calls do. It does not get through only when both sides are behind a strict ("symmetric") NAT; then the router can open one UDP port over UPnP, or the port can be forwarded by hand.
- Sunshine is no longer open to the internet: only the tunnel of a viewer you let in reaches it. The streamer's addresses go only to viewers that were let in.
- The stream's sound no longer carries the call: it is everything that plays on the computer except Astrum, as with a regular share. It goes uncompressed through the tunnel.
- Several viewers at once, each with their own encoder on the graphics card (up to 8 on NVIDIA). A cap is in the "Streams" tab.
- A viewer asks once. Access can be taken back in "Viewers with access" even while you do not stream.
- The encoder Sunshine uses is shown; a warning if it fell back to the processor.
- The network check tells what NAT is in front of the computer, whether the router has UPnP, and whether there is IPv6.
- Viewers: AV1 next to H.264 and HEVC, only codecs the graphics card decodes can be picked; the stream tile shows the path (home network, IPv6, direct) and the round trip.
- Sunshine no longer shows the computer's name to viewers.

### Settings
- The tabs come in two groups, "Account" and "App", in a more logical order. "App" is now "General", "Voice & Audio" is "Voice & Video". The stream player settings moved to "Streams", the camera to the end of "Voice & Video", "Refresh devices" next to the devices.
- The interface scale is a slider.
- Spelling mistakes are underlined by default.
- The statuses have no descriptions any more.

### Security
- New sign-ins lock the encryption key store with a key kept inside the sealed session: a copy of the profile folder no longer gives the message keys. Older sign-ins keep their store as it is; signing out and in again locks it.
- A packaged app no longer takes the page address from an environment variable.
- Global hotkeys from the page are checked and limited: a page that could bind every key would see everything typed in the system.
- Updates: the installer is checked again right before it runs, and a download bigger than the release says is stopped.
- Link previews no longer reach local addresses hidden in IPv6 forms (NAT64, 6to4, hex-mapped IPv4).
- Answers from a Sunshine host and data in the tunnel are limited in size; repeated "watching" packets and stream requests no longer flood with sounds; link preview texts and server names in invites are checked.

</details>

<details>
<summary>Русский</summary>

### Стримы через Sunshine
- **Не нужны ни проброс портов, ни белый IP.** Компьютеры соединяются напрямую по зашифрованному туннелю (X25519 и AES-256-GCM), который сам пробивается через NAT, как в играх и звонках. Не пробьётся, только если у обоих строгий («симметричный») NAT; тогда роутер может открыть один UDP-порт по UPnP или порт можно пробросить вручную.
- Sunshine больше не открыт в интернет: до него доходит только туннель зрителя, которого ты пустил. Адреса стримера получают только допущенные зрители.
- В звуке стрима больше нет звонка: это всё, что играет на компьютере, кроме Astrum, как в обычной демонстрации. Идёт по туннелю без сжатия.
- Несколько зрителей одновременно, у каждого свой кодировщик на видеокарте (у NVIDIA до 8). Предел во вкладке «Стримы».
- Зритель спрашивает один раз. Доступ можно забрать в «Зрителях с доступом», даже когда не стримишь.
- Видно, каким кодировщиком кодирует Sunshine; предупреждение, если он скатился на процессор.
- Проверка сети показывает, какой NAT стоит перед компьютером, есть ли на роутере UPnP и есть ли IPv6.
- Для зрителя: AV1 рядом с H.264 и HEVC, выбрать можно только кодеки, которые видеокарта декодирует; на плитке стрима видно, как он идёт (по локалке, IPv6, напрямую) и задержка.
- Sunshine больше не показывает зрителям имя компьютера.

### Настройки
- Вкладки разбиты на две группы, «Учётная запись» и «Приложение», порядок стал логичнее. «Приложение» теперь «Общие», «Голос и звук» стал «Голос и видео». Настройки плеера демонстрации переехали в «Стримы», камера в конец «Голоса и видео», «Обновить устройства» рядом с устройствами.
- Масштаб интерфейса ползунком.
- Ошибки в словах подчёркиваются по умолчанию.
- У статусов больше нет описаний.

### Безопасность
- Новые входы запирают хранилище ключей шифрования ключом, который лежит внутри запечатанной сессии: копия папки профиля больше не даёт ключей от сообщений. Старые входы оставляют хранилище как есть; выйти и войти снова, и оно запрётся.
- Собранная программа больше не берёт адрес страницы из переменной окружения.
- Глобальные горячие клавиши от страницы проверяются и ограничены: страница, которая могла бы назначить каждую клавишу, видела бы всё, что набирается в системе.
- Обновления: установщик сверяется ещё раз прямо перед запуском, скачивание больше заявленного в релизе обрывается.
- Превью ссылок больше не достают до локальных адресов, спрятанных в формах IPv6 (NAT64, 6to4, IPv4 в шестнадцатеричном виде).
- Ответы хоста Sunshine и данные в туннеле ограничены по размеру; повторные пакеты «смотрю» и запросы на стрим больше не засыпают звуками; тексты превью и имена серверов в приглашениях проверяются.

</details>

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
