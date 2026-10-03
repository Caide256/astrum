const dgram = require("node:dgram");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");

/**
 * The network around this computer, for streams through Sunshine.
 *
 * The NAT check itself runs in the native helper (STUN from the same kind of
 * socket the stream tunnel uses, see native/helper/src/tunnel). Here: the
 * addresses of the network adapters, and the router over UPnP, which can
 * open a port for the tunnel and says what its outside address is. UPnP only
 * talks to devices in the local network.
 */

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

/** Addresses of the home network: the tunnel's candidates for a viewer in the same network. */
function lanAddresses() {
  return adapterAddresses().filter((ip) => isPrivate(ip) && !ip.startsWith("127."));
}

/** Native global IPv6 addresses (2000::/3): reachable without NAT when both sides have IPv6. */
function v6Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== "IPv6" || a.internal || a.scopeid) continue;
      if (!/^[23][0-9a-f]{3}:/i.test(a.address)) continue;
      // Teredo (2001:0::/32) and 6to4 (2002::/16) are IPv6 tunneled through IPv4 relays: no help here
      if (/^2001:0{0,4}:/i.test(a.address) || /^2002:/i.test(a.address)) continue;
      out.push(a.address.toLowerCase());
    }
  }
  return [...new Set(out)].slice(0, 2);
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
  // found: description URL -> the local address it answered on
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
      if (m && !found.has(m[1])) found.set(m[1], local);
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

/** Routers answering an SSDP search for an internet gateway: description URL -> our local address. */
async function findGateways(timeoutMs) {
  const found = new Map();
  const locals = adapterAddresses().filter(isPrivate);
  await Promise.all(locals.map((ip) => searchFrom(ip, timeoutMs, found)));
  return found;
}

/** The WAN connection services of a router: where to send commands. */
async function wanServices(location) {
  const xml = await httpText(location, {}, 2500);
  if (!xml) return [];
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml)?.[1] || location;
  const out = [];
  for (const block of xml.match(/<service>[\s\S]*?<\/service>/gi) || []) {
    const type = /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(block)?.[1] || "";
    if (!/^urn:schemas-upnp-org:service:WAN(IP|PPP)Connection:\d$/i.test(type)) continue;
    const control = /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!control) continue;
    try {
      out.push({ type, url: new URL(control, base).toString() });
    } catch {
      // a broken URL: skip the service
    }
  }
  return out;
}

const XML_ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };

/** One SOAP command to a router service; the answer's text, or null. */
function soap(service, action, args) {
  const body =
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service.type}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${String(v).replace(/[&<>"]/g, (c) => XML_ESC[c])}</${k}>`)
      .join("") +
    `</u:${action}></s:Body></s:Envelope>`;
  return httpText(
    service.url,
    { method: "POST", body, headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPAction: `"${service.type}#${action}"` } },
    2500,
  );
}

async function externalAddress(service) {
  const answer = await soap(service, "GetExternalIPAddress", {});
  const ip = answer && /<NewExternalIPAddress>\s*([^<\s]*)\s*<\/NewExternalIPAddress>/i.exec(answer)?.[1];
  return ip && net.isIPv4(ip) ? ip : null;
}

/** The router (one answering UPnP with a WAN service) and its outside address. */
async function router() {
  const found = await findGateways(2500);
  for (const [location, local] of [...found].slice(0, 4)) {
    for (const service of await wanServices(location).catch(() => [])) {
      const ip = await externalAddress(service).catch(() => null);
      if (ip) return { service, local, ip };
    }
  }
  return null;
}

let mapped = null;

/**
 * Ask the router to pass a UDP port to this computer: the stream tunnel's
 * port. Returns the outside "ip:port", or "" when the router said no or its
 * outside address is not public (then the provider's NAT is in front of it).
 * The mapping expires on its own after an hour if the app is gone.
 */
async function openPort(port) {
  const r = await router().catch(() => null);
  if (!r || !isPublic(r.ip)) return "";
  const args = (lease) => ({
    NewRemoteHost: "",
    NewExternalPort: port,
    NewProtocol: "UDP",
    NewInternalPort: port,
    NewInternalClient: r.local,
    NewEnabled: 1,
    NewPortMappingDescription: "Astrum stream",
    NewLeaseDuration: lease,
  });
  let answer = await soap(r.service, "AddPortMapping", args(3600));
  // some routers take only permanent mappings
  if (answer && /<errorCode>\s*725\s*</i.test(answer)) answer = await soap(r.service, "AddPortMapping", args(0));
  if (!answer || /<errorCode>/i.test(answer)) return "";
  mapped = { service: r.service, port };
  return `${r.ip}:${port}`;
}

async function closePort() {
  const m = mapped;
  mapped = null;
  if (!m) return;
  await soap(m.service, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: m.port, NewProtocol: "UDP" }).catch(() => null);
}

/**
 * What a stream tunnel of this computer would face. `probe` is the native
 * helper's STUN look ({nat, ip}); nat: "open" (a public address right on the
 * computer), "cone" (an ordinary NAT, hole punching works), "symmetric" (a
 * strict NAT), "blocked" (UDP does not get out). The router may open a port
 * by UPnP, which beats any NAT in front of this computer.
 */
async function check(probe) {
  const [seen, r] = await Promise.all([probe().catch(() => null), router().catch(() => null)]);
  const nat = ["open", "cone", "symmetric", "blocked"].includes(seen?.nat) ? seen.nat : "unknown";
  return {
    nat,
    ip: typeof seen?.ip === "string" && net.isIPv4(seen.ip) ? seen.ip : "",
    upnp: !!r && isPublic(r.ip),
    v6: v6Addresses().length > 0,
    lan: lanAddresses(),
  };
}

module.exports = { check, isPublic, isPrivate, lanAddresses, v6Addresses, openPort, closePort };
