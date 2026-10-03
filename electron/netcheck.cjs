const dgram = require("node:dgram");
const dns = require("node:dns").promises;
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const crypto = require("node:crypto");

/**
 * Does this computer have a public ("white") IP that friends can reach?
 *
 * Three looks: the address the internet sees (STUN), the addresses of the
 * network adapters, and the router's own outside address (UPnP). A public
 * address on an adapter means a direct connection; the router reporting the
 * same public address as STUN means a home router with a white IP (and UPnP
 * opens the ports by itself); a router that sits behind another private
 * address means the provider's NAT, a "gray" IP, which nobody outside can
 * reach. Without UPnP the answer stays unknown.
 *
 * STUN goes to public STUN servers, as every WebRTC call does; UPnP only
 * talks to devices in the local network.
 */

const STUN_SERVERS = [
  ["stun.l.google.com", 19302],
  ["stun.cloudflare.com", 3478],
  ["stun1.l.google.com", 19302],
];

function v4(ip) {
  return net.isIPv4(ip) ? ip.split(".").map(Number) : null;
}

/** 10/8, 172.16/12, 192.168/16, loopback and link-local: never reachable from outside. */
function isPrivate(ip) {
  const p = v4(ip);
  if (!p) return true;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
}

/** The provider's NAT (100.64/10), also used by Tailscale, and 198.18/15 that Clash fake-ip hands out. */
function isShared(ip) {
  const p = v4(ip);
  if (!p) return false;
  return (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}

function isPublic(ip) {
  return !!v4(ip) && !isPrivate(ip) && !isShared(ip) && v4(ip)[0] < 224 && v4(ip)[0] !== 0;
}

/** One STUN binding request; the answer carries our address as the server saw it. */
async function stunOnce(host, port, timeoutMs) {
  let address;
  try {
    address = (await dns.lookup(host, { family: 4 })).address;
  } catch {
    return null;
  }
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const id = crypto.randomBytes(12);
    const done = (ip) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve(ip);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    sock.on("error", () => done(null));
    sock.on("message", (msg) => {
      if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || !msg.subarray(8, 20).equals(id)) return;
      let at = 20;
      while (at + 4 <= msg.length) {
        const type = msg.readUInt16BE(at);
        const len = msg.readUInt16BE(at + 2);
        const body = msg.subarray(at + 4, at + 4 + len);
        if ((type === 0x0020 || type === 0x0001) && body.length >= 8 && body[1] === 0x01) {
          const raw = body.subarray(4, 8);
          const ip = type === 0x0020 ? [raw[0] ^ 0x21, raw[1] ^ 0x12, raw[2] ^ 0xa4, raw[3] ^ 0x42] : [...raw];
          done(ip.join("."));
          return;
        }
        at += 4 + len + ((4 - (len % 4)) % 4);
      }
    });
    const req = Buffer.alloc(20);
    req.writeUInt16BE(0x0001, 0);
    req.writeUInt16BE(0, 2);
    req.writeUInt32BE(0x2112a442, 4);
    id.copy(req, 8);
    sock.send(req, port, address, (err) => err && done(null));
  });
}

/** Our public address as STUN servers see it: the first answer of a few servers. */
function stunAddress(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let left = STUN_SERVERS.length;
    for (const [host, port] of STUN_SERVERS) {
      void stunOnce(host, port, timeoutMs).then((ip) => {
        left -= 1;
        if (ip) resolve(ip);
        else if (!left) resolve(null);
      });
    }
  });
}

/** IPv4 addresses of the network adapters, without loopback, Tailscale and Clash. */
function adapterAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      if (isShared(a.address) || a.address.startsWith("169.254.")) continue;
      out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/* -------------------------------------------------------------------- UPnP */

function httpText(url, init, timeoutMs, limit = 256 * 1024) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve(null);
      return;
    }
    // only devices in the local network: an answer to the search could point anywhere
    if (u.protocol !== "http:" || !isPrivate(u.hostname)) {
      resolve(null);
      return;
    }
    const req = http.request(
      { host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: init.method || "GET", headers: init.headers || {}, timeout: timeoutMs },
      (res) => {
        let size = 0;
        const parts = [];
        res.on("data", (d) => {
          size += d.length;
          if (size > limit) req.destroy();
          else parts.push(d);
        });
        res.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
        res.on("error", () => resolve(null));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    if (init.body) req.write(init.body);
    req.end();
  });
}

