// Every test process is offline by construction. No real provider/auth traffic.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
const denied = () => { throw new Error("NETWORK DISABLED: tests must inject a fake transport"); };
globalThis.fetch = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
net.connect = denied;
net.createConnection = denied;
net.Socket.prototype.connect = denied;
tls.connect = denied;
syncBuiltinESMExports();
