const { app, BrowserWindow, desktopCapturer, session } = require("electron");
const path = require("node:path");

/**
 * Screen share encoding test: which encoder Chromium uses for the screen
 * picture (GPU or CPU) and how much CPU it takes. Two WebRTC connections
 * inside one page, no server.
 *
 *   npx electron scripts/encode-test.cjs [chromium switches separated by spaces]
 */

app.setPath("userData", path.join(app.getPath("appData"), "encode-test"));
for (const arg of process.argv.slice(2)) {
  if (!arg.startsWith("--")) continue;
  const [k, v] = arg.slice(2).split("=");
  if (v === undefined) app.commandLine.appendSwitch(k);
  else app.commandLine.appendSwitch(k, v);
}

function cpuNow() {
  // total load of all app processes, in percent of one core
  return app.getAppMetrics().reduce((sum, m) => sum + (m.cpu?.percentCPUUsage ?? 0), 0);
}

async function run(win, codec, height, fps) {
  cpuNow();
  const started = Date.now();
  const res = await win.webContents.executeJavaScript(`(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { height: { max: ${height} }, width: { max: ${Math.round(height * 2.4)} }, frameRate: { ideal: ${fps}, max: ${fps} } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    track.contentHint = "motion";
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    let got = null;
    b.ontrack = (e) => { got = e.track; };
    const tr = a.addTransceiver(track, { direction: "sendonly" });
    const caps = RTCRtpSender.getCapabilities("video").codecs;
    const want = caps.filter((c) => c.mimeType.toLowerCase() === "video/${codec}");
    tr.setCodecPreferences([...want, ...caps.filter((c) => !want.includes(c))]);
    const p = tr.sender.getParameters();
    p.encodings = [{ maxBitrate: 6000000, maxFramerate: ${fps} }];
    await tr.sender.setParameters(p).catch(() => {});
    await a.setLocalDescription();
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription();
    await a.setRemoteDescription(b.localDescription);
    // something must move on screen, or the encoder has nothing to encode
    const spin = document.createElement("div");
    spin.style.cssText = "position:fixed;inset:0;z-index:99999";
    document.body.appendChild(spin);
    let on = true, hue = 0;
    const paint = () => { hue = (hue + 9) % 360; spin.style.background = "linear-gradient(" + hue + "deg, hsl(" + hue + " 90% 50%), hsl(" + (hue + 120) + " 90% 40%))"; if (on) requestAnimationFrame(paint); };
    requestAnimationFrame(paint);
    await new Promise((r) => setTimeout(r, 6000));
    let out = {};
    (await tr.sender.getStats()).forEach((s) => {
      if (s.type === "outbound-rtp" && s.kind === "video") {
        out = { encoder: s.encoderImplementation, powerEfficient: s.powerEfficientEncoder, fps: s.framesPerSecond, w: s.frameWidth, h: s.frameHeight, limit: s.qualityLimitationReason, kbps: 0 };
      }
      if (s.type === "codec") out.codec = s.mimeType;
    });
    on = false; spin.remove();
    track.stop(); a.close(); b.close();
    return out;
  })()`);
  const secs = (Date.now() - started) / 1000;
  res.cpuPercent = Math.round(cpuNow());
  res.seconds = Math.round(secs);
  return res;
}

void app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler((_r, cb) => {
    void desktopCapturer.getSources({ types: ["screen"] }).then((s) => cb({ video: s[0] }));
  });
  const win = new BrowserWindow({ width: 900, height: 600, show: true, webPreferences: { backgroundThrottling: false } });
  // screen capture needs a secure context, and a file page is one
  const blank = path.join(app.getPath("userData"), "blank.html");
  require("node:fs").writeFileSync(blank, "<body style='margin:0;background:#000'></body>");
  await win.loadFile(blank);
  const out = {};
  for (const [codec, h, fps] of [["h264", 1080, 60], ["vp8", 1080, 60], ["h264", 720, 30]]) {
    out[`${codec} ${h}p${fps}`] = await run(win, codec, h, fps);
  }
  console.log("ENCODE " + JSON.stringify(out, null, 1));
  app.quit();
});