const SEARCH_TARGETS = [
  "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
  "urn:schemas-upnp-org:device:InternetGatewayDevice:2",
  "urn:schemas-upnp-org:service:WANIPConnection:1",
  "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

/** Search from one local address: the router is on one of the adapters, not always the default one. */
function searchFrom(local, timeoutMs, found) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const finish = () => {
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve();
    };
    sock.on("error", finish);
    sock.on("message", (msg, rinfo) => {
      if (!isPrivate(rinfo.address)) return;
      const m = /^location:\s*(\S+)/im.exec(msg.toString("utf8"));
      if (m) found.add(m[1]);
    });
    sock.bind(0, local, () => {
      try {
        sock.setMulticastInterface(local);
      } catch {
        // the system picks the adapter
      }
      for (const st of SEARCH_TARGETS) {
        const text = `M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`;
        sock.send(Buffer.from(text), 1900, "239.255.255.250", () => undefined);
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

/** Routers answering an SSDP search for an internet gateway: their description URLs. */
async function findGateways(timeoutMs) {
  const found = new Set();
  const locals = adapterAddresses().filter(isPrivate);
  await Promise.all(locals.map((ip) => searchFrom(ip, timeoutMs, found)));
  return [...found];
}

/** The outside address the router reports, through its WAN connection service. */
async function gatewayAddress(location) {
  const xml = await httpText(location, {}, 2500);
  if (!xml) return null;
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml)?.[1] || location;
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) || []) {
    const type = /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(block)?.[1] || "";
    if (!/WAN(IP|PPP)Connection/i.test(type)) continue;
    const control = /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!control) continue;
    let url;
    try {
      url = new URL(control, base).toString();
    } catch {
      continue;
    }
    const body =
      '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:GetExternalIPAddress xmlns:u="${type}"/></s:Body></s:Envelope>`;
    const answer = await httpText(
      url,
      { method: "POST", body, headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${type}#GetExternalIPAddress"` } },
      2500,
    );
    const ip = answer && /<NewExternalIPAddress>\s*([^<\s]*)\s*<\/NewExternalIPAddress>/i.exec(answer)?.[1];
    if (ip && net.isIPv4(ip)) return ip;
  }
  return null;
}

async function upnpAddress() {
  for (const location of (await findGateways(2500)).slice(0, 4)) {
    const ip = await gatewayAddress(location).catch(() => null);
    if (ip) return ip;
  }
  return null;
}

/**
 * verdict: "white" (reachable from outside), "gray" (behind the provider's
 * NAT), "unknown" (the router does not say). `ip` is the address to give out:
 * the router's when it knows one (STUN may be answered through a VPN), else
 * STUN's. `lan` are the local addresses for people in the same network.
 */
async function check() {
  const [stunIp, upnpIp] = await Promise.all([stunAddress().catch(() => null), upnpAddress().catch(() => null)]);
  const adapters = adapterAddresses();
  const lan = adapters.filter(isPrivate);
  // a public address straight on an adapter counts only if the internet sees it too:
  // VPN adapters (Radmin, Hamachi) carry public-looking addresses of their own
  const direct = adapters.find((a) => isPublic(a) && (a === stunIp || a === upnpIp));
  let verdict = "unknown";
  let ip = "";
  if (direct) {
    verdict = "white";
    ip = direct;
  } else if (upnpIp) {
    verdict = isPublic(upnpIp) ? "white" : "gray";
    ip = isPublic(upnpIp) ? upnpIp : stunIp || "";
  } else if (stunIp) {
    ip = stunIp;
  }
  return { verdict, ip, stunIp: stunIp || "", upnpIp: upnpIp || "", upnp: !!upnpIp, lan };
}

module.exports = { check, isPublic, isPrivate };
